import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { ALL_STAFF_PERMS, firstStaffPath, leadRoleFor } from "@/domain/roles";
import { permsForRole, saveRolePerms } from "@/server/permissions";
import { createStaffUser, deleteRecruit, deleteStaffUser, listAudit, listUsers, setUserRole } from "@/server/users";
import { provisionFromTwenty } from "@/server/provisioning";
import { buildMessages } from "@/server/messages";
import type { CurrentUser } from "@/server/session";

const staff = async (id: string, roleKey: string): Promise<CurrentUser> => ({
  id, email: `${id}@platinum.test`, name: id, role: "admin", roleKey, perms: await permsForRole(roleKey),
  mustChangePassword: false, impersonatedBy: null, sessionCreatedAt: new Date(),
});

describe("roles, users and the audit log", () => {
  beforeEach(async () => {
    await resetDb();
    await db.insert(schema.user).values([
      { id: "master", name: "Colton Elliott", email: "master@platinum.test", role: "master_admin" },
      { id: "jesse", name: "Jesse", email: "jesse@platinum.test", role: "admin" },
    ]);
  });

  it("has sensible defaults, and only the Master Admin can change a role", async () => {
    expect(await permsForRole("master_admin")).toEqual(ALL_STAFF_PERMS);
    const admin = await permsForRole("admin");
    expect(admin).toContain("ait.edit");
    expect(admin).toContain("free_agent.export");
    expect(admin).not.toContain("ait.delete");
    expect(admin).not.toContain("audit.view");
    const ro = await permsForRole("admin_readonly");
    expect(ro.every((p) => p.endsWith(".view"))).toBe(true);
    expect(firstStaffPath([])).toBe("/admin/no-access");
    expect(leadRoleFor("free_agent", "Traditional")).toBe("ind_lead");
    expect(leadRoleFor("free_agent", "Operation Free Agent")).toBe("captive_lead");
    expect(leadRoleFor("group_sell", null)).toBe("legacy_lead");

    await expect(saveRolePerms(await staff("jesse", "admin"), "admin_readonly", ["ait.view"])).rejects.toThrow(/Only the Master Admin/);
    await saveRolePerms(await staff("master", "master_admin"), "admin", [...admin, "audit.view"]);
    expect(await permsForRole("admin")).toContain("audit.view");
    const { rows } = await listAudit({ q: "role.permissions_changed" });
    expect(rows[0]).toMatchObject({ actor_name: "Colton Elliott", target_id: "admin" });
    expect(rows[0].metadata).toMatchObject({ added: ["audit.view"], removed: [] });
    expect(rows[0].at).toBeInstanceOf(Date);
    expect(Number.isNaN(+rows[0].at)).toBe(false);
    const users = await listUsers();
    expect(users.every((x) => x.created_at instanceof Date && !Number.isNaN(+x.created_at))).toBe(true);
  });

  it("creates staff accounts with the phone starter password and a welcome email", async () => {
    const master = await staff("master", "master_admin");
    await expect(createStaffUser(await staff("jesse", "admin"), { name: "Robin Reader", email: "robin@platinum.test", phone: "801-555-0133", role: "admin_readonly" })).rejects.toThrow(/Only the Master Admin/);
    await expect(createStaffUser(master, { name: "Robin Reader", email: "robin@platinum.test", phone: "801-555-0133", role: "recruit" })).rejects.toThrow(/staff role/);
    const id = await createStaffUser(master, { name: "Robin Reader", email: "Robin@Platinum.test", phone: "801-555-0133", role: "admin_readonly" });
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, id));
    expect(u).toMatchObject({ email: "robin@platinum.test", role: "admin_readonly", mustChangePassword: true, phoneE164: "+18015550133" });
    const signIn = await auth().api.signInEmail({ body: { email: "robin@platinum.test", password: "8015550133" } });
    expect(signIn.user).toBeTruthy();
    await expect(createStaffUser(master, { name: "Robin Again", email: "robin@platinum.test", phone: "801-555-0134", role: "admin" })).rejects.toThrow(/already exists/);

    const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "staff_welcome"));
    const [m] = await buildMessages(row);
    expect(m).toMatchObject({ to: "robin@platinum.test", subject: "Your Platinum AIT dashboard account" });
    expect(m.text).toContain("Hi, Robin");
    expect(m.text).toContain("(Admin read-only)");
    expect(m.text).toContain("Your temporary password is your phone number");

    await setUserRole(master, id, "admin");
    await expect(setUserRole(master, id, "recruit")).rejects.toThrow(/staff roles/);
    await expect(setUserRole(master, "master", "admin")).rejects.toThrow(/your own role/);
    await expect(deleteStaffUser(master, id, "wrong@x")).rejects.toThrow(/Type their email/);
    await deleteStaffUser(master, id, "robin@platinum.test");
    expect(await db.select().from(schema.user).where(eq(schema.user.id, id))).toHaveLength(0);
  });

  it("permanently deletes a recruit only with the delete permission and a typed name, keeping the audit record", async () => {
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "r1", eventId: "e1", record: { name: "Casey Morgan", email: "casey@example.com", phone: "801-555-0100", createdAt: "2026-10-06T15:00:00Z" } });
    const [r] = await db.select().from(schema.recruit);
    await expect(deleteRecruit(await staff("jesse", "admin"), r.id, "Casey Morgan", false)).rejects.toThrow(/doesn't allow/);
    const master = await staff("master", "master_admin");
    await expect(deleteRecruit(master, r.id, "Casey", false)).rejects.toThrow(/exactly/);
    await deleteRecruit(master, r.id, "  casey   morgan ", false);
    expect(await db.select().from(schema.recruit)).toHaveLength(0);
    expect(await db.select().from(schema.user).where(eq(schema.user.email, "casey@example.com"))).toHaveLength(0);
    const { rows } = await listAudit({ q: "recruit.deleted" });
    expect(rows[0]).toMatchObject({ actor_name: "Colton Elliott", target_type: "recruit" });
    expect(rows[0].metadata).toMatchObject({ name: "Casey Morgan", email: "casey@example.com" });
  });
});

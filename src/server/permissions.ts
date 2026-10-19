import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import type { RoleKey } from "@/domain/roles";
import { audit } from "./audit";
import { permsForRole } from "./role-perms";
import { HttpError, requirePageUser, type CurrentUser } from "./session";

export { permsForRole } from "./role-perms";

export function can(u: CurrentUser, perm: string) {
  return (u.perms ?? []).includes(perm);
}

/** Server actions and routes: throws if the signed-in staff member lacks the permission. */
export function needPerm(u: CurrentUser, perm: string) {
  if (!can(u, perm)) throw new HttpError(403, "Your role doesn't allow this. Ask the Master Admin.");
}

export function needMaster(u: CurrentUser) {
  if (u.roleKey !== "master_admin") throw new HttpError(403, "Only the Master Admin can do this.");
}

/** Admin pages: signed-in staff with this permission, otherwise sent to the no-access page. */
export async function requireStaffPage(perm: string): Promise<CurrentUser> {
  const u = await requirePageUser("admin");
  if (perm === "master" ? u.roleKey !== "master_admin" : !can(u, perm)) redirect("/admin/no-access");
  return u;
}

export async function saveRolePerms(u: CurrentUser, role: RoleKey, perms: string[]) {
  needMaster(u);
  if (role === "master_admin") throw new HttpError(400, "Master Admin always has full access.");
  await db.transaction(async (tx) => {
    const before = await permsForRole(role, tx);
    await tx.insert(schema.rolePermission).values({ role, perms, updatedByUserId: u.id })
      .onConflictDoUpdate({ target: schema.rolePermission.role, set: { perms, updatedByUserId: u.id, updatedAt: new Date() } });
    await audit(tx, {
      actorUserId: u.id, action: "role.permissions_changed", targetType: "role", targetId: role,
      metadata: { added: perms.filter((p) => !before.includes(p)), removed: before.filter((p) => !perms.includes(p)) },
    });
  });
}

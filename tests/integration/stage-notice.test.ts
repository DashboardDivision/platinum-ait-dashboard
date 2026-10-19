import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { provisionFromTwenty } from "@/server/provisioning";
import { completeStageTx } from "@/server/stages";
import { buildMessages } from "@/server/messages";

describe("stage-completion notices", () => {
  beforeEach(resetDb);

  it("go to every active admin, even one who turned alerts off, with record and dashboard links", async () => {
    await db.insert(schema.user).values([
      { id: "a1", name: "Admin One", email: "one@platinum.test", role: "admin" },
      { id: "a2", name: "Admin Two", email: "two@platinum.test", role: "admin" },
      { id: "a3", name: "Former Admin", email: "gone@platinum.test", role: "admin", banned: true },
    ]);
    await db.insert(schema.alertPreference).values({ userId: "a2", eventType: "stage_completed", channel: "email", enabled: false });
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "r1", eventId: "e1", record: { name: "Casey Morgan", email: "casey@example.com", phone: "801-555-0100", createdAt: "2026-10-06T15:00:00Z" } });
    const [r] = await db.select().from(schema.recruit);
    await db.transaction((tx) => completeStageTx(tx, r.id, 1, new Date(), {}, null));

    const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "stage_completed"));
    const admin = (await buildMessages(row)).filter((m) => m.to !== "casey@example.com");
    expect(admin.map((m) => m.to).sort()).toEqual(["one@platinum.test", "two@platinum.test"]);
    for (const m of admin) {
      expect(m.required).toBe(true);
      expect(m.subject).toMatch(/^\[AIT\] Casey Morgan completed Stage 1: /);
      expect(m.text).toContain(`Recruit record: http://localhost:3000/admin/recruits/${r.id}`);
      expect(m.text).toContain("Admin dashboard: http://localhost:3000/login");
      expect(m.html).toContain('href="http://localhost:3000/login"');
    }
  });
});

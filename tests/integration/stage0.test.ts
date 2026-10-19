import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { provisionFromTwenty } from "@/server/provisioning";
import { listRecruits, stageCounts } from "@/server/admin-queries";

describe("AIT Stage 0 (admin-only)", () => {
  beforeEach(resetDb);

  it("counts a recruit as Stage 0 until the welcome is delivered, then Stage 1 until they sign in", async () => {
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "r1", eventId: "e1", record: { name: "Casey Morgan", email: "casey@example.com", phone: "801-555-0100", createdAt: "2026-10-06T15:00:00Z" } });
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "r2", eventId: "e2", record: { name: "No Phone", email: "nophone@example.com", phone: null, createdAt: "2026-10-06T15:00:00Z" } });
    expect(await stageCounts()).toEqual({ 0: 2 });
    expect((await listRecruits({ stage: "0" })).rows.map((r) => r.full_name).sort()).toEqual(["Casey Morgan", "No Phone"]);
    expect((await listRecruits({})).rows.every((r) => r.current_stage === 0)).toBe(true);

    await db.update(schema.recruit).set({ welcomeStatus: "sent" }).where(eq(schema.recruit.email, "casey@example.com"));
    expect(await stageCounts()).toEqual({ 0: 1, 1: 1 });
    expect((await listRecruits({ stage: "1" })).rows.map((r) => r.full_name)).toEqual(["Casey Morgan"]);
  });
});

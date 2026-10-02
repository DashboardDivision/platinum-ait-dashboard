process.env.PROVISION_FROM = "2026-10-03T00:00:00Z";
import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { resetDb } from "./helpers";
import { previewBackfill, provisionFromTwenty } from "@/server/provisioning";

const old = { name: "Pat Before", email: "pat@example.com", phone: "801-555-0142", createdAt: "2026-09-15T16:00:00Z" };

describe("records that predate go-live", () => {
  beforeEach(resetDb);

  it("are not enrolled by ordinary webhook events", async () => {
    const out = await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "old-1", eventId: "e-old", record: old });
    expect(out.dashboard).toBe("ignored");
    expect(await db.select().from(schema.recruit)).toHaveLength(0);
  });

  it("are previewed without writing anything, then enrolled quietly on apply", async () => {
    const preview = await previewBackfill("ws", [
      { recordId: "old-1", ...old },
      { recordId: "old-2", name: "No Phone", email: "np@example.com", phone: null, createdAt: old.createdAt },
      { recordId: "old-3", name: "Dropped", email: "d@example.com", phone: "8015550199", stage: "NOT_MOVING_FORWARD" },
    ]);
    expect(preview.map((p) => p.outcome)).toEqual(["would_enroll", "missing_information", "not_eligible"]);
    expect(await db.select().from(schema.recruit)).toHaveLength(0);

    const out = await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "old-1", eventId: "backfill:old-1", record: old, backfill: { sendWelcome: false } });
    expect(out.dashboard).toBe("ready");
    const [r] = await db.select().from(schema.recruit);
    expect(r.welcomeStatus).toBe("suppressed");
    expect(+r.enrollmentAt).toBe(+new Date(old.createdAt));
    expect((await db.select().from(schema.outbox)).filter((o) => o.eventType === "welcome")).toHaveLength(0);
  });
});

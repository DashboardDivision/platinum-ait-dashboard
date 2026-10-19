import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { provisionFromTwenty } from "@/server/provisioning";
import {
  meetingAttendanceFor, meetingSessions, recordMeetingClick, setMeetingAttendance, setMeetingSession, setTrainingModule, trainingModules,
} from "@/server/training";
import type { CurrentUser } from "@/server/session";

async function recruit() {
  await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "r1", eventId: "e1", record: { name: "Casey Morgan", email: "casey@example.com", phone: "801-555-0100", createdAt: "2026-10-06T15:00:00Z" } });
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.email, "casey@example.com"));
  return r;
}
const asRecruit = (userId: string): CurrentUser => ({ id: userId, email: "casey@example.com", name: "Casey", role: "recruit", impersonatedBy: null } as CurrentUser);

describe("Stage 5 training modules", () => {
  beforeEach(resetDb);

  it("admins check modules off and back on; the audit log keeps both", async () => {
    const r = await recruit();
    expect((await trainingModules(r.id)).done).toBe(0);
    await setTrainingModule("admin-1", r.id, "intro_meeting", true);
    await setTrainingModule("admin-1", r.id, "intro_meeting", true); // idempotent
    await setTrainingModule("admin-1", r.id, "momentum_training", true);
    let t = await trainingModules(r.id);
    expect(t.done).toBe(2);
    expect(t.modules.find((m) => m.key === "intro_meeting")!.completedAt).toBeInstanceOf(Date);
    await setTrainingModule("admin-1", r.id, "intro_meeting", false);
    t = await trainingModules(r.id);
    expect(t.done).toBe(1);
    const audits = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.targetId, r.id));
    expect(audits.filter((a) => a.action.startsWith("training_module.")).map((a) => a.action).sort())
      .toEqual(["training_module.completed", "training_module.completed", "training_module.uncompleted"]);
  });

  it("rejects unknown modules and recruits", async () => {
    const r = await recruit();
    await expect(setTrainingModule("admin-1", r.id, "nope", true)).rejects.toThrow(/Unknown training module/);
    await expect(setTrainingModule("admin-1", "00000000-0000-0000-0000-000000000000", "intro_meeting", true)).rejects.toThrow(/not found/);
  });
});

describe("monthly meetings", () => {
  beforeEach(resetDb);

  it("admin posts a link, the recruit's Join click is recorded but is not attendance, admin marks attendance", async () => {
    const r = await recruit();
    const now = new Date("2026-10-19T16:00:00Z");
    const u = asRecruit(r.userId!);
    await expect(recordMeetingClick(u, "agency_meeting", now)).rejects.toThrow(/hasn't been posted/);
    await setMeetingSession("admin-1", "2026-10", "agency_meeting", "https://zoom.us/j/123", "2026-10-22T09:00");
    const [s] = (await meetingSessions(["2026-10"])).filter((x) => x.key === "agency_meeting");
    expect(s.joinUrl).toBe("https://zoom.us/j/123");
    expect(s.startsAt!.toISOString()).toBe("2026-10-22T15:00:00.000Z");

    expect(await recordMeetingClick(u, "agency_meeting", now)).toBe("https://zoom.us/j/123");
    let a = (await meetingAttendanceFor([r.id], ["2026-10"])).get(r.id)!;
    const agency = a.find((x) => x.key === "agency_meeting")!;
    expect(agency.clickedAt).toEqual(now);
    expect(agency.attended).toBeNull();

    await setMeetingAttendance("admin-1", r.id, "2026-10", "agency_meeting", true);
    await setMeetingAttendance("admin-1", r.id, "2026-10", "ait_checkin_training", false);
    a = (await meetingAttendanceFor([r.id], ["2026-10"])).get(r.id)!;
    expect(a.map((x) => [x.key, x.attended])).toEqual([["agency_meeting", true], ["ait_checkin_training", false]]);
    await setMeetingAttendance("admin-1", r.id, "2026-10", "ait_checkin_training", null);
    a = (await meetingAttendanceFor([r.id], ["2026-10"])).get(r.id)!;
    expect(a.find((x) => x.key === "ait_checkin_training")!.attended).toBeNull();
  });

  it("rejects non-https links and bad months, and clearing the link hides Join", async () => {
    await expect(setMeetingSession("admin-1", "2026-10", "agency_meeting", "http://zoom.us/j/1", "")).rejects.toThrow(/https/);
    await expect(setMeetingSession("admin-1", "2026-13", "agency_meeting", "https://zoom.us/j/1", "")).rejects.toThrow(/Unknown meeting/);
    const r = await recruit();
    await setMeetingSession("admin-1", "2026-10", "agency_meeting", "https://zoom.us/j/1", "");
    await setMeetingSession("admin-1", "2026-10", "agency_meeting", "", "");
    await expect(recordMeetingClick(asRecruit(r.userId!), "agency_meeting", new Date("2026-10-19T16:00:00Z"))).rejects.toThrow(/hasn't been posted/);
  });
});

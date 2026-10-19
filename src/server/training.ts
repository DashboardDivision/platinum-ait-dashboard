import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  cleanMeetingUrl, isMeetingKey, isMonthKey, isTrainingModuleKey, MONTHLY_MEETINGS, monthKey, TRAINING_MODULES, type MeetingKey,
} from "@/domain/training";
import { BUSINESS_TZ } from "@/domain/durations";
import { audit } from "./audit";
import { actorKind, HttpError, type CurrentUser } from "./session";

/* ---------- Stage 5 training modules ---------- */

export type TrainingModuleView = { key: string; label: string; completedAt: Date | null };

export async function trainingModules(recruitId: string): Promise<{ modules: TrainingModuleView[]; done: number; total: number }> {
  const rows = await db.select().from(schema.trainingModuleCompletion).where(eq(schema.trainingModuleCompletion.recruitId, recruitId));
  const at = new Map(rows.map((r) => [r.moduleKey, r.completedAt]));
  const modules = TRAINING_MODULES.map((m) => ({ key: m.key, label: m.label, completedAt: at.get(m.key) ?? null }));
  return { modules, done: modules.filter((m) => m.completedAt).length, total: modules.length };
}

/** Admin check / uncheck. Idempotent: checking twice keeps the first completion time. */
export async function setTrainingModule(adminUserId: string, recruitId: string, moduleKey: string, done: boolean) {
  if (!isTrainingModuleKey(moduleKey)) throw new HttpError(400, "Unknown training module");
  await db.transaction(async (tx) => {
    const [r] = await tx.select({ id: schema.recruit.id }).from(schema.recruit).where(eq(schema.recruit.id, recruitId));
    if (!r) throw new HttpError(404, "Recruit not found");
    const where = and(eq(schema.trainingModuleCompletion.recruitId, recruitId), eq(schema.trainingModuleCompletion.moduleKey, moduleKey));
    const [existing] = await tx.select().from(schema.trainingModuleCompletion).where(where);
    if (done === Boolean(existing)) return;
    if (done) await tx.insert(schema.trainingModuleCompletion).values({ recruitId, moduleKey, completedByUserId: adminUserId });
    else await tx.delete(schema.trainingModuleCompletion).where(where);
    await audit(tx, {
      actorUserId: adminUserId, action: done ? "training_module.completed" : "training_module.uncompleted", targetType: "recruit", targetId: recruitId,
      metadata: { module: moduleKey, ...(existing ? { previouslyCompletedAt: existing.completedAt.toISOString() } : {}) },
    });
  });
}

/* ---------- monthly meetings ---------- */

export type MeetingSessionView = { key: MeetingKey; label: string; month: string; joinUrl: string | null; startsAt: Date | null };

export async function meetingSessions(months: string[]): Promise<MeetingSessionView[]> {
  const rows = months.length ? await db.select().from(schema.meetingSession).where(inArray(schema.meetingSession.month, months)) : [];
  return months.flatMap((month) => MONTHLY_MEETINGS.map((m) => {
    const row = rows.find((r) => r.month === month && r.meetingKey === m.key);
    return { key: m.key, label: m.label, month, joinUrl: row?.joinUrl ?? null, startsAt: row?.startsAt ?? null };
  }));
}

/** Admin sets (or clears) the join link and optional start time for one month's meeting. */
export async function setMeetingSession(adminUserId: string, month: string, meetingKey: string, rawUrl: string, startsAtLocal: string) {
  if (!isMonthKey(month) || !isMeetingKey(meetingKey)) throw new HttpError(400, "Unknown meeting");
  let joinUrl: string | null;
  try { joinUrl = cleanMeetingUrl(rawUrl); } catch (e) { throw new HttpError(400, (e as Error).message); }
  let startsAt: Date | null = null;
  if (startsAtLocal.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startsAtLocal.trim())) throw new HttpError(400, "Pick a date and time.");
    startsAt = denverLocalToDate(startsAtLocal.trim());
    if (!startsAt) throw new HttpError(400, "Pick a real date and time.");
  }
  await db.transaction(async (tx) => {
    await tx.insert(schema.meetingSession).values({ month, meetingKey, joinUrl, startsAt, updatedByUserId: adminUserId })
      .onConflictDoUpdate({ target: [schema.meetingSession.month, schema.meetingSession.meetingKey], set: { joinUrl, startsAt, updatedByUserId: adminUserId, updatedAt: new Date() } });
    // Host only: meeting links often carry a passcode (?pwd=), and audit metadata never holds secrets.
    const link = joinUrl ? { host: new URL(joinUrl).host, hasQuery: new URL(joinUrl).search !== "" } : null;
    await audit(tx, { actorUserId: adminUserId, action: "meeting.link_set", targetType: "meeting", targetId: `${month}:${meetingKey}`, metadata: { link, startsAt: startsAt?.toISOString() ?? null } });
  });
}

export type AttendanceView = { month: string; key: MeetingKey; attended: boolean | null; markedAt: Date | null; clickedAt: Date | null };

/** Attendance (admin-marked) and the recruit's own link clicks for the given months. */
export async function meetingAttendanceFor(recruitIds: string[], months: string[]) {
  if (!recruitIds.length || !months.length) return new Map<string, AttendanceView[]>();
  const [marks, clicks] = await Promise.all([
    db.select().from(schema.meetingAttendance).where(and(inArray(schema.meetingAttendance.recruitId, recruitIds), inArray(schema.meetingAttendance.month, months))),
    db.select().from(schema.activityEvent).where(and(inArray(schema.activityEvent.recruitId, recruitIds), eq(schema.activityEvent.type, "meeting_link_click"), eq(schema.activityEvent.actorKind, "recruit"))),
  ]);
  const out = new Map<string, AttendanceView[]>();
  for (const id of recruitIds) {
    out.set(id, months.flatMap((month) => MONTHLY_MEETINGS.map((m) => {
      const mark = marks.find((a) => a.recruitId === id && a.month === month && a.meetingKey === m.key);
      const click = clicks.filter((c) => c.recruitId === id && c.metadata?.month === month && c.metadata?.meeting === m.key)
        .sort((x, y) => +x.at - +y.at)[0];
      return { month, key: m.key, attended: mark ? mark.attended : null, markedAt: mark?.markedAt ?? null, clickedAt: click?.at ?? null };
    })));
  }
  return out;
}

/** Admin marks attended / not attended, or clears the mark (attended = null). */
export async function setMeetingAttendance(adminUserId: string, recruitId: string, month: string, meetingKey: string, attended: boolean | null) {
  if (!isMonthKey(month) || !isMeetingKey(meetingKey)) throw new HttpError(400, "Unknown meeting");
  await db.transaction(async (tx) => {
    const [r] = await tx.select({ id: schema.recruit.id }).from(schema.recruit).where(eq(schema.recruit.id, recruitId));
    if (!r) throw new HttpError(404, "Recruit not found");
    const where = and(eq(schema.meetingAttendance.recruitId, recruitId), eq(schema.meetingAttendance.month, month), eq(schema.meetingAttendance.meetingKey, meetingKey));
    if (attended === null) await tx.delete(schema.meetingAttendance).where(where);
    else await tx.insert(schema.meetingAttendance).values({ recruitId, month, meetingKey, attended, markedByUserId: adminUserId })
      .onConflictDoUpdate({ target: [schema.meetingAttendance.recruitId, schema.meetingAttendance.month, schema.meetingAttendance.meetingKey], set: { attended, markedByUserId: adminUserId, markedAt: new Date() } });
    await audit(tx, { actorUserId: adminUserId, action: "meeting.attendance_set", targetType: "recruit", targetId: recruitId, metadata: { month, meeting: meetingKey, attended } });
  });
}

/** Recruit clicked this month's "Join" button: records the click and returns the link. A click is not attendance. */
export async function recordMeetingClick(u: CurrentUser, meetingKey: string, now = new Date()) {
  if (!isMeetingKey(meetingKey)) throw new HttpError(404, "Not found.");
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.userId, u.id));
  if (!r) throw new HttpError(404, "No recruit record");
  const month = monthKey(now);
  const [session] = await db.select().from(schema.meetingSession).where(and(eq(schema.meetingSession.month, month), eq(schema.meetingSession.meetingKey, meetingKey)));
  if (!session?.joinUrl) throw new HttpError(409, "The link for this meeting hasn't been posted yet.");
  const kind = actorKind(u);
  await db.transaction(async (tx) => {
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "meeting_link_click", actorKind: kind, actorUserId: u.id, impersonatorUserId: u.impersonatedBy, at: now, metadata: { month, meeting: meetingKey } });
    if (kind === "recruit") await tx.update(schema.recruit).set({ lastActivityAt: now }).where(eq(schema.recruit.id, r.id));
  });
  return session.joinUrl;
}

/** "2026-11-05T08:00" entered by an admin in Denver → the right instant, DST included; null for impossible dates. */
export function denverLocalToDate(local: string): Date | null {
  const guess = new Date(`${local}:00Z`);
  if (isNaN(+guess) || guess.toISOString().slice(0, 16) !== local) return null;
  const offsetMin = (d: Date) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, timeZoneName: "longOffset" }).formatToParts(d).find((x) => x.type === "timeZoneName")!.value;
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(p);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  };
  const first = new Date(+guess - offsetMin(guess) * 60_000);
  return new Date(+guess - offsetMin(first) * 60_000);
}

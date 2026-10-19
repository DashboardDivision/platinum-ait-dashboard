import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { completeStageTx, loadIntervals } from "./stages";
import { audit } from "./audit";
import { deriveState } from "@/domain/stages";
import { enqueue } from "./outbox";
import { examUrlFor, getSetting } from "./settings";
import { HttpError, type CurrentUser, actorKind } from "./session";

async function recruitFor(u: CurrentUser) {
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.userId, u.id));
  if (!r) throw new HttpError(404, "No recruit record");
  return r;
}

/** Records the study-link click (a click, not a confirmed visit) and returns the destination. */
export async function recordStudyClick(u: CurrentUser, educationUrl: string) {
  const r = await recruitFor(u);
  const kind = actorKind(u);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "study_link_click", actorKind: kind, actorUserId: u.id, impersonatorUserId: u.impersonatedBy, at: now });
    if (kind !== "recruit") return;
    await tx.update(schema.recruit).set({ firstStudyClickAt: r.firstStudyClickAt ?? now, lastActivityAt: now }).where(eq(schema.recruit.id, r.id));
  });
  return educationUrl;
}

/** "I'm ready to schedule my exam": self-reported readiness after a recorded study click. Completes Stage 2. */
export async function markReadyToSchedule(u: CurrentUser) {
  if (u.impersonatedBy) throw new HttpError(403, "Stage actions aren't allowed while viewing as a recruit");
  const r = await recruitFor(u);
  if (!r.firstStudyClickAt) throw new HttpError(409, "Open the study materials first.");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(schema.recruit).set({ readyToScheduleAt: r.readyToScheduleAt ?? now, lastActivityAt: now }).where(eq(schema.recruit.id, r.id));
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "ready_to_schedule", actorKind: "recruit", actorUserId: u.id, at: now });
    await completeStageTx(tx, r.id, 2, now, { selfReported: true, firstStudyClickAt: r.firstStudyClickAt?.toISOString() }, u.id);
  });
}

/**
 * "Just kidding, I'm not ready": steps back one stage after an accidental click.
 * - Stage 3 -> 2 (undoes "I'm ready to schedule"), until the exam link is opened.
 * - Stage 4 -> 3 (undoes opening exam scheduling), until results or a license are uploaded.
 * The reopened stage is exactly as before; its completion email is cancelled if it hasn't gone out.
 */
export async function stepBackStage(u: CurrentUser): Promise<string> {
  if (u.impersonatedBy) throw new HttpError(403, "Stage actions aren't allowed while viewing as a recruit");
  const r = await recruitFor(u);
  const now = new Date();
  return db.transaction(async (tx) => {
    const current = deriveState(await loadIntervals(tx, r.id)).currentStage;
    if (current === 3 && r.examLinkClickedAt) {
      throw new HttpError(409, "You've already opened exam scheduling, so this can't be undone here. Use Need help? and Platinum can adjust it.");
    }
    if (current === 4) {
      const proof = await tx.select({ id: schema.document.id }).from(schema.document)
        .where(and(eq(schema.document.recruitId, r.id), inArray(schema.document.kind, ["exam_result", "license"]))).limit(1);
      if (proof.length) throw new HttpError(409, "You've already uploaded results, so this can't be undone here. Use Need help? and Platinum can adjust it.");
    }
    if (current !== 3 && current !== 4) throw new HttpError(409, "There's nothing to undo right now.");
    const back = current - 1;
    await tx.delete(schema.stageInterval).where(and(eq(schema.stageInterval.recruitId, r.id), eq(schema.stageInterval.stage, current), isNull(schema.stageInterval.completedAt)));
    const [prev] = await tx.select().from(schema.stageInterval)
      .where(and(eq(schema.stageInterval.recruitId, r.id), eq(schema.stageInterval.stage, back), isNotNull(schema.stageInterval.completedAt)))
      .orderBy(desc(schema.stageInterval.completedAt)).limit(1);
    if (!prev) throw new HttpError(409, "There's nothing to undo right now.");
    await tx.update(schema.stageInterval).set({ completedAt: null, evidence: null }).where(eq(schema.stageInterval.id, prev.id));
    await tx.update(schema.recruit)
      .set(back === 2 ? { readyToScheduleAt: null, lastActivityAt: now } : { examLinkClickedAt: null, lastActivityAt: now })
      .where(eq(schema.recruit.id, r.id));
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: back === 2 ? "ready_to_schedule_undone" : "exam_scheduling_undone", actorKind: "recruit", actorUserId: u.id, at: now });
    await tx.delete(schema.outbox).where(and(eq(schema.outbox.dedupeKey, `stage_completed:${r.id}:${back}`), eq(schema.outbox.status, "pending")));
    await audit(tx, { actorUserId: u.id, action: "stage.stepped_back", targetType: "recruit", targetId: r.id, metadata: { from: current, to: back } });
    return back === 2
      ? "No problem. Stage 2 is open again; keep studying and tell us when you're ready."
      : "No problem. Stage 3 is open again; schedule your exam when you're ready.";
  });
}

/**
 * Exam scheduling click. Must be a POST from the authenticated recruit, so link
 * previews, crawlers and prefetch can't trigger it. Completes Stage 3 once.
 */
export async function recordExamClick(u: CurrentUser): Promise<string> {
  const r = await recruitFor(u);
  const url = examUrlFor(await getSetting("examScheduling"), r.homeState);
  if (!url) throw new HttpError(409, "The exam scheduling link isn't set up yet. Use Need help? to reach Platinum.");
  const kind = actorKind(u);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "exam_link_click", actorKind: kind, actorUserId: u.id, impersonatorUserId: u.impersonatedBy, at: now, metadata: { url } });
    if (kind !== "recruit") return;
    const state = deriveState(await loadIntervals(tx, r.id));
    await tx.update(schema.recruit).set({ examLinkClickedAt: r.examLinkClickedAt ?? now, lastActivityAt: now }).where(eq(schema.recruit.id, r.id));
    if (state.currentStage === 3) await completeStageTx(tx, r.id, 3, now, { examLinkOpened: url, verifiedBooking: false }, u.id);
  });
  return url;
}

export async function saveExamDetails(u: CurrentUser, input: { examDate: string | null; confirmation: string | null; homeState: string | null }) {
  const r = await recruitFor(u);
  if (input.examDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.examDate)) throw new HttpError(400, "Enter the exam date as YYYY-MM-DD.");
  if (input.homeState && !/^[A-Za-z]{2}$/.test(input.homeState)) throw new HttpError(400, "Use a two-letter state code.");
  await db
    .update(schema.recruit)
    .set({ examDate: input.examDate || null, examBookingConfirmation: input.confirmation?.trim().slice(0, 120) || null, homeState: input.homeState?.toUpperCase() || r.homeState })
    .where(eq(schema.recruit.id, r.id));
}

/** Records the one-time training start after a verified contract. */
export async function startTraining(u: CurrentUser) {
  if (u.impersonatedBy) throw new HttpError(403, "Stage actions aren't allowed while viewing as a recruit");
  const r = await recruitFor(u);
  if (!r.contractSignedAt) throw new HttpError(409, "Your signed contract has to be verified first.");
  if (r.trainingStartedAt) return;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(schema.recruit).set({ trainingStartedAt: now, stage5Substatus: "in_training", lastActivityAt: now }).where(eq(schema.recruit.id, r.id));
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "training_started", actorKind: "recruit", actorUserId: u.id, at: now });
    await enqueue(tx, { eventType: "training_started", dedupeKey: `training_started:${r.id}`, recruitId: r.id });
  });
}

export async function requestHelp(u: CurrentUser, message: string) {
  const r = await recruitFor(u);
  const body = message.trim().slice(0, 2000);
  if (!body) throw new HttpError(400, "Tell us what you need help with.");
  await db.transaction(async (tx) => {
    const [t] = await tx.insert(schema.task).values({ recruitId: r.id, kind: "help_request", title: `Help request from ${r.fullName}`, body }).returning();
    await enqueue(tx, { eventType: "help_request", dedupeKey: `help:${t.id}`, recruitId: r.id, payload: { taskId: t.id } });
  });
}

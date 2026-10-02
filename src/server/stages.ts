import { and, eq, isNull } from "drizzle-orm";
import { schema, type DbOrTx } from "@/db";
import { completeStage, deriveState, type StageInterval, type StageNumber } from "@/domain/stages";
import { enqueue } from "./outbox";
import { audit } from "./audit";

export async function loadIntervals(tx: DbOrTx, recruitId: string): Promise<(StageInterval & { id: string })[]> {
  const rows = await tx.select().from(schema.stageInterval).where(eq(schema.stageInterval.recruitId, recruitId));
  return rows.map((r) => ({ id: r.id, stage: r.stage as StageNumber, enteredAt: r.enteredAt, completedAt: r.completedAt }));
}

export async function openFirstStage(tx: DbOrTx, recruitId: string, at: Date) {
  const existing = await loadIntervals(tx, recruitId);
  if (existing.length) return;
  await tx.insert(schema.stageInterval).values({ recruitId, stage: 1, enteredAt: at });
}

/**
 * Completes a stage if (and only if) it is the recruit's current stage.
 * Congratulations are deduped per recruit+stage, so a reopened stage that is
 * completed again does not replay them.
 */
export async function completeStageTx(
  tx: DbOrTx,
  recruitId: string,
  stage: StageNumber,
  at: Date,
  evidence: Record<string, unknown>,
  actorUserId: string | null,
) {
  const intervals = await loadIntervals(tx, recruitId);
  const t = completeStage(intervals, stage, at);
  if (t.kind === "noop") return { advanced: false as const, reason: t.reason };
  await tx
    .update(schema.stageInterval)
    .set({ completedAt: at, evidence })
    .where(and(eq(schema.stageInterval.id, (t.close as { id: string }).id), isNull(schema.stageInterval.completedAt)));
  if (t.open) await tx.insert(schema.stageInterval).values({ recruitId, stage: t.open.stage, enteredAt: at });
  if (stage === 4) {
    await tx.update(schema.recruit).set({ stage5Substatus: "awaiting_contract" }).where(eq(schema.recruit.id, recruitId));
  }
  if (stage < 5) {
    await enqueue(tx, { eventType: "stage_completed", dedupeKey: `stage_completed:${recruitId}:${stage}`, recruitId, payload: { stage } });
  }
  await audit(tx, { actorUserId, action: "stage.completed", targetType: "recruit", targetId: recruitId, metadata: { stage, evidence } });
  return { advanced: true as const };
}

/** Admin correction: reopen a completed stage as a new interval; history is kept. */
export async function reopenStageTx(tx: DbOrTx, recruitId: string, stage: StageNumber, actorUserId: string, reason: string) {
  if (!reason.trim()) throw new Error("A reason is required");
  const intervals = await loadIntervals(tx, recruitId);
  const state = deriveState(intervals);
  const now = new Date();
  const open = intervals.find((i) => !i.completedAt);
  if (open) {
    if (open.stage === stage) return;
    // Close the currently open interval at the correction time; it stays in history.
    await tx.delete(schema.stageInterval).where(and(eq(schema.stageInterval.id, open.id), isNull(schema.stageInterval.completedAt)));
    await tx.insert(schema.stageInterval).values({ recruitId, stage: open.stage, enteredAt: open.enteredAt, completedAt: now, reopenReason: `superseded by reopen of stage ${stage}`, actorUserId });
  }
  await tx.insert(schema.stageInterval).values({ recruitId, stage, enteredAt: now, reopenReason: reason, actorUserId });
  await audit(tx, { actorUserId, action: "stage.reopened", targetType: "recruit", targetId: recruitId, reason, metadata: { stage, from: state.currentStage } });
}

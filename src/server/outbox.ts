import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/db";

export type OutboxEventType =
  | "welcome"
  | "stage_completed"
  | "milestones_achieved"
  | "stage4_admin_followup"
  | "contract_sent"
  | "contract_reminder"
  | "contract_signed"
  | "training_started"
  | "reimbursement_updated"
  | "inactivity_reminder"
  | "admin_alert"
  | "help_request"
  | "password_reset_by_admin"
  | "first_study_click"
  | "agent_welcome"
  | "agent_step_completed"
  | "staff_welcome"
  | "login_email_changed";

/**
 * Written in the same transaction as the state change it describes. The dedupe
 * key makes replays, retries and corrections idempotent.
 */
export async function enqueue(tx: DbOrTx, e: { eventType: OutboxEventType; dedupeKey: string; recruitId?: string | null; payload?: Record<string, unknown> }) {
  const rows = await tx
    .insert(schema.outbox)
    .values({ eventType: e.eventType, dedupeKey: e.dedupeKey, recruitId: e.recruitId ?? null, payload: e.payload ?? {} })
    .onConflictDoNothing({ target: schema.outbox.dedupeKey })
    .returning({ id: schema.outbox.id });
  return rows[0]?.id ?? null;
}

const CLAIM_TIMEOUT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;

/** n8n claims a batch; claimed rows that never report back become claimable again. */
export async function claimBatch(limit = 20) {
  return db.transaction(async (tx) => {
    const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    const rows = await tx.execute<{ id: string }>(sql`
      select id from ${schema.outbox}
      where (status = 'pending' and available_at <= now())
         or (status = 'claimed' and claimed_at < ${staleBefore})
      order by created_at
      limit ${limit}
      for update skip locked`);
    const ids = rows.rows.map((r) => r.id);
    if (!ids.length) return [];
    return tx
      .update(schema.outbox)
      .set({ status: "claimed", claimedAt: new Date(), attempts: sql`${schema.outbox.attempts} + 1` })
      .where(inArray(schema.outbox.id, ids))
      .returning();
  });
}

export async function completeOutbox(id: string, ok: boolean, error?: string) {
  const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.id, id));
  if (!row) return null;
  if (ok) {
    await db.update(schema.outbox).set({ status: "done", lastError: null }).where(eq(schema.outbox.id, id));
    return "done";
  }
  const exhausted = row.attempts >= MAX_ATTEMPTS;
  const backoffMs = Math.min(6 * 3_600_000, 60_000 * 2 ** row.attempts);
  await db
    .update(schema.outbox)
    .set({
      status: exhausted ? "failed" : "pending",
      lastError: (error ?? "unknown error").slice(0, 500),
      availableAt: new Date(Date.now() + backoffMs),
    })
    .where(and(eq(schema.outbox.id, id), eq(schema.outbox.status, "claimed")));
  return exhausted ? "failed" : "retry";
}

/** Only quiet-hours texts are left: wait for the window without spending a retry attempt. */
export async function deferToWindow(id: string, until: Date) {
  await db
    .update(schema.outbox)
    .set({ status: "pending", availableAt: until, attempts: sql`greatest(${schema.outbox.attempts} - 1, 0)` })
    .where(and(eq(schema.outbox.id, id), eq(schema.outbox.status, "claimed")));
}

export async function retryFailed(id: string) {
  await db.update(schema.outbox).set({ status: "pending", availableAt: new Date() }).where(and(eq(schema.outbox.id, id), eq(schema.outbox.status, "failed")));
}

export async function dueCount() {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.outbox).where(and(eq(schema.outbox.status, "pending"), lte(schema.outbox.availableAt, new Date())));
  return r?.n ?? 0;
}

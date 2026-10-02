import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Cents } from "@/domain/money";
import { audit } from "./audit";
import { enqueue } from "./outbox";
import { HttpError } from "./session";

/** Tracking and approval only. Nothing here moves money. */

export async function updateReimbursement(adminUserId: string, id: string, input: { testCostCents?: Cents | null; requestedCents?: Cents | null; approvedCents?: Cents | null; decision?: "approve" | "reject"; reason?: string | null }) {
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(schema.reimbursement).where(eq(schema.reimbursement.id, id)).for("update");
    if (!c) throw new HttpError(404, "Reimbursement not found");
    const patch: Partial<typeof schema.reimbursement.$inferInsert> = { reviewerUserId: adminUserId };
    if (input.testCostCents !== undefined) patch.testCostCents = input.testCostCents;
    if (input.requestedCents !== undefined) patch.requestedCents = input.requestedCents;
    if (input.decision === "approve") {
      const amount = input.approvedCents ?? input.requestedCents ?? c.requestedCents ?? input.testCostCents ?? c.testCostCents;
      if (amount == null || amount <= 0) throw new HttpError(400, "Enter the approved amount");
      patch.approvedCents = amount;
      patch.status = "approved";
    }
    if (input.decision === "reject") {
      if (!input.reason?.trim()) throw new HttpError(400, "A reason is required");
      patch.status = "rejected";
    }
    await tx.update(schema.reimbursement).set(patch).where(eq(schema.reimbursement.id, id));
    await audit(tx, { actorUserId: adminUserId, action: "reimbursement.update", targetType: "reimbursement", targetId: id, reason: input.reason ?? null, metadata: { ...input, reason: undefined } });
    if (input.decision) await enqueue(tx, { eventType: "reimbursement_updated", dedupeKey: `reimb:${id}:${patch.status}`, recruitId: c.recruitId, payload: { status: patch.status } });
  });
}

/** Records a payment made outside the app. Duplicate payment references are rejected. */
export async function recordReimbursementPayment(adminUserId: string, id: string, amountCents: Cents, paidOn: string, paymentRef: string, note?: string) {
  if (!paymentRef.trim()) throw new HttpError(400, "A payment reference is required");
  if (!Number.isInteger(amountCents) || amountCents === 0) throw new HttpError(400, "Enter a non-zero amount in cents");
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(schema.reimbursement).where(eq(schema.reimbursement.id, id)).for("update");
    if (!c) throw new HttpError(404, "Reimbursement not found");
    if (c.status !== "approved" && c.status !== "partially_paid" && c.status !== "paid") throw new HttpError(409, "Approve the reimbursement before recording a payment");
    const inserted = await tx.insert(schema.reimbursementPayment).values({ reimbursementId: id, amountCents, paidAt: new Date(`${paidOn}T12:00:00-07:00`), paymentRef: paymentRef.trim(), actorUserId: adminUserId, note }).onConflictDoNothing().returning();
    if (!inserted.length) throw new HttpError(409, "That payment reference is already recorded");
    const [{ paid }] = await tx.select({ paid: sql<number>`coalesce(sum(${schema.reimbursementPayment.amountCents}),0)::bigint` }).from(schema.reimbursementPayment).where(eq(schema.reimbursementPayment.reimbursementId, id));
    const paidNum = Number(paid);
    if (c.approvedCents != null && paidNum > c.approvedCents) throw new HttpError(409, "Payments would exceed the approved amount");
    const status = paidNum <= 0 ? "approved" : c.approvedCents != null && paidNum >= c.approvedCents ? "paid" : "partially_paid";
    await tx.update(schema.reimbursement).set({ status }).where(eq(schema.reimbursement.id, id));
    await audit(tx, { actorUserId: adminUserId, action: "reimbursement.payment", targetType: "reimbursement", targetId: id, metadata: { amountCents, paymentRef } });
    await enqueue(tx, { eventType: "reimbursement_updated", dedupeKey: `reimb:${id}:pay:${paymentRef}`, recruitId: c.recruitId, payload: { status } });
  });
}

export async function createPayout(adminUserId: string, input: { recruitId: string; payoutType: string; periodLabel?: string | null; amountCents: Cents; basis?: string | null; policyIds?: string[] }) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(400, "Enter a positive amount");
  const [p] = await db.insert(schema.payout).values({ ...input, status: "pending" }).returning();
  await audit(db, { actorUserId: adminUserId, action: "payout.create", targetType: "payout", targetId: p.id, metadata: { amountCents: input.amountCents } });
  return p;
}

export async function setPayoutStatus(adminUserId: string, id: string, status: "approved" | "paid", paymentRef?: string, paidOn?: string) {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(schema.payout).where(eq(schema.payout.id, id)).for("update");
    if (!p) throw new HttpError(404, "Payout not found");
    if (p.status === "reversed") throw new HttpError(409, "Reversed payouts can't change");
    if (status === "paid") {
      if (p.status !== "approved") throw new HttpError(409, "Approve the payout first");
      if (!paymentRef?.trim()) throw new HttpError(400, "A payment reference is required");
      await tx.update(schema.payout).set({ status, paymentRef, paidAt: paidOn ? new Date(`${paidOn}T12:00:00-07:00`) : new Date() }).where(eq(schema.payout.id, id));
    } else await tx.update(schema.payout).set({ status, approvedByUserId: adminUserId }).where(eq(schema.payout.id, id));
    await audit(tx, { actorUserId: adminUserId, action: `payout.${status}`, targetType: "payout", targetId: id });
  });
}

/** Paid history is never deleted: a reversal is a new negative entry. */
export async function reversePayout(adminUserId: string, id: string, reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required");
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(schema.payout).where(eq(schema.payout.id, id)).for("update");
    if (!p || p.status === "reversed") throw new HttpError(409, "Nothing to reverse");
    await tx.update(schema.payout).set({ status: "reversed" }).where(eq(schema.payout.id, id));
    await tx.insert(schema.payout).values({ recruitId: p.recruitId, payoutType: `${p.payoutType} (reversal)`, periodLabel: p.periodLabel, amountCents: -p.amountCents, basis: reason, status: "reversed", reversesPayoutId: p.id, approvedByUserId: adminUserId });
    await audit(tx, { actorUserId: adminUserId, action: "payout.reverse", targetType: "payout", targetId: id, reason });
  });
}

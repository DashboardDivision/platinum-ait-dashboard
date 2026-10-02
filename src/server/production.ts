import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/db";
import { annualize, type Cents } from "@/domain/money";
import { belowAchievedThreshold, MILESTONES, newlyReachedMilestones } from "@/domain/milestones";
import { qualifyingPremium, type PolicyForCredit } from "@/domain/premium";
import { completeStageTx } from "./stages";
import { enqueue } from "./outbox";
import { audit } from "./audit";
import { HttpError } from "./session";

export type PolicyInput = {
  recruitId: string;
  source: "momentum" | "admin" | "recruit" | "csv";
  externalRef: string;
  policyType: string;
  carrier?: string | null;
  businessType: "new" | "renewal" | "rewrite" | "endorsement" | "quote";
  writtenDate: string; // YYYY-MM-DD
  effectiveDate?: string | null;
  termMonths?: number | null;
  termPremiumCents?: Cents | null;
  annualizedCents?: Cents | null; // authoritative, e.g. from Momentum
  status?: "pending" | "approved";
};

export function validatePolicy(p: PolicyInput) {
  if (!p.externalRef.trim()) return "Policy reference is required";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.writtenDate)) return "Written date must be YYYY-MM-DD";
  const a = annualize({ termMonths: p.termMonths ?? null, termPremiumCents: p.termPremiumCents ?? null, authoritativeAnnualizedCents: p.annualizedCents ?? null });
  if (!a.ok) return a.reason;
  if (a.annualizedCents < 0) return "Premium can't be negative; record a cancellation instead";
  return null;
}

/**
 * Insert or update by (source, externalRef) so repeated imports and syncs never
 * duplicate policies. Approved records keep their approval unless the source changes the premium.
 */
export async function upsertPolicy(p: PolicyInput, actorUserId: string | null) {
  const problem = validatePolicy(p);
  if (problem) throw new HttpError(400, problem);
  const a = annualize({ termMonths: p.termMonths ?? null, termPremiumCents: p.termPremiumCents ?? null, authoritativeAnnualizedCents: p.annualizedCents ?? null });
  if (!a.ok) throw new HttpError(400, a.reason);
  const values = {
    recruitId: p.recruitId,
    source: p.source,
    externalRef: p.externalRef.trim(),
    policyType: p.policyType,
    carrier: p.carrier ?? null,
    businessType: p.businessType,
    writtenDate: new Date(`${p.writtenDate}T00:00:00Z`),
    effectiveDate: p.effectiveDate ? new Date(`${p.effectiveDate}T00:00:00Z`) : null,
    termMonths: p.termMonths ?? null,
    termPremiumCents: p.termPremiumCents ?? null,
    annualizedCents: a.annualizedCents,
    annualizedSource: a.source,
    status: p.status ?? "pending",
    submittedByUserId: actorUserId,
  };
  const [row] = await db
    .insert(schema.policy)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.policy.source, schema.policy.externalRef],
      set: {
        policyType: values.policyType,
        carrier: values.carrier,
        businessType: values.businessType,
        writtenDate: values.writtenDate,
        effectiveDate: values.effectiveDate,
        termMonths: values.termMonths,
        termPremiumCents: values.termPremiumCents,
        annualizedCents: values.annualizedCents,
        annualizedSource: values.annualizedSource,
        updatedAt: new Date(),
      },
    })
    .returning();
  await recomputeProduction(p.recruitId);
  return row;
}

export async function reviewPolicy(adminUserId: string, policyId: string, decision: "approved" | "rejected" | "duplicate", reason: string | null) {
  const [p] = await db.select().from(schema.policy).where(eq(schema.policy.id, policyId));
  if (!p) throw new HttpError(404, "Policy not found");
  await db.transaction(async (tx) => {
    await tx.update(schema.policy).set({ status: decision, reviewedByUserId: adminUserId, reviewedAt: new Date(), reviewReason: reason }).where(eq(schema.policy.id, p.id));
    await audit(tx, { actorUserId: adminUserId, action: `policy.${decision}`, targetType: "policy", targetId: p.id, reason, metadata: { recruitId: p.recruitId, annualizedCents: p.annualizedCents } });
  });
  await recomputeProduction(p.recruitId);
}

/** Cancellations, reversals and corrections are compensating entries; the original record stays. */
export async function adjustPolicy(actorUserId: string | null, policyId: string, kind: "cancellation" | "reversal" | "correction", deltaCents: Cents, reason: string, externalRef?: string | null) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required");
  if (!Number.isInteger(deltaCents)) throw new HttpError(400, "Amount must be whole cents");
  const [p] = await db.select().from(schema.policy).where(eq(schema.policy.id, policyId));
  if (!p) throw new HttpError(404, "Policy not found");
  await db.transaction(async (tx) => {
    await tx.insert(schema.policyAdjustment).values({ policyId, kind, deltaCents, reason, externalRef: externalRef ?? null, actorUserId }).onConflictDoNothing();
    if (kind === "cancellation" && p.status === "approved") await tx.update(schema.policy).set({ status: "cancelled" }).where(eq(schema.policy.id, p.id));
    await audit(tx, { actorUserId, action: `policy.${kind}`, targetType: "policy", targetId: p.id, reason, metadata: { deltaCents } });
  });
  await recomputeProduction(p.recruitId);
}

export async function productionFor(tx: DbOrTx, recruitId: string) {
  const [r] = await tx.select().from(schema.recruit).where(eq(schema.recruit.id, recruitId));
  if (!r) throw new HttpError(404, "Recruit not found");
  const policies = await tx.select().from(schema.policy).where(eq(schema.policy.recruitId, recruitId));
  const adj = policies.length
    ? await tx
        .select({ policyId: schema.policyAdjustment.policyId, total: sql<number>`sum(${schema.policyAdjustment.deltaCents})::bigint` })
        .from(schema.policyAdjustment)
        .where(inArray(schema.policyAdjustment.policyId, policies.map((p) => p.id)))
        .groupBy(schema.policyAdjustment.policyId)
    : [];
  const adjBy = new Map(adj.map((a) => [a.policyId, Number(a.total)]));
  const forCredit: PolicyForCredit[] = policies.map((p) => ({
    id: p.id,
    status: p.status as PolicyForCredit["status"],
    businessType: p.businessType as PolicyForCredit["businessType"],
    writtenDate: p.writtenDate,
    annualizedCents: p.annualizedCents,
    adjustmentsCents: adjBy.get(p.id) ?? 0,
    countsOverride: p.countsOverride,
  }));
  const window = { contractSignedAt: r.contractSignedAt, enrollmentAt: r.enrollmentAt, enrollmentEndedAt: r.enrollmentEndedAt };
  const q = qualifyingPremium(forCredit, window);
  return { recruit: r, policies, adjustmentsByPolicy: adjBy, ...q };
}

/**
 * Recalculates premium and records any newly reached milestones exactly once,
 * with one consolidated congratulation for thresholds crossed together.
 * Achievements are never removed; a drop below an achieved threshold is flagged.
 */
export async function recomputeProduction(recruitId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`production:${recruitId}`}))`);
    const prod = await productionFor(tx, recruitId);
    const r = prod.recruit;
    const achievedRows = await tx.select().from(schema.milestoneAchievement).where(eq(schema.milestoneAchievement.recruitId, recruitId));
    const achieved = new Set(achievedRows.map((a) => a.milestone));
    const snapshot = { qualifyingCents: prod.qualifyingCents, qualifyingPolicyCount: prod.contributingPolicyCount };
    const reached = r.contractSignedAt ? newlyReachedMilestones(snapshot, achieved) : [];
    const now = new Date();
    if (reached.length) {
      await tx.insert(schema.milestoneAchievement).values(reached.map((m) => ({ recruitId, milestone: m, achievedAt: now, premiumCentsAtAchievement: prod.qualifyingCents }))).onConflictDoNothing();
      await enqueue(tx, { eventType: "milestones_achieved", dedupeKey: `milestones:${recruitId}:${reached.join(",")}`, recruitId, payload: { milestones: reached, qualifyingCents: prod.qualifyingCents } });
      reached.forEach((m) => achieved.add(m));
      if (reached.includes("graduation") && !r.graduatedAt) {
        await tx.update(schema.recruit).set({ graduatedAt: now }).where(eq(schema.recruit.id, recruitId));
        await completeStageTx(tx, recruitId, 5, now, { graduation: true, qualifyingCents: prod.qualifyingCents }, null);
      }
    }
    const below = belowAchievedThreshold(snapshot, achieved);
    if (below !== r.premiumBelowThreshold) await tx.update(schema.recruit).set({ premiumBelowThreshold: below }).where(eq(schema.recruit.id, recruitId));
    return { ...snapshot, reached, below };
  });
}

export function milestoneLabel(key: string) {
  return MILESTONES.find((m) => m.key === key)?.label ?? key;
}

/** Momentum sync: map producer → recruit; unknown producers are reported, not guessed. */
export async function importMomentumPolicies(rows: (Omit<PolicyInput, "recruitId" | "source"> & { producerId: string; cancelled?: boolean; cancellationDeltaCents?: Cents | null })[]) {
  const producers = [...new Set(rows.map((r) => r.producerId))];
  const recruits = producers.length ? await db.select({ id: schema.recruit.id, producer: schema.recruit.momentumProducerId }).from(schema.recruit).where(inArray(schema.recruit.momentumProducerId, producers)) : [];
  const byProducer = new Map(recruits.map((r) => [r.producer!, r.id]));
  const result = { upserted: 0, unmatchedProducers: [] as string[], errors: [] as { ref: string; error: string }[] };
  for (const row of rows) {
    const recruitId = byProducer.get(row.producerId);
    if (!recruitId) {
      if (!result.unmatchedProducers.includes(row.producerId)) result.unmatchedProducers.push(row.producerId);
      continue;
    }
    try {
      // Momentum is the agency's system of record, so its policies arrive approved.
      const p = await upsertPolicy({ ...row, recruitId, source: "momentum", status: "approved" }, null);
      if (row.cancelled) await adjustPolicy(null, p.id, "cancellation", row.cancellationDeltaCents ?? -p.annualizedCents, "Cancelled in Momentum", `momentum-cancel:${row.externalRef}`);
      result.upserted++;
    } catch (err) {
      result.errors.push({ ref: row.externalRef, error: err instanceof Error ? err.message : "error" });
    }
  }
  return result;
}

export async function hasPolicy(source: string, ref: string) {
  const [p] = await db.select({ id: schema.policy.id }).from(schema.policy).where(and(eq(schema.policy.source, source), eq(schema.policy.externalRef, ref)));
  return Boolean(p);
}

import type { Cents } from "./money";

export const MILESTONES = [
  { key: "first_policy", label: "First Sale / First Policy Written", thresholdCents: null },
  { key: "premium_25k", label: "$25,000 Annualized Premium", thresholdCents: 2_500_000 },
  { key: "premium_50k", label: "$50,000 Annualized Premium", thresholdCents: 5_000_000 },
  { key: "premium_100k", label: "$100,000 Annualized Premium", thresholdCents: 10_000_000 },
  { key: "premium_200k", label: "$200,000 Annualized Premium", thresholdCents: 20_000_000 },
  { key: "graduation", label: "GRADUATION: $250,000 Annualized Premium", thresholdCents: 25_000_000 },
] as const;

export type MilestoneKey = (typeof MILESTONES)[number]["key"];
export const GRADUATION_CENTS: Cents = 25_000_000;

export type ProductionSnapshot = {
  qualifyingCents: Cents;
  qualifyingPolicyCount: number;
};

/**
 * Returns milestones newly reached. Achievements already recorded are never
 * removed or re-issued, even if premium later drops below a threshold.
 */
export function newlyReachedMilestones(snapshot: ProductionSnapshot, alreadyAchieved: ReadonlySet<string>): MilestoneKey[] {
  const reached: MilestoneKey[] = [];
  for (const m of MILESTONES) {
    if (alreadyAchieved.has(m.key)) continue;
    const hit = m.thresholdCents == null ? snapshot.qualifyingPolicyCount >= 1 : snapshot.qualifyingCents >= m.thresholdCents;
    if (hit) reached.push(m.key);
  }
  return reached;
}

/** Highest achieved premium threshold that current premium no longer supports (for the review flag). */
export function belowAchievedThreshold(snapshot: ProductionSnapshot, alreadyAchieved: ReadonlySet<string>): MilestoneKey | null {
  let flagged: MilestoneKey | null = null;
  for (const m of MILESTONES) {
    if (!alreadyAchieved.has(m.key)) continue;
    const below = m.thresholdCents == null ? snapshot.qualifyingPolicyCount < 1 : snapshot.qualifyingCents < m.thresholdCents;
    if (below) flagged = m.key;
  }
  return flagged;
}

export function nextTarget(qualifyingCents: Cents, achieved: ReadonlySet<string>) {
  const next = MILESTONES.find((m) => !achieved.has(m.key));
  if (!next) return null;
  const remainingCents = next.thresholdCents == null ? 0 : Math.max(0, next.thresholdCents - qualifyingCents);
  return { key: next.key, label: next.label, thresholdCents: next.thresholdCents, remainingCents };
}

/** Percent toward graduation for the progress bar: capped at 100 while the true total is shown separately. */
export function graduationPercent(qualifyingCents: Cents): number {
  if (qualifyingCents <= 0) return 0;
  return Math.min(100, Math.floor((qualifyingCents / GRADUATION_CENTS) * 1000) / 10);
}

import type { Cents } from "./money";

export type PolicyForCredit = {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "duplicate";
  businessType: "new" | "renewal" | "rewrite" | "endorsement" | "quote";
  writtenDate: Date;
  annualizedCents: Cents;
  /** Sum of approved adjustments (cancellations, reversals, corrections); negative reduces credit. */
  adjustmentsCents: Cents;
  countsOverride?: boolean | null;
};

export type CreditWindow = {
  contractSignedAt: Date | null;
  enrollmentAt: Date;
  enrollmentEndedAt: Date | null;
};

/**
 * Platinum rule (decided 2026-10-02): approved new business written during the
 * AIT enrollment and after contract signing counts, net of approved
 * cancellations and corrections. Renewals, quotes, rejected and duplicate
 * records are excluded. Rewrites/endorsements count only by explicit admin override.
 */
/** Calendar date in the business timezone; policy written dates are calendar dates. */
function denverDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function policyCounts(policy: PolicyForCredit, window: CreditWindow): boolean {
  if (!window.contractSignedAt) return false;
  if (policy.status !== "approved" && policy.status !== "cancelled") return false;
  const written = policy.writtenDate.toISOString().slice(0, 10);
  // Day granularity in America/Denver: business written on the signing day counts.
  if (written < denverDay(window.contractSignedAt)) return false;
  if (written < denverDay(window.enrollmentAt)) return false;
  if (window.enrollmentEndedAt && written > denverDay(window.enrollmentEndedAt)) return false;
  if (policy.countsOverride != null) return policy.countsOverride;
  return policy.businessType === "new";
}

export function qualifyingPremium(policies: PolicyForCredit[], window: CreditWindow) {
  let totalCents = 0;
  let contributing = 0;
  for (const p of policies) {
    if (!policyCounts(p, window)) continue;
    const net = Math.max(0, p.annualizedCents + p.adjustmentsCents);
    totalCents += net;
    if (net > 0) contributing += 1;
  }
  return { qualifyingCents: totalCents, contributingPolicyCount: contributing };
}

/** All money is integer cents. */
export type Cents = number;

export function dollarsToCents(input: string | number): Cents {
  const text = String(input).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error(`Invalid money amount: ${input}`);
  const negative = text.startsWith("-");
  const [whole, frac = ""] = text.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function formatCents(cents: Cents, opts: { whole?: boolean } = {}): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: opts.whole ? 0 : 2,
    maximumFractionDigits: opts.whole ? 0 : 2,
  }).format(cents / 100);
}

export type AnnualizeInput = {
  termMonths: number | null;
  termPremiumCents: Cents | null;
  /** An authoritative annualized value (e.g. from Momentum) always wins and is never re-annualized. */
  authoritativeAnnualizedCents?: Cents | null;
};

export type AnnualizeResult =
  | { ok: true; annualizedCents: Cents; source: "authoritative" | "calculated" }
  | { ok: false; reason: string };

/**
 * 6-month term: annualized = 2 x full-term premium. 12-month term: annualized = term premium.
 * Other terms need a validated annualized input; we refuse to guess.
 */
export function annualize(input: AnnualizeInput): AnnualizeResult {
  if (input.authoritativeAnnualizedCents != null) {
    if (!Number.isInteger(input.authoritativeAnnualizedCents)) return { ok: false, reason: "Annualized premium must be whole cents" };
    return { ok: true, annualizedCents: input.authoritativeAnnualizedCents, source: "authoritative" };
  }
  if (input.termPremiumCents == null || input.termMonths == null) return { ok: false, reason: "Term and term premium are required" };
  if (!Number.isInteger(input.termPremiumCents)) return { ok: false, reason: "Term premium must be whole cents" };
  if (input.termMonths === 6) return { ok: true, annualizedCents: input.termPremiumCents * 2, source: "calculated" };
  if (input.termMonths === 12) return { ok: true, annualizedCents: input.termPremiumCents, source: "calculated" };
  return { ok: false, reason: `A ${input.termMonths}-month term needs an annualized premium entered directly` };
}

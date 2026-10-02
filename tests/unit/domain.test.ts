import { describe, expect, it } from "vitest";
import { starterPasswordFromPhone, isPhoneLikePassword } from "@/domain/phone";
import { normalizeEmail } from "@/domain/email";
import { annualize, dollarsToCents, formatCents } from "@/domain/money";
import { newlyReachedMilestones, belowAchievedThreshold, graduationPercent, nextTarget } from "@/domain/milestones";
import { qualifyingPremium, type PolicyForCredit } from "@/domain/premium";
import { completeStage, deriveState, stageDurationMs, type StageInterval } from "@/domain/stages";
import { formatDuration, withinSmsWindow } from "@/domain/durations";
import { csvCell, parseCsv } from "@/domain/csv";

describe("starter password from phone", () => {
  it.each([
    ["(385) 469-8200", "3854698200"],
    ["+1 385-469-8200", "3854698200"],
    ["1.385.469.8200", "3854698200"],
    ["385 469 8200", "3854698200"],
  ])("normalizes %s", (raw, want) => {
    const r = starterPasswordFromPhone(raw);
    expect(r.ok && r.starterPassword).toBe(want);
  });
  it("rejects missing, invalid and non-U.S. numbers without truncating", () => {
    expect(starterPasswordFromPhone("")).toEqual({ ok: false, reason: "missing" });
    expect(starterPasswordFromPhone("12345")).toEqual({ ok: false, reason: "invalid" });
    expect(starterPasswordFromPhone("+1 385-469-82001")).toEqual({ ok: false, reason: "invalid" });
    expect(starterPasswordFromPhone("+44 7911 123456")).toEqual({ ok: false, reason: "non_us" });
  });
  it("detects reuse of the phone number as a new password", () => {
    expect(isPhoneLikePassword("385-469-8200", "+13854698200")).toBe(true);
    expect(isPhoneLikePassword("13854698200", "+13854698200")).toBe(true);
    expect(isPhoneLikePassword("Blue-river-42", "+13854698200")).toBe(false);
  });
});

describe("email normalization", () => {
  it("trims and lowercases, rejects invalid", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("money and annualization", () => {
  it("parses dollars into integer cents without float error", () => {
    expect(dollarsToCents("$1,234.56")).toBe(123456);
    expect(dollarsToCents("0.1")).toBe(10);
    expect(dollarsToCents("-25")).toBe(-2500);
    expect(() => dollarsToCents("12.345")).toThrow();
    expect(formatCents(2500000, { whole: true })).toBe("$25,000");
  });
  it("doubles six-month terms, keeps twelve-month terms, refuses others", () => {
    expect(annualize({ termMonths: 6, termPremiumCents: 60000 })).toEqual({ ok: true, annualizedCents: 120000, source: "calculated" });
    expect(annualize({ termMonths: 12, termPremiumCents: 90000 })).toEqual({ ok: true, annualizedCents: 90000, source: "calculated" });
    expect(annualize({ termMonths: 3, termPremiumCents: 30000 }).ok).toBe(false);
  });
  it("never re-annualizes an authoritative annualized value", () => {
    expect(annualize({ termMonths: 6, termPremiumCents: 60000, authoritativeAnnualizedCents: 120000 })).toEqual({ ok: true, annualizedCents: 120000, source: "authoritative" });
  });
});

describe("milestones", () => {
  const none = new Set<string>();
  it("crosses several thresholds with one policy and records each once", () => {
    const hits = newlyReachedMilestones({ qualifyingCents: 6_000_000, qualifyingPolicyCount: 1 }, none);
    expect(hits).toEqual(["first_policy", "premium_25k", "premium_50k"]);
    const again = newlyReachedMilestones({ qualifyingCents: 6_000_000, qualifyingPolicyCount: 1 }, new Set(hits));
    expect(again).toEqual([]);
  });
  it("uses exact boundaries", () => {
    expect(newlyReachedMilestones({ qualifyingCents: 2_499_999, qualifyingPolicyCount: 3 }, new Set(["first_policy"]))).toEqual([]);
    expect(newlyReachedMilestones({ qualifyingCents: 2_500_000, qualifyingPolicyCount: 3 }, new Set(["first_policy"]))).toEqual(["premium_25k"]);
    expect(newlyReachedMilestones({ qualifyingCents: 25_000_000, qualifyingPolicyCount: 9 }, new Set(["first_policy", "premium_25k", "premium_50k", "premium_100k", "premium_200k"]))).toEqual(["graduation"]);
  });
  it("flags premium that falls below an achieved threshold without erasing it", () => {
    const achieved = new Set(["first_policy", "premium_25k", "premium_50k"]);
    expect(belowAchievedThreshold({ qualifyingCents: 4_000_000, qualifyingPolicyCount: 2 }, achieved)).toBe("premium_50k");
    expect(newlyReachedMilestones({ qualifyingCents: 6_000_000, qualifyingPolicyCount: 2 }, achieved)).toEqual([]);
  });
  it("caps the bar at 100% and reports the next target", () => {
    expect(graduationPercent(30_000_000)).toBe(100);
    expect(graduationPercent(12_500_000)).toBe(50);
    expect(nextTarget(3_000_000, new Set(["first_policy", "premium_25k"]))).toMatchObject({ key: "premium_50k", remainingCents: 2_000_000 });
  });
});

describe("qualifying premium rule", () => {
  const window = { contractSignedAt: new Date("2026-03-01T00:00:00Z"), enrollmentAt: new Date("2026-01-01T00:00:00Z"), enrollmentEndedAt: null };
  const base: PolicyForCredit = { id: "p", status: "approved", businessType: "new", writtenDate: new Date("2026-03-05T00:00:00Z"), annualizedCents: 100000, adjustmentsCents: 0 };
  it("counts approved new business after contract signing net of cancellations", () => {
    const r = qualifyingPremium([
      base,
      { ...base, id: "renewal", businessType: "renewal" },
      { ...base, id: "pending", status: "pending" },
      { ...base, id: "before", writtenDate: new Date("2026-02-01T00:00:00Z") },
      { ...base, id: "cancelled", status: "cancelled", adjustmentsCents: -40000 },
    ], window);
    expect(r).toEqual({ qualifyingCents: 160000, contributingPolicyCount: 2 });
  });
  it("counts nothing without a signed contract", () => {
    expect(qualifyingPremium([base], { ...window, contractSignedAt: null }).qualifyingCents).toBe(0);
  });
});

describe("stage machine", () => {
  const t0 = new Date("2026-01-01T15:00:00Z");
  const t1 = new Date("2026-01-02T15:00:00Z");
  it("completes the current stage and opens the next at the same boundary", () => {
    const intervals: StageInterval[] = [{ stage: 1, enteredAt: t0, completedAt: null }];
    const tr = completeStage(intervals, 1, t1);
    expect(tr).toEqual({ kind: "advance", close: { stage: 1, enteredAt: t0, completedAt: t1 }, open: { stage: 2, enteredAt: t1, completedAt: null } });
  });
  it("treats repeats and out-of-order completions as no-ops", () => {
    const intervals: StageInterval[] = [
      { stage: 1, enteredAt: t0, completedAt: t1 },
      { stage: 2, enteredAt: t1, completedAt: null },
    ];
    expect(completeStage(intervals, 1, new Date()).kind).toBe("noop");
    expect(completeStage(intervals, 3, new Date()).kind).toBe("noop");
    expect(deriveState(intervals).currentStage).toBe(2);
  });
  it("freezes completed durations and sums reopened intervals", () => {
    const now = new Date("2026-01-10T15:00:00Z");
    const intervals: StageInterval[] = [
      { stage: 1, enteredAt: t0, completedAt: t1 },
      { stage: 2, enteredAt: t1, completedAt: new Date("2026-01-03T15:00:00Z") },
      { stage: 2, enteredAt: new Date("2026-01-05T15:00:00Z"), completedAt: null },
    ];
    expect(stageDurationMs(intervals, 1, now)).toBe(86_400_000);
    expect(stageDurationMs(intervals, 2, now)).toBe(86_400_000 + 5 * 86_400_000);
  });
});

describe("formatting and quiet hours", () => {
  it("formats short durations in hours and long ones in days", () => {
    expect(formatDuration(3 * 3_600_000)).toBe("3h");
    expect(formatDuration(28 * 3_600_000)).toBe("1d 4h");
    expect(formatDuration(12 * 86_400_000)).toBe("12d");
  });
  it("applies the 8am–9pm Denver SMS window across DST", () => {
    expect(withinSmsWindow(new Date("2026-07-01T14:00:00Z"))).toBe(true); // 8:00 MDT
    expect(withinSmsWindow(new Date("2026-07-01T13:59:00Z"))).toBe(false);
    expect(withinSmsWindow(new Date("2026-12-01T03:59:00Z"))).toBe(true); // 20:59 MST
    expect(withinSmsWindow(new Date("2026-12-01T04:00:00Z"))).toBe(false); // 21:00 MST
  });
});

describe("csv", () => {
  it("neutralizes formula injection and quotes", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1 385")).toBe("'+1 385");
    expect(csvCell("a,b")).toBe("\"a,b\"");
  });
  it("parses quoted fields and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
});

describe("formatDay", () => {
  it("shows a stored calendar day without shifting it into Denver time", async () => {
    const { formatDay } = await import("@/domain/durations");
    expect(formatDay(new Date("2026-03-01T00:00:00Z"))).toBe("Mar 1, 2026");
    expect(formatDay("2026-12-31")).toBe("Dec 31, 2026");
  });
});

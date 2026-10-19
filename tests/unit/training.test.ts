import { describe, expect, it } from "vitest";
import { cleanMeetingUrl, isMonthKey, monthKey, shiftMonth, TRAINING_MODULES, MONTHLY_MEETINGS } from "@/domain/training";
import { denverLocalToDate } from "@/server/training";

describe("training modules and meetings", () => {
  it("has the nine Stage 5 modules and two monthly meetings, in order", () => {
    expect(TRAINING_MODULES.map((m) => m.label)).toEqual([
      "Intro Meeting", "5 Qualifying Quotes", "Platinum Dashboard Training", "Complete Required Forms (W9, EFT, Agent Info & E&O)",
      "Momentum Training", "PL Rater Training", "Coverage Training", "Payment Processing", "Acord Form Training",
    ]);
    expect(MONTHLY_MEETINGS.map((m) => m.label)).toEqual(["Agency Meeting", "AIT Check-in Training"]);
  });

  it("files a meeting under Denver's month, not UTC's", () => {
    expect(monthKey(new Date("2026-11-01T03:00:00Z"))).toBe("2026-10"); // Oct 31, 9pm in Denver
    expect(monthKey(new Date("2026-11-01T08:00:00Z"))).toBe("2026-11");
  });

  it("shifts months across year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-07")).toBe(true);
  });

  it("only accepts https meeting links", () => {
    expect(cleanMeetingUrl("  https://zoom.us/j/123?pwd=x ")).toBe("https://zoom.us/j/123?pwd=x");
    expect(cleanMeetingUrl("")).toBeNull();
    expect(() => cleanMeetingUrl("http://zoom.us/j/1")).toThrow();
    expect(() => cleanMeetingUrl("javascript:alert(1)")).toThrow();
    expect(() => cleanMeetingUrl("zoom.us/j/1")).toThrow();
  });

  it("reads admin-entered times as Mountain time, DST included", () => {
    expect(denverLocalToDate("2026-07-15T08:00").toISOString()).toBe("2026-07-15T14:00:00.000Z"); // MDT
    expect(denverLocalToDate("2026-12-15T08:00").toISOString()).toBe("2026-12-15T15:00:00.000Z"); // MST
  });
});

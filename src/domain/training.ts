/** Stage 5 training modules (owner, 2026-10-19). Admins check them off; recruits see them once in Stage 5. */
export const TRAINING_MODULES = [
  { key: "intro_meeting", label: "Intro Meeting" },
  { key: "qualifying_quotes", label: "5 Qualifying Quotes" },
  { key: "dashboard_training", label: "Platinum Dashboard Training" },
  { key: "required_forms", label: "Complete Required Forms (W9, EFT, Agent Info & E&O)" },
  { key: "momentum_training", label: "Momentum Training" },
  { key: "pl_rater_training", label: "PL Rater Training" },
  { key: "coverage_training", label: "Coverage Training" },
  { key: "payment_processing", label: "Payment Processing" },
  { key: "acord_form_training", label: "Acord Form Training" },
] as const;

export type TrainingModuleKey = (typeof TRAINING_MODULES)[number]["key"];

export function isTrainingModuleKey(v: string): v is TrainingModuleKey {
  return TRAINING_MODULES.some((m) => m.key === v);
}

/** Two mandatory meetings every month for every active recruit. */
export const MONTHLY_MEETINGS = [
  { key: "agency_meeting", label: "Agency Meeting" },
  { key: "ait_checkin_training", label: "AIT Check-in Training" },
] as const;

export type MeetingKey = (typeof MONTHLY_MEETINGS)[number]["key"];

export function isMeetingKey(v: string): v is MeetingKey {
  return MONTHLY_MEETINGS.some((m) => m.key === v);
}

export function meetingLabel(key: string) {
  return MONTHLY_MEETINGS.find((m) => m.key === key)?.label ?? key;
}

/** "2026-10" in Platinum's time zone (Denver), so a meeting on the 1st at 8am isn't filed under last month. */
export function monthKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit" }).formatToParts(at);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

export function isMonthKey(v: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** The month before/after `month` ("2026-01" → "2025-12"). */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Meeting links must be plain https URLs (Zoom, Google Meet, Teams...). */
export function cleanMeetingUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error("Enter a full link starting with https://"); }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("Enter a full link starting with https://");
  return u.toString();
}

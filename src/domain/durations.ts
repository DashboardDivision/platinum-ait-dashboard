const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "3h", "1d 4h", "12d". Short durations show hours; long ones show days. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < HOUR) return `${Math.max(0, Math.floor(ms / 60_000))}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return days < 7 && hours ? `${days}d ${hours}h` : `${days}d`;
}

export function wholeDays(ms: number): number {
  return Math.max(0, Math.floor(ms / DAY));
}

export const BUSINESS_TZ = "America/Denver";

export function formatDate(d: Date | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, ...opts }).format(d);
}

/** Date-only columns (written date, exam date) are calendar days stored at UTC midnight; never shift them into Denver time. */
export function formatDay(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const v = typeof d === "string" ? new Date(`${d}T00:00:00Z`) : d;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(v);
}

export function formatDateTime(d: Date | null | undefined): string {
  return formatDate(d, { dateStyle: "medium", timeStyle: "short" });
}

/** Hour of day in Denver, used for SMS quiet hours (8am–9pm). */
export function denverHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, hour: "numeric", hourCycle: "h23" }).format(d));
}

export function withinSmsWindow(d: Date, startHour = 8, endHour = 21): boolean {
  const h = denverHour(d);
  return h >= startHour && h < endHour;
}

/** Start of the next allowed SMS hour in Denver (Denver offsets are whole hours, so top-of-hour steps are exact). */
export function nextSmsWindowStart(now: Date, startHour = 8, endHour = 21): Date {
  if (withinSmsWindow(now, startHour, endHour)) return now;
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (withinSmsWindow(t, startHour, endHour)) return t;
  }
  return t;
}

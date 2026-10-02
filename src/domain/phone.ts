import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export type StarterPasswordResult =
  | { ok: true; e164: string; starterPassword: string }
  | { ok: false; reason: "missing" | "invalid" | "non_us" };

/**
 * Starter password convention (both sites): the ten U.S. national digits, no
 * punctuation and no leading country code. Platinum chose U.S.-only, so any
 * valid non-U.S. number is queued for admin correction instead of guessed at.
 */
export function starterPasswordFromPhone(raw: string | null | undefined): StarterPasswordResult {
  if (!raw || !raw.trim()) return { ok: false, reason: "missing" };
  const parsed = parsePhoneNumberFromString(raw.trim(), "US");
  if (!parsed || !parsed.isValid()) return { ok: false, reason: "invalid" };
  if (parsed.country !== "US" && parsed.countryCallingCode !== "1") return { ok: false, reason: "non_us" };
  if (parsed.country && parsed.country !== "US") return { ok: false, reason: "non_us" };
  const national = parsed.nationalNumber.toString();
  if (!/^\d{10}$/.test(national)) return { ok: false, reason: "invalid" };
  return { ok: true, e164: parsed.number, starterPassword: national };
}

/** Digits-only comparison used to reject reusing the phone number as a new password. */
export function isPhoneLikePassword(candidate: string, phoneE164: string | null | undefined): boolean {
  if (!phoneE164) return false;
  const digits = candidate.replace(/\D/g, "");
  const national = phoneE164.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length >= 10 && (digits === national || digits === `1${national}`);
}

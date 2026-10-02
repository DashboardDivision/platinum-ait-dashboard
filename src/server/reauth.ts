import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const REAUTH_COOKIE = "ait_reauth";
const TTL_MS = 10 * 60_000;

function sig(payload: string) {
  return createHmac("sha256", env().BETTER_AUTH_SECRET).update(`reauth:${payload}`).digest("base64url");
}

/** Short-lived proof that an admin just re-entered their current password (no second factor). */
export function issueReauth(userId: string, now = Date.now()) {
  const payload = `${userId}.${now + TTL_MS}`;
  return { value: `${payload}.${sig(payload)}`, maxAge: TTL_MS / 1000 };
}

export function verifyReauth(value: string | undefined | null, userId: string, now = Date.now()) {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [uid, exp, s] = parts;
  if (uid !== userId || Number(exp) < now) return false;
  const want = Buffer.from(sig(`${uid}.${exp}`));
  const got = Buffer.from(s);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

import { z } from "zod";

/** One normalization for every system: trim and lowercase the whole address. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  return z.email().safeParse(value).success ? value : null;
}

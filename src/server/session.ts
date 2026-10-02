import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { db, schema } from "@/db";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "recruit";
  mustChangePassword: boolean;
  impersonatedBy: string | null;
  sessionCreatedAt: Date;
};

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Read request headers before touching config so every signed-in page renders per request, never at build time.
  const h = await headers();
  const s = await auth().api.getSession({ headers: h });
  if (!s) return null;
  // Re-read authoritative flags from the database rather than trusting cached session data.
  const [u] = await db.select().from(schema.user).where(eq(schema.user.id, s.user.id));
  if (!u || u.banned) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role === "admin" ? "admin" : "recruit",
    mustChangePassword: u.mustChangePassword,
    impersonatedBy: (s.session as { impersonatedBy?: string | null }).impersonatedBy ?? null,
    sessionCreatedAt: s.session.createdAt,
  };
});

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** For pages. A starter-password session can only reach the change-password page. */
export async function requirePageUser(role?: "admin" | "recruit"): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (u.mustChangePassword && !u.impersonatedBy) redirect("/change-password");
  if (role && u.role !== role) redirect(u.role === "admin" ? "/admin" : "/recruit");
  return u;
}

/** For route handlers and server actions: same rules, but throws instead of redirecting. */
export async function requireApiUser(role?: "admin" | "recruit"): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new HttpError(401, "Not signed in");
  if (u.mustChangePassword && !u.impersonatedBy) throw new HttpError(403, "Change your temporary password first");
  if (role && u.role !== role) throw new HttpError(403, "Not allowed");
  return u;
}

export async function recruitForUser(userId: string) {
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.userId, userId));
  return r ?? null;
}

/** Actions forbidden during "Login as AIT". */
export function assertNotImpersonating(u: CurrentUser, what: string) {
  if (u.impersonatedBy) throw new HttpError(403, `${what} isn't allowed while viewing as a recruit`);
}

export function actorKind(u: CurrentUser): "recruit" | "impersonation" | "admin" {
  if (u.impersonatedBy) return "impersonation";
  return u.role === "admin" ? "admin" : "recruit";
}

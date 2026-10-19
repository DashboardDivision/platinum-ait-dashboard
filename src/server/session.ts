import { headers } from "next/headers";
import { firstStaffPath, isLeadRole, isStaffRole } from "@/domain/roles";
import { cachedPermsForRole } from "./role-perms";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { auth } from "@/lib/auth";
import { db, schema } from "@/db";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  /** Coarse kind: "admin" = any staff role, "agent" = any lead role. */
  role: "admin" | "recruit" | "agent";
  /** The exact role (see src/domain/roles.ts) and its permissions. */
  roleKey?: string;
  perms?: string[];
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
    role: isStaffRole(u.role) ? "admin" : isLeadRole(u.role) ? "agent" : "recruit",
    roleKey: u.role,
    perms: await cachedPermsForRole(u.role),
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

/** Where each kind of account lands. AIT recruits and agents never see each other's pages. */
export function homeFor(u: Pick<CurrentUser, "role" | "impersonatedBy" | "perms">) {
  if (u.role === "admin" && !u.impersonatedBy) return firstStaffPath(u.perms ?? []);
  return u.role === "agent" ? "/agent" : "/recruit";
}

/** For pages. A starter-password session can only reach the change-password page. */
export async function requirePageUser(role?: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (u.mustChangePassword && !u.impersonatedBy) redirect("/change-password");
  if (role && u.role !== role) redirect(homeFor(u));
  return u;
}

/** For route handlers and server actions: same rules, but throws instead of redirecting. */
export async function requireApiUser(role?: CurrentUser["role"]): Promise<CurrentUser> {
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
  return u.role === "admin" ? "admin" : "recruit"; // agents never reach AIT recruit actions (role checks)
}

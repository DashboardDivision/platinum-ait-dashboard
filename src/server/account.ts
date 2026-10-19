import { randomBytes } from "node:crypto";
import { isLeadRole } from "@/domain/roles";
import { onAgentPasswordChanged } from "./agents";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { isPhoneLikePassword } from "@/domain/phone";
import { completeStageTx } from "./stages";
import { audit } from "./audit";
import { enqueue } from "./outbox";
import { HttpError } from "./session";

export function validateNewPassword(pw: string, phoneE164: string | null): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 128) return "Use 128 characters or fewer.";
  if (isPhoneLikePassword(pw, phoneE164)) return "Your new password can't be your phone number.";
  if (/^\d+$/.test(pw)) return "Use more than just numbers.";
  return null;
}

/**
 * The required first-login change (and ordinary later changes). Verifies the
 * current password through Better Auth, revokes other sessions, clears the
 * starter-password restriction and completes Stage 1 for a recruit's first change.
 */
export async function changePassword(input: { userId: string; currentPassword: string; newPassword: string; headers: Headers; impersonatedBy: string | null }) {
  if (input.impersonatedBy) throw new HttpError(403, "Password changes aren't allowed while viewing as a recruit");
  const [u] = await db.select().from(schema.user).where(eq(schema.user.id, input.userId));
  if (!u) throw new HttpError(401, "Not signed in");
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.userId, u.id));
  const [ag] = r ? [] : await db.select({ phoneE164: schema.agent.phoneE164 }).from(schema.agent).where(eq(schema.agent.userId, u.id));
  const problem = validateNewPassword(input.newPassword, r?.phoneE164 ?? ag?.phoneE164 ?? u.phoneE164 ?? null);
  if (problem) throw new HttpError(400, problem);
  if (input.newPassword === input.currentPassword) throw new HttpError(400, "Choose a password different from your current one.");

  try {
    await auth().api.changePassword({
      body: { currentPassword: input.currentPassword, newPassword: input.newPassword, revokeOtherSessions: true },
      headers: input.headers,
    });
  } catch {
    throw new HttpError(400, "Your current password isn't right.");
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(schema.user).set({ mustChangePassword: false }).where(eq(schema.user.id, u.id));
    await audit(tx, { actorUserId: u.id, action: "password.changed", targetType: "user", targetId: u.id, metadata: { wasStarter: u.mustChangePassword } });
    if (isLeadRole(u.role)) await onAgentPasswordChanged(tx, u.id);
    if (!r) return;
    const first = !r.initialPasswordChangedAt;
    await tx.update(schema.recruit).set({ initialPasswordChangedAt: r.initialPasswordChangedAt ?? now, lastActivityAt: now }).where(eq(schema.recruit.id, r.id));
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "password_changed", actorKind: "recruit", actorUserId: u.id, at: now });
    if (first || u.mustChangePassword) {
      await completeStageTx(tx, r.id, 1, now, { firstLoginAt: r.firstLoginAt?.toISOString() ?? null, passwordChangedAt: now.toISOString() }, u.id);
    }
  });
}

/**
 * Audited forced temporary reset by an admin. Generates a random one-time
 * password shown once to the admin (never stored or logged), forces a change
 * at next login, revokes every session and notifies the recruit.
 * Only the dashboard is affected; the education site is never touched.
 */
export async function adminForceTemporaryPassword(input: { adminUserId: string; recruitId: string; reason: string }) {
  if (!input.reason.trim()) throw new HttpError(400, "A reason is required");
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, input.recruitId));
  if (!r?.userId) throw new HttpError(404, "This recruit has no dashboard account yet");
  const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId));
  if (!u || u.role !== "recruit") throw new HttpError(400, "Only recruit accounts can be reset here");
  const temp = randomBytes(9).toString("base64url");
  const ctx = await auth().$context;
  const hash = await ctx.password.hash(temp);
  await db.transaction(async (tx) => {
    await tx.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(eq(schema.account.userId, u.id));
    await tx.update(schema.user).set({ mustChangePassword: true }).where(eq(schema.user.id, u.id));
    await tx.delete(schema.session).where(eq(schema.session.userId, u.id));
    await audit(tx, { actorUserId: input.adminUserId, action: "password.admin_temporary_reset", targetType: "recruit", targetId: r.id, reason: input.reason, metadata: { site: "dashboard" } });
    await enqueue(tx, { eventType: "password_reset_by_admin", dedupeKey: `admin-reset:${r.id}:${Date.now()}`, recruitId: r.id, payload: {} });
  });
  return temp;
}

/** Admin-initiated recovery: sends the standard single-use reset link for the dashboard only. */
export async function adminSendResetLink(input: { adminUserId: string; recruitId: string }) {
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, input.recruitId));
  if (!r?.email || !r.userId) throw new HttpError(404, "This recruit has no dashboard account yet");
  const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId));
  await auth().api.requestPasswordReset({ body: { email: u.email, redirectTo: "/reset-password" } });
  await audit(db, { actorUserId: input.adminUserId, action: "password.admin_reset_link", targetType: "recruit", targetId: r.id, metadata: { site: "dashboard" } });
}

import { eq } from "drizzle-orm";
import { isLeadRole } from "@/domain/roles";
import { db, schema } from "@/db";
import { completeStageTx } from "./stages";
import { onAgentSessionCreated } from "./agents";

/**
 * Called for every new session. Only a real recruit sign-in counts: admin
 * impersonation sessions and service calls never set first login or activity.
 */
export async function onRecruitSessionCreated(input: { userId: string; impersonatedBy: string | null; at: Date }) {
  if (input.impersonatedBy) return;
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(schema.user).where(eq(schema.user.id, input.userId));
    if (u && isLeadRole(u.role)) return onAgentSessionCreated(tx, u, input.at);
    if (!u || u.role !== "recruit") return;
    const [r] = await tx.select().from(schema.recruit).where(eq(schema.recruit.userId, u.id)).for("update");
    if (!r) return;
    await tx
      .update(schema.recruit)
      .set({ firstLoginAt: r.firstLoginAt ?? input.at, lastActivityAt: input.at })
      .where(eq(schema.recruit.id, r.id));
    await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "login", actorKind: "recruit", actorUserId: u.id, at: input.at });
    // Recruit who recovered their password first: a real login with a non-starter password completes Stage 1.
    if (!u.mustChangePassword && r.initialPasswordChangedAt) {
      await completeStageTx(tx, r.id, 1, input.at, { via: "login_after_recovery" }, u.id);
    }
  });
}

/** Recovery sets a non-starter password but is not a login; Stage 1 waits for an actual sign-in. */
export async function onPasswordRecovered(userId: string) {
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(schema.user).where(eq(schema.user.id, userId));
    if (!u) return;
    await tx.update(schema.user).set({ mustChangePassword: false }).where(eq(schema.user.id, userId));
    if (u.role !== "recruit") return;
    const [r] = await tx.select().from(schema.recruit).where(eq(schema.recruit.userId, userId));
    if (r && !r.initialPasswordChangedAt) {
      await tx.update(schema.recruit).set({ initialPasswordChangedAt: new Date() }).where(eq(schema.recruit.id, r.id));
      await tx.insert(schema.activityEvent).values({ recruitId: r.id, type: "password_recovered", actorKind: "recruit", actorUserId: userId });
    }
  });
}

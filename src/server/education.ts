import { and, eq, inArray, lt } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/db";
import { env } from "@/lib/env";
import { starterPasswordFromPhone } from "@/domain/phone";
import { enqueue } from "./outbox";
import { audit } from "./audit";

/**
 * Education (study site) accounts, created through the study site's internal provisioning
 * endpoint (Platinum approved, 2026-10-05). Same login as the dashboard: email + the phone-number
 * starter password, changed at first sign-in on that site. Off unless both settings are present.
 */
export function educationProvisioningEnabled() {
  return Boolean(env().EDUCATION_PROVISION_URL && env().EDUCATION_PROVISION_TOKEN);
}

export const EDUCATION_UNAVAILABLE =
  "The study site isn't connected to this dashboard, so learners create their own study login there.";

const MAX_ATTEMPTS = 8;

function splitName(fullName: string) {
  const [first = "", ...rest] = fullName.trim().split(/\s+/);
  return { firstName: first || fullName.trim(), lastName: rest.join(" ") };
}

/**
 * Creates or links the study-site account once the dashboard account is ready, then lets the
 * held welcome go out. Never runs inside a transaction (it makes a network call); safe to repeat.
 */
export async function provisionEducation(recruitId: string): Promise<string> {
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, recruitId));
  const rows = await db.select().from(schema.provisioning).where(eq(schema.provisioning.recruitId, recruitId));
  const p = rows.find((x) => x.system === "education");
  const dash = rows.find((x) => x.system === "dashboard");
  if (!r || !p) return "unavailable";
  if (!["pending", "failed"].includes(p.status)) return p.status;
  if (r.status !== "active" || dash?.status !== "ready") return p.status;

  const phone = starterPasswordFromPhone(r.phoneE164);
  const now = new Date();
  if (!educationProvisioningEnabled() || !r.email || !phone.ok) {
    await db.update(schema.provisioning).set({ status: "unavailable", lastError: EDUCATION_UNAVAILABLE, lastAttemptAt: now }).where(eq(schema.provisioning.id, p.id));
    await queueWelcome(db, recruitId);
    return "unavailable";
  }

  const attempt = p.attempts + 1;
  try {
    const res = await fetch(env().EDUCATION_PROVISION_URL!, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env().EDUCATION_PROVISION_TOKEN}` },
      body: JSON.stringify({ email: r.email, ...splitName(r.fullName), password: phone.starterPassword, externalRef: `ait:${r.id}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`study site answered ${res.status}`);
    const body = (await res.json()) as { status: "created" | "existing"; userId: string };
    const linkedExisting = body.status === "existing";
    await db.transaction(async (tx) => {
      await tx.update(schema.provisioning)
        .set({ status: "ready", externalAccountId: body.userId, linkedExisting, attempts: attempt, lastAttemptAt: now, readyAt: now, lastError: null })
        .where(eq(schema.provisioning.id, p.id));
      if (!linkedExisting) await tx.update(schema.recruit).set({ educationAccountCreatedAt: now }).where(eq(schema.recruit.id, recruitId));
      await audit(tx, { actorUserId: null, action: linkedExisting ? "account.linked" : "account.created", targetType: "recruit", targetId: recruitId, metadata: { system: "education", userId: body.userId } });
      await queueWelcome(tx, recruitId);
    });
    return "ready";
  } catch (err) {
    const msg = (err instanceof Error ? err.message : "unknown error").replace(/\b\d{10,11}\b/g, "[redacted]").slice(0, 300);
    await db.transaction(async (tx) => {
      // A concurrent attempt (webhook + "Add New Recruit") may already have succeeded: never downgrade a ready account.
      const marked = await tx.update(schema.provisioning)
        .set({ status: "failed", attempts: attempt, lastAttemptAt: now, lastError: `Study account not created yet: ${msg}` })
        .where(and(eq(schema.provisioning.id, p.id), inArray(schema.provisioning.status, ["pending", "failed"])))
        .returning({ id: schema.provisioning.id });
      if (!marked.length) return;
      if (attempt === 1 || attempt === MAX_ATTEMPTS) {
        await enqueue(tx, { eventType: "admin_alert", dedupeKey: `alert:education-failed:${recruitId}:${attempt}`, recruitId, payload: { kind: "education_provisioning_failed", detail: msg } });
      }
      // The welcome isn't held hostage: it goes out now and points them to the study site's Sign up instead.
      await queueWelcome(tx, recruitId);
    });
    const [now2] = await db.select({ status: schema.provisioning.status }).from(schema.provisioning).where(eq(schema.provisioning.id, p.id));
    return now2?.status ?? "failed";
  }
}

/**
 * One combined welcome per enrollment, queued once the dashboard account is ready and the study
 * account is no longer pending (ready, failed or unavailable). Idempotent through its dedupe key.
 */
export async function queueWelcome(tx: DbOrTx, recruitId: string) {
  const [r] = await tx.select({ welcomeStatus: schema.recruit.welcomeStatus, status: schema.recruit.status }).from(schema.recruit).where(eq(schema.recruit.id, recruitId));
  if (!r || r.welcomeStatus !== "not_sent") return;
  const rows = await tx.select().from(schema.provisioning).where(eq(schema.provisioning.recruitId, recruitId));
  const dash = rows.find((x) => x.system === "dashboard");
  const edu = rows.find((x) => x.system === "education");
  if (dash?.status !== "ready" || edu?.status === "pending") return;
  await tx.update(schema.recruit).set({ welcomeStatus: "queued" }).where(eq(schema.recruit.id, recruitId));
  await enqueue(tx, { eventType: "welcome", dedupeKey: `welcome:${recruitId}`, recruitId, payload: { linkedExisting: dash.linkedExisting } });
}

/** Hourly: retry study accounts that are still pending or failed for active recruits. */
export async function reconcileEducation() {
  const rows = await db
    .select({ id: schema.recruit.id })
    .from(schema.recruit)
    .innerJoin(schema.provisioning, and(eq(schema.provisioning.recruitId, schema.recruit.id), eq(schema.provisioning.system, "education")))
    .where(and(eq(schema.recruit.status, "active"), inArray(schema.provisioning.status, ["pending", "failed"]), lt(schema.provisioning.attempts, MAX_ATTEMPTS)));
  const results: Record<string, string> = {};
  for (const row of rows) results[row.id] = await provisionEducation(row.id);
  return results;
}

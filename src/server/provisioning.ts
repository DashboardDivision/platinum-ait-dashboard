import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/domain/email";
import { starterPasswordFromPhone } from "@/domain/phone";
import { enqueue } from "./outbox";
import { audit } from "./audit";
import { openFirstStage } from "./stages";

export const EDUCATION_UNAVAILABLE =
  "The education site has no account-provisioning integration. Platinum chose (2026-10-02) to leave it unmodified, so learners create their own study login there.";

export type TwentyRecruitInput = {
  workspaceId: string;
  object: string; // "platinumAit"
  recordId: string;
  eventId: string;
  sourceTime?: string | null;
  record: {
    name: string | null;
    email: string | null;
    phone: string | null;
    stage?: string | null;
    createdAt?: string | null;
    deletedAt?: string | null;
  };
  /** Set only by the admin-approved backfill of records that predate go-live. */
  backfill?: { sendWelcome: boolean };
};

export type ProvisionOutcome = {
  recruitId: string | null;
  duplicateEvent: boolean;
  dashboard: string;
  education: string;
  detail?: string;
};

const INELIGIBLE_STAGES = new Set(["NOT_MOVING_FORWARD"]);

function lockKey(i: TwentyRecruitInput) {
  return `${i.workspaceId}:${i.object}:${i.recordId}`;
}

/**
 * Twenty → dashboard provisioning. Safe to call any number of times, concurrently:
 * - events are deduped by id, and work is serialized per CRM record with an advisory lock;
 * - accounts are matched by the immutable CRM identity, never by email alone;
 * - an existing password is never overwritten and nothing is reset on a phone change.
 */
export async function provisionFromTwenty(input: TwentyRecruitInput): Promise<ProvisionOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey(input)}))`);
    const inserted = await tx
      .insert(schema.inboundEvent)
      .values({ source: "twenty", eventId: input.eventId, sourceTime: input.sourceTime ? new Date(input.sourceTime) : null })
      .onConflictDoNothing()
      .returning({ id: schema.inboundEvent.id });
    const duplicateEvent = inserted.length === 0;

    if (input.object !== "platinumAit") {
      return { recruitId: null, duplicateEvent, dashboard: "ignored", education: "ignored", detail: "Not a Platinum AIT record" };
    }

    const name = (input.record.name ?? "").trim();
    const email = normalizeEmail(input.record.email);
    const phone = starterPasswordFromPhone(input.record.phone);

    let [r] = await tx
      .select()
      .from(schema.recruit)
      .where(and(eq(schema.recruit.twentyWorkspaceId, input.workspaceId), eq(schema.recruit.twentyObject, input.object), eq(schema.recruit.twentyRecordId, input.recordId)));

    const eligible = !input.record.deletedAt && !INELIGIBLE_STAGES.has(input.record.stage ?? "");
    if (!r && !eligible) {
      return { recruitId: null, duplicateEvent, dashboard: "ignored", education: "ignored", detail: "Record is not eligible for AIT enrollment" };
    }

    const goLive = env().PROVISION_FROM ? new Date(env().PROVISION_FROM!) : null;
    if (!r && !input.backfill && goLive && input.record.createdAt && new Date(input.record.createdAt) < goLive) {
      return { recruitId: null, duplicateEvent, dashboard: "ignored", education: "ignored", detail: "Created before go-live; enroll it through the backfill preview" };
    }

    const contactIssue = !email ? "missing_or_invalid_email" : !phone.ok ? `phone_${phone.reason}` : null;

    if (!r) {
      const enrollmentAt = input.record.createdAt ? new Date(input.record.createdAt) : new Date();
      [r] = await tx
        .insert(schema.recruit)
        .values({
          twentyWorkspaceId: input.workspaceId,
          twentyObject: input.object,
          twentyRecordId: input.recordId,
          fullName: name || "(no name in CRM)",
          email,
          phoneE164: phone.ok ? phone.e164 : null,
          contactIssue,
          enrollmentAt,
          enrollmentAtBasis: input.record.createdAt ? "twenty_record_created" : "first_event_received",
          source: input.backfill ? "twenty_backfill" : "twenty",
          // A quiet backfill never sends the welcome; admins can still resend it from the record.
          welcomeStatus: input.backfill && !input.backfill.sendWelcome ? "suppressed" : "not_sent",
        })
        .returning();
      await tx.insert(schema.provisioning).values([
        { recruitId: r.id, system: "dashboard", status: "pending" },
        { recruitId: r.id, system: "education", status: "unavailable", lastError: EDUCATION_UNAVAILABLE },
      ]);
      await audit(tx, { actorUserId: null, action: "recruit.enrolled", targetType: "recruit", targetId: r.id, metadata: { twentyRecordId: input.recordId } });
    } else {
      // Contact updates: phone and name are contact data only. Email changes on a linked account need admin review.
      const updates: Partial<typeof schema.recruit.$inferInsert> = {};
      if (name && name !== r.fullName) updates.fullName = name;
      if (phone.ok && phone.e164 !== r.phoneE164) updates.phoneE164 = phone.e164;
      if (email && email !== r.email) {
        if (r.userId) {
          updates.contactIssue = "crm_email_changed_review";
          await upsertTask(tx, r.id, "contact_fix", `crm-email-change:${r.id}:${email}`, "CRM email changed for a linked account",
            `Twenty now lists ${email} for ${r.fullName}. The dashboard login is still ${r.email}. Review before changing it.`);
        } else updates.email = email;
      }
      if (!r.userId) updates.contactIssue = contactIssue;
      if (Object.keys(updates).length) [r] = await tx.update(schema.recruit).set(updates).where(eq(schema.recruit.id, r.id)).returning();
    }

    const dashboard = await provisionDashboard(tx, r.id);
    const [edu] = await tx.select().from(schema.provisioning).where(and(eq(schema.provisioning.recruitId, r.id), eq(schema.provisioning.system, "education")));
    return { recruitId: r.id, duplicateEvent, dashboard, education: edu?.status ?? "unavailable" };
  });
}

async function upsertTask(tx: Tx, recruitId: string, kind: string, dedupeKey: string, title: string, body: string) {
  await tx.insert(schema.task).values({ recruitId, kind, dedupeKey, title, body }).onConflictDoNothing({ target: schema.task.dedupeKey });
}

/**
 * Creates or safely links the dashboard account for a recruit. Only touches
 * missing/failed work: a Ready account is never recreated or reset.
 */
export async function provisionDashboard(tx: Tx, recruitId: string): Promise<string> {
  const [r] = await tx.select().from(schema.recruit).where(eq(schema.recruit.id, recruitId)).for("update");
  const [p] = await tx.select().from(schema.provisioning).where(and(eq(schema.provisioning.recruitId, recruitId), eq(schema.provisioning.system, "dashboard"))).for("update");
  if (!r || !p) throw new Error("recruit or provisioning row missing");
  if (p.status === "ready") return "ready";
  if (r.status !== "active") return p.status;

  const now = new Date();
  const phone = starterPasswordFromPhone(r.phoneE164);
  if (!r.email || !phone.ok) {
    const why = !r.email ? "Email is missing or invalid in Twenty." : !phone.ok && phone.reason === "non_us" ? "Phone is not a U.S. number; starter passwords are U.S.-only." : "Phone is missing or invalid in Twenty.";
    await tx.update(schema.provisioning).set({ status: "missing_information", lastError: why, lastAttemptAt: now }).where(eq(schema.provisioning.id, p.id));
    await upsertTask(tx, recruitId, "contact_fix", `contact-fix:${recruitId}`, `Fix contact details for ${r.fullName}`, `${why} Update the record in Twenty; the account is created automatically once it's complete.`);
    await enqueue(tx, { eventType: "admin_alert", dedupeKey: `alert:missing-info:${recruitId}`, recruitId, payload: { kind: "missing_information", detail: why } });
    return "missing_information";
  }

  const [existing] = await tx.select().from(schema.user).where(eq(schema.user.email, r.email));
  if (existing) {
    const [linked] = await tx.select({ id: schema.recruit.id }).from(schema.recruit).where(eq(schema.recruit.userId, existing.id));
    if (linked?.id === recruitId) {
      await linkUser(tx, r.id, p.id, existing.id, existing.createdAt, false);
      return "ready";
    }
    // A matching email is only a lookup candidate: never overwrite credentials, roles or another recruit's link.
    const why = existing.role === "admin" ? "An admin account already uses this email." : linked ? "This email belongs to another recruit's account." : "A dashboard account with this email already exists.";
    await tx.update(schema.provisioning).set({ status: "needs_match_review", lastError: why, lastAttemptAt: now }).where(eq(schema.provisioning.id, p.id));
    await upsertTask(tx, recruitId, "provisioning", `match-review:${recruitId}`, `Review account match for ${r.fullName}`, `${why} Confirm it's the same person before linking. Nothing was changed on the existing account.`);
    await enqueue(tx, { eventType: "admin_alert", dedupeKey: `alert:match-review:${recruitId}`, recruitId, payload: { kind: "needs_match_review", detail: why } });
    return "needs_match_review";
  }

  await tx.update(schema.provisioning).set({ attempts: p.attempts + 1, lastAttemptAt: now }).where(eq(schema.provisioning.id, p.id));
  try {
    // Created inside a savepoint of this transaction with Better Auth's own password hasher,
    // so the account row and the recruit link commit together: no ambiguous half-created state.
    const ctx = await auth().$context;
    const hash = await ctx.password.hash(phone.starterPassword);
    const userId = await tx.transaction(async (sp) => {
      const id = randomUUID();
      await sp.insert(schema.user).values({ id, name: r.fullName, email: r.email!, emailVerified: false, role: "recruit", mustChangePassword: true, createdAt: now, updatedAt: now });
      await sp.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: now, updatedAt: now });
      return id;
    });
    await linkUser(tx, r.id, p.id, userId, now, false);
    await audit(tx, { actorUserId: null, action: "account.created", targetType: "recruit", targetId: r.id, metadata: { system: "dashboard", userId } });
    return "ready";
  } catch (err) {
    const msg = redact(err instanceof Error ? err.message : "unknown error");
    await tx.update(schema.provisioning).set({ status: "failed", lastError: msg }).where(eq(schema.provisioning.id, p.id));
    await enqueue(tx, { eventType: "admin_alert", dedupeKey: `alert:provision-failed:${recruitId}:${p.attempts + 1}`, recruitId, payload: { kind: "provisioning_failed", detail: msg } });
    return "failed";
  }
}

async function linkUser(tx: Tx, recruitId: string, provisioningId: string, userId: string, createdAt: Date, linkedExisting: boolean) {
  await tx.update(schema.recruit).set({ userId, accountCreatedAt: createdAt, contactIssue: null }).where(eq(schema.recruit.id, recruitId));
  await tx.update(schema.provisioning).set({ status: "ready", externalAccountId: userId, linkedExisting, readyAt: new Date(), lastError: null }).where(eq(schema.provisioning.id, provisioningId));
  await openFirstStage(tx, recruitId, createdAt);
  // One combined welcome per enrollment. The education account is unavailable (not pending), so it doesn't hold the welcome.
  const [cur] = await tx.select({ welcomeStatus: schema.recruit.welcomeStatus }).from(schema.recruit).where(eq(schema.recruit.id, recruitId));
  if (cur?.welcomeStatus === "suppressed") return;
  await tx.update(schema.recruit).set({ welcomeStatus: "queued" }).where(eq(schema.recruit.id, recruitId));
  await enqueue(tx, { eventType: "welcome", dedupeKey: `welcome:${recruitId}`, recruitId, payload: { linkedExisting } });
}

export function redact(message: string) {
  return message.replace(/\b\d{10,11}\b/g, "[redacted]").replace(/password[^,;]*/gi, "password [redacted]").slice(0, 300);
}

/** Admin "retry provisioning": only acts on missing/failed work. */
export async function retryDashboardProvisioning(recruitId: string, actorUserId: string) {
  return db.transaction(async (tx) => {
    const res = await provisionDashboard(tx, recruitId);
    await audit(tx, { actorUserId, action: "provisioning.retry", targetType: "recruit", targetId: recruitId, metadata: { system: "dashboard", result: res } });
    return res;
  });
}

/** Scheduled reconciliation: resume any eligible recruit whose dashboard account isn't ready. */
export async function reconcileProvisioning() {
  const rows = await db
    .select({ id: schema.recruit.id })
    .from(schema.recruit)
    .innerJoin(schema.provisioning, and(eq(schema.provisioning.recruitId, schema.recruit.id), eq(schema.provisioning.system, "dashboard")))
    .where(and(eq(schema.recruit.status, "active"), sql`${schema.provisioning.status} in ('pending','failed')`));
  const results: Record<string, string> = {};
  for (const row of rows) results[row.id] = await db.transaction((tx) => provisionDashboard(tx, row.id));
  return results;
}

export type BackfillPreviewRow = { recordId: string; name: string; email: string | null; outcome: "would_enroll" | "already_enrolled" | "not_eligible" | "missing_information" | "needs_match_review"; detail: string | null };

/** Read-only: what a backfill of these pre-go-live records would do. Writes nothing. */
export async function previewBackfill(workspaceId: string, records: (TwentyRecruitInput["record"] & { recordId: string })[]): Promise<BackfillPreviewRow[]> {
  const out: BackfillPreviewRow[] = [];
  for (const rec of records) {
    const email = normalizeEmail(rec.email);
    const phone = starterPasswordFromPhone(rec.phone);
    const base = { recordId: rec.recordId, name: (rec.name ?? "").trim() || "(no name in CRM)", email };
    const [existing] = await db.select({ id: schema.recruit.id }).from(schema.recruit)
      .where(and(eq(schema.recruit.twentyWorkspaceId, workspaceId), eq(schema.recruit.twentyObject, "platinumAit"), eq(schema.recruit.twentyRecordId, rec.recordId)));
    if (existing) { out.push({ ...base, outcome: "already_enrolled", detail: null }); continue; }
    if (rec.deletedAt || INELIGIBLE_STAGES.has(rec.stage ?? "")) { out.push({ ...base, outcome: "not_eligible", detail: rec.deletedAt ? "Deleted in Twenty" : `Stage ${rec.stage}` }); continue; }
    if (!email || !phone.ok) {
      out.push({ ...base, outcome: "missing_information", detail: !email ? "Email missing or invalid" : !phone.ok && phone.reason === "non_us" ? "Phone is not a U.S. number" : "Phone missing or invalid" });
      continue;
    }
    const [user] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
    out.push(user ? { ...base, outcome: "needs_match_review", detail: "A dashboard account already uses this email" } : { ...base, outcome: "would_enroll", detail: null });
  }
  return out;
}

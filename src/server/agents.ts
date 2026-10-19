import { randomUUID } from "node:crypto";
import { isStaffRole, leadRoleFor } from "@/domain/roles";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema, type DbOrTx } from "@/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/domain/email";
import { starterPasswordFromPhone } from "@/domain/phone";
import { currentStep, PROGRAMS, type AgentProgramKey } from "@/domain/programs";
import { enqueue } from "./outbox";
import { audit } from "./audit";
import { HttpError, type CurrentUser } from "./session";

/* ---------------------------------------------------------------- Twenty (read live, written by Twenty) */

export type TwentyContact = {
  id: string;
  name: string;
  organization: string | null;
  email: string | null;
  phone: string | null;
  recruiter: string | null;
  stage: string | null;
  createdAt: string | null;
  /** Free Agent only: "Operation Free Agent" (captive) or "Traditional" (independent). */
  recruitType: string | null;
};

async function twentyGet(path: string) {
  if (!env().TWENTY_API_KEY) throw new HttpError(503, "The dashboard isn't connected to Twenty yet.");
  const res = await fetch(`${env().TWENTY_URL.replace(/\/$/, "")}/rest/${path}`, {
    headers: { authorization: `Bearer ${env().TWENTY_API_KEY}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) throw new HttpError(502, `Twenty answered ${res.status}. Try again in a moment.`);
  return (await res.json()) as { data?: Record<string, unknown>; pageInfo?: { hasNextPage?: boolean; endCursor?: string }; totalCount?: number };
}

function toContact(program: AgentProgramKey, raw: Record<string, unknown>): TwentyContact {
  const emails = raw.emails as { primaryEmail?: string } | null;
  const phones = raw.phones as { primaryPhoneNumber?: string; primaryPhoneCallingCode?: string } | null;
  const phone = phones?.primaryPhoneNumber ? `${phones.primaryPhoneCallingCode || "+1"}${phones.primaryPhoneNumber}` : null;
  // Group Sell records are agencies: the person is the owner, the record name is the agency.
  const owner = program === "group_sell" ? String(raw.ownerName ?? "").trim() : "";
  const name = String(raw.name ?? "").trim();
  return {
    id: String(raw.id),
    name: owner || name || "(no name in Twenty)",
    organization: program === "group_sell" ? name || null : (String(raw.currentOrganization ?? "").trim() || null),
    email: emails?.primaryEmail?.trim() || null,
    phone,
    recruiter: (raw.recruiter as string | null) ?? null,
    stage: (raw.stage as string | null) ?? null,
    createdAt: (raw.createdAt as string | null) ?? null,
    recruitType: (raw.recruitType as string | null) ?? null,
  };
}

export async function listTwentyContacts(program: AgentProgramKey, opts: { q?: string; after?: string; limit?: number; type?: string }) {
  const p = PROGRAMS[program];
  const params = new URLSearchParams({ limit: String(opts.limit ?? 25), order_by: "createdAt[DescNullsLast]" });
  const q = opts.q?.trim().replace(/["\\%]/g, "");
  const parts: string[] = [];
  if (q) {
    const like = `"%${q}%"`;
    parts.push(program === "group_sell"
      ? `or(name[ilike]:${like},ownerName[ilike]:${like},emails.primaryEmail[ilike]:${like})`
      : `or(name[ilike]:${like},emails.primaryEmail[ilike]:${like})`);
  }
  if (program === "free_agent" && opts.type === "captive") parts.push(`recruitType[eq]:"Operation Free Agent"`);
  if (program === "free_agent" && opts.type === "independent") parts.push(`recruitType[eq]:"Traditional"`);
  if (parts.length) params.set("filter", parts.length === 1 ? parts[0] : `and(${parts.join(",")})`);
  if (opts.after) params.set("starting_after", opts.after);
  const body = await twentyGet(`${p.twentyPlural}?${params}`);
  const rows = ((body.data?.[p.twentyPlural] as Record<string, unknown>[]) ?? []).map((r) => toContact(program, r));
  return { rows, total: body.totalCount ?? rows.length, next: body.pageInfo?.hasNextPage ? body.pageInfo.endCursor ?? null : null };
}

export async function getTwentyContact(program: AgentProgramKey, recordId: string) {
  if (!/^[0-9a-f-]{36}$/.test(recordId)) throw new HttpError(400, "Unknown Twenty record.");
  const p = PROGRAMS[program];
  const body = await twentyGet(`${p.twentyPlural}/${recordId}`);
  const raw = body.data?.[p.twentyObject] as Record<string, unknown> | undefined;
  if (!raw) throw new HttpError(404, "That record isn't in Twenty anymore.");
  return toContact(program, raw);
}

async function twentyPost(path: string, body: unknown) {
  if (!env().TWENTY_API_KEY) throw new HttpError(503, "The dashboard isn't connected to Twenty yet.");
  const res = await fetch(`${env().TWENTY_URL.replace(/\/$/, "")}/rest/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env().TWENTY_API_KEY}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: Record<string, { id?: string }>; messages?: string[]; error?: string };
  if (!res.ok) throw new HttpError(502, `Twenty didn't accept that: ${(json.messages?.join(" ") ?? json.error ?? String(res.status)).slice(0, 200)}`);
  return json;
}

export type NewContactInput = { name: string; organization: string; email: string; phone: string; recruiter: string };

/** "+ Add New" on a program page: creates the contact in that program's Twenty object. Returns the record id. */
export async function createTwentyContact(u: CurrentUser, program: AgentProgramKey, input: NewContactInput): Promise<string> {
  const p = PROGRAMS[program];
  const name = input.name.trim().replace(/\s+/g, " ");
  const organization = input.organization.trim().replace(/\s+/g, " ");
  const email = normalizeEmail(input.email);
  if (!name.includes(" ")) throw new HttpError(400, "Enter a first and last name.");
  if (program === "group_sell" && !organization) throw new HttpError(400, "Enter the agency name.");
  if (!email) throw new HttpError(400, "Enter a valid email address.");
  let phones: Record<string, string> | undefined;
  if (input.phone.trim()) {
    const ph = starterPasswordFromPhone(input.phone);
    if (!ph.ok) throw new HttpError(400, "Enter a valid 10-digit U.S. mobile number, or leave it blank.");
    phones = { primaryPhoneNumber: ph.e164.slice(2), primaryPhoneCountryCode: "US", primaryPhoneCallingCode: "+1" };
  }
  const recruiter = ["COLTON", "JESSE", "PARKER"].find((r) => r === input.recruiter.toUpperCase()) ?? null;

  const dupe = await twentyGet(`${p.twentyPlural}?limit=1&filter=${encodeURIComponent(`emails.primaryEmail[ilike]:"${email}"`)}`);
  if (((dupe.data?.[p.twentyPlural] as unknown[]) ?? []).length) throw new HttpError(409, `${p.label} already has a contact with that email in Twenty. Search for it on the list.`);

  const body = program === "group_sell"
    ? { name: organization, ownerName: name, stage: "IDENTIFIED" }
    : { name, stage: "NEW_LEAD", ...(organization ? { currentOrganization: organization } : {}) };
  const created = await twentyPost(p.twentyPlural, {
    ...body,
    emails: { primaryEmail: email },
    ...(phones ? { phones } : {}),
    ...(recruiter ? { recruiter } : {}),
    sourceSystem: "ait.getstrategic.vip",
  });
  const singular = `create${p.twentyObject[0].toUpperCase()}${p.twentyObject.slice(1)}`;
  const id = created.data?.[singular]?.id;
  if (!id) throw new HttpError(502, "Twenty didn't return the new record.");
  await audit(db, { actorUserId: u.id, action: "agent.contact_created", targetType: "twenty_record", targetId: id, metadata: { program } });
  return id;
}

/* ---------------------------------------------------------------- local agents */

export async function agentsByRecord(program: AgentProgramKey, recordIds: string[]) {
  if (!recordIds.length) return new Map<string, AgentSummary>();
  const rows = await db.select().from(schema.agent)
    .where(and(eq(schema.agent.program, program), inArray(schema.agent.twentyRecordId, recordIds)));
  const steps = rows.length ? await db.select().from(schema.agentStep).where(inArray(schema.agentStep.agentId, rows.map((r) => r.id))) : [];
  return new Map(rows.map((a) => [a.twentyRecordId, summarize(a, steps.filter((s) => s.agentId === a.id))]));
}

export type AgentSummary = ReturnType<typeof summarize>;
function summarize(a: typeof schema.agent.$inferSelect, steps: (typeof schema.agentStep.$inferSelect)[]) {
  const c = currentStep(steps.map((s) => s.step), PROGRAMS[a.program].steps.length);
  // Recruiter view only: Step 0 "Email Sent" until the login email is delivered.
  const adminCurrent = c.current === 1 && a.welcomeStatus !== "sent" ? 0 : c.current;
  return { agent: a, steps, ...c, adminCurrent };
}

export async function agentOverview(agentId: string) {
  const [a] = await db.select().from(schema.agent).where(eq(schema.agent.id, agentId));
  if (!a) return null;
  const steps = await db.select().from(schema.agentStep).where(eq(schema.agentStep.agentId, a.id)).orderBy(asc(schema.agentStep.step));
  const [u] = a.userId ? await db.select({ mustChangePassword: schema.user.mustChangePassword }).from(schema.user).where(eq(schema.user.id, a.userId)) : [];
  const [ws] = await db.select({ at: schema.messageDelivery.updatedAt }).from(schema.messageDelivery)
    .innerJoin(schema.outbox, eq(schema.outbox.id, schema.messageDelivery.outboxId))
    .where(and(eq(schema.messageDelivery.purpose, "agent_welcome"), inArray(schema.messageDelivery.status, ["sent", "delivered"]), sql`${schema.outbox.payload}->>'agentId' = ${a.id}`))
    .orderBy(asc(schema.messageDelivery.updatedAt)).limit(1);
  return { ...summarize(a, steps), program: PROGRAMS[a.program], mustChangePassword: u?.mustChangePassword ?? null, welcomeSentAt: ws?.at ?? null };
}

export async function agentForUser(userId: string) {
  const [a] = await db.select().from(schema.agent).where(eq(schema.agent.userId, userId));
  return a ? agentOverview(a.id) : null;
}

/** Counts of active, invited agents by current step, for a program's overview tiles. */
export async function agentStepCounts(program: AgentProgramKey) {
  const rows = await db.select().from(schema.agent).where(and(eq(schema.agent.program, program), eq(schema.agent.status, "active")));
  const steps = rows.length ? await db.select().from(schema.agentStep).where(inArray(schema.agentStep.agentId, rows.map((r) => r.id))) : [];
  const counts: Record<number, number> = {};
  let done = 0;
  for (const r of rows) {
    const c = summarize(r, steps.filter((s) => s.agentId === r.id));
    if (c.done) done += 1;
    else counts[c.adminCurrent!] = (counts[c.adminCurrent!] ?? 0) + 1;
  }
  return { counts, done, total: rows.length };
}

/**
 * "Send dashboard login": creates the agent's login from their Twenty record (email + phone-number
 * starter password, changed at first sign-in) and emails them. Re-sending only re-sends the email.
 */
export async function inviteAgent(u: CurrentUser, program: AgentProgramKey, recordId: string): Promise<string> {
  if (!env().TWENTY_WORKSPACE_ID) throw new HttpError(503, "The dashboard isn't connected to Twenty yet.");
  const c = await getTwentyContact(program, recordId);
  const email = normalizeEmail(c.email);
  const phone = starterPasswordFromPhone(c.phone);
  if (!email) throw new HttpError(400, `Add a valid email to this record in Twenty first.`);
  if (!phone.ok) throw new HttpError(400, phone.reason === "non_us" ? "The phone in Twenty isn't a U.S. number; the starter password is the phone number." : "Add a valid 10-digit U.S. phone to this record in Twenty first.");

  const [existing] = await db.select().from(schema.agent)
    .where(and(eq(schema.agent.twentyWorkspaceId, env().TWENTY_WORKSPACE_ID!), eq(schema.agent.twentyObject, PROGRAMS[program].twentyObject), eq(schema.agent.twentyRecordId, c.id)));
  if (existing?.userId) return resendAgentLogin(u, existing.id);

  const [taken] = await db.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).where(eq(schema.user.email, email));
  if (taken) {
    const [other] = await db.select({ program: schema.agent.program }).from(schema.agent).where(eq(schema.agent.userId, taken.id));
    throw new HttpError(409, isStaffRole(taken.role) ? "That email belongs to an admin account."
      : other ? `That email already has a ${PROGRAMS[other.program].label} login. One email can only be in one program.`
      : "That email already has an AIT dashboard login. One email can only be in one program.");
  }

  const hash = await (await auth().$context).password.hash(phone.starterPassword);
  const now = new Date();
  return db.transaction(async (tx) => {
    const userId = randomUUID();
    await tx.insert(schema.user).values({ id: userId, name: c.name, email, emailVerified: false, role: leadRoleFor(program, c.recruitType), mustChangePassword: true, createdAt: now, updatedAt: now });
    await tx.insert(schema.account).values({ id: randomUUID(), accountId: userId, providerId: "credential", userId, password: hash, createdAt: now, updatedAt: now });
    const values = {
      program, twentyWorkspaceId: env().TWENTY_WORKSPACE_ID!, twentyObject: PROGRAMS[program].twentyObject, twentyRecordId: c.id,
      userId, fullName: c.name, organization: c.organization, email, phoneE164: phone.e164, recruiter: c.recruiter,
      status: "active", welcomeStatus: "queued", invitedAt: now, invitedByUserId: u.id,
    };
    const [a] = existing
      ? await tx.update(schema.agent).set(values).where(eq(schema.agent.id, existing.id)).returning()
      : await tx.insert(schema.agent).values(values).returning();
    await audit(tx, { actorUserId: u.id, action: "agent.invited", targetType: "agent", targetId: a.id, metadata: { program, twentyRecordId: c.id } });
    await enqueue(tx, { eventType: "agent_welcome", dedupeKey: `agent_welcome:${a.id}`, payload: { agentId: a.id } });
    return a.id;
  });
}

export async function resendAgentLogin(u: CurrentUser, agentId: string): Promise<string> {
  const [a] = await db.select().from(schema.agent).where(eq(schema.agent.id, agentId));
  if (!a?.userId) throw new HttpError(404, "This contact has no dashboard login yet.");
  if (a.status !== "active") throw new HttpError(409, "Reactivate this contact first.");
  const n = (await db.select({ id: schema.auditEvent.id }).from(schema.auditEvent)
    .where(and(eq(schema.auditEvent.targetId, a.id), eq(schema.auditEvent.action, "agent.login_resent")))).length + 1;
  await db.transaction(async (tx) => {
    await tx.update(schema.agent).set({ welcomeStatus: "queued" }).where(eq(schema.agent.id, a.id));
    await audit(tx, { actorUserId: u.id, action: "agent.login_resent", targetType: "agent", targetId: a.id });
    await enqueue(tx, { eventType: "agent_welcome", dedupeKey: `agent_welcome:${a.id}:resend:${n}`, payload: { agentId: a.id, resend: true } });
  });
  return a.id;
}

export async function completeAgentStepTx(tx: DbOrTx, agentId: string, step: number, actorUserId: string | null, note?: string | null) {
  const [a] = await tx.select().from(schema.agent).where(eq(schema.agent.id, agentId)).for("update");
  if (!a) throw new HttpError(404, "Unknown contact.");
  const done = (await tx.select({ step: schema.agentStep.step }).from(schema.agentStep).where(eq(schema.agentStep.agentId, a.id))).map((s) => s.step);
  if (done.includes(step)) return false;
  const { current } = currentStep(done, PROGRAMS[a.program].steps.length);
  if (current !== step) throw new HttpError(409, `Step ${current ?? "–"} comes first.`);
  await tx.insert(schema.agentStep).values({ agentId: a.id, step, completedByUserId: actorUserId, note: note?.trim() || null });
  await audit(tx, { actorUserId, action: "agent.step_completed", targetType: "agent", targetId: a.id, metadata: { program: a.program, step } });
  await enqueue(tx, { eventType: "agent_step_completed", dedupeKey: `agent_step:${a.id}:${step}`, payload: { agentId: a.id, step } });
  return true;
}

/** Recruiters mark steps 2-6 (step 1 completes itself at the agent's first sign-in). */
export async function markAgentStep(u: CurrentUser, agentId: string, step: number, note: string | null) {
  if (step < 2) throw new HttpError(400, "Step 1 completes when they sign in and choose their password.");
  const [a] = await db.select({ status: schema.agent.status }).from(schema.agent).where(eq(schema.agent.id, agentId));
  if (a?.status !== "active") throw new HttpError(409, "Reactivate this contact first.");
  await db.transaction((tx) => completeAgentStepTx(tx, agentId, step, u.id, note));
}

/** Undo the most recent step (not step 1). Its admin email is cancelled if it hasn't gone out. */
export async function undoAgentStep(u: CurrentUser, agentId: string, reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required.");
  await db.transaction(async (tx) => {
    const [last] = await tx.select().from(schema.agentStep).where(eq(schema.agentStep.agentId, agentId)).orderBy(desc(schema.agentStep.step)).limit(1);
    if (!last || last.step < 2) throw new HttpError(409, "There's nothing to undo.");
    await tx.delete(schema.agentStep).where(eq(schema.agentStep.id, last.id));
    await tx.delete(schema.outbox).where(and(eq(schema.outbox.dedupeKey, `agent_step:${agentId}:${last.step}`), eq(schema.outbox.status, "pending")));
    await audit(tx, { actorUserId: u.id, action: "agent.step_undone", targetType: "agent", targetId: agentId, reason, metadata: { step: last.step } });
  });
}

export async function setAgentStatus(u: CurrentUser, agentId: string, status: "active" | "archived", reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required.");
  await db.transaction(async (tx) => {
    const [a] = await tx.update(schema.agent).set({ status }).where(eq(schema.agent.id, agentId)).returning();
    if (!a) throw new HttpError(404, "Unknown contact.");
    // An archived agent can't sign in; reactivating restores access.
    if (a.userId) await tx.update(schema.user).set({ banned: status === "archived", banReason: status === "archived" ? "Archived from the agent program" : null }).where(eq(schema.user.id, a.userId));
    await audit(tx, { actorUserId: u.id, action: `agent.${status}`, targetType: "agent", targetId: agentId, reason });
  });
}

/** First sign-in bookkeeping; a sign-in after password recovery also completes step 1. */
export async function onAgentSessionCreated(tx: DbOrTx, user: { id: string; mustChangePassword: boolean }, at: Date) {
  const [a] = await tx.select().from(schema.agent).where(eq(schema.agent.userId, user.id)).for("update");
  if (!a) return;
  await tx.update(schema.agent).set({ firstLoginAt: a.firstLoginAt ?? at, lastActivityAt: at }).where(eq(schema.agent.id, a.id));
  if (!user.mustChangePassword) await completeAgentStepTx(tx, a.id, 1, user.id);
}

/** The required first password change completes step 1. */
export async function onAgentPasswordChanged(tx: DbOrTx, userId: string) {
  const [a] = await tx.select({ id: schema.agent.id }).from(schema.agent).where(eq(schema.agent.userId, userId));
  if (a) await completeAgentStepTx(tx, a.id, 1, userId);
}

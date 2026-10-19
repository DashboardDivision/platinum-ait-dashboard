import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/domain/email";
import { starterPasswordFromPhone } from "@/domain/phone";
import { isLeadRole, isRoleKey, isStaffRole, LEAD_ROLES, ROLE_LABELS, STAFF_ROLES, type RoleKey } from "@/domain/roles";
import { PROGRAMS } from "@/domain/programs";
import { audit } from "./audit";
import { enqueue } from "./outbox";
import { needMaster, needPerm } from "./permissions";
import { HttpError, type CurrentUser } from "./session";

/** Raw SQL returns timestamps as Postgres text ("2026-10-06 15:34:23.1+00"); pages need real Dates. */
function asDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const iso = String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const d = new Date(iso);
  return Number.isNaN(+d) ? null : d;
}

/* ---------------------------------------------------------------- Users screen (Master Admin) */

export async function listUsers() {
  const res = await db.execute<{
    id: string; name: string; email: string; role: string; banned: boolean | null; must_change_password: boolean; created_at: Date;
    last_sign_in: Date | null; recruit_id: string | null; agent_id: string | null; agent_program: string | null;
  }>(sql`
    select u.id, u.name, u.email, u.role, u.banned, u.must_change_password, u.created_at,
      (select max(s.created_at) from session s where s.user_id = u.id) as last_sign_in,
      r.id as recruit_id, a.id as agent_id, a.program as agent_program
    from "user" u
    left join recruit r on r.user_id = u.id
    left join agent a on a.user_id = u.id
    order by case when u.role in ('master_admin','admin','admin_readonly') then 0 else 1 end, u.created_at desc`);
  return res.rows.map((x) => ({ ...x, created_at: asDate(x.created_at)!, last_sign_in: asDate(x.last_sign_in) }));
}

/** Staff accounts only: candidates get their logins from their AIT / Free Agent / Group Sell record. */
export async function createStaffUser(u: CurrentUser, input: { name: string; email: string; phone: string; role: string }) {
  needMaster(u);
  const name = input.name.trim().replace(/\s+/g, " ");
  const email = normalizeEmail(input.email);
  const phone = starterPasswordFromPhone(input.phone);
  if (!name) throw new HttpError(400, "Enter their name.");
  if (!email) throw new HttpError(400, "Enter a valid email address.");
  if (!phone.ok) throw new HttpError(400, "Enter a valid 10-digit U.S. mobile; it's their starter password.");
  if (!isRoleKey(input.role) || !isStaffRole(input.role)) throw new HttpError(400, "Pick a staff role. Candidate logins are created from their record.");
  const [taken] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
  if (taken) throw new HttpError(409, "An account with that email already exists.");
  const hash = await (await auth().$context).password.hash(phone.starterPassword);
  const now = new Date();
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(schema.user).values({ id, name, email, role: input.role, phoneE164: phone.e164, emailVerified: false, mustChangePassword: true, createdAt: now, updatedAt: now });
    await tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: now, updatedAt: now });
    await audit(tx, { actorUserId: u.id, action: "user.created", targetType: "user", targetId: id, metadata: { email, role: input.role } });
    await enqueue(tx, { eventType: "staff_welcome", dedupeKey: `staff_welcome:${id}`, payload: { userId: id } });
  });
  return id;
}

export async function setUserRole(u: CurrentUser, userId: string, role: string) {
  needMaster(u);
  if (userId === u.id) throw new HttpError(400, "You can't change your own role.");
  if (!isRoleKey(role)) throw new HttpError(400, "Unknown role.");
  const [t] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
  if (!t) throw new HttpError(404, "Unknown user.");
  const sameFamily = (isStaffRole(t.role) && isStaffRole(role)) || (isLeadRole(t.role) && LEAD_ROLES.includes(role));
  if (!sameFamily) throw new HttpError(400, isStaffRole(t.role) ? "Staff accounts can only move between staff roles." : t.role === "recruit" ? "AIT Recruit accounts keep their role." : "Lead accounts can only move between the three lead roles.");
  await db.transaction(async (tx) => {
    await tx.update(schema.user).set({ role }).where(eq(schema.user.id, userId));
    await audit(tx, { actorUserId: u.id, action: "user.role_changed", targetType: "user", targetId: userId, metadata: { from: t.role, to: role } });
  });
}

export async function setUserActive(u: CurrentUser, userId: string, active: boolean, reason: string) {
  needMaster(u);
  if (userId === u.id) throw new HttpError(400, "You can't deactivate yourself.");
  if (!reason.trim()) throw new HttpError(400, "A reason is required.");
  await db.transaction(async (tx) => {
    const [t] = await tx.update(schema.user).set({ banned: !active, banReason: active ? null : reason.trim() }).where(eq(schema.user.id, userId)).returning();
    if (!t) throw new HttpError(404, "Unknown user.");
    if (!active) await tx.delete(schema.session).where(eq(schema.session.userId, userId));
    await audit(tx, { actorUserId: u.id, action: active ? "user.reactivated" : "user.deactivated", targetType: "user", targetId: userId, reason });
  });
}

/** Staff accounts. Candidates are deleted from their record so their enrollment goes with them. */
export async function deleteStaffUser(u: CurrentUser, userId: string, confirm: string) {
  needMaster(u);
  if (userId === u.id) throw new HttpError(400, "You can't delete your own account.");
  const [t] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
  if (!t) throw new HttpError(404, "Unknown user.");
  if (!isStaffRole(t.role)) throw new HttpError(400, "Delete candidates from their record page so their enrollment is removed too.");
  if (confirm.trim().toLowerCase() !== t.email.toLowerCase()) throw new HttpError(400, "Type their email exactly to confirm.");
  await db.transaction(async (tx) => {
    await audit(tx, { actorUserId: u.id, action: "user.deleted", targetType: "user", targetId: userId, metadata: { name: t.name, email: t.email, role: t.role } });
    await tx.delete(schema.user).where(eq(schema.user.id, userId));
  });
}

/* ---------------------------------------------------------------- permanent deletes */

async function deleteInTwenty(plural: string, recordId: string) {
  if (!env().TWENTY_API_KEY) return "not connected";
  const res = await fetch(`${env().TWENTY_URL.replace(/\/$/, "")}/rest/${plural}/${recordId}`, {
    method: "DELETE", headers: { authorization: `Bearer ${env().TWENTY_API_KEY}` }, signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  return res?.ok ? "deleted" : res?.status === 404 ? "already gone" : `failed (${res?.status ?? "no answer"})`;
}

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** Permanently removes an AIT recruit, their dashboard login, documents and history rows. The audit entry stays. */
export async function deleteRecruit(u: CurrentUser, recruitId: string, confirm: string, alsoTwenty: boolean) {
  needPerm(u, "ait.delete");
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, recruitId));
  if (!r) throw new HttpError(404, "Unknown recruit.");
  if (!sameName(confirm, r.fullName)) throw new HttpError(400, `Type "${r.fullName}" exactly to confirm.`);
  const docs = await db.select({ key: schema.document.storageKey }).from(schema.document).where(eq(schema.document.recruitId, r.id));
  await db.transaction(async (tx) => {
    await audit(tx, { actorUserId: u.id, action: "recruit.deleted", targetType: "recruit", targetId: r.id,
      metadata: { name: r.fullName, email: r.email, twentyRecordId: r.twentyRecordId, documents: docs.length, alsoTwenty } });
    await tx.delete(schema.recruit).where(eq(schema.recruit.id, r.id));
    if (r.userId) {
      const [acct] = await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, r.userId));
      if (acct && !isStaffRole(acct.role)) await tx.delete(schema.user).where(eq(schema.user.id, r.userId));
    }
  });
  for (const d of docs) await unlink(path.join(env().DOCUMENT_DIR, d.key)).catch(() => undefined);
  const twenty = alsoTwenty ? await deleteInTwenty("platinumAits", r.twentyRecordId) : "kept";
  return `Deleted ${r.fullName}. Twenty record: ${twenty}. Their study-site account, if any, isn't removed.`;
}

export async function deleteAgent(u: CurrentUser, agentId: string, confirm: string, alsoTwenty: boolean) {
  const [a] = await db.select().from(schema.agent).where(eq(schema.agent.id, agentId));
  if (!a) throw new HttpError(404, "Unknown contact.");
  needPerm(u, `${a.program}.delete`);
  if (!sameName(confirm, a.fullName)) throw new HttpError(400, `Type "${a.fullName}" exactly to confirm.`);
  await db.transaction(async (tx) => {
    await audit(tx, { actorUserId: u.id, action: "agent.deleted", targetType: "agent", targetId: a.id,
      metadata: { name: a.fullName, email: a.email, program: a.program, twentyRecordId: a.twentyRecordId, alsoTwenty } });
    await tx.delete(schema.agent).where(eq(schema.agent.id, a.id));
    if (a.userId) {
      const [acct] = await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, a.userId));
      if (acct && !isStaffRole(acct.role)) await tx.delete(schema.user).where(eq(schema.user.id, a.userId));
    }
  });
  const twenty = alsoTwenty ? await deleteInTwenty(PROGRAMS[a.program].twentyPlural, a.twentyRecordId) : "kept";
  return { program: a.program, message: `Deleted ${a.fullName}. Twenty record: ${twenty}.` };
}

/* ---------------------------------------------------------------- audit log */

export type AuditFilters = { q?: string; actor?: string; type?: string; from?: string; to?: string; page?: string };
export const AUDIT_PAGE = 50;

export async function listAudit(f: AuditFilters, limit = AUDIT_PAGE) {
  const where = [sql`true`];
  if (f.q?.trim()) where.push(sql`(a.action ilike ${`%${f.q.trim()}%`} or coalesce(a.reason,'') ilike ${`%${f.q.trim()}%`} or a.target_id = ${f.q.trim()})`);
  if (f.actor === "system") where.push(sql`a.actor_user_id is null`);
  else if (f.actor) where.push(sql`a.actor_user_id = ${f.actor}`);
  if (f.type) where.push(sql`a.target_type = ${f.type}`);
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) where.push(sql`a.at >= ${f.from}::date`);
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) where.push(sql`a.at < (${f.to}::date + 1)`);
  const page = Math.max(1, Number(f.page) || 1);
  const res = await db.execute<{
    id: string; at: Date; action: string; target_type: string; target_id: string | null; reason: string | null; metadata: Record<string, unknown> | null;
    actor_name: string | null; actor_email: string | null; actor_role: string | null; impersonator_name: string | null; total: number;
  }>(sql`
    select a.id, a.at, a.action, a.target_type, a.target_id, a.reason, a.metadata,
      au.name as actor_name, au.email as actor_email, au.role as actor_role, iu.name as impersonator_name,
      count(*) over()::int as total
    from audit_event a
    left join "user" au on au.id = a.actor_user_id
    left join "user" iu on iu.id = a.impersonator_user_id
    where ${sql.join(where, sql` and `)}
    order by a.at desc
    limit ${limit} offset ${(page - 1) * limit}`);
  return { rows: res.rows.map((x) => ({ ...x, at: asDate(x.at)! })), total: res.rows[0]?.total ?? 0, page };
}

export async function auditActors() {
  return db.select({ id: schema.user.id, name: schema.user.name, role: schema.user.role }).from(schema.user)
    .where(sql`${schema.user.role} in ('master_admin','admin','admin_readonly')`).orderBy(desc(schema.user.createdAt));
}

export const roleLabel = (r: string) => (isRoleKey(r) ? ROLE_LABELS[r as RoleKey] : r === "agent" ? "Agent" : r);
export { STAFF_ROLES, LEAD_ROLES };

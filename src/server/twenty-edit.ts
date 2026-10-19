import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/domain/email";
import { PROGRAMS, type AgentProgramKey } from "@/domain/programs";
import { audit } from "./audit";
import { enqueue } from "./outbox";
import { needPerm } from "./permissions";
import { HttpError, type CurrentUser } from "./session";

/**
 * Edit a prospect's Twenty record from the dashboard: every field on Platinum AIT, Platinum Recruiting
 * or Platinum Legacy (automation bookkeeping excluded). Twenty stays the source of truth; the
 * dashboard's own copy (name, email, phone, recruiter, agency) and a linked login's email follow.
 */

export type FieldType = "TEXT" | "NUMBER" | "CURRENCY" | "DATE" | "DATE_TIME" | "SELECT" | "BOOLEAN" | "RICH_TEXT" | "EMAILS" | "PHONES";
export type TwentyField = { name: string; label: string; type: FieldType; nullable: boolean; readOnly: boolean; options: { value: string; label: string }[] };

const SUPPORTED = new Set<string>(["TEXT", "NUMBER", "CURRENCY", "DATE", "DATE_TIME", "SELECT", "BOOLEAN", "RICH_TEXT", "EMAILS", "PHONES"]);
const HIDDEN = new Set(["automationStatus", "lastAutomationAt", "automationError", "n8nExecutionId"]);
const READ_ONLY = new Set(["sourceSystem", "sourceRecordId"]);
const FIRST = ["name", "ownerName", "emails", "phones", "stage", "recruiter", "recruitType"];
export const TZ = "America/Denver";

export type Target = { kind: "ait"; id: string } | { kind: "agent"; id: string };

async function twenty(path: string, init: RequestInit = {}) {
  if (!env().TWENTY_API_KEY) throw new HttpError(503, "The dashboard isn't connected to Twenty yet.");
  const res = await fetch(`${env().TWENTY_URL.replace(/\/$/, "")}/rest/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env().TWENTY_API_KEY}`, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = Array.isArray(body.messages) ? body.messages.join(" ") : String(body.error ?? res.status);
    throw new HttpError(502, `Twenty didn't accept that: ${msg.slice(0, 200)}`);
  }
  return body;
}

let metaCache: { at: number; objects: Record<string, TwentyField[]> } | null = null;
/** Field definitions per object, from Twenty's metadata (cached 5 minutes so new Twenty fields appear on their own). */
export async function fieldsFor(plural: string): Promise<TwentyField[]> {
  if (!metaCache || Date.now() - metaCache.at > 5 * 60_000) {
    const body = await twenty("metadata/objects?limit=200");
    const data = (body as { data?: unknown }).data;
    const list = (Array.isArray(data) ? data : (data as { objects?: unknown[] })?.objects ?? []) as {
      namePlural: string; fields: { name: string; label: string; type: string; isSystem?: boolean; isActive?: boolean; isNullable?: boolean; options?: { value: string; label: string; position?: number }[] }[];
    }[];
    const objects: Record<string, TwentyField[]> = {};
    for (const o of list) {
      const fs = o.fields
        .filter((f) => !f.isSystem && f.isActive !== false && SUPPORTED.has(f.type) && !HIDDEN.has(f.name))
        .map((f) => ({
          name: f.name, label: f.label, type: f.type as FieldType, nullable: f.isNullable !== false, readOnly: READ_ONLY.has(f.name),
          options: [...(f.options ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((x) => ({ value: x.value, label: x.label })),
        }));
      fs.sort((a, b) => {
        const ia = FIRST.indexOf(a.name), ib = FIRST.indexOf(b.name);
        const ra = a.type === "RICH_TEXT" ? 2 : a.readOnly ? 1.5 : ia >= 0 ? 0 : 1, rb = b.type === "RICH_TEXT" ? 2 : b.readOnly ? 1.5 : ib >= 0 ? 0 : 1;
        return ra - rb || (ia >= 0 && ib >= 0 ? ia - ib : 0);
      });
      objects[o.namePlural] = fs;
    }
    metaCache = { at: Date.now(), objects };
  }
  const fs = metaCache.objects[plural];
  if (!fs) throw new HttpError(502, "Twenty didn't describe this record type.");
  return fs;
}

/* ---------------------------------------------------------------- value conversions */

/** Wall-clock time in Denver for an instant, as "YYYY-MM-DDTHH:mm" (for datetime-local inputs). */
export function toDenverLocal(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** "YYYY-MM-DDTHH:mm" in Denver → UTC ISO. */
export function fromDenverLocal(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const shown = toDenverLocal(new Date(guess).toISOString());
    const sm = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(shown)!;
    guess += wall - Date.UTC(+sm[1], +sm[2] - 1, +sm[3], +sm[4], +sm[5]);
  }
  return new Date(guess).toISOString();
}

/** Plain text → Twenty rich text (Markdown + BlockNote JSON, so it shows in Twenty's editor). */
export function toRichText(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = lines.map((line) => ({
    id: randomUUID(), type: "paragraph", props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
    content: line ? [{ type: "text", text: line, styles: {} }] : [], children: [],
  }));
  return { markdown: text.trim() ? lines.join("\n") : "", blocknote: text.trim() ? JSON.stringify(blocks) : null };
}

/** Comparable, form-friendly value for each field type. */
export function displayValue(f: TwentyField, v: unknown): string {
  if (v == null) return "";
  switch (f.type) {
    case "EMAILS": return String((v as { primaryEmail?: string }).primaryEmail ?? "");
    case "PHONES": {
      const p = v as { primaryPhoneNumber?: string; primaryPhoneCallingCode?: string };
      return p.primaryPhoneNumber ? `${p.primaryPhoneCallingCode && p.primaryPhoneCallingCode !== "+1" ? `${p.primaryPhoneCallingCode} ` : ""}${p.primaryPhoneNumber}` : "";
    }
    case "CURRENCY": { const micros = (v as { amountMicros?: number | null }).amountMicros; return micros == null ? "" : String(Math.round(micros / 10_000) / 100); }
    case "RICH_TEXT": return String((v as { markdown?: string | null }).markdown ?? "");
    case "BOOLEAN": return v ? "true" : "false";
    case "DATE_TIME": return toDenverLocal(String(v));
    case "DATE": return String(v).slice(0, 10);
    default: return String(v);
  }
}

/** Form value → Twenty value (or an error message). */
function toTwenty(f: TwentyField, raw: string, current: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const s = raw.trim();
  switch (f.type) {
    case "TEXT": return { ok: true, value: s };
    case "NUMBER": {
      if (!s) return { ok: true, value: null };
      const n = Number(s.replace(/,/g, ""));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `${f.label}: enter a number` };
    }
    case "CURRENCY": {
      const code = (current as { currencyCode?: string } | null)?.currencyCode || "USD";
      if (!s) return { ok: true, value: { amountMicros: null, currencyCode: code } };
      const n = Number(s.replace(/[$,\s]/g, ""));
      return Number.isFinite(n) ? { ok: true, value: { amountMicros: Math.round(n * 1_000_000), currencyCode: code } } : { ok: false, error: `${f.label}: enter an amount like 125000` };
    }
    case "DATE":
      if (!s) return { ok: true, value: null };
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? { ok: true, value: s } : { ok: false, error: `${f.label}: pick a date` };
    case "DATE_TIME": {
      if (!s) return { ok: true, value: null };
      const iso = fromDenverLocal(s);
      return iso ? { ok: true, value: iso } : { ok: false, error: `${f.label}: pick a date and time` };
    }
    case "SELECT":
      if (!s) return f.nullable ? { ok: true, value: null } : { ok: false, error: `${f.label} is required` };
      return f.options.some((o) => o.value === s) ? { ok: true, value: s } : { ok: false, error: `${f.label}: unknown choice` };
    case "BOOLEAN": return { ok: true, value: s === "true" };
    case "RICH_TEXT": return { ok: true, value: toRichText(raw) };
    case "EMAILS": {
      if (!s) return { ok: true, value: { primaryEmail: "", additionalEmails: (current as { additionalEmails?: unknown })?.additionalEmails ?? [] } };
      const e = normalizeEmail(s);
      return e ? { ok: true, value: { primaryEmail: e, additionalEmails: (current as { additionalEmails?: unknown })?.additionalEmails ?? [] } } : { ok: false, error: "Enter a valid email address" };
    }
    case "PHONES": {
      const extra = (current as { additionalPhones?: unknown })?.additionalPhones ?? [];
      if (!s) return { ok: true, value: { primaryPhoneNumber: "", primaryPhoneCountryCode: "", primaryPhoneCallingCode: "", additionalPhones: extra } };
      const p = parsePhoneNumberFromString(s, "US");
      if (!p?.isValid()) return { ok: false, error: "Enter a valid phone number" };
      return { ok: true, value: { primaryPhoneNumber: p.nationalNumber.toString(), primaryPhoneCountryCode: p.country ?? "US", primaryPhoneCallingCode: `+${p.countryCallingCode}`, additionalPhones: extra } };
    }
  }
}

/* ---------------------------------------------------------------- read + save */

async function resolve(target: Target) {
  if (target.kind === "ait") {
    const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, target.id));
    if (!r) throw new HttpError(404, "Unknown recruit.");
    return { perm: "ait", plural: "platinumAits", singular: "platinumAit", recordId: r.twentyRecordId, userId: r.userId, recruit: r, agent: null, program: null as AgentProgramKey | null };
  }
  const [a] = await db.select().from(schema.agent).where(eq(schema.agent.id, target.id));
  if (!a) throw new HttpError(404, "Unknown contact.");
  const p = PROGRAMS[a.program];
  return { perm: a.program, plural: p.twentyPlural, singular: p.twentyObject, recordId: a.twentyRecordId, userId: a.userId, recruit: null, agent: a, program: a.program };
}

export async function loadTwentyDetails(target: Target) {
  const t = await resolve(target);
  const [fields, body] = await Promise.all([fieldsFor(t.plural), twenty(`${t.plural}/${t.recordId}`)]);
  const record = (body.data as Record<string, Record<string, unknown>> | undefined)?.[t.singular];
  if (!record) throw new HttpError(404, "This record isn't in Twenty anymore.");
  return { fields, record, twentyUrl: `${env().TWENTY_URL.replace(/\/$/, "")}/object/${t.singular}/${t.recordId}`, perm: t.perm };
}

const short = (v: unknown) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? null); return s.length > 140 ? `${s.slice(0, 140)}…` : s; };

/**
 * Saves the changed fields to Twenty. The dashboard copy (and a linked login's email) is updated first and
 * restored if Twenty refuses, so Twenty's own update webhook never sees a mismatch.
 */
export async function saveTwentyDetails(u: CurrentUser, target: Target, form: Map<string, string>) {
  const t = await resolve(target);
  needPerm(u, `${t.perm}.edit`);
  const { fields, record } = await loadTwentyDetails(target);
  const patch: Record<string, unknown> = {};
  const changes: Record<string, { from: string; to: string }> = {};
  const errors: string[] = [];
  for (const f of fields) {
    if (f.readOnly || !form.has(f.name)) continue;
    const before = displayValue(f, record[f.name]);
    const raw = form.get(f.name)!;
    if (raw.trim() === before.trim() && f.type !== "BOOLEAN") continue;
    if (f.type === "BOOLEAN" && raw === before) continue;
    const conv = toTwenty(f, raw, record[f.name]);
    if (!conv.ok) { errors.push(conv.error); continue; }
    patch[f.name] = conv.value;
    changes[f.name] = { from: short(before), to: short(displayValue(f, conv.value)) };
  }
  if (errors.length) throw new HttpError(400, errors.join(". "));
  if (!Object.keys(patch).length) return "Nothing changed.";

  // What the dashboard keeps locally.
  const email = "emails" in patch ? normalizeEmail((patch.emails as { primaryEmail: string }).primaryEmail) : undefined;
  const phoneObj = "phones" in patch ? (patch.phones as { primaryPhoneNumber: string; primaryPhoneCallingCode: string }) : undefined;
  const phone = phoneObj ? (phoneObj.primaryPhoneNumber ? `${phoneObj.primaryPhoneCallingCode}${phoneObj.primaryPhoneNumber}` : null) : undefined;
  if (email === null && t.userId) throw new HttpError(400, "This person has a dashboard login, so they need an email.");
  const groupSell = t.program === "group_sell";
  const personName = groupSell ? ("ownerName" in patch ? String(patch.ownerName ?? "").trim() : undefined) : ("name" in patch ? String(patch.name ?? "").trim() : undefined);
  const org = groupSell ? ("name" in patch ? String(patch.name ?? "").trim() : undefined) : ("currentOrganization" in patch ? String(patch.currentOrganization ?? "").trim() : undefined);
  const recruiter = "recruiter" in patch ? (patch.recruiter as string | null) : undefined;

  let oldUser: typeof schema.user.$inferSelect | null = null;
  if (t.userId) [oldUser] = await db.select().from(schema.user).where(eq(schema.user.id, t.userId));
  const emailChanges = Boolean(email && oldUser && email !== oldUser.email);
  if (emailChanges) {
    const [taken] = await db.select({ id: schema.user.id }).from(schema.user).where(and(eq(schema.user.email, email!), ne(schema.user.id, oldUser!.id)));
    if (taken) throw new HttpError(409, "Another dashboard account already uses that email.");
  }

  const before = { recruit: t.recruit, agent: t.agent, user: oldUser };
  const noticeKey = `login_email_changed:${oldUser?.id ?? "-"}:${randomUUID()}`;
  await db.transaction(async (tx) => {
    if (t.recruit) {
      const set: Partial<typeof schema.recruit.$inferInsert> = {};
      if (personName) set.fullName = personName;
      if (email) set.email = email;
      if (phone !== undefined) set.phoneE164 = phone;
      if (Object.keys(set).length) await tx.update(schema.recruit).set(set).where(eq(schema.recruit.id, t.recruit.id));
    }
    if (t.agent) {
      const set: Partial<typeof schema.agent.$inferInsert> = {};
      if (personName) set.fullName = personName;
      if (org !== undefined) set.organization = org || null;
      if (email) set.email = email;
      if (phone !== undefined) set.phoneE164 = phone;
      if (recruiter !== undefined) set.recruiter = recruiter;
      if (Object.keys(set).length) await tx.update(schema.agent).set(set).where(eq(schema.agent.id, t.agent.id));
    }
    if (oldUser && (emailChanges || personName)) {
      await tx.update(schema.user).set({ ...(emailChanges ? { email: email! } : {}), ...(personName ? { name: personName } : {}) }).where(eq(schema.user.id, oldUser.id));
    }
    if (emailChanges) {
      await enqueue(tx, { eventType: "login_email_changed", dedupeKey: noticeKey, payload: { userId: oldUser!.id, oldEmail: oldUser!.email, newEmail: email } });
    }
    await audit(tx, { actorUserId: u.id, action: "twenty.record_updated", targetType: target.kind === "ait" ? "recruit" : "agent", targetId: target.id,
      metadata: { object: t.singular, twentyRecordId: t.recordId, changes, loginEmailChanged: emailChanges } });
  });

  try {
    await twenty(`${t.plural}/${t.recordId}`, { method: "PATCH", body: JSON.stringify(patch) });
  } catch (e) {
    // Twenty refused: put the dashboard copy back exactly as it was.
    await db.transaction(async (tx) => {
      if (before.recruit) await tx.update(schema.recruit).set({ fullName: before.recruit.fullName, email: before.recruit.email, phoneE164: before.recruit.phoneE164 }).where(eq(schema.recruit.id, before.recruit.id));
      if (before.agent) await tx.update(schema.agent).set({ fullName: before.agent.fullName, organization: before.agent.organization, email: before.agent.email, phoneE164: before.agent.phoneE164, recruiter: before.agent.recruiter }).where(eq(schema.agent.id, before.agent.id));
      if (before.user) await tx.update(schema.user).set({ email: before.user.email, name: before.user.name }).where(eq(schema.user.id, before.user.id));
      await tx.delete(schema.outbox).where(and(eq(schema.outbox.dedupeKey, noticeKey), eq(schema.outbox.status, "pending")));
      await audit(tx, { actorUserId: u.id, action: "twenty.update_failed", targetType: target.kind === "ait" ? "recruit" : "agent", targetId: target.id, metadata: { fields: Object.keys(patch) } });
    });
    throw e;
  }
  const n = Object.keys(patch).length;
  return `Saved ${n} field${n === 1 ? "" : "s"} to Twenty.${emailChanges ? " Their sign-in email changed too; both addresses were notified." : ""}`;
}

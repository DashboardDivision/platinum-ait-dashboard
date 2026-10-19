import { eq, inArray } from "drizzle-orm";
import { isStaffRole } from "@/domain/roles";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/domain/email";
import { starterPasswordFromPhone } from "@/domain/phone";
import { HttpError, type CurrentUser } from "./session";
import { provisionFromTwenty } from "./provisioning";
import { RECRUITERS, twenty } from "./new-recruit";
import { audit } from "./audit";

/** Free PIE study-site signups that the PIE account service puts in Twenty as Platinum Recruiting leads. */
const PIE_SOURCE_SYSTEM = "PIE";

type TwentyLead = {
  id: string;
  name?: string | null;
  createdAt?: string | null;
  sourceSystem?: string | null;
  sourceRecordId?: string | null;
  states?: string | null;
  recruiter?: string | null;
  emails?: { primaryEmail?: string | null } | null;
  phones?: { primaryPhoneNumber?: string | null; primaryPhoneCallingCode?: string | null } | null;
};

export type PieLead = {
  leadId: string;
  name: string;
  email: string | null;
  phone: string | null;
  state: string | null;
  signedUpAt: string | null;
  /** The AIT recruit already enrolled with this email, if any. */
  recruitId: string | null;
};

function leadPhone(l: TwentyLead) {
  const n = l.phones?.primaryPhoneNumber?.trim();
  return n ? `${l.phones?.primaryPhoneCallingCode || "+1"}${n}` : null;
}

export function pieLeadsConnected() {
  return Boolean(env().TWENTY_API_KEY && env().TWENTY_WORKSPACE_ID);
}

/** Newest PIE signups from Twenty, each with whether an AIT dashboard already exists for that email. */
export async function listPieLeads(limit = 25): Promise<PieLead[]> {
  const q = new URLSearchParams({ filter: `sourceSystem[eq]:"${PIE_SOURCE_SYSTEM}"`, order_by: "createdAt[DescNullsLast]", limit: String(limit) });
  const body = await twenty(`platinumRecruitings?${q}`);
  const leads = ((body.data as { platinumRecruitings?: TwentyLead[] })?.platinumRecruitings ?? []);
  const emails = leads.map((l) => normalizeEmail(l.emails?.primaryEmail)).filter((e): e is string => Boolean(e));
  const enrolled = emails.length
    ? await db.select({ id: schema.recruit.id, email: schema.recruit.email }).from(schema.recruit).where(inArray(schema.recruit.email, emails))
    : [];
  return leads.map((l) => {
    const email = normalizeEmail(l.emails?.primaryEmail);
    return {
      leadId: l.id,
      name: (l.name ?? "").trim() || "(no name)",
      email,
      phone: leadPhone(l),
      state: (l.states ?? "").split(",")[0].trim() || null,
      signedUpAt: l.createdAt ?? null,
      recruitId: enrolled.find((e) => e.email === email)?.id ?? null,
    };
  });
}

/**
 * "Create AIT dashboard" on a PIE signup: adds the Platinum AIT record in Twenty (the source of truth)
 * and runs the normal provisioning, with two differences. The learner's existing PIE study account is
 * linked rather than a new one created, and the welcome goes by email only, never by text.
 */
export async function createAitFromPieLead(u: CurrentUser, leadId: string): Promise<string> {
  if (!pieLeadsConnected()) throw new HttpError(503, "The dashboard isn't connected to Twenty yet.");
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) throw new HttpError(400, "Unknown PIE signup.");
  const got = await twenty(`platinumRecruitings/${leadId}`);
  const lead = (got.data as { platinumRecruiting?: TwentyLead })?.platinumRecruiting;
  if (!lead || lead.sourceSystem !== PIE_SOURCE_SYSTEM || !lead.sourceRecordId) throw new HttpError(404, "That isn't a PIE signup in Twenty.");

  const name = (lead.name ?? "").trim().replace(/\s+/g, " ");
  const email = normalizeEmail(lead.emails?.primaryEmail);
  const phone = starterPasswordFromPhone(leadPhone(lead));
  if (!name) throw new HttpError(400, "This signup has no name in Twenty. Add it there first.");
  if (!email) throw new HttpError(400, "This signup has no valid email in Twenty. Fix it there first.");
  if (!phone.ok) throw new HttpError(400, "This signup needs a valid U.S. mobile number in Twenty first; the temporary dashboard password is the phone number.");

  const [enrolled] = await db.select({ id: schema.recruit.id }).from(schema.recruit).where(eq(schema.recruit.email, email));
  if (enrolled) throw new HttpError(409, "This person already has an AIT dashboard. Open their record from the recruits list.");
  const [account] = await db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.email, email));
  if (account) throw new HttpError(409, isStaffRole(account.role) ? "That email belongs to an admin account." : "A dashboard account already uses that email.");
  const found = await twenty(`platinumAits?limit=1&filter=${encodeURIComponent(`emails.primaryEmail[ilike]:"${email}"`)}`);
  if (((found.data as { platinumAits?: unknown[] })?.platinumAits ?? []).length) {
    throw new HttpError(409, "Twenty already has a Platinum AIT record with this email. Check it there instead of adding a duplicate.");
  }

  const recruiter = RECRUITERS.find((r) => r === (lead.recruiter ?? "").toUpperCase()) ?? "COLTON";
  const created = await twenty("platinumAits", {
    method: "POST",
    body: JSON.stringify({
      name,
      emails: { primaryEmail: email },
      phones: { primaryPhoneNumber: phone.e164.slice(2), primaryPhoneCountryCode: "US", primaryPhoneCallingCode: "+1" },
      stage: "APPLICANT",
      sourceSystem: PIE_SOURCE_SYSTEM,
      sourceRecordId: lead.id,
      recruiter,
    }),
  });
  const rec = (created.data as { createPlatinumAit?: { id: string; createdAt?: string } })?.createPlatinumAit;
  if (!rec?.id) throw new HttpError(502, "Twenty didn't return the new record.");

  const out = await provisionFromTwenty({
    workspaceId: env().TWENTY_WORKSPACE_ID!,
    object: "platinumAit",
    recordId: rec.id,
    eventId: `pie-create:${rec.id}`,
    record: { name, email, phone: phone.e164, stage: "APPLICANT", createdAt: rec.createdAt ?? new Date().toISOString() },
    pie: { studyAccountId: lead.sourceRecordId },
  });
  if (!out.recruitId) throw new HttpError(500, `Added to Twenty, but enrollment didn't start: ${out.detail ?? "unknown reason"}`);
  await audit(db, { actorUserId: u.id, action: "recruit.created_from_pie", targetType: "recruit", targetId: out.recruitId, metadata: { twentyRecordId: rec.id, pieLeadId: lead.id, dashboard: out.dashboard } });
  return out.recruitId;
}

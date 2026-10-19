import { eq } from "drizzle-orm";
import { isStaffRole } from "@/domain/roles";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/domain/email";
import { starterPasswordFromPhone } from "@/domain/phone";
import { HttpError, type CurrentUser } from "./session";
import { provisionFromTwenty } from "./provisioning";
import { audit } from "./audit";

export const RECRUITERS = ["COLTON", "JESSE", "PARKER"] as const;

export type NewRecruitInput = { name: string; email: string; phone: string; recruiter: string };

export async function twenty(path: string, init: RequestInit = {}) {
  const res = await fetch(`${env().TWENTY_URL.replace(/\/$/, "")}/rest/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env().TWENTY_API_KEY}`, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = Array.isArray(body.messages) ? body.messages.join(" ") : String(body.error ?? res.status);
    throw new HttpError(502, `Twenty didn't accept that: ${msg.slice(0, 200)}`);
  }
  return body;
}

/**
 * "+ Add New Recruit": creates the Platinum AIT record in Twenty (the source of truth), then runs the
 * same provisioning the Twenty webhook runs, so accounts and the welcome go out right away. The webhook
 * that follows finds the recruit already enrolled and changes nothing.
 */
export async function addRecruitFromDashboard(u: CurrentUser, input: NewRecruitInput): Promise<string> {
  if (!env().TWENTY_API_KEY || !env().TWENTY_WORKSPACE_ID) throw new HttpError(503, "Adding recruits isn't connected to Twenty yet.");
  const name = input.name.trim().replace(/\s+/g, " ");
  const email = normalizeEmail(input.email);
  const phone = starterPasswordFromPhone(input.phone);
  if (!name || !name.includes(" ")) throw new HttpError(400, "Enter the recruit's first and last name.");
  if (!email) throw new HttpError(400, "Enter a valid email address.");
  if (!phone.ok) throw new HttpError(400, phone.reason === "non_us" ? "Use a U.S. mobile number; the starter password is the phone number." : "Enter a valid 10-digit U.S. mobile number.");
  const recruiter = RECRUITERS.find((r) => r === input.recruiter.toUpperCase()) ?? null;

  const [enrolled] = await db.select({ id: schema.recruit.id }).from(schema.recruit).where(eq(schema.recruit.email, email));
  if (enrolled) throw new HttpError(409, "That email is already enrolled. Open their record from the recruits list.");
  const [account] = await db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.email, email));
  if (account) throw new HttpError(409, isStaffRole(account.role) ? "That email belongs to an admin account." : "A dashboard account already uses that email.");
  const found = await twenty(`platinumAits?limit=1&filter=${encodeURIComponent(`emails.primaryEmail[ilike]:"${email}"`)}`);
  if (((found.data as { platinumAits?: unknown[] })?.platinumAits ?? []).length) {
    throw new HttpError(409, "Twenty already has a Platinum AIT record with that email. Check it there instead of adding a duplicate.");
  }

  const created = await twenty("platinumAits", {
    method: "POST",
    body: JSON.stringify({
      name,
      emails: { primaryEmail: email },
      phones: { primaryPhoneNumber: phone.e164.slice(2), primaryPhoneCountryCode: "US", primaryPhoneCallingCode: "+1" },
      stage: "APPLICANT",
      sourceSystem: "ait.getstrategic.vip",
      ...(recruiter ? { recruiter } : {}),
    }),
  });
  const rec = (created.data as { createPlatinumAit?: { id: string; createdAt?: string } })?.createPlatinumAit;
  if (!rec?.id) throw new HttpError(502, "Twenty didn't return the new record.");

  const out = await provisionFromTwenty({
    workspaceId: env().TWENTY_WORKSPACE_ID!,
    object: "platinumAit",
    recordId: rec.id,
    eventId: `admin-add:${rec.id}`,
    record: { name, email, phone: phone.e164, stage: "APPLICANT", createdAt: rec.createdAt ?? new Date().toISOString() },
  });
  if (!out.recruitId) throw new HttpError(500, `Added to Twenty, but enrollment didn't start: ${out.detail ?? "unknown reason"}`);
  await audit(db, { actorUserId: u.id, action: "recruit.added_from_dashboard", targetType: "recruit", targetId: out.recruitId, metadata: { twentyRecordId: rec.id, dashboard: out.dashboard, education: out.education } });
  return out.recruitId;
}

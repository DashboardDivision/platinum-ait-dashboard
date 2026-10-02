import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { formatCents } from "@/domain/money";
import { stageTitle, STAGES } from "@/domain/stages";
import { milestoneLabel } from "./production";
import { getSetting } from "./settings";
import { nextSmsWindowStart, withinSmsWindow } from "@/domain/durations";
import { completeOutbox, deferToWindow } from "./outbox";

export type OutgoingMessage = {
  channel: "email" | "sms";
  to: string;
  subject?: string;
  text: string;
  /** Per event + recipient + channel; n8n must not send a key already marked sent. */
  dedupeKey: string;
  purpose: string;
  required: boolean;
  /** SMS outside quiet hours is deferred, not dropped. */
  deferUntilWindow?: boolean;
};

/** Admin notification toggles. Required operational and security mail ignores them. */
export const ADMIN_ALERT_EVENTS = [
  { key: "stage_completed", label: "Recruit completed a stage", defaultOn: true },
  { key: "milestones_achieved", label: "Production milestone or graduation", defaultOn: true },
  { key: "contract_signed", label: "Contract signed", defaultOn: true },
  { key: "admin_alert", label: "Provisioning and integration problems", defaultOn: true },
  { key: "help_request", label: "Recruit asked for help", defaultOn: true },
] as const;

const NEXT_STEP: Record<number, string> = {
  1: "Next, open your study materials from the dashboard.",
  2: "Next, schedule your P&C licensing exam from the dashboard.",
  3: "When you pass, upload your official results or license on the dashboard.",
  4: "Next, sign your AIT contract. Training starts after that.",
};

function sign() {
  return "\n\nPlatinum Insurance Group";
}

async function recruitMessages(row: typeof schema.outbox.$inferSelect, r: typeof schema.recruit.$inferSelect): Promise<{ subject: string; text: string; sms?: string } | null> {
  const app = env().APP_URL;
  const edu = env().EDUCATION_URL;
  const first = r.fullName.split(/\s+/)[0] || r.fullName;
  const p = row.payload as Record<string, unknown>;
  switch (row.eventType) {
    case "welcome": {
      const linked = Boolean(p.linkedExisting);
      return {
        subject: "Welcome to the Platinum Agent in Training program",
        text: [
          `Hi ${first},`,
          "",
          "Your Platinum AIT dashboard account is ready.",
          "",
          `AIT dashboard: ${app}/login`,
          `Username: ${r.email}`,
          linked
            ? "Use your existing password, or choose Forgot password on the sign-in page."
            : "Your temporary password is your phone number, numbers only. Change it when you first sign in to each site.",
          "",
          `P&C study site: ${edu}`,
          "Create your study account there with the Sign up link, using this same email address. That site has its own password, separate from the dashboard.",
          "",
          "Your dashboard shows each step of the program and what to do next.",
        ].join("\n") + sign(),
        sms: `Platinum AIT: your dashboard account is ready. Sign in at ${app}/login with ${r.email}. Your temporary password is your phone number, numbers only. Reply STOP to opt out.`,
      };
    }
    case "stage_completed": {
      const n = Number(p.stage);
      return {
        subject: `Done: ${stageTitle(n)}`,
        text: `Congratulations, ${first}. You completed Stage ${n} of ${STAGES.length}: ${stageTitle(n)}.\n\n${NEXT_STEP[n] ?? ""}\n\n${app}/recruit` + sign(),
        sms: `Platinum AIT: you completed Stage ${n}, ${stageTitle(n)}. ${NEXT_STEP[n] ?? ""} Reply STOP to opt out.`,
      };
    }
    case "milestones_achieved": {
      const ms = (p.milestones as string[]).map(milestoneLabel);
      const grad = (p.milestones as string[]).includes("graduation");
      return {
        subject: grad ? "You graduated from the Platinum AIT program" : `Milestone reached: ${ms[ms.length - 1]}`,
        text: `Congratulations, ${first}. You reached ${ms.join(", ")}.\n\nApproved qualifying premium: ${formatCents(Number(p.qualifyingCents), { whole: true })}.\n\n${app}/recruit` + sign(),
        sms: `Platinum AIT: congratulations, you reached ${ms[ms.length - 1]}. Reply STOP to opt out.`,
      };
    }
    case "contract_signed":
      return { subject: "Your AIT contract is complete", text: `Hi ${first}, your signed AIT contract is on file. You can now start training from your dashboard.\n\n${app}/recruit` + sign() };
    case "training_started":
      return { subject: "Training started", text: `Hi ${first}, we recorded your training start. Your production progress toward the $250,000 graduation goal now shows on your dashboard.\n\n${app}/recruit` + sign() };
    case "reimbursement_updated":
      return { subject: "Exam reimbursement update", text: `Hi ${first}, your exam reimbursement status is now: ${String(p.status).replace(/_/g, " ")}.\n\n${app}/recruit` + sign() };
    case "inactivity_reminder":
      return { subject: "Your next AIT step", text: `Hi ${first}, it's been a while since you signed in. Your next step is waiting on your dashboard.\n\n${app}/recruit` + sign() };
    case "password_reset_by_admin":
      return { subject: "Your Platinum AIT password was reset", text: `Hi ${first}, a Platinum admin reset your AIT dashboard password at your request. They'll give you a temporary password, and you'll choose a new one when you sign in. Your study-site password didn't change.\n\nIf you didn't ask for this, reply to this email.` + sign() };
    default:
      return null;
  }
}

async function adminRecipients(eventType: string, required: boolean) {
  const admins = await db.select().from(schema.user).where(and(eq(schema.user.role, "admin")));
  const active = admins.filter((a) => !a.banned);
  if (required) return active;
  const prefs = await db.select().from(schema.alertPreference).where(and(inArray(schema.alertPreference.userId, active.map((a) => a.id).concat("")), eq(schema.alertPreference.eventType, eventType), eq(schema.alertPreference.channel, "email")));
  const def = ADMIN_ALERT_EVENTS.find((e) => e.key === eventType)?.defaultOn ?? false;
  return active.filter((a) => prefs.find((p) => p.userId === a.id)?.enabled ?? def);
}

async function smsAllowed(recruitId: string) {
  if (!(await getSetting("smsEnabled"))) return false;
  const rows = await db.select().from(schema.consent).where(and(eq(schema.consent.recruitId, recruitId), eq(schema.consent.channel, "sms")));
  const latest = rows.sort((a, b) => +b.at - +a.at)[0];
  return Boolean(latest?.granted);
}

/** Resolve recipients and content at send time (recipient status and preferences are rechecked now). */
export async function buildMessages(row: typeof schema.outbox.$inferSelect): Promise<OutgoingMessage[]> {
  const out: OutgoingMessage[] = [];
  const [r] = row.recruitId ? await db.select().from(schema.recruit).where(eq(schema.recruit.id, row.recruitId)) : [];
  const adminLink = r ? `${env().APP_URL}/admin/recruits/${r.id}` : `${env().APP_URL}/admin`;
  const key = (to: string, ch: string) => `${row.dedupeKey}|${ch}|${to}`;

  // Recruit-facing (archived/withdrawn recruits get nothing except security notices).
  if (r && r.email && (r.status === "active" || row.eventType === "password_reset_by_admin")) {
    const m = await recruitMessages(row, r);
    if (m) {
      out.push({ channel: "email", to: r.email, subject: m.subject, text: m.text, dedupeKey: key(r.email, "email"), purpose: row.eventType, required: row.eventType === "password_reset_by_admin" });
      if (m.sms && r.phoneE164 && (await smsAllowed(r.id))) {
        out.push({ channel: "sms", to: r.phoneE164, text: m.sms, dedupeKey: key(r.phoneE164, "sms"), purpose: row.eventType, required: false, deferUntilWindow: !withinSmsWindow(new Date()) });
      }
    }
  }

  // Admin-facing.
  const p = row.payload as Record<string, unknown>;
  if (row.eventType === "stage4_admin_followup" && r) {
    const [c] = p.reimbursementId ? await db.select().from(schema.reimbursement).where(eq(schema.reimbursement.id, String(p.reimbursementId))) : [];
    for (const a of await adminRecipients(row.eventType, true)) {
      out.push({
        channel: "email",
        to: a.email,
        subject: `[Required] ${r.fullName} passed the P&C exam`,
        text: [
          `${r.fullName} passed the P&C licensing exam and their proof was approved.`,
          "",
          "Please personally congratulate them.",
          "",
          `Exam reimbursement: one shared task was created. Receipt ${c?.receiptDocumentId ? "is on file" : "has not been uploaded yet"}. Claim the task on the recruit's record so only one admin handles the reimbursement.`,
          "",
          `Recruit record: ${adminLink}`,
          "",
          "This operational email is required and can't be turned off.",
        ].join("\n"),
        dedupeKey: key(a.email, "email"),
        purpose: row.eventType,
        required: true,
      });
    }
  }
  const adminSummary: Record<string, string> = {
    stage_completed: r ? `${r.fullName} completed Stage ${p.stage}: ${stageTitle(Number(p.stage))}` : "",
    milestones_achieved: r ? `${r.fullName} reached ${(p.milestones as string[] | undefined)?.map(milestoneLabel).join(", ")}` : "",
    contract_signed: r ? `${r.fullName}'s AIT contract is verified` : "",
    admin_alert: `Needs attention${r ? `: ${r.fullName}` : ""} (${String(p.kind ?? "").replace(/_/g, " ")})`,
    help_request: r ? `${r.fullName} asked for help` : "Help request",
  };
  if (adminSummary[row.eventType]) {
    for (const a of await adminRecipients(row.eventType, false)) {
      out.push({
        channel: "email",
        to: a.email,
        subject: `[AIT] ${adminSummary[row.eventType]}`,
        text: `${adminSummary[row.eventType]}.${p.detail ? `\n\n${p.detail}` : ""}\n\n${adminLink}\n\nChange which alerts you get in Settings.`,
        dedupeKey: key(a.email, "email"),
        purpose: row.eventType,
        required: false,
      });
    }
  }
  return out;
}

/**
 * After a delivery report (or a claim with nothing sendable), decide the event's fate from the
 * current message set: done when every message is sent, deferred when only quiet-hours texts
 * remain, otherwise left claimed for the other reports (a lost report is reclaimed after 10 minutes).
 */
export async function settleOutbox(row: typeof schema.outbox.$inferSelect, now = new Date()): Promise<"done" | "deferred" | "waiting"> {
  const messages = await buildMessages(row);
  const sent = await alreadySent(messages.map((m) => m.dedupeKey));
  const unsent = messages.filter((m) => !sent.has(m.dedupeKey));
  if (!unsent.length) {
    await completeOutbox(row.id, true);
    return "done";
  }
  if (unsent.every((m) => m.deferUntilWindow)) {
    await deferToWindow(row.id, nextSmsWindowStart(now));
    return "deferred";
  }
  return "waiting";
}

/** Records per-recipient outcomes reported by n8n; returns keys that were already sent so n8n skips them. */
export async function alreadySent(keys: string[]) {
  if (!keys.length) return new Set<string>();
  const rows = await db
    .select({ k: schema.messageDelivery.dedupeKey })
    .from(schema.messageDelivery)
    .where(and(inArray(schema.messageDelivery.dedupeKey, keys), inArray(schema.messageDelivery.status, ["sent", "delivered"])));
  return new Set(rows.map((x) => x.k));
}

export async function recordDelivery(input: { outboxId: string; recruitId: string | null; purpose: string; recipient: string; channel: string; dedupeKey: string; status: string; providerRef?: string | null; detail?: string | null }) {
  await db
    .insert(schema.messageDelivery)
    .values({ ...input, detail: input.detail?.slice(0, 300) ?? null })
    .onConflictDoUpdate({ target: [schema.messageDelivery.dedupeKey, schema.messageDelivery.recipient, schema.messageDelivery.channel], set: { status: input.status, providerRef: input.providerRef ?? null, detail: input.detail?.slice(0, 300) ?? null, updatedAt: new Date() } });
  if (input.purpose === "welcome" && input.recruitId && input.channel === "email") {
    await db.update(schema.recruit).set({ welcomeStatus: input.status === "sent" || input.status === "delivered" ? "sent" : "failed" }).where(eq(schema.recruit.id, input.recruitId));
  }
}

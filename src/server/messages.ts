import { and, eq, inArray } from "drizzle-orm";
import { ROLE_LABELS, type RoleKey } from "@/domain/roles";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { formatCents } from "@/domain/money";
import { stageTitle, STAGES } from "@/domain/stages";
import { milestoneLabel } from "./production";
import { getSetting } from "./settings";
import { nextSmsWindowStart, withinSmsWindow } from "@/domain/durations";
import { completeOutbox, deferToWindow } from "./outbox";
import { PROGRAMS, RECRUITER_NAMES } from "@/domain/programs";

export type OutgoingMessage = {
  channel: "email" | "sms";
  to: string;
  subject?: string;
  text: string;
  /** Email only: the same content with the Platinum logo on top. */
  html?: string;
  /** Per event + recipient + channel; n8n must not send a key already marked sent. */
  dedupeKey: string;
  purpose: string;
  required: boolean;
  /** SMS outside quiet hours is deferred, not dropped. */
  deferUntilWindow?: boolean;
};

/** Admin notification toggles. Required operational and security mail ignores them. */
export const ADMIN_ALERT_EVENTS = [
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Branded HTML version of a plain-text email: logo on top, paragraphs, clickable links. */
export function emailHtml(text: string) {
  const logo = `${env().APP_URL}/brand/platinum-logo-transparent.png`;
  const body = text
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 16px">${esc(para).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#1d4ed8">${u}</a>`).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td align="center" style="padding:28px 28px 8px"><img src="${logo}" alt="Platinum Insurance Group" width="200" style="display:block;width:200px;max-width:100%;height:auto;border:0"></td></tr>
<tr><td style="padding:16px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2933">${body}</td></tr>
</table></td></tr></table></body></html>`;
}

async function recruitMessages(row: typeof schema.outbox.$inferSelect, r: typeof schema.recruit.$inferSelect): Promise<{ subject: string; text: string; sms?: string } | null> {
  const app = env().APP_URL;
  const edu = env().EDUCATION_URL;
  const first = r.fullName.split(/\s+/)[0] || r.fullName;
  const p = row.payload as Record<string, unknown>;
  switch (row.eventType) {
    case "welcome": {
      const linked = Boolean(p.linkedExisting);
      const [study] = await db.select().from(schema.provisioning).where(and(eq(schema.provisioning.recruitId, r.id), eq(schema.provisioning.system, "education")));
      const studyReady = study?.status === "ready";
      const studyLinked = studyReady && study.linkedExisting;
      const passwords = !studyReady
        ? [linked ? "Use your existing password, or choose Forgot password on the sign-in page." : "Your temporary password is your phone number, numbers only. Change it when you first sign in."]
        : !linked && !studyLinked
          ? ["Your temporary password is your phone number, numbers only. Change it when you first sign in to each site."]
          : [
              linked ? "Dashboard: use your existing password, or choose Forgot password on the sign-in page." : "Dashboard: your temporary password is your phone number, numbers only. Change it when you first sign in.",
              studyLinked ? "Study site: you already had an account there, so use your existing study password, or choose Forgot password on that site." : "Study site: your temporary password is your phone number, numbers only. Change it when you first sign in.",
            ];
      return {
        subject: "Welcome to the Platinum Agent in Training program",
        text: [
          `Hi, ${first}`,
          "",
          studyReady ? "Your Platinum AIT dashboard and P&C study accounts are ready." : "Your Platinum AIT dashboard account is ready.",
          "",
          `AIT dashboard: ${app}/login`,
          ...(studyReady ? [`P&C study site: ${edu}/#/login`] : []),
          "",
          `Username: ${r.email}${studyReady ? " (your email, for both sites)" : " (your email)"}`,
          ...passwords,
          ...(studyReady ? [] : [
            "",
            `P&C study site: ${edu}`,
            "Create your study account there with the Sign up link, using this same email address. That site has its own password, separate from the dashboard.",
          ]),
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
  // Every staff role gets admin notices (Master Admin, Admin, Admin read-only).
  const admins = await db.select().from(schema.user).where(inArray(schema.user.role, ["master_admin", "admin", "admin_readonly"]));
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
/** Free Agent / Group Sell emails: the agent's welcome, and step notices to every admin. */
async function agentMessages(row: typeof schema.outbox.$inferSelect): Promise<OutgoingMessage[]> {
  const p = row.payload as { agentId?: string; step?: number; resend?: boolean };
  const [a] = p.agentId ? await db.select().from(schema.agent).where(eq(schema.agent.id, p.agentId)) : [];
  if (!a) return [];
  const prog = PROGRAMS[a.program];
  const app = env().APP_URL;
  const key = (to: string) => `${row.dedupeKey}|email|${to}`;
  if (row.eventType === "agent_welcome") {
    if (a.status !== "active" || !a.userId) return [];
    const [u] = await db.select({ mustChangePassword: schema.user.mustChangePassword }).from(schema.user).where(eq(schema.user.id, a.userId));
    const first = a.fullName.split(/\s+/)[0] || a.fullName;
    const recruiter = a.recruiter ? RECRUITER_NAMES[a.recruiter] ?? null : null;
    const text = [
      `Hi, ${first}`,
      "",
      `Your Platinum ${prog.label} dashboard is ready. It shows each step of the process and what's next, so you're always in the loop.`,
      "",
      `Dashboard: ${app}/login`,
      `Username: ${a.email} (your email)`,
      u?.mustChangePassword
        ? "Your temporary password is your phone number, numbers only. Change it when you first sign in."
        : "Use your existing password, or choose Forgot password on the sign-in page.",
      ...(recruiter ? ["", `Your recruiter: ${recruiter}`] : []),
    ].join("\n") + sign();
    return [{ channel: "email", to: a.email, subject: `Your ${prog.label} dashboard is ready`, text, dedupeKey: key(a.email), purpose: "agent_welcome", required: false }];
  }
  const n = Number(p.step);
  const title = prog.steps[n - 1]?.title ?? `Step ${n}`;
  const out: OutgoingMessage[] = [];
  for (const admin of await adminRecipients("agent_step_completed", true)) {
    out.push({
      channel: "email",
      to: admin.email,
      subject: `[${prog.short}] ${a.fullName} completed Step ${n}: ${title}`,
      text: [
        `${a.fullName}${a.organization ? ` (${a.organization})` : ""} completed Step ${n} of ${prog.steps.length} in ${prog.label}: ${title}.`,
        "",
        `Contact: ${app}/admin/agents/${a.id}`,
        `Admin dashboard: ${app}/login`,
        "",
        "Every admin gets step-completion notices.",
      ].join("\n"),
      dedupeKey: key(admin.email),
      purpose: "agent_step_completed",
      required: true,
    });
  }
  return out;
}

/** New staff account from the Users screen. */
async function staffMessages(row: typeof schema.outbox.$inferSelect): Promise<OutgoingMessage[]> {
  const userId = (row.payload as { userId?: string }).userId;
  const [u] = userId ? await db.select().from(schema.user).where(eq(schema.user.id, userId)) : [];
  if (!u || u.banned) return [];
  const first = u.name.split(/\s+/)[0] || u.name;
  const text = [
    `Hi, ${first}`,
    "",
    `You now have a Platinum AIT dashboard account (${ROLE_LABELS[u.role as RoleKey] ?? u.role}).`,
    "",
    `Dashboard: ${env().APP_URL}/login`,
    `Username: ${u.email} (your email)`,
    u.mustChangePassword ? "Your temporary password is your phone number, numbers only. Change it when you first sign in." : "Use your existing password, or choose Forgot password on the sign-in page.",
  ].join("\n") + sign();
  return [{ channel: "email", to: u.email, subject: "Your Platinum AIT dashboard account", text, html: emailHtml(text), dedupeKey: `${row.dedupeKey}|email|${u.email}`, purpose: "staff_welcome", required: true }];
}

/** Sent to the old and new address when an admin changes someone's sign-in email. */
function loginEmailChangedMessages(row: typeof schema.outbox.$inferSelect): OutgoingMessage[] {
  const p = row.payload as { oldEmail?: string; newEmail?: string };
  if (!p.oldEmail || !p.newEmail) return [];
  const text = [
    "Hi,",
    "",
    `The sign-in email for your Platinum dashboard account was changed from ${p.oldEmail} to ${p.newEmail} by a Platinum admin.`,
    "",
    `From now on, sign in at ${env().APP_URL}/login with ${p.newEmail}. Your password didn't change.`,
    "",
    "If you didn't expect this, reply to this email or contact your Platinum recruiter.",
  ].join("\n") + sign();
  return [p.oldEmail, p.newEmail].map((to) => ({ channel: "email" as const, to, subject: "Your Platinum dashboard sign-in email changed", text, html: emailHtml(text), dedupeKey: `${row.dedupeKey}|email|${to}`, purpose: "login_email_changed", required: true }));
}

export async function buildMessages(row: typeof schema.outbox.$inferSelect): Promise<OutgoingMessage[]> {
  if (row.eventType === "staff_welcome") return staffMessages(row);
  if (row.eventType === "login_email_changed") return loginEmailChangedMessages(row);
  if (row.eventType === "agent_welcome" || row.eventType === "agent_step_completed") {
    return (await agentMessages(row)).map((m) => ({ ...m, html: emailHtml(m.text) }));
  }
  const out: OutgoingMessage[] = [];
  const [r] = row.recruitId ? await db.select().from(schema.recruit).where(eq(schema.recruit.id, row.recruitId)) : [];
  const adminLink = r ? `${env().APP_URL}/admin/recruits/${r.id}` : `${env().APP_URL}/admin`;
  const key = (to: string, ch: string) => `${row.dedupeKey}|${ch}|${to}`;

  // Recruit-facing (archived/withdrawn recruits get nothing except security notices).
  if (r && r.email && (r.status === "active" || row.eventType === "password_reset_by_admin")) {
    const m = await recruitMessages(row, r);
    if (m) {
      out.push({ channel: "email", to: r.email, subject: m.subject, text: m.text, dedupeKey: key(r.email, "email"), purpose: row.eventType, required: row.eventType === "password_reset_by_admin" });
      // PIE learners get their AIT welcome by email only (Colton, 2026-10-08).
      const emailOnly = row.eventType === "welcome" && r.source === "pie";
      if (m.sms && !emailOnly && r.phoneE164 && (await smsAllowed(r.id))) {
        out.push({ channel: "sms", to: r.phoneE164, text: m.sms, dedupeKey: key(r.phoneE164, "sms"), purpose: row.eventType, required: false, deferUntilWindow: !withinSmsWindow(new Date()) });
      }
    }
  }

  // Admin-facing.
  const p = row.payload as Record<string, unknown>;
  if (row.eventType === "stage_completed" && r) {
    const n = Number(p.stage);
    for (const a of await adminRecipients(row.eventType, true)) {
      out.push({
        channel: "email",
        to: a.email,
        subject: `[AIT] ${r.fullName} completed Stage ${n}: ${stageTitle(n)}`,
        text: [
          `${r.fullName} completed Stage ${n} of ${STAGES.length}: ${stageTitle(n)}.`,
          "",
          `Recruit record: ${adminLink}`,
          `Admin dashboard: ${env().APP_URL}/login`,
          "",
          "Every admin gets stage-completion notices.",
        ].join("\n"),
        dedupeKey: key(a.email, "email"),
        purpose: row.eventType,
        required: true,
      });
    }
  }
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
  return out.map((m) => (m.channel === "email" && !m.html ? { ...m, html: emailHtml(m.text) } : m));
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
  if (input.purpose === "agent_welcome" && input.channel === "email") {
    const [o] = await db.select({ payload: schema.outbox.payload }).from(schema.outbox).where(eq(schema.outbox.id, input.outboxId));
    const agentId = (o?.payload as { agentId?: string } | undefined)?.agentId;
    if (agentId) await db.update(schema.agent).set({ welcomeStatus: input.status === "sent" || input.status === "delivered" ? "sent" : "failed" }).where(eq(schema.agent.id, agentId));
  }
}

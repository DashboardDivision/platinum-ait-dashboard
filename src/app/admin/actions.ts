"use server";
import { revalidatePath } from "next/cache";
import { saveTwentyDetails } from "@/server/twenty-edit";
import { needPerm, saveRolePerms } from "@/server/permissions";
import { createStaffUser, deleteAgent, deleteRecruit, deleteStaffUser, setUserActive, setUserRole } from "@/server/users";
import { ALL_STAFF_PERMS, CANDIDATE_TOGGLES, isRoleKey, isStaffRole } from "@/domain/roles";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { dollarsToCents } from "@/domain/money";
import { parseCsv } from "@/domain/csv";
import type { StageNumber } from "@/domain/stages";
import type { ActionState } from "@/components/action-form";
import { HttpError, requireApiUser, type CurrentUser } from "@/server/session";
import { audit } from "@/server/audit";
import { enqueue, retryFailed } from "@/server/outbox";
import { retryDashboardProvisioning } from "@/server/provisioning";
import { adminForceTemporaryPassword, adminSendResetLink } from "@/server/account";
import { reviewDocument, uploadDocument } from "@/server/documents";
import { adminCorrectTrainingStart, approveExternalContract } from "@/server/contracts";
import { reopenStageTx } from "@/server/stages";
import { adjustPolicy, recomputeProduction, reviewPolicy, upsertPolicy, type PolicyInput } from "@/server/production";
import { createPayout, recordReimbursementPayment, reversePayout, setPayoutStatus, updateReimbursement } from "@/server/money-ledger";
import { putSetting, SETTING_SCHEMAS } from "@/server/settings";
import { issueReauth, REAUTH_COOKIE } from "@/server/reauth";
import { ADMIN_ALERT_EVENTS } from "@/server/messages";
import { addRecruitFromDashboard } from "@/server/new-recruit";
import { createAitFromPieLead } from "@/server/pie-leads";
import { createTwentyContact, inviteAgent, markAgentStep, setAgentStatus, undoAgentStep } from "@/server/agents";
import { isProgramKey, PROGRAMS } from "@/domain/programs";

async function admin(): Promise<CurrentUser> {
  const u = await requireApiUser("admin");
  if (u.impersonatedBy) throw new HttpError(403, "Return to your admin session first");
  return u;
}

/** Every admin action names the permission it needs (null = checks inside, or any staff member). */
async function run(perm: string | null, fn: (u: CurrentUser) => Promise<string | void>, ok = "Saved."): Promise<ActionState> {
  try {
    const u = await admin();
    if (perm) needPerm(u, perm);
    const msg = await fn(u);
    revalidatePath("/admin", "layout");
    return { ok: msg || ok };
  } catch (e) {
    if (e instanceof HttpError) return { error: e.message };
    if (e instanceof Error && /invalid money/i.test(e.message)) return { error: "Enter amounts like 1234.56" };
    throw e;
  }
}

const s = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
const cents = (d: FormData, k: string) => (s(d, k) ? dollarsToCents(s(d, k)) : null);

/* ---------- accounts & provisioning ---------- */

export async function addRecruitAction(_: ActionState, d: FormData): Promise<ActionState> {
  let recruitId: string | null = null;
  const res = await run("ait.edit", async (u) => {
    recruitId = await addRecruitFromDashboard(u, { name: String(d.get("name") ?? ""), email: String(d.get("email") ?? ""), phone: String(d.get("phone") ?? ""), recruiter: String(d.get("recruiter") ?? "") });
  });
  if (recruitId) redirect(`/admin/recruits/${recruitId}?added=1`);
  return res;
}

/** "Create AIT dashboard" on a PIE signup from the Recruits page. */
export async function createAitFromPieAction(_: ActionState, d: FormData): Promise<ActionState> {
  let recruitId: string | null = null;
  const res = await run("ait.edit", async (u) => {
    recruitId = await createAitFromPieLead(u, s(d, "leadId"));
  });
  if (recruitId) redirect(`/admin/recruits/${recruitId}?added=1`);
  return res;
}

export async function inviteAgentAction(_: ActionState, d: FormData): Promise<ActionState> {
  let agentId: string | null = null;
  const res = await run(null, async (u) => {
    const program = s(d, "program");
    if (!isProgramKey(program)) throw new HttpError(400, "Unknown program");
    needPerm(u, `${program}.edit`);
    agentId = await inviteAgent(u, program, s(d, "recordId"));
  });
  if (agentId) redirect(`/admin/agents/${agentId}?sent=1`);
  return res;
}

export async function addAgentContactAction(_: ActionState, d: FormData): Promise<ActionState> {
  let to: string | null = null;
  const res = await run(null, async (u) => {
    const program = s(d, "program");
    if (!isProgramKey(program)) throw new HttpError(400, "Unknown program");
    needPerm(u, `${program}.edit`);
    const sendLogin = d.get("sendLogin") === "on";
    if (sendLogin && !s(d, "phone")) throw new HttpError(400, "Add their mobile number to send a login; it's their starter password.");
    const recordId = await createTwentyContact(u, program, { name: s(d, "name"), organization: s(d, "organization"), email: s(d, "email"), phone: s(d, "phone"), recruiter: s(d, "recruiter") });
    if (sendLogin) {
      to = `/admin/agents/${await inviteAgent(u, program, recordId)}?sent=1`;
    } else {
      to = `${PROGRAMS[program].adminPath}?added=1&q=${encodeURIComponent(s(d, "email").trim())}`;
    }
  });
  if (to) redirect(to);
  return res;
}

export async function agentStepAction(_: ActionState, d: FormData) {
  return run(null, async (u) => { await needAgentPerm(u, s(d, "agentId"), "edit"); await markAgentStep(u, s(d, "agentId"), Number(s(d, "step")), s(d, "note") || null); }, "Step marked complete. Every admin is emailed.");
}

export async function agentUndoStepAction(_: ActionState, d: FormData) {
  return run(null, async (u) => { await needAgentPerm(u, s(d, "agentId"), "edit"); await undoAgentStep(u, s(d, "agentId"), s(d, "reason")); }, "Step undone.");
}

export async function agentStatusAction(_: ActionState, d: FormData) {
  return run(null, async (u) => {
    const status = s(d, "status");
    if (status !== "active" && status !== "archived") throw new HttpError(400, "Unknown status");
    await needAgentPerm(u, s(d, "agentId"), "edit");
    await setAgentStatus(u, s(d, "agentId"), status, s(d, "reason"));
    return status === "archived" ? "Archived. Their dashboard login is off." : "Reactivated. Their login works again.";
  });
}

export async function retryProvisioningAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => `Dashboard account: ${(await retryDashboardProvisioning(s(d, "recruitId"), u.id)).replace(/_/g, " ")}.`);
}

export async function resendWelcomeAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const id = s(d, "recruitId");
    const [p] = await db.select().from(schema.provisioning).where(and(eq(schema.provisioning.recruitId, id), eq(schema.provisioning.system, "dashboard")));
    if (p?.status !== "ready") throw new HttpError(409, "The dashboard account isn't ready yet");
    await db.transaction(async (tx) => {
      await enqueue(tx, { eventType: "welcome", dedupeKey: `welcome:${id}:resend:${Date.now()}`, recruitId: id, payload: { linkedExisting: p.linkedExisting, resend: true } });
      await audit(tx, { actorUserId: u.id, action: "welcome.resend", targetType: "recruit", targetId: id });
    });
    return "Welcome instructions queued. No account was changed.";
  });
}

export async function sendResetLinkAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    await adminSendResetLink({ adminUserId: u.id, recruitId: s(d, "recruitId") });
    return "Reset link sent for the dashboard only.";
  });
}

export async function forceTempPasswordAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const temp = await adminForceTemporaryPassword({ adminUserId: u.id, recruitId: s(d, "recruitId"), reason: s(d, "reason") });
    return `Temporary dashboard password (shown once, give it to the recruit directly): ${temp}`;
  });
}

export async function reauthAction(_: ActionState, d: FormData) {
  try {
    const u = await admin();
    const [acc] = await db.select().from(schema.account).where(and(eq(schema.account.userId, u.id), eq(schema.account.providerId, "credential")));
    const ctx = await auth().$context;
    if (!acc?.password || !(await ctx.password.verify({ hash: acc.password, password: s(d, "password") }))) {
      await audit(db, { actorUserId: u.id, action: "admin.reauth_failed", targetType: "user", targetId: u.id });
      return { error: "That password isn't right." };
    }
    const t = issueReauth(u.id);
    (await cookies()).set(REAUTH_COOKIE, t.value, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: t.maxAge });
    return { ok: "Confirmed for 10 minutes." };
  } catch (e) {
    if (e instanceof HttpError) return { error: e.message };
    throw e;
  }
}

export async function impersonateAction(_: ActionState, d: FormData): Promise<ActionState> {
  try {
    const u = await admin();
    needPerm(u, "ait.edit");
    const id = s(d, "recruitId");
    const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, id));
    if (!r?.userId) return { error: "This recruit has no dashboard account yet" };
    await auth().api.impersonateUser({ body: { userId: r.userId }, headers: await headers() });
    await audit(db, { actorUserId: u.id, action: "impersonation.start", targetType: "recruit", targetId: id });
  } catch (e) {
    if (e instanceof HttpError) return { error: e.message };
    const msg = e instanceof Error ? e.message : "";
    return { error: /re-enter/i.test(msg) ? "Confirm your password first." : "Couldn't start viewing as this recruit." };
  }
  return redirect("/recruit");
}

/* ---------- recruit record ---------- */

export async function updateRecruitAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const id = s(d, "recruitId");
    const patch = {
      cohort: s(d, "cohort") || null,
      ownerAdminId: s(d, "ownerAdminId") || null,
      momentumProducerId: s(d, "momentumProducerId") || null,
      homeState: s(d, "homeState").toUpperCase().slice(0, 2) || null,
    };
    await db.transaction(async (tx) => {
      await tx.update(schema.recruit).set(patch).where(eq(schema.recruit.id, id));
      await audit(tx, { actorUserId: u.id, action: "recruit.update", targetType: "recruit", targetId: id, metadata: patch });
    });
    if (patch.momentumProducerId) await recomputeProduction(id);
  });
}

export async function setStatusAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const id = s(d, "recruitId");
    const status = s(d, "status") as "active" | "archived" | "withdrawn";
    if (!["active", "archived", "withdrawn"].includes(status)) throw new HttpError(400, "Unknown status");
    const reason = s(d, "reason");
    if (!reason) throw new HttpError(400, "A reason is required");
    await db.transaction(async (tx) => {
      await tx.update(schema.recruit).set({ status, enrollmentEndedAt: status === "active" ? null : new Date() }).where(eq(schema.recruit.id, id));
      await audit(tx, { actorUserId: u.id, action: `recruit.${status}`, targetType: "recruit", targetId: id, reason });
    });
    return status === "active" ? "Reactivated. History is unchanged." : "Archived. History is kept and reminders stop.";
  });
}

export async function reopenStageAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const stage = Number(s(d, "stage")) as StageNumber;
    if (![1, 2, 3, 4, 5].includes(stage)) throw new HttpError(400, "Pick a stage");
    await db.transaction((tx) => reopenStageTx(tx, s(d, "recruitId"), stage, u.id, s(d, "reason")));
    return `Stage ${stage} reopened. Congratulations won't be sent again.`;
  });
}

export async function addNoteAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const body = s(d, "body");
    if (!body) throw new HttpError(400, "Write a note first");
    await db.insert(schema.note).values({ recruitId: s(d, "recruitId"), authorUserId: u.id, body: body.slice(0, 4000) });
  }, "Note added.");
}

export async function createTaskAction(_: ActionState, d: FormData) {
  return run("tasks.edit", async (u) => {
    const title = s(d, "title");
    if (!title) throw new HttpError(400, "Give the task a title");
    await db.insert(schema.task).values({ recruitId: s(d, "recruitId") || null, kind: "general", title, body: s(d, "body") || null, ownerUserId: s(d, "ownerUserId") || u.id, dueAt: s(d, "dueAt") ? new Date(`${s(d, "dueAt")}T17:00:00-07:00`) : null });
  }, "Task created.");
}

export async function taskAction(_: ActionState, d: FormData) {
  return run("tasks.edit", async (u) => {
    const id = s(d, "taskId");
    const op = s(d, "op");
    if (op === "claim") await db.update(schema.task).set({ ownerUserId: u.id }).where(eq(schema.task.id, id));
    else if (op === "done") await db.update(schema.task).set({ status: "done", completedAt: new Date(), completedByUserId: u.id }).where(eq(schema.task.id, id));
    else if (op === "reopen") await db.update(schema.task).set({ status: "open", completedAt: null, completedByUserId: null }).where(eq(schema.task.id, id));
    await audit(db, { actorUserId: u.id, action: `task.${op}`, targetType: "task", targetId: id });
  });
}

/* ---------- documents & contracts ---------- */

export async function reviewDocumentAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const decision = s(d, "decision") === "approve" ? "approve" : "reject";
    const res = await reviewDocument(u.id, s(d, "documentId"), decision, s(d, "reason") || null);
    return decision === "approve" ? (res.stageCompleted ? "Approved. Stage 4 is complete; all admins were notified and one reimbursement case was created." : "Approved.") : "Sent back for replacement.";
  });
}

export async function adminUploadAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    const file = d.get("file");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "Choose a file");
    const kind = s(d, "kind");
    if (!["contract_external", "exam_result", "license", "receipt"].includes(kind)) throw new HttpError(400, "Pick a document type");
    await uploadDocument(u, { recruitId: s(d, "recruitId"), kind: kind as "contract_external", fileName: file.name, data: Buffer.from(await file.arrayBuffer()) });
    return "Uploaded.";
  });
}

export async function approveContractAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => {
    await approveExternalContract(u.id, s(d, "recruitId"), s(d, "documentId"), s(d, "signedOn"), s(d, "reason"));
    return "Contract recorded as an admin-reviewed upload. Production tracking is on.";
  });
}

export async function trainingStartAction(_: ActionState, d: FormData) {
  return run("ait.edit", async (u) => adminCorrectTrainingStart(u.id, s(d, "recruitId"), s(d, "date"), s(d, "reason")), "Training start corrected.");
}

/* ---------- policies ---------- */

export async function addPolicyAction(_: ActionState, d: FormData) {
  return run("policies.edit", async (u) => {
    const term = s(d, "termMonths");
    await upsertPolicy(
      {
        recruitId: s(d, "recruitId"),
        source: "admin",
        externalRef: s(d, "externalRef"),
        policyType: s(d, "policyType"),
        carrier: s(d, "carrier") || null,
        businessType: (s(d, "businessType") || "new") as PolicyInput["businessType"],
        writtenDate: s(d, "writtenDate"),
        effectiveDate: s(d, "effectiveDate") || null,
        termMonths: term ? Number(term) : null,
        termPremiumCents: cents(d, "termPremium"),
        annualizedCents: cents(d, "annualized"),
        status: d.get("approve") ? "approved" : "pending",
      },
      u.id,
    );
  }, "Policy saved.");
}

export async function reviewPolicyAction(_: ActionState, d: FormData) {
  return run("policies.edit", async (u) => reviewPolicy(u.id, s(d, "policyId"), s(d, "decision") as "approved" | "rejected" | "duplicate", s(d, "reason") || null), "Policy updated.");
}

export async function adjustPolicyAction(_: ActionState, d: FormData) {
  return run("policies.edit", async (u) => {
    const amount = cents(d, "amount");
    if (amount == null) throw new HttpError(400, "Enter the premium change");
    const kind = s(d, "kind") as "cancellation" | "reversal" | "correction";
    await adjustPolicy(u.id, s(d, "policyId"), kind, kind === "correction" ? amount : -Math.abs(amount), s(d, "reason"));
  }, "Adjustment recorded. History is kept.");
}

export type CsvPreviewRow = { line: number; recruitEmail: string; recruitId: string | null; input: Omit<PolicyInput, "recruitId"> | null; error: string | null; exists: boolean };

const CSV_COLUMNS = ["recruit_email", "policy_number", "policy_type", "carrier", "business_type", "written_date", "effective_date", "term_months", "term_premium", "annualized_premium"];

export async function previewCsv(text: string): Promise<CsvPreviewRow[]> {
  await admin();
  const rows = parseCsv(text);
  const [head, ...body] = rows;
  if (!head) throw new HttpError(400, "The file is empty");
  const idx = Object.fromEntries(CSV_COLUMNS.map((c) => [c, head.findIndex((h) => h.trim().toLowerCase() === c)]));
  for (const c of ["recruit_email", "policy_number", "policy_type", "written_date"]) if (idx[c] < 0) throw new HttpError(400, `Missing column: ${c}`);
  const recruits = await db.select({ id: schema.recruit.id, email: schema.recruit.email }).from(schema.recruit);
  const out: CsvPreviewRow[] = [];
  for (const [i, r] of body.entries()) {
    const get = (c: string) => (idx[c] >= 0 ? (r[idx[c]] ?? "").trim() : "");
    const email = get("recruit_email").toLowerCase();
    const recruit = recruits.find((x) => x.email === email);
    try {
      const input: Omit<PolicyInput, "recruitId"> = {
        source: "csv",
        externalRef: get("policy_number"),
        policyType: get("policy_type"),
        carrier: get("carrier") || null,
        businessType: ((get("business_type") || "new").toLowerCase() as PolicyInput["businessType"]),
        writtenDate: get("written_date"),
        effectiveDate: get("effective_date") || null,
        termMonths: get("term_months") ? Number(get("term_months")) : null,
        termPremiumCents: get("term_premium") ? dollarsToCents(get("term_premium")) : null,
        annualizedCents: get("annualized_premium") ? dollarsToCents(get("annualized_premium")) : null,
        status: "pending",
      };
      const { validatePolicy, hasPolicy } = await import("@/server/production");
      const err = !recruit ? "No recruit with this email" : !["new", "renewal", "rewrite", "endorsement", "quote"].includes(input.businessType) ? "Unknown business type" : validatePolicy({ ...input, recruitId: recruit.id });
      out.push({ line: i + 2, recruitEmail: email, recruitId: recruit?.id ?? null, input, error: err, exists: await hasPolicy("csv", input.externalRef) });
    } catch (e) {
      out.push({ line: i + 2, recruitEmail: email, recruitId: recruit?.id ?? null, input: null, error: e instanceof Error ? e.message : "Invalid row", exists: false });
    }
  }
  return out;
}

export async function previewCsvAction(_: unknown, d: FormData): Promise<{ rows?: CsvPreviewRow[]; error?: string; csv?: string }> {
  try {
    needPerm(await admin(), "policies.edit");
    const file = d.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file" };
    if (file.size > 2_000_000) return { error: "CSV must be under 2 MB" };
    const text = await file.text();
    return { rows: await previewCsv(text), csv: text };
  } catch (e) {
    if (e instanceof HttpError) return { error: e.message };
    throw e;
  }
}

export async function commitCsvAction(_: ActionState, d: FormData) {
  return run("policies.edit", async (u) => {
    const rows = await previewCsv(s(d, "csv"));
    let n = 0;
    for (const r of rows) {
      if (r.error || !r.input || !r.recruitId) continue;
      await upsertPolicy({ ...r.input, recruitId: r.recruitId }, u.id);
      n++;
    }
    await audit(db, { actorUserId: u.id, action: "policy.csv_import", targetType: "policy", metadata: { imported: n, skipped: rows.length - n } });
    return `Imported ${n} rows as pending (existing policy numbers were updated, not duplicated). Skipped ${rows.length - n}.`;
  });
}

/* ---------- money ---------- */

export async function reimbursementAction(_: ActionState, d: FormData) {
  return run("money.edit", async (u) => {
    const op = s(d, "op");
    const id = s(d, "reimbursementId");
    if (op === "payment") {
      const amount = cents(d, "amount");
      if (amount == null) throw new HttpError(400, "Enter the amount paid");
      await recordReimbursementPayment(u.id, id, amount, s(d, "paidOn"), s(d, "paymentRef"), s(d, "note") || undefined);
      return "Payment recorded.";
    }
    await updateReimbursement(u.id, id, {
      testCostCents: cents(d, "testCost") ?? undefined,
      requestedCents: cents(d, "requested") ?? undefined,
      approvedCents: cents(d, "approved"),
      decision: op === "approve" ? "approve" : op === "reject" ? "reject" : undefined,
      reason: s(d, "reason") || null,
    });
  });
}

export async function payoutAction(_: ActionState, d: FormData) {
  return run("money.edit", async (u) => {
    const op = s(d, "op");
    if (op === "create") {
      const amount = cents(d, "amount");
      if (amount == null) throw new HttpError(400, "Enter an amount");
      await createPayout(u.id, { recruitId: s(d, "recruitId"), payoutType: s(d, "payoutType") || "Payout", periodLabel: s(d, "periodLabel") || null, amountCents: amount, basis: s(d, "basis") || null });
      return "Payout recorded as pending.";
    }
    if (op === "approve") await setPayoutStatus(u.id, s(d, "payoutId"), "approved");
    if (op === "paid") await setPayoutStatus(u.id, s(d, "payoutId"), "paid", s(d, "paymentRef"), s(d, "paidOn") || undefined);
    if (op === "reverse") await reversePayout(u.id, s(d, "payoutId"), s(d, "reason"));
  });
}

/* ---------- settings ---------- */

export async function saveSettingsAction(_: ActionState, d: FormData) {
  return run("settings.edit", async (u) => {
    const overrides: Record<string, string> = {};
    for (const line of s(d, "stateOverrides").split(/\n/)) {
      const m = line.trim().match(/^([A-Za-z]{2})\s*[,:=]\s*(https:\/\/\S+)$/);
      if (line.trim() && !m) throw new HttpError(400, `Couldn't read state override: "${line.trim()}". Use "UT, https://…"`);
      if (m) overrides[m[1].toUpperCase()] = m[2];
    }
    const exam = SETTING_SCHEMAS.examScheduling.safeParse({ defaultUrl: s(d, "examUrl") || null, defaultLabel: s(d, "examLabel") || "the testing vendor", stateOverrides: overrides });
    if (!exam.success) throw new HttpError(400, "Exam links must be full https:// URLs");
    await putSetting("examScheduling", exam.data, u.id);
    const helpName = s(d, "helpName");
    await putSetting("helpContact", helpName ? { name: helpName, email: s(d, "helpEmail") || null, phone: s(d, "helpPhone") || null } : null, u.id);
    const types = s(d, "policyTypes").split(/\n/).map((x) => x.trim()).filter(Boolean);
    await putSetting("policyTypes", types.length ? types : ["Other"], u.id);
    const days = Number(s(d, "inactivityDays"));
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, "Inactivity reminder must be 1–90 days");
    await putSetting("inactivityDays", days, u.id);
    await putSetting("smsEnabled", d.get("smsEnabled") === "on", u.id);
    const booking = SETTING_SCHEMAS.bookingLinks.safeParse({ COLTON: s(d, "bookColton") || null, JESSE: s(d, "bookJesse") || null, PARKER: s(d, "bookParker") || null, fallback: s(d, "bookFallback") || null });
    if (!booking.success) throw new HttpError(400, "Booking links must be full https:// URLs");
    await putSetting("bookingLinks", booking.data, u.id);
    await audit(db, { actorUserId: u.id, action: "settings.update", targetType: "setting" });
  }, "Settings saved.");
}

export async function alertPrefsAction(_: ActionState, d: FormData) {
  return run(null, async (u) => {
    for (const e of ADMIN_ALERT_EVENTS) {
      const enabled = d.get(`email:${e.key}`) === "on";
      await db.insert(schema.alertPreference).values({ userId: u.id, eventType: e.key, channel: "email", enabled }).onConflictDoUpdate({ target: [schema.alertPreference.userId, schema.alertPreference.eventType, schema.alertPreference.channel], set: { enabled } });
    }
  }, "Your alert preferences are saved.");
}

export async function saveViewAction(_: ActionState, d: FormData) {
  return run(null, async (u) => {
    const name = s(d, "name");
    if (!name) throw new HttpError(400, "Name the view");
    await db.insert(schema.savedView).values({ userId: u.id, name: name.slice(0, 60), query: s(d, "query").slice(0, 500) });
  }, "View saved.");
}

export async function deleteViewAction(_: ActionState, d: FormData) {
  return run(null, async (u) => {
    await db.delete(schema.savedView).where(and(eq(schema.savedView.id, s(d, "viewId")), eq(schema.savedView.userId, u.id)));
  }, "View removed.");
}

export async function retryOutboxAction(_: ActionState, d: FormData) {
  return run("messages.edit", async (u) => {
    await retryFailed(s(d, "outboxId"));
    await audit(db, { actorUserId: u.id, action: "outbox.retry", targetType: "outbox", targetId: s(d, "outboxId") });
  }, "Queued for another attempt.");
}

/* ---------- roles, users, deletes (Master Admin / delete permission) ---------- */

async function needAgentPerm(u: CurrentUser, agentId: string, action: "view" | "edit" | "delete") {
  const [a] = await db.select({ program: schema.agent.program }).from(schema.agent).where(eq(schema.agent.id, agentId));
  if (!a) throw new HttpError(404, "Unknown contact.");
  needPerm(u, `${a.program}.${action}`);
}

export async function createUserAction(_: ActionState, d: FormData) {
  return run(null, async (u) => { await createStaffUser(u, { name: s(d, "name"), email: s(d, "email"), phone: s(d, "phone"), role: s(d, "role") }); }, "Account created. Their login details are on the way.");
}

export async function setUserRoleAction(_: ActionState, d: FormData) {
  return run(null, async (u) => { await setUserRole(u, s(d, "userId"), s(d, "role")); }, "Role changed.");
}

export async function setUserActiveAction(_: ActionState, d: FormData) {
  const active = s(d, "active") === "1";
  return run(null, async (u) => { await setUserActive(u, s(d, "userId"), active, s(d, "reason")); }, active ? "Reactivated." : "Deactivated and signed out.");
}

export async function deleteUserAction(_: ActionState, d: FormData) {
  return run(null, async (u) => { await deleteStaffUser(u, s(d, "userId"), s(d, "confirm")); }, "Account deleted.");
}

export async function saveRoleAction(_: ActionState, d: FormData) {
  return run(null, async (u) => {
    const role = s(d, "role");
    if (!isRoleKey(role) || role === "master_admin") throw new HttpError(400, "Unknown role");
    const allowed = isStaffRole(role) ? ALL_STAFF_PERMS : (CANDIDATE_TOGGLES[role] ?? []).map((x) => x.key);
    const perms = d.getAll("perm").map(String).filter((p) => allowed.includes(p));
    await saveRolePerms(u, role, perms);
  }, "Saved. It applies on their next page load.");
}

export async function deleteRecruitAction(_: ActionState, d: FormData): Promise<ActionState> {
  let msg: string | null = null;
  const res = await run(null, async (u) => { msg = await deleteRecruit(u, s(d, "recruitId"), s(d, "confirm"), d.get("alsoTwenty") === "on"); });
  if (msg) redirect(`/admin?deleted=${encodeURIComponent(msg)}`);
  return res;
}

export async function deleteAgentAction(_: ActionState, d: FormData): Promise<ActionState> {
  let to: string | null = null;
  const res = await run(null, async (u) => {
    const out = await deleteAgent(u, s(d, "agentId"), s(d, "confirm"), d.get("alsoTwenty") === "on");
    to = `${PROGRAMS[out.program].adminPath}?deleted=${encodeURIComponent(out.message)}`;
  });
  if (to) redirect(to);
  return res;
}

/* ---------- prospect details, saved to Twenty ---------- */

export async function saveTwentyDetailsAction(_: ActionState, d: FormData) {
  return run(null, async (u) => {
    const kind = s(d, "kind");
    if (kind !== "ait" && kind !== "agent") throw new HttpError(400, "Unknown record");
    const form = new Map<string, string>();
    for (const [k, v] of d.entries()) if (k.startsWith("field:") && typeof v === "string") form.set(k.slice(6), v);
    return saveTwentyDetails(u, { kind, id: s(d, "id") }, form);
  });
}

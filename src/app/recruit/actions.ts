"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { dollarsToCents } from "@/domain/money";
import { HttpError, requireApiUser, recruitForUser, actorKind } from "@/server/session";
import { markReadyToSchedule, recordExamClick, recordStudyClick, requestHelp, saveExamDetails, startTraining } from "@/server/recruit-actions";
import { uploadDocument } from "@/server/documents";
import { upsertPolicy } from "@/server/production";
import type { ActionState } from "@/components/action-form";

async function run(fn: () => Promise<string | void>, ok?: string): Promise<ActionState> {
  try {
    const msg = await fn();
    revalidatePath("/recruit", "layout");
    return { ok: msg || ok || "Saved." };
  } catch (e) {
    if (e instanceof HttpError) return { error: e.message };
    throw e;
  }
}

export async function openStudyAction() {
  const u = await requireApiUser("recruit");
  const url = await recordStudyClick(u, env().EDUCATION_URL);
  redirect(url);
}

export async function readyAction(_: ActionState): Promise<ActionState> {
  return run(async () => markReadyToSchedule(await requireApiUser("recruit")), "Stage 2 complete. Next, schedule your exam.");
}

export async function examClickAction() {
  const u = await requireApiUser("recruit");
  const url = await recordExamClick(u);
  redirect(url);
}

export async function examDetailsAction(_: ActionState, d: FormData): Promise<ActionState> {
  return run(async () =>
    saveExamDetails(await requireApiUser("recruit"), { examDate: String(d.get("examDate") ?? "") || null, confirmation: String(d.get("confirmation") ?? "") || null, homeState: String(d.get("homeState") ?? "") || null }),
  );
}

export async function uploadAction(_: ActionState, d: FormData): Promise<ActionState> {
  return run(async () => {
    const u = await requireApiUser("recruit");
    const r = await recruitForUser(u.id);
    if (!r) throw new HttpError(404, "No recruit record");
    const file = d.get("file");
    if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "Choose a file to upload.");
    const kind = String(d.get("kind"));
    if (!["exam_result", "license", "receipt"].includes(kind)) throw new HttpError(400, "Pick what you're uploading.");
    await uploadDocument(u, {
      recruitId: r.id,
      kind: kind as "exam_result" | "license" | "receipt",
      fileName: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      state: String(d.get("state") ?? "") || null,
      examDate: String(d.get("examDate") ?? "") || null,
      licenseNumber: String(d.get("licenseNumber") ?? "") || null,
    });
    return "Uploaded. An admin will review it.";
  });
}

export async function startTrainingAction(_: ActionState): Promise<ActionState> {
  return run(async () => startTraining(await requireApiUser("recruit")), "Training start recorded.");
}

export async function helpAction(_: ActionState, d: FormData): Promise<ActionState> {
  return run(async () => requestHelp(await requireApiUser("recruit"), String(d.get("message") ?? "")), "Sent. A Platinum admin will follow up.");
}

export async function submitPolicyAction(_: ActionState, d: FormData): Promise<ActionState> {
  return run(async () => {
    const u = await requireApiUser("recruit");
    if (u.impersonatedBy) throw new HttpError(403, "Policies can't be submitted while viewing as a recruit");
    const r = await recruitForUser(u.id);
    if (!r) throw new HttpError(404, "No recruit record");
    const term = Number(d.get("termMonths"));
    await upsertPolicy(
      {
        recruitId: r.id,
        source: "recruit",
        externalRef: `${r.id.slice(0, 8)}:${String(d.get("policyNumber") ?? "").trim()}`,
        policyType: String(d.get("policyType") ?? "Other"),
        carrier: String(d.get("carrier") ?? "") || null,
        businessType: "new",
        writtenDate: String(d.get("writtenDate") ?? ""),
        termMonths: term,
        termPremiumCents: dollarsToCents(String(d.get("termPremium") ?? "")),
      },
      u.id,
    );
    return "Submitted. It counts once Platinum verifies it.";
  });
}

export async function smsConsentAction(_: ActionState, d: FormData): Promise<ActionState> {
  return run(async () => {
    const u = await requireApiUser("recruit");
    if (u.impersonatedBy) throw new HttpError(403, "Consent can only be changed by the recruit");
    const r = await recruitForUser(u.id);
    if (!r) throw new HttpError(404, "No recruit record");
    const granted = d.get("granted") === "yes";
    await db.insert(schema.consent).values({ recruitId: r.id, channel: "sms", granted, source: "dashboard_account_page" });
    await db.insert(schema.activityEvent).values({ recruitId: r.id, type: granted ? "sms_opt_in" : "sms_opt_out", actorKind: actorKind(u), actorUserId: u.id });
    return granted ? "Text messages turned on." : "Text messages turned off.";
  });
}

export async function getMyRecruitId() {
  const u = await requireApiUser("recruit");
  const [r] = await db.select({ id: schema.recruit.id }).from(schema.recruit).where(eq(schema.recruit.userId, u.id));
  return r?.id ?? null;
}

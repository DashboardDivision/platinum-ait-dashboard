import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { provisionFromTwenty } from "@/server/provisioning";
import { changePassword } from "@/server/account";
import { markReadyToSchedule, recordExamClick, recordStudyClick, startTraining } from "@/server/recruit-actions";
import { reviewDocument, uploadDocument } from "@/server/documents";
import { approveExternalContract } from "@/server/contracts";
import { adjustPolicy, recomputeProduction, reviewPolicy, upsertPolicy } from "@/server/production";
import { recordReimbursementPayment, updateReimbursement } from "@/server/money-ledger";
import { deriveState } from "@/domain/stages";
import { loadIntervals } from "@/server/stages";
import type { CurrentUser } from "@/server/session";
import { HttpError } from "@/server/session";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");

async function signIn(email: string, password: string) {
  const res = await auth().api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return new Headers({ cookie });
}

async function makeAdmin() {
  const ctx = await auth().$context;
  const id = "admin-1";
  await db.insert(schema.user).values({ id, name: "Admin", email: "admin@example.com", role: "admin" });
  await db.insert(schema.account).values({ id: "acc-admin", accountId: id, providerId: "credential", userId: id, password: await ctx.password.hash("admin-strong-password-1") });
  return id;
}

async function stageOf(recruitId: string) {
  return deriveState(await loadIntervals(db, recruitId));
}

describe("end-to-end AIT journey (fictitious data)", () => {
  beforeEach(resetDb);

  it("takes a new Twenty recruit from enrollment to $250,000 graduation", async () => {
    const adminId = await makeAdmin();
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "r1", eventId: "e1", record: { name: "Casey Morgan", email: "casey@example.com", phone: "801-555-0100", createdAt: "2026-09-01T15:00:00Z" } });
    const [r0] = await db.select().from(schema.recruit);
    expect(r0.accountCreatedAt).not.toBeNull();
    expect(r0.firstLoginAt).toBeNull();

    // Stage 1: starter login, then the required change. No MFA, no verification step.
    const h = await signIn("casey@example.com", "8015550100");
    let [r] = await db.select().from(schema.recruit);
    expect(r.firstLoginAt).not.toBeNull();
    expect((await stageOf(r.id)).currentStage).toBe(1);
    await expect(changePassword({ userId: r.userId!, currentPassword: "8015550100", newPassword: "801-555-0100", headers: h, impersonatedBy: null })).rejects.toThrow(/phone number/);
    await changePassword({ userId: r.userId!, currentPassword: "8015550100", newPassword: "Casey-new-pass-77", headers: h, impersonatedBy: null });
    await expect(signIn("casey@example.com", "8015550100")).rejects.toBeTruthy();
    await signIn("casey@example.com", "Casey-new-pass-77");
    expect((await stageOf(r.id)).currentStage).toBe(2);
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId!));
    expect(u.mustChangePassword).toBe(false);
    expect(u.emailVerified).toBe(false);

    const me: CurrentUser = { id: u.id, email: u.email, name: u.name, role: "recruit", mustChangePassword: false, impersonatedBy: null, sessionCreatedAt: new Date() };
    const asAdmin: CurrentUser = { ...me, impersonatedBy: adminId };

    // Stage 2: readiness requires a recorded study click; impersonation can't do it.
    await expect(markReadyToSchedule(me)).rejects.toBeInstanceOf(HttpError);
    await recordStudyClick(asAdmin, "https://insurance.getstrategic.vip");
    [r] = await db.select().from(schema.recruit);
    expect(r.firstStudyClickAt).toBeNull();
    await recordStudyClick(me, "https://insurance.getstrategic.vip");
    await expect(markReadyToSchedule(asAdmin)).rejects.toBeInstanceOf(HttpError);
    await markReadyToSchedule(me);
    expect((await stageOf(r.id)).currentStage).toBe(3);

    // Stage 3: the click completes it once; repeats don't restart anything.
    expect(await recordExamClick(me)).toBe("https://www.prometric.com/utah/insurance");
    await recordExamClick(me);
    expect((await stageOf(r.id)).currentStage).toBe(4);
    expect((await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "stage_completed")))).toHaveLength(3);

    // Stage 4: upload alone does nothing; rejection asks for replacement; approval completes and creates one case.
    const doc1 = await uploadDocument(me, { recruitId: r.id, kind: "exam_result", fileName: "result.pdf", data: PDF, state: "ut" });
    expect((await stageOf(r.id)).currentStage).toBe(4);
    expect(await db.select().from(schema.reimbursement)).toHaveLength(0);
    await reviewDocument(adminId, doc1.id, "reject", "Photo is cut off");
    const doc2 = await uploadDocument(me, { recruitId: r.id, kind: "exam_result", fileName: "result2.pdf", data: PDF });
    await reviewDocument(adminId, doc2.id, "approve", null);
    const lic = await uploadDocument(me, { recruitId: r.id, kind: "license", fileName: "license.pdf", data: PDF, licenseNumber: "UT-1" });
    await reviewDocument(adminId, lic.id, "approve", null);
    expect((await stageOf(r.id)).currentStage).toBe(5);
    expect(await db.select().from(schema.reimbursement)).toHaveLength(1);
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "stage4_admin_followup"))).toHaveLength(1);
    expect((await db.select().from(schema.task).where(eq(schema.task.kind, "stage4_followup")))).toHaveLength(1);

    // Receipt arrives after approval; reimbursement is approved and paid once.
    await uploadDocument(me, { recruitId: r.id, kind: "receipt", fileName: "receipt.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) });
    const [case_] = await db.select().from(schema.reimbursement);
    expect(case_.status).toBe("submitted");
    await updateReimbursement(adminId, case_.id, { testCostCents: 6800, decision: "approve" });
    await recordReimbursementPayment(adminId, case_.id, 6800, "2026-10-01", "CHK-1001");
    await expect(recordReimbursementPayment(adminId, case_.id, 6800, "2026-10-01", "CHK-1001")).rejects.toThrow(/already recorded/);
    await expect(recordReimbursementPayment(adminId, case_.id, 100, "2026-10-01", "CHK-1002")).rejects.toThrow(/exceed/);
    expect((await db.select().from(schema.reimbursement))[0].status).toBe("paid");

    // Stage 5: production doesn't count before a verified contract; training needs the contract.
    await expect(startTraining(me)).rejects.toBeInstanceOf(HttpError);
    const early = await upsertPolicy({ recruitId: r.id, source: "admin", externalRef: "POL-0", policyType: "Auto", businessType: "new", writtenDate: "2026-09-20", termMonths: 6, termPremiumCents: 50000, status: "approved" }, adminId);
    expect((await recomputeProduction(r.id)).qualifyingCents).toBe(0);
    const contractDoc = await uploadDocument({ ...me, id: adminId, role: "admin" }, { recruitId: r.id, kind: "contract_external", fileName: "contract.pdf", data: PDF });
    await approveExternalContract(adminId, r.id, contractDoc.id, "2026-09-25", "Signed in office, wet signature");
    await startTraining(me);
    await startTraining(me);
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "training_started"))).toHaveLength(1);
    expect((await recomputeProduction(r.id)).qualifyingCents).toBe(0); // POL-0 written before signing

    // Policies: pending doesn't count; one approval crosses several thresholds with one consolidated message.
    const big = await upsertPolicy({ recruitId: r.id, source: "recruit", externalRef: "POL-1", policyType: "Commercial", businessType: "new", writtenDate: "2026-09-28", termMonths: 12, termPremiumCents: 6_000_000 }, u.id);
    expect((await recomputeProduction(r.id)).qualifyingCents).toBe(0);
    await reviewPolicy(adminId, big.id, "approved", null);
    const achieved1 = await db.select().from(schema.milestoneAchievement);
    expect(achieved1.map((a) => a.milestone).sort()).toEqual(["first_policy", "premium_25k", "premium_50k"]);
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "milestones_achieved"))).toHaveLength(1);

    // Re-importing the same policy doesn't duplicate it.
    await upsertPolicy({ recruitId: r.id, source: "recruit", externalRef: "POL-1", policyType: "Commercial", businessType: "new", writtenDate: "2026-09-28", termMonths: 12, termPremiumCents: 6_000_000 }, u.id);
    expect(await db.select().from(schema.policy)).toHaveLength(2);

    // Renewals excluded; six-month term doubled; cancellation flags but keeps history.
    await upsertPolicy({ recruitId: r.id, source: "admin", externalRef: "POL-R", policyType: "Home", businessType: "renewal", writtenDate: "2026-09-29", termMonths: 12, termPremiumCents: 9_000_000, status: "approved" }, adminId);
    await upsertPolicy({ recruitId: r.id, source: "admin", externalRef: "POL-2", policyType: "Auto", businessType: "new", writtenDate: "2026-09-29", termMonths: 6, termPremiumCents: 9_500_000, status: "approved" }, adminId);
    let prod = await recomputeProduction(r.id);
    expect(prod.qualifyingCents).toBe(6_000_000 + 19_000_000);
    const [rg] = await db.select().from(schema.recruit);
    expect(rg.graduatedAt).not.toBeNull();
    expect((await stageOf(r.id)).finished).toBe(true);
    expect(await db.select().from(schema.milestoneAchievement)).toHaveLength(6);

    await adjustPolicy(adminId, big.id, "cancellation", -6_000_000, "Cancelled for non-payment");
    prod = await recomputeProduction(r.id);
    expect(prod.qualifyingCents).toBe(19_000_000);
    expect(prod.below).toBe("graduation");
    expect(await db.select().from(schema.milestoneAchievement)).toHaveLength(6);
    expect(early.status).toBe("approved");
  });
});

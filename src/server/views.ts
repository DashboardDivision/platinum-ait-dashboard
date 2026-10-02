import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { deriveState, STAGES, stageDurationMs, type StageNumber } from "@/domain/stages";
import { graduationPercent, MILESTONES, nextTarget } from "@/domain/milestones";
import { loadIntervals } from "./stages";
import { productionFor } from "./production";
import { examUrlFor, getSetting } from "./settings";
import { adobeSignConfigured } from "./contracts";

export async function recruitOverview(recruitId: string, now = new Date()) {
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, recruitId));
  if (!r) return null;
  const intervals = await loadIntervals(db, recruitId);
  const state = deriveState(intervals);
  const stages = STAGES.map((s) => {
    const own = intervals.filter((i) => i.stage === s.n).sort((a, b) => +a.enteredAt - +b.enteredAt);
    const first = own[0];
    const last = own[own.length - 1];
    const completed = own.length > 0 && own.every((i) => i.completedAt);
    return {
      ...s,
      enteredAt: first?.enteredAt ?? null,
      completedAt: completed ? last.completedAt : null,
      current: !state.finished && state.currentStage === s.n,
      done: completed,
      reopened: own.length > 1,
      durationMs: own.length ? stageDurationMs(intervals, s.n as StageNumber, now) : null,
    };
  });
  const provisioning = await db.select().from(schema.provisioning).where(eq(schema.provisioning.recruitId, recruitId));
  const documents = await db.select().from(schema.document).where(eq(schema.document.recruitId, recruitId)).orderBy(desc(schema.document.uploadedAt));
  const contracts = await db.select().from(schema.contractInstance).where(eq(schema.contractInstance.recruitId, recruitId)).orderBy(desc(schema.contractInstance.createdAt));
  const prod = await productionFor(db, recruitId);
  const achievements = await db.select().from(schema.milestoneAchievement).where(eq(schema.milestoneAchievement.recruitId, recruitId));
  const achievedSet = new Set(achievements.map((a) => a.milestone));
  const reimbursements = await db.select().from(schema.reimbursement).where(eq(schema.reimbursement.recruitId, recruitId));
  const reimbPayments = reimbursements.length
    ? await db.select().from(schema.reimbursementPayment).where(inArray(schema.reimbursementPayment.reimbursementId, reimbursements.map((c) => c.id)))
    : [];
  const payouts = await db.select().from(schema.payout).where(eq(schema.payout.recruitId, recruitId)).orderBy(desc(schema.payout.createdAt));
  const examCfg = await getSetting("examScheduling");
  const studyClicks = await db.select().from(schema.activityEvent).where(and(eq(schema.activityEvent.recruitId, recruitId), eq(schema.activityEvent.type, "study_link_click"), eq(schema.activityEvent.actorKind, "recruit")));

  const milestoneRows = MILESTONES.map((m, i) => {
    const a = achievements.find((x) => x.milestone === m.key);
    const prev = i > 0 ? achievements.find((x) => x.milestone === MILESTONES[i - 1].key) : null;
    return {
      ...m,
      achievedAt: a?.achievedAt ?? null,
      sinceTrainingMs: a && r.trainingStartedAt ? +a.achievedAt - +r.trainingStartedAt : null,
      sinceContractMs: a && r.contractSignedAt ? +a.achievedAt - +r.contractSignedAt : null,
      sincePreviousMs: a && prev ? +a.achievedAt - +prev.achievedAt : null,
    };
  });

  return {
    recruit: r,
    state,
    stages,
    intervals,
    provisioning: {
      dashboard: provisioning.find((p) => p.system === "dashboard") ?? null,
      education: provisioning.find((p) => p.system === "education") ?? null,
    },
    documents,
    contracts,
    contractSigningAvailable: adobeSignConfigured(),
    production: {
      qualifyingCents: prod.qualifyingCents,
      contributingPolicyCount: prod.contributingPolicyCount,
      policies: prod.policies,
      adjustmentsByPolicy: prod.adjustmentsByPolicy,
      next: nextTarget(prod.qualifyingCents, achievedSet),
      percent: graduationPercent(prod.qualifyingCents),
      milestones: milestoneRows,
    },
    reimbursements: reimbursements.map((c) => ({ ...c, payments: reimbPayments.filter((p) => p.reimbursementId === c.id) })),
    payouts,
    examUrl: examUrlFor(examCfg, r.homeState),
    examLabel: examCfg.defaultLabel,
    studyClickCount: studyClicks.length,
    daysSinceSignupMs: +now - +r.enrollmentAt,
  };
}

export type RecruitOverview = NonNullable<Awaited<ReturnType<typeof recruitOverview>>>;

/** What the recruit should do next, in plain words. */
export function nextAction(o: RecruitOverview): { title: string; body: string; cta?: "study" | "ready" | "exam" | "upload" | "contract" | "training" | "production" } {
  const r = o.recruit;
  if (o.state.finished) return { title: "You graduated", body: "You reached $250,000 in qualifying annualized premium. Congratulations." };
  switch (o.state.currentStage) {
    case 1:
      return { title: "Change your password", body: "Choose your own password to finish Stage 1." };
    case 2:
      return r.firstStudyClickAt
        ? { title: "Keep studying, then tell us you're ready", body: "When you feel ready to schedule your P&C exam, confirm it below. This is your own readiness, not a course-completion check.", cta: "ready" }
        : { title: "Open your P&C study materials", body: "Study for the Property & Casualty license exam on the Platinum study site.", cta: "study" };
    case 3:
      return o.examUrl
        ? { title: "Schedule your insurance exam", body: `Register and book your exam with ${o.examLabel}.`, cta: "exam" }
        : { title: "Exam scheduling link coming soon", body: "Platinum hasn't set up the scheduling link yet. Use Need help? and we'll get you the right link." };
    case 4:
      return { title: "Upload your passing results", body: "After you pass, upload a photo or PDF of your official results or your state license. An admin reviews it.", cta: "upload" };
    case 5:
      if (!r.contractSignedAt) return { title: "Sign your AIT contract", body: "Your contract unlocks training and production tracking.", cta: "contract" };
      if (!r.trainingStartedAt) return { title: "Start training", body: "Your signed contract is verified. Record your training start.", cta: "training" };
      return { title: o.production.next ? `Next: ${o.production.next.label}` : "Keep writing business", body: "Production counts once Platinum approves each policy.", cta: "production" };
  }
}

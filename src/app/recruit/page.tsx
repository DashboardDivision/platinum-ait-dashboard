import { requirePageUser, recruitForUser } from "@/server/session";
import { MilestoneGraph } from "@/components/milestone-graph";
import { recruitOverview, nextAction } from "@/server/views";
import { Shell } from "@/components/shell";
import { StageTimeline } from "@/components/stage-timeline";
import { ActionForm } from "@/components/action-form";
import { Badge, ProgressBar, ProvisionBadge } from "@/components/ui";
import { formatCents } from "@/domain/money";
import { formatDate, wholeDays } from "@/domain/durations";
import { env } from "@/lib/env";
import { getSetting } from "@/server/settings";
import { OpenLinkForm } from "@/components/open-link";
import { examDetailsAction, helpAction, notReadyAction, readyAction, startTrainingAction } from "./actions";
import { RecruitMeetingsCard, RecruitTrainingCard } from "@/components/training-cards";
import { meetingAttendanceFor, meetingSessions, trainingModules } from "@/server/training";
import { monthKey, shiftMonth } from "@/domain/training";

export const metadata = { title: "My progress" };

export default async function RecruitHome({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const u = await requirePageUser("recruit");
  const r = await recruitForUser(u.id);
  const { welcome } = await searchParams;
  if (!r) {
    return (
      <Shell user={u} active="/recruit">
        <p className="alert warn">Your account isn't linked to an AIT enrollment yet. Contact Platinum.</p>
      </Shell>
    );
  }
  const o = (await recruitOverview(r.id))!;
  const next = nextAction(o);
  const help = await getSetting("helpContact");
  const eduUrl = env().EDUCATION_URL;
  const showProduction = Boolean(r.contractSignedAt) && (u.impersonatedBy !== null || (u.perms ?? []).includes("recruit.production"));
  const inStage5 = Boolean(o.stages[4]?.enteredAt);
  const month = monthKey(new Date());
  const months = [month, shiftMonth(month, -1), shiftMonth(month, -2)];
  const [training, sessions, attendance] = await Promise.all([
    inStage5 ? trainingModules(r.id) : null, meetingSessions(months), meetingAttendanceFor([r.id], months),
  ]);

  return (
    <Shell user={u} active="/recruit">
      <div className="topbar">
        <div>
          <h1>{r.fullName}</h1>
          <p className="sub tabular">
            Day {wholeDays(o.daysSinceSignupMs) + 1} since you joined AIT · enrolled {formatDate(r.enrollmentAt)}
          </p>
        </div>
      </div>
      {welcome ? <p className="alert ok" style={{ marginBottom: 16 }}>Your password is set. Stage 1 is complete.</p> : null}

      <div className="grid-main">
        <div className="stack">
          <section className="card next-action" aria-labelledby="next-title">
            <div className="bd">
              <div className="eyebrow">Your next step</div>
              <h2 id="next-title">{next.title}</h2>
              <p className="muted" style={{ marginBottom: 14 }}>{next.body}</p>
              {next.cta === "study" ? <OpenLinkForm href="/recruit/open/study" className="btn lg">Open P&amp;C Study Materials</OpenLinkForm> : null}
              {next.cta === "ready" ? (
                <div className="row">
                  <div className="shrink"><OpenLinkForm href="/recruit/open/study" className="btn lg secondary">Open P&amp;C Study Materials</OpenLinkForm></div>
                  <div className="shrink">
                    <ActionForm action={readyAction} submit="I'm ready to schedule my exam" size="lg" className="" />
                  </div>
                </div>
              ) : null}
              {next.cta === "exam" ? <OpenLinkForm href="/recruit/open/exam" className="btn lg">Click here to schedule your insurance exam</OpenLinkForm> : null}
              {(o.state.currentStage === 3 && r.readyToScheduleAt && !r.examLinkClickedAt) ||
              (o.state.currentStage === 4 && !o.documents.some((d) => d.kind === "exam_result" || d.kind === "license")) ? (
                <div style={{ marginTop: 10 }}>
                  <ActionForm
                    action={notReadyAction}
                    submit="Just kidding, I'm not ready"
                    variant="secondary"
                    className=""
                    confirm={o.state.currentStage === 3 ? "Go back to studying? You can tell us you're ready again any time." : "Go back to scheduling your exam? You can open exam scheduling again any time."}
                  />
                </div>
              ) : null}
              {next.cta === "upload" ? <a className="btn lg" href="/recruit/documents">Upload results or license</a> : null}
              {next.cta === "contract" ? (
                o.contracts.find((c) => c.status === "sent") ? (
                  <p className="alert info">Your contract was sent by email from Adobe Acrobat Sign. Open that email to sign it.</p>
                ) : (
                  <p className="alert info">Platinum will send your contract for signature. You'll get an email when it's ready.</p>
                )
              ) : null}
              {next.cta === "training" ? <ActionForm action={startTrainingAction} submit="Start Training" size="lg" className="" /> : null}
              {next.cta === "production" ? <a className="btn lg secondary" href="/recruit/production">See production</a> : null}
            </div>
          </section>

          <section className="card" aria-labelledby="stages-title">
            <div className="hd"><h2 id="stages-title">Your five stages</h2></div>
            <div className="bd"><StageTimeline o={o} /></div>
          </section>

          {training ? <RecruitTrainingCard training={training} /> : null}

          <RecruitMeetingsCard month={month} sessions={sessions} attendance={attendance.get(r.id) ?? []} history={months.slice(1)} />

          <section className="card" aria-labelledby="milestones-title">
            <div className="hd">
              <h2 id="milestones-title">Milestones</h2>
              {showProduction ? <a href="/recruit/production" className="small">Details</a> : null}
            </div>
            <div className="bd">
              <MilestoneGraph milestones={o.production.milestones} qualifyingCents={o.production.qualifyingCents} locked={!r.contractSignedAt} />
              <details className="disclose" style={{ marginTop: 10 }}>
              <summary className="small">Milestone dates</summary>
              <ul className="milestones">
                {o.production.milestones.map((m) => (
                  <li key={m.key}>
                    <span>{m.achievedAt ? "✓ " : ""}{m.label}</span>
                    <span className="small muted tabular" style={{ textAlign: "right" }}>{m.achievedAt ? formatDate(m.achievedAt) : "Not yet"}</span>
                  </li>
                ))}
              </ul>
              </details>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="study-title">
            <div className="hd"><h2 id="study-title">Study site</h2></div>
            <div className="bd form-grid">
              <div className="row" style={{ alignItems: "center" }}>
                <span>Study account</span>
                <span className="shrink"><ProvisionBadge status={o.provisioning.education?.status ?? "unavailable"} /></span>
              </div>
              {o.provisioning.education?.status === "ready" ? (
                <p className="small muted">
                  Sign in at <a href={eduUrl} target="_blank" rel="noopener noreferrer">{eduUrl.replace("https://", "")}</a> with your email. {o.provisioning.education.linkedExisting
                    ? "Use the password you already had there."
                    : "Your first password there is your phone number, numbers only; you'll choose your own the first time you sign in."} After that, its password is separate from this dashboard's.
                </p>
              ) : (
                <p className="small muted">
                  The study site has its own sign-in. Create your study account at <a href={eduUrl} target="_blank" rel="noopener noreferrer">{eduUrl.replace("https://", "")}</a> with the Sign up link, using the same email. Its password is separate from this dashboard's.
                </p>
              )}
              <OpenLinkForm href="/recruit/open/study" className="btn secondary">Open P&amp;C Study Materials</OpenLinkForm>
              <p className="small muted">Study time: unavailable. The study site doesn't report activity to this dashboard.</p>
            </div>
          </section>

          {o.state.currentStage >= 3 && !o.state.finished ? (
            <section className="card" aria-labelledby="exam-title">
              <div className="hd"><h2 id="exam-title">Exam details</h2></div>
              <div className="bd">
                <p className="small muted" style={{ marginBottom: 10 }}>Optional. Booking isn't verified by Platinum.</p>
                <ActionForm action={examDetailsAction} submit="Save" variant="secondary">
                  <div className="row">
                    <label className="f">Exam date<input type="date" name="examDate" defaultValue={r.examDate ?? ""} /></label>
                    <label className="f">State<input type="text" name="homeState" maxLength={2} defaultValue={r.homeState ?? ""} placeholder="UT" /></label>
                  </div>
                  <label className="f">Booking confirmation number<input type="text" name="confirmation" defaultValue={r.examBookingConfirmation ?? ""} /></label>
                </ActionForm>
                {o.state.currentStage > 3 && o.examUrl ? (
                  <div style={{ marginTop: 10 }}><OpenLinkForm href="/recruit/open/exam" className="btn small secondary">Open exam scheduling again</OpenLinkForm></div>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="card" aria-labelledby="help-title">
            <div className="hd"><h2 id="help-title">Need help?</h2></div>
            <div className="bd">
              {help ? (
                <p className="small" style={{ marginBottom: 10 }}>
                  Your Platinum contact: <strong>{help.name}</strong>
                  {help.phone ? <> · <a href={`tel:${help.phone.replace(/\D/g, "")}`}>{help.phone}</a></> : null}
                  {help.email ? <> · <a href={`mailto:${help.email}`}>{help.email}</a></> : null}
                </p>
              ) : null}
              <ActionForm action={helpAction} submit="Send" variant="secondary">
                <label className="f">
                  What do you need?
                  <textarea name="message" maxLength={2000} required />
                </label>
              </ActionForm>
            </div>
          </section>

          {r.premiumBelowThreshold ? <Badge tone="warn">Premium adjusted after a cancellation; Platinum is reviewing</Badge> : null}
        </div>
      </div>
    </Shell>
  );
}

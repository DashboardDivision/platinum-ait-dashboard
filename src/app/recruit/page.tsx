import { requirePageUser, recruitForUser } from "@/server/session";
import { recruitOverview, nextAction } from "@/server/views";
import { Shell } from "@/components/shell";
import { StageTimeline } from "@/components/stage-timeline";
import { ActionForm } from "@/components/action-form";
import { Badge, ProgressBar, ProvisionBadge } from "@/components/ui";
import { formatCents } from "@/domain/money";
import { formatDate, wholeDays } from "@/domain/durations";
import { env } from "@/lib/env";
import { getSetting } from "@/server/settings";
import { examClickAction, examDetailsAction, helpAction, openStudyAction, readyAction, startTrainingAction } from "./actions";

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
  const showProduction = Boolean(r.contractSignedAt);

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
              {next.cta === "study" ? (
                <form action={openStudyAction}>
                  <button className="btn lg" type="submit">Open P&amp;C Study Materials</button>
                </form>
              ) : null}
              {next.cta === "ready" ? (
                <div className="row">
                  <form action={openStudyAction} className="shrink">
                    <button className="btn lg secondary" type="submit">Open P&amp;C Study Materials</button>
                  </form>
                  <div className="shrink">
                    <ActionForm action={readyAction} submit="I'm ready to schedule my exam" size="lg" className="" />
                  </div>
                </div>
              ) : null}
              {next.cta === "exam" ? (
                <form action={examClickAction}>
                  <button className="btn lg" type="submit">Click here to schedule your insurance exam</button>
                </form>
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

          {showProduction ? (
            <section className="card" aria-labelledby="prod-title">
              <div className="hd">
                <h2 id="prod-title">Production toward graduation</h2>
                <a href="/recruit/production" className="small">Details</a>
              </div>
              <div className="bd">
                <div className="row" style={{ alignItems: "baseline", marginBottom: 8 }}>
                  <div>
                    <div className="tabular" style={{ fontSize: 24, fontWeight: 650 }}>{formatCents(o.production.qualifyingCents, { whole: true })}</div>
                    <div className="small muted">approved qualifying annualized premium of $250,000</div>
                  </div>
                  <div className="shrink small muted tabular">{o.production.percent}%</div>
                </div>
                <ProgressBar percent={o.production.percent} label="Progress toward $250,000 graduation" />
                {o.production.next ? (
                  <p className="small" style={{ marginTop: 10 }}>
                    Next target: <strong>{o.production.next.label}</strong>
                    {o.production.next.thresholdCents != null ? <> · {formatCents(o.production.next.remainingCents, { whole: true })} to go</> : null}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>

        <div className="stack">
          <section className="card" aria-labelledby="study-title">
            <div className="hd"><h2 id="study-title">Study site</h2></div>
            <div className="bd form-grid">
              <div className="row" style={{ alignItems: "center" }}>
                <span>Study account</span>
                <span className="shrink"><ProvisionBadge status={o.provisioning.education?.status ?? "unavailable"} /></span>
              </div>
              <p className="small muted">
                The study site has its own sign-in. Create your study account at <a href={eduUrl}>{eduUrl.replace("https://", "")}</a> with the Sign up link, using the same email. Its password is separate from this dashboard's.
              </p>
              <form action={openStudyAction}>
                <button className="btn secondary" type="submit">Open P&amp;C Study Materials</button>
              </form>
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
                  <form action={examClickAction} style={{ marginTop: 10 }}>
                    <button className="btn small secondary" type="submit">Open exam scheduling again</button>
                  </form>
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

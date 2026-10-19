import { formatDate } from "@/domain/durations";
import type { RecruitOverview } from "@/server/views";
import { Badge, Duration } from "./ui";

/** `stage0` is passed only on admin pages: recruits never see Stage 0. */
export function StageTimeline({ o, admin = false, stage0 }: { o: RecruitOverview; admin?: boolean; stage0?: { sentAt: Date | null; status: string } }) {
  const r = o.recruit;
  const blocked: Record<number, string> = {
    2: "Starts after you choose your own password.",
    3: "Starts after you confirm you're ready to schedule.",
    4: "Starts after you open the exam scheduling link.",
    5: "Starts when your passing results are approved.",
  };
  return (
    <ol className="timeline">
      {stage0 ? (
        <li>
          <span className={`dot ${stage0.sentAt ? "done" : "current"}`} aria-hidden="true">{stage0.sentAt ? "✓" : 0}</span>
          <div>
            <div style={{ fontWeight: 600 }}>Stage 0: Email Sent<span className="sr-only">{stage0.sentAt ? " (completed)" : " (current)"}</span></div>
            <div className="small muted">
              {stage0.sentAt ? <>Welcome email delivered {formatDate(stage0.sentAt)}</>
                : stage0.status === "suppressed" ? "Not sent (enrolled by quiet backfill)"
                : stage0.status === "failed" ? "The welcome email failed. Resend it from Account below."
                : stage0.status === "queued" ? "Sending now"
                : "Waits for their account to be created"}
            </div>
          </div>
          <div />
        </li>
      ) : null}
      {o.stages.map((s) => (
        <li key={s.n}>
          <span className={`dot ${s.done ? "done" : s.current ? "current" : ""}`} aria-hidden="true">
            {s.done ? "✓" : s.n}
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>
              Stage {s.n}: {s.title}
              <span className="sr-only">{s.done ? " (completed)" : s.current ? " (current)" : " (not started)"}</span>
            </div>
            <div className="small muted">
              {s.done && s.completedAt ? <>Completed {formatDate(s.completedAt)}</> : s.current ? <>In progress since {formatDate(s.enteredAt)}</> : blocked[s.n] ?? ""}
              {s.reopened ? " · reopened by an admin" : ""}
            </div>
            {s.n === 3 && r.examLinkClickedAt ? (
              <div className="small" style={{ marginTop: 4 }}>
                <Badge tone="info">Scheduling link opened</Badge>{" "}
                <span className="muted">The booking itself isn't verified.{r.examDate ? ` Exam date you entered: ${r.examDate}.` : ""}</span>
              </div>
            ) : null}
            {s.n === 5 && s.current ? (
              <div className="small" style={{ marginTop: 4 }}>
                {r.trainingStartedAt ? <Badge tone="ok">In training</Badge> : <Badge tone="warn">Awaiting contract</Badge>}
                {admin && r.contractSignedAt ? <span className="muted"> · contract wait <Duration ms={+r.contractSignedAt - +(s.enteredAt ?? r.contractSignedAt)} /></span> : null}
                {admin && r.trainingStartedAt ? <span className="muted"> · training <Duration ms={Date.now() - +r.trainingStartedAt} /></span> : null}
              </div>
            ) : null}
          </div>
          <div className="small muted tabular" style={{ textAlign: "right" }}>
            {s.durationMs != null ? (
              <>
                <Duration ms={s.durationMs} />
                <div>{s.done ? "took" : "so far"}</div>
              </>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

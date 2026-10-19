import { Badge, ProgressBar } from "@/components/ui";
import { OpenLinkForm } from "@/components/open-link";
import { formatDate, formatDateTime } from "@/domain/durations";
import { meetingLabel, monthLabel } from "@/domain/training";
import type { AttendanceView, MeetingSessionView, TrainingModuleView } from "@/server/training";

/** Recruit view of the Stage 5 training modules. Read-only: admins check them off. */
export function RecruitTrainingCard({ training }: { training: { modules: TrainingModuleView[]; done: number; total: number } }) {
  const all = training.done === training.total;
  return (
    <section className="card" aria-labelledby="training-title">
      <div className="hd">
        <h2 id="training-title">Stage 5 training modules</h2>
        {all ? <Badge tone="ok">All modules done</Badge> : <span className="small muted tabular">{training.done} of {training.total} done</span>}
      </div>
      <div className="bd">
        <ProgressBar percent={Math.round((training.done / training.total) * 100)} label="Training modules completed" />
        <ul className="milestones" style={{ marginTop: 10 }}>
          {training.modules.map((m) => (
            <li key={m.key}>
              <span>{m.completedAt ? "✓ " : ""}{m.label}</span>
              <span className="small muted tabular" style={{ textAlign: "right" }}>{m.completedAt ? formatDate(m.completedAt) : "Not yet"}</span>
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ marginTop: 8 }}>Platinum checks each module off when you complete it.</p>
      </div>
    </section>
  );
}

function AttendanceBadge({ a }: { a: AttendanceView | undefined }) {
  if (a?.attended === true) return <Badge tone="ok">Attended</Badge>;
  if (a?.attended === false) return <Badge tone="bad">Missed</Badge>;
  return <Badge tone="info">Not marked yet</Badge>;
}

/** Recruit view of the two mandatory monthly meetings: this month's Join buttons plus recent history. */
export function RecruitMeetingsCard({ month, sessions, attendance, history }: {
  month: string; sessions: MeetingSessionView[]; attendance: AttendanceView[]; history: string[];
}) {
  const find = (m: string, k: string) => attendance.find((a) => a.month === m && a.key === k);
  return (
    <section className="card" aria-labelledby="meetings-title">
      <div className="hd"><h2 id="meetings-title">Monthly meetings</h2><span className="small muted">{monthLabel(month)} · both required</span></div>
      <div className="bd form-grid">
        {sessions.filter((s) => s.month === month).map((s) => (
          <div key={s.key} className="row" style={{ alignItems: "center" }}>
            <div>
              <strong>{s.label}</strong>
              <div className="small muted">{s.startsAt ? formatDateTime(s.startsAt) : "Date to be announced"}</div>
            </div>
            <div className="shrink"><AttendanceBadge a={find(month, s.key)} /></div>
            <div className="shrink">
              {s.joinUrl
                ? <OpenLinkForm href={`/recruit/open/meeting-${s.key}`} className="btn secondary">Join {s.label}</OpenLinkForm>
                : <span className="small muted">Link not posted yet</span>}
            </div>
          </div>
        ))}
        {history.length ? (
          <details className="disclose">
            <summary className="small">Earlier months</summary>
            <ul className="milestones">
              {history.flatMap((m) => sessions.filter((s) => s.month === m).map((s) => (
                <li key={`${m}-${s.key}`}><span>{monthLabel(m)} · {meetingLabel(s.key)}</span><AttendanceBadge a={find(m, s.key)} /></li>
              )))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

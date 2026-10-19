import { ActionForm } from "@/components/action-form";
import type { ActionState } from "@/components/action-form";
import { Badge, ProgressBar } from "@/components/ui";
import { formatDate, formatDateTime } from "@/domain/durations";
import { meetingLabel, monthLabel } from "@/domain/training";
import type { AttendanceView, TrainingModuleView } from "@/server/training";

type Action = (prev: ActionState, data: FormData) => Promise<ActionState>;

/** Admin checklist for the nine Stage 5 training modules. */
export function AdminTrainingCard({ recruitId, training, inStage5, canEdit, action }: {
  recruitId: string; training: { modules: TrainingModuleView[]; done: number; total: number }; inStage5: boolean; canEdit: boolean; action: Action;
}) {
  return (
    <section className="card" id="training-modules">
      <div className="hd">
        <h2>Stage 5 training modules</h2>
        {training.done === training.total ? <Badge tone="ok">All modules done</Badge> : <span className="small muted tabular">{training.done} of {training.total} done</span>}
      </div>
      <div className="bd">
        {!inStage5 ? <p className="alert info small" style={{ marginBottom: 10 }}>The recruit sees these once they reach Stage 5 (Start Training).</p> : null}
        <ProgressBar percent={Math.round((training.done / training.total) * 100)} label="Training modules completed" />
        <ul className="milestones" style={{ marginTop: 10 }}>
          {training.modules.map((m) => (
            <li key={m.key} style={{ alignItems: "center" }}>
              <span>{m.completedAt ? "✓ " : ""}{m.label}{m.completedAt ? <span className="small muted"> · {formatDate(m.completedAt)}</span> : null}</span>
              {canEdit ? (
                <ActionForm action={action} submit={m.completedAt ? "Undo" : "Mark complete"} variant={m.completedAt ? "secondary" : undefined} size="small" className=""
                  confirm={m.completedAt ? `Uncheck "${m.label}"?` : undefined}>
                  <input type="hidden" name="recruitId" value={recruitId} />
                  <input type="hidden" name="module" value={m.key} />
                  <input type="hidden" name="done" value={m.completedAt ? "0" : "1"} />
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Mark({ a }: { a: AttendanceView }) {
  if (a.attended === true) return <Badge tone="ok">Attended</Badge>;
  if (a.attended === false) return <Badge tone="bad">Missed</Badge>;
  return <Badge tone="neutral">Not marked</Badge>;
}

/** Attendance controls for one recruit and one meeting/month: Attended, Missed, Clear. */
export function AttendanceButtons({ recruitId, a, action }: { recruitId: string; a: AttendanceView; action: Action }) {
  const choices: [string, string][] = a.attended === true ? [["no", "Missed"], ["", "Clear"]] : a.attended === false ? [["yes", "Attended"], ["", "Clear"]] : [["yes", "Attended"], ["no", "Missed"]];
  return (
    <div className="row" style={{ gap: 6 }}>
      {choices.map(([v, label]) => (
        <div className="shrink" key={label}>
          <ActionForm action={action} submit={label} size="small" variant={v === "yes" ? undefined : "secondary"} className="">
            <input type="hidden" name="recruitId" value={recruitId} />
            <input type="hidden" name="month" value={a.month} />
            <input type="hidden" name="meeting" value={a.key} />
            <input type="hidden" name="attended" value={v} />
          </ActionForm>
        </div>
      ))}
    </div>
  );
}

/** One recruit's monthly meeting attendance (this month and the two before), with the recruit's link clicks. */
export function AdminMeetingsCard({ recruitId, attendance, canEdit, action }: { recruitId: string; attendance: AttendanceView[]; canEdit: boolean; action: Action }) {
  return (
    <section className="card" id="meetings">
      <div className="hd"><h2>Monthly meetings</h2><a className="small" href="/admin/meetings">Meeting links &amp; tracker</a></div>
      <div className="table-wrap"><table className="t stack-sm">
        <thead><tr><th>Month</th><th>Meeting</th><th>Status</th><th>Join link clicked</th>{canEdit ? <th>Mark</th> : null}</tr></thead>
        <tbody>{attendance.map((a) => (
          <tr key={`${a.month}-${a.key}`}>
            <td data-label="Month">{monthLabel(a.month)}</td>
            <td data-label="Meeting">{meetingLabel(a.key)}</td>
            <td data-label="Status"><Mark a={a} /></td>
            <td data-label="Join link clicked" className="small">{a.clickedAt ? formatDateTime(a.clickedAt) : "—"}</td>
            {canEdit ? <td data-label="Mark"><AttendanceButtons recruitId={recruitId} a={a} action={action} /></td> : null}
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}

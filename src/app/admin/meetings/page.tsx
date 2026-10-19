import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { can, requireStaffPage } from "@/server/permissions";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, Empty } from "@/components/ui";
import { AttendanceButtons } from "@/components/admin-training";
import { formatDateTime } from "@/domain/durations";
import { isMonthKey, MONTHLY_MEETINGS, monthKey, monthLabel, shiftMonth } from "@/domain/training";
import { meetingAttendanceFor, meetingSessions } from "@/server/training";
import { meetingAttendanceAction, meetingSessionAction } from "../actions";

export const metadata = { title: "AIT Meetings" };

/** "2026-11-05T08:00" for a datetime-local input, in Denver time. */
function denverInput(d: Date | null) {
  if (!d) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const u = await requireStaffPage("ait.view");
  const canEdit = can(u, "ait.edit");
  const current = monthKey(new Date());
  const { month: asked } = await searchParams;
  const month = asked && isMonthKey(asked) ? asked : current;
  const recruits = await db.select({ id: schema.recruit.id, name: schema.recruit.fullName }).from(schema.recruit)
    .where(eq(schema.recruit.status, "active")).orderBy(asc(schema.recruit.fullName));
  const [sessions, attendance] = await Promise.all([meetingSessions([month]), meetingAttendanceFor(recruits.map((r) => r.id), [month])]);
  const attendedCount = (key: string) => recruits.filter((r) => attendance.get(r.id)?.find((a) => a.key === key)?.attended === true).length;

  return (
    <Shell user={u} active="/admin/meetings">
      <div className="topbar">
        <div>
          <h1>AIT Meetings</h1>
          <p className="sub">Two mandatory meetings every month for every active recruit. Recruits see the Join buttons on their dashboard.</p>
        </div>
      </div>

      <nav className="row" aria-label="Month" style={{ marginBottom: 16, gap: 8 }}>
        <a className="btn secondary small shrink" href={`/admin/meetings?month=${shiftMonth(month, -1)}`}>← {monthLabel(shiftMonth(month, -1))}</a>
        <strong className="shrink" style={{ alignSelf: "center" }}>{monthLabel(month)}{month === current ? " (this month)" : ""}</strong>
        <a className="btn secondary small shrink" href={`/admin/meetings?month=${shiftMonth(month, 1)}`}>{monthLabel(shiftMonth(month, 1))} →</a>
      </nav>

      <section className="card" aria-labelledby="links-title">
        <div className="hd"><h2 id="links-title">Join links for {monthLabel(month)}</h2></div>
        <div className="bd form-grid">
          {sessions.map((s) => (
            <div key={s.key} className="form-grid">
              <h3 style={{ margin: 0 }}>{s.label}</h3>
              {canEdit ? (
                <ActionForm action={meetingSessionAction} submit={`Save ${s.label} link`} variant="secondary">
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="meeting" value={s.key} />
                  <div className="row">
                    <label className="f">Join link (Zoom, Google Meet, Teams…)<input type="url" name="url" defaultValue={s.joinUrl ?? ""} placeholder="https://" /></label>
                    <label className="f shrink">Date and time (Mountain)<input type="datetime-local" name="startsAt" defaultValue={denverInput(s.startsAt)} /></label>
                  </div>
                  <p className="small muted">Leave the link empty to remove it. Recruits only see this month&apos;s links.</p>
                </ActionForm>
              ) : (
                <p className="small">{s.joinUrl ? <a href={s.joinUrl} target="_blank" rel="noopener noreferrer">{s.joinUrl}</a> : "No link yet"}{s.startsAt ? ` · ${formatDateTime(s.startsAt)}` : ""}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="tracker-title" style={{ marginTop: 16 }}>
        <div className="hd">
          <h2 id="tracker-title">Attendance tracker</h2>
          <span className="small muted">{MONTHLY_MEETINGS.map((m) => `${m.label}: ${attendedCount(m.key)} of ${recruits.length}`).join(" · ")}</span>
        </div>
        {recruits.length ? (
          <div className="table-wrap"><table className="t stack-sm">
            <thead><tr><th>Recruit</th>{MONTHLY_MEETINGS.map((m) => <th key={m.key}>{m.label}</th>)}</tr></thead>
            <tbody>{recruits.map((r) => (
              <tr key={r.id}>
                <td data-label="Recruit"><a href={`/admin/recruits/${r.id}#meetings`}>{r.name}</a></td>
                {MONTHLY_MEETINGS.map((m) => {
                  const a = attendance.get(r.id)!.find((x) => x.key === m.key)!;
                  return (
                    <td key={m.key} data-label={m.label}>
                      <div className="form-grid" style={{ gap: 6 }}>
                        <span>{a.attended === true ? <Badge tone="ok">Attended</Badge> : a.attended === false ? <Badge tone="bad">Missed</Badge> : <Badge tone="neutral">Not marked</Badge>}
                          {a.clickedAt ? <span className="small muted"> · clicked Join {formatDateTime(a.clickedAt)}</span> : null}</span>
                        {canEdit ? <AttendanceButtons recruitId={r.id} a={a} action={meetingAttendanceAction} /> : null}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div className="bd"><Empty>No active recruits.</Empty></div>}
      </section>
    </Shell>
  );
}

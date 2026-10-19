import { notFound, redirect } from "next/navigation";
import { TwentyDetails } from "@/components/twenty-details";
import { can } from "@/server/permissions";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { agentOverview } from "@/server/agents";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui";
import { formatDate, formatDateTime } from "@/domain/durations";
import { RECRUITER_NAMES } from "@/domain/programs";
import { agentStatusAction, agentStepAction, agentUndoStepAction, deleteAgentAction, inviteAgentAction } from "../../actions";

export const metadata = { title: "Agent" };

export default async function AgentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string }> }) {
  const u = await requirePageUser("admin");
  const { id } = await params;
  const { sent } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const o = await agentOverview(id);
  if (!o) notFound();
  if (!can(u, `${o.agent.program}.view`)) redirect("/admin/no-access");
  const a = o.agent;
  const p = o.program;
  const twentyUrl = `${process.env.TWENTY_URL ?? "https://crm.getstrategic.vip"}/object/${p.twentyObject}/${a.twentyRecordId}`;
  const auditRows = await db.select().from(schema.auditEvent).where(eq(schema.auditEvent.targetId, a.id)).orderBy(desc(schema.auditEvent.at)).limit(40);
  const lastStep = o.steps.length ? Math.max(...o.steps.map((s) => s.step)) : 0;

  return (
    <Shell user={u} active={p.adminPath}>
      {sent ? <p className="alert ok" style={{ marginBottom: 16 }}>Dashboard login sent to {a.email}.</p> : null}
      <div className="topbar">
        <div>
          <p className="small"><a href={p.adminPath}>← {p.label}</a></p>
          <h1>{a.fullName}</h1>
          <p className="sub">
            {p.label}{a.organization ? ` · ${a.organization}` : ""} · {o.done ? "All steps done" : o.adminCurrent === 0 ? "Step 0: Email Sent" : `Step ${o.current}: ${p.steps[o.current! - 1].title}`}
            {a.status !== "active" ? " · archived" : ""}
          </p>
        </div>
        <div className="row" style={{ flex: "0 0 auto" }}>
          {can(u, `${a.program}.delete`) ? (
            <details className="disclose shrink">
              <summary style={{ color: "var(--bad)" }}>Delete permanently</summary>
              <div className="card"><div className="bd form-grid" style={{ maxWidth: 340 }}>
                <p className="small muted">Removes this contact's dashboard login, steps and history for good. The audit log keeps a record. Can't be undone.</p>
                <ActionForm action={deleteAgentAction} submit="Delete permanently" variant="danger" size="small" confirm={`Permanently delete ${a.fullName}? This can't be undone.`}>
                  <input type="hidden" name="agentId" value={a.id} />
                  <label className="f">Type their full name to confirm<input name="confirm" required autoComplete="off" placeholder={a.fullName} /></label>
                  <label className="row" style={{ gap: 6, alignItems: "center" }}><input type="checkbox" name="alsoTwenty" /> Also delete their record in Twenty</label>
                </ActionForm>
              </div></div>
            </details>
          ) : null}
          <details className="disclose shrink">
            <summary>{a.status === "active" ? "Archive" : "Reactivate"}</summary>
            <div className="card"><div className="bd form-grid" style={{ maxWidth: 320 }}>
              <p className="small muted">{a.status === "active" ? "Turns off their dashboard login. History is kept and you can reactivate later." : "Restores their dashboard login."}</p>
              <ActionForm action={agentStatusAction} submit={a.status === "active" ? "Archive" : "Reactivate"} variant={a.status === "active" ? "danger" : "secondary"} size="small" confirm={`${a.status === "active" ? "Archive" : "Reactivate"} ${a.fullName}?`}>
                <input type="hidden" name="agentId" value={a.id} />
                <input type="hidden" name="status" value={a.status === "active" ? "archived" : "active"} />
                <label className="f">Reason<input type="text" name="reason" required maxLength={300} /></label>
              </ActionForm>
            </div></div>
          </details>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Steps</h2></div>
            <div className="bd">
              <ol className="steps-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                <li style={{ padding: "10px 0", borderBottom: "1px solid var(--line-2)" }}>
                  <strong>{o.welcomeSentAt ? "✓ " : ""}Step 0: Email Sent</strong>
                  <div className="small muted">
                    {o.welcomeSentAt ? `Login email delivered ${formatDate(o.welcomeSentAt)}` : a.welcomeStatus === "failed" ? "The login email failed. Use Re-send login email." : "Sending now"}
                  </div>
                </li>
                {p.steps.map((s, i) => {
                  const n = i + 1;
                  const doneRow = o.steps.find((x) => x.step === n);
                  return (
                    <li key={n} style={{ padding: "10px 0", borderBottom: "1px solid var(--line-2)" }}>
                      <div className="row" style={{ alignItems: "center" }}>
                        <div>
                          <strong>{doneRow ? "✓ " : ""}Step {n}: {s.title}</strong>
                          <div className="small muted">
                            {doneRow ? `Completed ${formatDate(doneRow.completedAt)}${doneRow.note ? ` · ${doneRow.note}` : ""}`
                              : n === o.current ? (n === 1 ? "Completes when they sign in and choose their password." : "Current step") : "Not yet"}
                          </div>
                        </div>
                        <div className="shrink">
                          {n === o.current && n > 1 && a.status === "active" ? (
                            <ActionForm action={agentStepAction} submit="Mark complete" size="small" className="" confirm={`Mark Step ${n} (${s.title}) complete? Every admin is emailed.`}>
                              <input type="hidden" name="agentId" value={a.id} />
                              <input type="hidden" name="step" value={n} />
                              <label className="f small">Note (optional)<input type="text" name="note" maxLength={200} /></label>
                            </ActionForm>
                          ) : null}
                          {n === lastStep && n > 1 ? (
                            <details className="disclose">
                              <summary className="small">Undo</summary>
                              <ActionForm action={agentUndoStepAction} submit="Undo this step" variant="secondary" size="small">
                                <input type="hidden" name="agentId" value={a.id} />
                                <label className="f">Reason<input type="text" name="reason" required maxLength={300} /></label>
                              </ActionForm>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>
          <TwentyDetails target={{ kind: "agent", id: a.id }} canEdit={can(u, `${a.program}.edit`)} />
        </div>

        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Contact</h2><a className="small" href={twentyUrl} target="_blank" rel="noopener noreferrer">Open in Twenty</a></div>
            <div className="bd">
              <dl className="kv">
                <dt>Email</dt><dd>{a.email}</dd>
                <dt>Phone</dt><dd>{a.phoneE164 ?? "–"}</dd>
                <dt>Recruiter</dt><dd>{a.recruiter ? RECRUITER_NAMES[a.recruiter] ?? a.recruiter : "Not set in Twenty"}</dd>
              </dl>
            </div>
          </section>
          <section className="card">
            <div className="hd"><h2>Dashboard login</h2></div>
            <div className="bd form-grid">
              <dl className="kv">
                <dt>Invited</dt><dd>{a.invitedAt ? formatDateTime(a.invitedAt) : "–"}</dd>
                <dt>Welcome email</dt><dd><Badge tone={a.welcomeStatus === "sent" ? "ok" : a.welcomeStatus === "failed" ? "bad" : "info"}>{a.welcomeStatus.replace(/_/g, " ")}</Badge></dd>
                <dt>First sign-in</dt><dd>{a.firstLoginAt ? formatDateTime(a.firstLoginAt) : "Not yet"}</dd>
                <dt>Password</dt><dd>{o.mustChangePassword ? "Still the starter (phone number)" : "Their own"}</dd>
              </dl>
              {a.status === "active" ? (
                <ActionForm action={inviteAgentAction} submit="Re-send login email" variant="secondary" size="small" confirm={`Email ${a.email} their login details again?`}>
                  <input type="hidden" name="program" value={a.program} />
                  <input type="hidden" name="recordId" value={a.twentyRecordId} />
                </ActionForm>
              ) : null}
            </div>
          </section>
          <section className="card">
            <div className="hd"><h2>History</h2></div>
            <div className="bd small" style={{ maxHeight: 320, overflowY: "auto" }}>
              {auditRows.map((x) => (
                <div key={x.id} style={{ marginBottom: 6 }}>
                  <div>{x.action.replace(/^agent\./, "").replace(/[._]/g, " ")}{(x.metadata as { step?: number } | null)?.step ? ` (step ${(x.metadata as { step: number }).step})` : ""}{x.reason ? `: ${x.reason}` : ""}</div>
                  <div className="muted">{formatDateTime(x.at)}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}

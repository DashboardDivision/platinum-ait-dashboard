import { notFound } from "next/navigation";
import { TwentyDetails } from "@/components/twenty-details";
import { MilestoneGraph } from "@/components/milestone-graph";
import { can, requireStaffPage } from "@/server/permissions";
import { and, desc, eq, ne, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { recruitOverview } from "@/server/views";
import { getSetting } from "@/server/settings";
import { Shell } from "@/components/shell";
import { StageTimeline } from "@/components/stage-timeline";
import { ActionForm } from "@/components/action-form";
import { Badge, DocBadge, Duration, Empty, PolicyBadge, ProgressBar, ProvisionBadge, ReimbursementBadge } from "@/components/ui";
import { formatCents } from "@/domain/money";
import { formatDate, formatDateTime, wholeDays, formatDay } from "@/domain/durations";
import { stageTitle } from "@/domain/stages";
import { milestoneLabel } from "@/server/production";
import {
  addNoteAction, addPolicyAction, adjustPolicyAction, adminUploadAction, approveContractAction, createTaskAction, forceTempPasswordAction, impersonateAction,
  payoutAction, reauthAction, reimbursementAction, reopenStageAction, resendWelcomeAction, retryProvisioningAction, reviewDocumentAction, reviewPolicyAction,
  sendResetLinkAction, setStatusAction, deleteRecruitAction, taskAction, trainingStartAction, updateRecruitAction,
  meetingAttendanceAction, trainingModuleAction,
} from "../../actions";
import { AdminMeetingsCard, AdminTrainingCard } from "@/components/admin-training";
import { meetingAttendanceFor, trainingModules } from "@/server/training";
import { monthKey, shiftMonth } from "@/domain/training";

export const metadata = { title: "Recruit" };

const DOC_KIND: Record<string, string> = { exam_result: "Exam results", license: "License", receipt: "Receipt", contract_signed: "Signed contract", contract_external: "Contract (upload)" };
const TWENTY_URL = process.env.TWENTY_URL ?? "https://crm.getstrategic.vip";

export default async function RecruitDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ added?: string }> }) {
  const u = await requireStaffPage("ait.view");
  const { id } = await params;
  const { added } = await searchParams;
  const [ws] = await db.select({ at: schema.messageDelivery.updatedAt }).from(schema.messageDelivery)
    .where(and(eq(schema.messageDelivery.recruitId, id), eq(schema.messageDelivery.purpose, "welcome"), eq(schema.messageDelivery.channel, "email"), or(eq(schema.messageDelivery.status, "sent"), eq(schema.messageDelivery.status, "delivered"))))
    .orderBy(desc(schema.messageDelivery.updatedAt)).limit(1);
  const welcomeSentAt = ws?.at ?? null;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const o = await recruitOverview(id);
  if (!o) notFound();
  const r = o.recruit;
  const [notes, tasks, deliveries, auditRows, activity, admins, types] = await Promise.all([
    db.select({ n: schema.note, author: schema.user.name }).from(schema.note).leftJoin(schema.user, eq(schema.user.id, schema.note.authorUserId)).where(eq(schema.note.recruitId, id)).orderBy(desc(schema.note.createdAt)),
    db.select().from(schema.task).where(eq(schema.task.recruitId, id)).orderBy(desc(schema.task.createdAt)),
    db.select().from(schema.messageDelivery).where(eq(schema.messageDelivery.recruitId, id)).orderBy(desc(schema.messageDelivery.createdAt)).limit(50),
    db.select({ a: schema.auditEvent, actor: schema.user.name }).from(schema.auditEvent).leftJoin(schema.user, eq(schema.user.id, schema.auditEvent.actorUserId)).where(or(and(eq(schema.auditEvent.targetType, "recruit"), eq(schema.auditEvent.targetId, id)))).orderBy(desc(schema.auditEvent.at)).limit(60),
    db.select().from(schema.activityEvent).where(and(eq(schema.activityEvent.recruitId, id), ne(schema.activityEvent.type, "meeting_link_click"))).orderBy(desc(schema.activityEvent.at)).limit(40),
    db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(eq(schema.user.role, "admin")),
    getSetting("policyTypes"),
  ]);
  const dash = o.provisioning.dashboard;
  const edu = o.provisioning.education;
  const recruitClicks = activity.filter((a) => a.type === "study_link_click" && a.actorKind === "recruit");
  const examClicks = activity.filter((a) => a.type === "exam_link_click" && a.actorKind === "recruit");
  const p = o.production;
  const stage5 = o.stages[4];
  const month = monthKey(new Date());
  const enrolled = monthKey(r.enrollmentAt);
  const [training, attendanceMap] = await Promise.all([trainingModules(id), meetingAttendanceFor([id], [month, shiftMonth(month, -1), shiftMonth(month, -2)].filter((m) => m >= enrolled))]);
  const canEdit = can(u, "ait.edit");

  return (
    <Shell user={u} active="/admin">
      {added ? (
        <p className="alert ok" style={{ marginBottom: 16 }}>
          Recruit added to Twenty. Their account status is below; the welcome email goes out as soon as their logins are ready.
        </p>
      ) : null}
      <div className="topbar">
        <div>
          <p className="small"><a href="/admin">← Recruits</a></p>
          <h1>{r.fullName}</h1>
          <p className="sub tabular">
            {o.state.finished ? "Graduated" : `Stage ${o.state.currentStage}: ${stageTitle(o.state.currentStage)}`} · {wholeDays(o.daysSinceSignupMs)} days since signup
            {r.status !== "active" ? ` · ${r.status}` : ""}
          </p>
        </div>
        <div className="row" style={{ flex: "0 0 auto" }}>
          {can(u, "ait.delete") ? (
            <details className="disclose shrink">
              <summary style={{ color: "var(--bad)" }}>Delete permanently</summary>
              <div className="card"><div className="bd form-grid" style={{ maxWidth: 340 }}>
                <p className="small muted">Removes this recruit, their dashboard login, documents, stages, policies and history from the dashboard for good. The audit log keeps a record. Can't be undone.</p>
                <ActionForm action={deleteRecruitAction} submit="Delete permanently" variant="danger" size="small" confirm={`Permanently delete ${r.fullName}? This can't be undone.`}>
                  <input type="hidden" name="recruitId" value={id} />
                  <label className="f">Type their full name to confirm<input name="confirm" required autoComplete="off" placeholder={r.fullName} /></label>
                  <label className="row" style={{ gap: 6, alignItems: "center" }}><input type="checkbox" name="alsoTwenty" /> Also delete their Platinum AIT record in Twenty</label>
                </ActionForm>
              </div></div>
            </details>
          ) : null}
          <details className="disclose shrink">
            <summary>{r.status === "active" ? "Archive AIT" : "Reactivate AIT"}</summary>
            <div className="card"><div className="bd form-grid" style={{ maxWidth: 320 }}>
              <p className="small muted">
                {r.status === "active"
                  ? "Ends their enrollment: reminders and recruit emails stop. History, documents and production are kept, and you can reactivate later."
                  : "Puts them back in the active program. Their history is unchanged."}
              </p>
              <ActionForm
                action={setStatusAction}
                submit={r.status === "active" ? "Archive AIT" : "Reactivate AIT"}
                variant={r.status === "active" ? "danger" : "secondary"}
                size="small"
                confirm={r.status === "active" ? `Archive ${r.fullName}?` : `Reactivate ${r.fullName}?`}
              >
                <input type="hidden" name="recruitId" value={id} />
                <input type="hidden" name="status" value={r.status === "active" ? "archived" : "active"} />
                <label className="f">Reason<input type="text" name="reason" required maxLength={300} /></label>
              </ActionForm>
            </div></div>
          </details>
          <details className="disclose shrink">
            <summary>Login as AIT</summary>
            <div className="card"><div className="bd form-grid" style={{ maxWidth: 320 }}>
              <p className="small muted">Opens a 30-minute view as this recruit. It's audited, doesn't count as their activity, and blocks stage actions, signing, password and payment changes.</p>
              <ActionForm action={reauthAction} submit="Confirm my password" variant="secondary" size="small">
                <label className="f">Your current password<input type="password" name="password" autoComplete="current-password" required /></label>
              </ActionForm>
              <ActionForm action={impersonateAction} submit="View as recruit" size="small">
                <input type="hidden" name="recruitId" value={id} />
              </ActionForm>
            </div></div>
          </details>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Five-stage timeline</h2><span className="small muted">Days since signup {wholeDays(o.daysSinceSignupMs)}{r.graduatedAt ? ` · days to graduate ${wholeDays(+r.graduatedAt - +r.enrollmentAt)}` : ""}</span></div>
            <div className="bd">
              <StageTimeline o={o} admin stage0={{ sentAt: welcomeSentAt, status: r.welcomeStatus }} />
              {stage5.enteredAt ? (
                <p className="small muted" style={{ marginTop: 8 }}>
                  Contract wait: {r.contractSignedAt ? <Duration ms={+r.contractSignedAt - +stage5.enteredAt} /> : <>running <Duration ms={Date.now() - +stage5.enteredAt} /></>}
                  {r.trainingStartedAt ? <> · Since training start: <Duration ms={+(r.graduatedAt ?? new Date()) - +r.trainingStartedAt} /></> : null}
                </p>
              ) : null}
              <details className="disclose" style={{ marginTop: 10 }}>
                <summary>Correct a stage</summary>
                <ActionForm action={reopenStageAction} submit="Reopen stage" variant="danger" confirm="Reopen this stage? History is kept and no congratulations are re-sent.">
                  <input type="hidden" name="recruitId" value={id} />
                  <div className="row">
                    <label className="f">Stage<select name="stage">{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}. {stageTitle(n)}</option>)}</select></label>
                    <label className="f">Reason<input type="text" name="reason" required /></label>
                  </div>
                </ActionForm>
              </details>
            </div>
          </section>

          <section className="card">
            <div className="hd"><h2>Study and exam</h2></div>
            <div className="bd">
              <dl className="kv">
                <dt>Study link clicks</dt><dd className="tabular">{o.studyClickCount}{recruitClicks[recruitClicks.length - 1] ? ` · first ${formatDateTime(r.firstStudyClickAt)}` : ""}</dd>
                <dt>Confirmed study visits</dt><dd><Badge tone="neutral">Unavailable</Badge> <span className="small muted">The study site isn't instrumented (left unmodified).</span></dd>
                <dt>Estimated study time</dt><dd><Badge tone="neutral">Unavailable</Badge></dd>
                <dt>Ready to schedule</dt><dd>{r.readyToScheduleAt ? `${formatDateTime(r.readyToScheduleAt)} (self-reported)` : "Not yet"}</dd>
                <dt>Exam link opened</dt><dd>{r.examLinkClickedAt ? `${formatDateTime(r.examLinkClickedAt)} · ${examClicks.length} click${examClicks.length === 1 ? "" : "s"}` : "Not yet"}</dd>
                <dt>Booking (recruit-entered)</dt><dd>{r.examDate ? `Exam ${formatDay(r.examDate)}` : "No date"}{r.examBookingConfirmation ? ` · confirmation ${r.examBookingConfirmation}` : ""} <span className="small muted">not verified</span></dd>
                <dt>Exam status</dt><dd>{r.examPassedAt ? <Badge tone="ok">Passed (proof approved {formatDate(r.examPassedAt)})</Badge> : <Badge tone="neutral">Not verified</Badge>}</dd>
                <dt>License status</dt><dd>{r.licenseIssuedAt ? <Badge tone="ok">On file {r.licenseState ?? ""} {r.licenseNumber ?? ""}</Badge> : <Badge tone="neutral">Not verified</Badge>}</dd>
              </dl>
            </div>
          </section>

          <section className="card" id="documents">
            <div className="hd"><h2>Proof and documents</h2></div>
            {o.documents.length === 0 ? <Empty>No uploads yet.</Empty> : (
              <div className="table-wrap"><table className="t stack-sm">
                <thead><tr><th>Type</th><th>File</th><th>Details</th><th>Status</th><th>Review</th></tr></thead>
                <tbody>{o.documents.map((d) => (
                  <tr key={d.id}>
                    <td data-label="Type">{DOC_KIND[d.kind]}</td>
                    <td data-label="File"><a href={`/api/files/${d.id}`}>{d.originalName}</a><div className="small muted">{formatDateTime(d.uploadedAt)} · {Math.ceil(d.sizeBytes / 1024)} KB</div>{d.mimeType.startsWith("image/") ? <img src={`/api/files/${d.id}?inline=1`} alt={`${DOC_KIND[d.kind]} preview`} style={{ maxWidth: 160, maxHeight: 120, display: "block", marginTop: 6, border: "1px solid var(--line)" }} /> : null}</td>
                    <td data-label="Details" className="small">{[d.state, d.examDate && `exam ${formatDay(d.examDate)}`, d.licenseNumber && `#${d.licenseNumber}`].filter(Boolean).join(" · ") || "—"}</td>
                    <td data-label="Status"><DocBadge status={d.status} />{d.reviewReason ? <div className="small muted">{d.reviewReason}</div> : null}</td>
                    <td data-label="Review">
                      {d.status === "uploaded" && d.kind !== "contract_external" ? (
                        <div className="form-grid">
                          <ActionForm action={reviewDocumentAction} submit="Approve" size="small" className="">
                            <input type="hidden" name="documentId" value={d.id} /><input type="hidden" name="decision" value="approve" />
                          </ActionForm>
                          <ActionForm action={reviewDocumentAction} submit="Needs replacement" variant="danger" size="small" className="form-grid">
                            <input type="hidden" name="documentId" value={d.id} /><input type="hidden" name="decision" value="reject" />
                            <label className="f"><span className="sr-only">Reason</span><input type="text" name="reason" placeholder="Reason for the recruit" required /></label>
                          </ActionForm>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>

          <section className="card">
            <div className="hd"><h2>Contract and training</h2>{r.contractSignedAt ? <Badge tone="ok">Contract verified {formatDate(r.contractSignedAt)}</Badge> : <Badge tone="warn">Awaiting contract</Badge>}</div>
            <div className="bd form-grid">
              {o.contracts.map((c) => (
                <p key={c.id} className="small">
                  {c.source === "adobe_sign" ? "Adobe Acrobat Sign" : "Admin-reviewed upload (not an e-signature record)"} · {c.status.replace(/_/g, " ")}
                  {c.signedAt ? ` · signed ${formatDate(c.signedAt)}` : ""}
                  {c.signedDocumentId ? <> · <a href={`/api/files/${c.signedDocumentId}`}>Download</a></> : null}
                </p>
              ))}
              {!o.contractSigningAvailable ? <p className="small muted">Adobe Acrobat Sign isn't connected yet, and no approved contract template has been added. Use the upload path below for contracts signed elsewhere.</p> : null}
              {!r.contractSignedAt ? (
                <details className="disclose">
                  <summary>Record a contract signed outside the dashboard</summary>
                  <div className="form-grid">
                    <ActionForm action={adminUploadAction} submit="Upload signed contract" variant="secondary">
                      <input type="hidden" name="recruitId" value={id} /><input type="hidden" name="kind" value="contract_external" />
                      <label className="f">Signed contract (PDF)<input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required /></label>
                    </ActionForm>
                    {o.documents.filter((d) => d.kind === "contract_external").length ? (
                      <ActionForm action={approveContractAction} submit="Verify contract" confirm="Record this contract as signed? This enables production credit.">
                        <input type="hidden" name="recruitId" value={id} />
                        <div className="row">
                          <label className="f">File<select name="documentId">{o.documents.filter((d) => d.kind === "contract_external").map((d) => <option key={d.id} value={d.id}>{d.originalName}</option>)}</select></label>
                          <label className="f">Signed on<input type="date" name="signedOn" required /></label>
                        </div>
                        <label className="f">How it was verified<input type="text" name="reason" required placeholder="e.g. wet signature reviewed in office" /></label>
                      </ActionForm>
                    ) : null}
                  </div>
                </details>
              ) : null}
              <p className="small">Training start: {r.trainingStartedAt ? formatDateTime(r.trainingStartedAt) : "not recorded"}</p>
              {r.contractSignedAt ? (
                <details className="disclose">
                  <summary>Correct training start date</summary>
                  <ActionForm action={trainingStartAction} submit="Save correction" variant="secondary">
                    <input type="hidden" name="recruitId" value={id} />
                    <div className="row"><label className="f">Actual start<input type="date" name="date" required /></label><label className="f">Reason<input type="text" name="reason" required /></label></div>
                  </ActionForm>
                </details>
              ) : null}
            </div>
          </section>

          <AdminTrainingCard recruitId={id} training={training} inStage5={Boolean(stage5.enteredAt)} canEdit={canEdit} action={trainingModuleAction} />

          <AdminMeetingsCard recruitId={id} attendance={attendanceMap.get(id) ?? []} canEdit={canEdit} action={meetingAttendanceAction} />

          <TwentyDetails target={{ kind: "ait", id }} canEdit={can(u, "ait.edit")} />

          <section className="card" id="production">
            <div className="hd"><h2>Production</h2>{r.premiumBelowThreshold ? <Badge tone="bad">Current premium below achieved threshold ({milestoneLabel(r.premiumBelowThreshold)})</Badge> : null}</div>
            <div className="bd">
              {!r.contractSignedAt ? <p className="alert info small" style={{ marginBottom: 10 }}>Milestone credit starts after the contract is verified.</p> : null}
              <div className="row" style={{ alignItems: "baseline" }}>
                <div><span className="tabular" style={{ fontSize: 22, fontWeight: 650 }}>{formatCents(p.qualifyingCents, { whole: true })}</span> <span className="small muted">qualifying of $250,000 · {p.contributingPolicyCount} policies contributing</span></div>
                <div className="shrink small tabular">{p.percent}%</div>
              </div>
              <ProgressBar percent={p.percent} label="Progress toward graduation" />
              <div style={{ marginTop: 12 }}><MilestoneGraph milestones={p.milestones} qualifyingCents={p.qualifyingCents} locked={!r.contractSignedAt} /></div>
              <ul className="milestones" style={{ marginTop: 10 }}>
                {p.milestones.map((m) => (
                  <li key={m.key}><span>{m.achievedAt ? "✓ " : ""}{m.label}</span><span className="small muted tabular">{m.achievedAt ? <>{formatDate(m.achievedAt)}{m.sinceTrainingMs != null ? <> · <Duration ms={m.sinceTrainingMs} /> from training start</> : null}{m.sincePreviousMs != null ? <> · <Duration ms={m.sincePreviousMs} /> after previous</> : null}</> : p.next?.key === m.key && m.thresholdCents ? `${formatCents(p.next.remainingCents, { whole: true })} to go` : "—"}</span></li>
                ))}
              </ul>
            </div>
            {p.policies.length ? (
              <div className="table-wrap"><table className="t stack-sm">
                <thead><tr><th>Policy</th><th>Type</th><th>Written</th><th className="num">Term premium</th><th className="num">Annualized</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>{p.policies.map((pol) => {
                  const adj = p.adjustmentsByPolicy.get(pol.id) ?? 0;
                  return (
                    <tr key={pol.id}>
                      <td data-label="Policy">{pol.externalRef}<div className="small muted">{pol.source}{pol.carrier ? ` · ${pol.carrier}` : ""}</div></td>
                      <td data-label="Type">{pol.policyType}<div className="small muted">{pol.businessType}</div></td>
                      <td data-label="Written">{formatDay(pol.writtenDate)}</td>
                      <td data-label="Term premium" className="num">{pol.termPremiumCents != null ? `${formatCents(pol.termPremiumCents)} / ${pol.termMonths}mo` : "—"}</td>
                      <td data-label="Annualized" className="num">{formatCents(pol.annualizedCents)}{adj ? <div className="small muted">{formatCents(adj)} adj.</div> : null}</td>
                      <td data-label="Status"><PolicyBadge status={pol.status} /></td>
                      <td data-label="Actions">
                        {pol.status === "pending" ? (
                          <div className="row">
                            <ActionForm action={reviewPolicyAction} submit="Approve" size="small" className="shrink"><input type="hidden" name="policyId" value={pol.id} /><input type="hidden" name="decision" value="approved" /></ActionForm>
                            <ActionForm action={reviewPolicyAction} submit="Reject" size="small" variant="danger" className="shrink"><input type="hidden" name="policyId" value={pol.id} /><input type="hidden" name="decision" value="rejected" /></ActionForm>
                          </div>
                        ) : (
                          <details className="disclose"><summary className="small">Adjust</summary>
                            <ActionForm action={adjustPolicyAction} submit="Record" size="small" variant="secondary">
                              <input type="hidden" name="policyId" value={pol.id} />
                              <label className="f">Kind<select name="kind"><option value="cancellation">Cancellation</option><option value="reversal">Reversal</option><option value="correction">Correction (+/-)</option></select></label>
                              <label className="f">Annualized change ($)<input type="text" name="amount" inputMode="decimal" required /></label>
                              <label className="f">Reason<input type="text" name="reason" required /></label>
                            </ActionForm>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            ) : null}
            <div className="bd">
              <details className="disclose">
                <summary>Add a policy</summary>
                <ActionForm action={addPolicyAction} submit="Save policy" variant="secondary">
                  <input type="hidden" name="recruitId" value={id} />
                  <div className="row">
                    <label className="f">Policy number<input type="text" name="externalRef" required /></label>
                    <label className="f">Type<select name="policyType">{types.map((t) => <option key={t}>{t}</option>)}</select></label>
                    <label className="f">Carrier<input type="text" name="carrier" /></label>
                  </div>
                  <div className="row">
                    <label className="f">Business<select name="businessType"><option value="new">New business</option><option value="renewal">Renewal</option><option value="rewrite">Rewrite</option><option value="endorsement">Endorsement</option><option value="quote">Quote</option></select></label>
                    <label className="f">Written<input type="date" name="writtenDate" required /></label>
                    <label className="f">Effective<input type="date" name="effectiveDate" /></label>
                  </div>
                  <div className="row">
                    <label className="f">Term<select name="termMonths" defaultValue="6"><option value="6">6 months</option><option value="12">12 months</option><option value="">Other</option></select></label>
                    <label className="f">Full-term premium ($)<input type="text" name="termPremium" inputMode="decimal" /></label>
                    <label className="f">Annualized ($) <span className="hint">only if authoritative</span><input type="text" name="annualized" inputMode="decimal" /></label>
                  </div>
                  <label className="small"><input type="checkbox" name="approve" defaultChecked /> Approve now</label>
                </ActionForm>
              </details>
            </div>
          </section>

          <section className="card" id="money">
            <div className="hd"><h2>Reimbursement and payouts</h2></div>
            <div className="bd form-grid">
              {o.reimbursements.length === 0 ? <p className="small muted">The exam reimbursement case is created when passing proof is approved.</p> : o.reimbursements.map((c) => {
                const paid = c.payments.reduce((s2, x) => s2 + x.amountCents, 0);
                return (
                  <div key={c.id} className="form-grid">
                    <div className="row" style={{ alignItems: "center" }}><strong>Exam reimbursement</strong><span className="shrink"><ReimbursementBadge status={c.status} /></span></div>
                    <dl className="kv small">
                      <dt>Receipt</dt><dd>{c.receiptDocumentId ? <a href={`/api/files/${c.receiptDocumentId}`}>View receipt</a> : "Not uploaded"}</dd>
                      <dt>Test cost</dt><dd className="tabular">{c.testCostCents != null ? formatCents(c.testCostCents) : "—"}</dd>
                      <dt>Approved</dt><dd className="tabular">{c.approvedCents != null ? formatCents(c.approvedCents) : "—"}</dd>
                      <dt>Paid</dt><dd className="tabular">{formatCents(paid)}{c.payments.map((x) => <div key={x.id} className="small muted">{formatDate(x.paidAt)} · {formatCents(x.amountCents)} · ref {x.paymentRef}</div>)}</dd>
                    </dl>
                    {c.status === "awaiting_receipt" || c.status === "submitted" ? (
                      <ActionForm action={reimbursementAction} submit="Approve" size="small">
                        <input type="hidden" name="reimbursementId" value={c.id} /><input type="hidden" name="op" value="approve" />
                        <div className="row"><label className="f">Actual test cost ($)<input type="text" name="testCost" inputMode="decimal" required /></label><label className="f">Approved amount ($)<input type="text" name="approved" inputMode="decimal" /></label></div>
                      </ActionForm>
                    ) : null}
                    {c.status === "approved" || c.status === "partially_paid" ? (
                      <ActionForm action={reimbursementAction} submit="Record payment" size="small" variant="secondary">
                        <input type="hidden" name="reimbursementId" value={c.id} /><input type="hidden" name="op" value="payment" />
                        <div className="row"><label className="f">Amount ($)<input type="text" name="amount" inputMode="decimal" required /></label><label className="f">Paid on<input type="date" name="paidOn" required /></label><label className="f">Payment reference<input type="text" name="paymentRef" required /></label></div>
                      </ActionForm>
                    ) : null}
                  </div>
                );
              })}
              <hr className="sep" />
              <strong>Payouts</strong>
              {o.payouts.length === 0 ? <p className="small muted">None recorded.</p> : (
                <table className="t"><tbody>{o.payouts.map((po) => (
                  <tr key={po.id}><td>{po.payoutType}<div className="small muted">{po.periodLabel ?? ""} {po.basis ?? ""}</div></td><td className="num">{formatCents(po.amountCents)}</td><td><Badge tone={po.status === "paid" ? "ok" : po.status === "reversed" ? "neutral" : "info"}>{po.status}</Badge>{po.paymentRef ? <div className="small muted">ref {po.paymentRef}</div> : null}</td>
                    <td>{po.status === "pending" ? <ActionForm action={payoutAction} submit="Approve" size="small" className=""><input type="hidden" name="op" value="approve" /><input type="hidden" name="payoutId" value={po.id} /></ActionForm> : po.status === "approved" ? (
                      <ActionForm action={payoutAction} submit="Mark paid" size="small" className="form-grid"><input type="hidden" name="op" value="paid" /><input type="hidden" name="payoutId" value={po.id} /><input type="text" name="paymentRef" placeholder="Payment ref" aria-label="Payment reference" required /></ActionForm>
                    ) : po.status === "paid" ? (
                      <details className="disclose"><summary className="small">Reverse</summary><ActionForm action={payoutAction} submit="Reverse" size="small" variant="danger"><input type="hidden" name="op" value="reverse" /><input type="hidden" name="payoutId" value={po.id} /><input type="text" name="reason" placeholder="Reason" aria-label="Reason" required /></ActionForm></details>
                    ) : null}</td></tr>
                ))}</tbody></table>
              )}
              <details className="disclose">
                <summary>Record a payout</summary>
                <ActionForm action={payoutAction} submit="Save as pending" variant="secondary">
                  <input type="hidden" name="op" value="create" /><input type="hidden" name="recruitId" value={id} />
                  <div className="row"><label className="f">Type<input type="text" name="payoutType" required placeholder="e.g. Commission" /></label><label className="f">Period<input type="text" name="periodLabel" placeholder="Oct 2026" /></label><label className="f">Amount ($)<input type="text" name="amount" inputMode="decimal" required /></label></div>
                  <label className="f">Calculation basis (optional)<input type="text" name="basis" /></label>
                </ActionForm>
              </details>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Contact</h2></div>
            <div className="bd form-grid">
              <dl className="kv small">
                <dt>Email</dt><dd>{r.email ?? <Badge tone="warn">Missing</Badge>}</dd>
                <dt>Phone</dt><dd className="tabular">{r.phoneE164 ?? <Badge tone="warn">Missing</Badge>}</dd>
                <dt>Twenty record</dt><dd><a href={`${TWENTY_URL}/object/platinumAit/${r.twentyRecordId}`} target="_blank" rel="noreferrer">Open in Twenty</a></dd>
                <dt>Enrolled</dt><dd>{formatDateTime(r.enrollmentAt)} <span className="muted">({r.enrollmentAtBasis.replace(/_/g, " ")})</span></dd>
                <dt>Welcome message</dt><dd>{r.welcomeStatus === "suppressed" ? "not sent (enrolled by backfill)" : r.welcomeStatus.replace(/_/g, " ")}</dd>
              </dl>
              {r.contactIssue ? <p className="alert warn small">{r.contactIssue === "crm_email_changed_review" ? "Twenty has a different email than this login. Review before changing the login email." : "Contact details in Twenty are incomplete."}</p> : null}
              <ActionForm action={resendWelcomeAction} submit="Resend welcome instructions" variant="secondary" size="small" confirm="Send the welcome instructions again? No account or password is changed.">
                <input type="hidden" name="recruitId" value={id} />
              </ActionForm>
            </div>
          </section>

          <section className="card">
            <div className="hd"><h2>Accounts</h2></div>
            <div className="bd form-grid small">
              <div className="row" style={{ alignItems: "center" }}><strong>AIT dashboard</strong><span className="shrink"><ProvisionBadge status={dash?.status ?? "pending"} /></span></div>
              <dl className="kv">
                <dt>Account ID</dt><dd><code>{dash?.externalAccountId ?? "—"}</code></dd>
                <dt>Created</dt><dd>{formatDateTime(r.accountCreatedAt)}</dd>
                <dt>First recruit login</dt><dd>{formatDateTime(r.firstLoginAt)}</dd>
                <dt>Password changed</dt><dd>{formatDateTime(r.initialPasswordChangedAt)}</dd>
                <dt>Last recruit activity</dt><dd>{formatDateTime(r.lastActivityAt)}</dd>
                {dash?.lastError ? <><dt>Last error</dt><dd>{dash.lastError}</dd></> : null}
              </dl>
              {dash && dash.status !== "ready" ? (
                <ActionForm action={retryProvisioningAction} submit="Retry dashboard account" size="small"><input type="hidden" name="recruitId" value={id} /></ActionForm>
              ) : null}
              {dash?.status === "ready" ? (
                <details className="disclose"><summary>Password support (dashboard only)</summary>
                  <div className="form-grid">
                    <ActionForm action={sendResetLinkAction} submit="Email a reset link" variant="secondary" size="small"><input type="hidden" name="recruitId" value={id} /></ActionForm>
                    <ActionForm action={forceTempPasswordAction} submit="Set a temporary password" variant="danger" size="small" confirm="This signs the recruit out everywhere and requires a new password at next sign-in. Continue?">
                      <input type="hidden" name="recruitId" value={id} />
                      <label className="f">Reason<input type="text" name="reason" required /></label>
                    </ActionForm>
                    <p className="muted">Admins can't see passwords. The study site isn't affected.</p>
                  </div>
                </details>
              ) : null}
              <hr className="sep" />
              <div className="row" style={{ alignItems: "center" }}><strong>Education site</strong><span className="shrink"><ProvisionBadge status={edu?.status ?? "unavailable"} /></span></div>
              <p className="muted">{edu?.lastError}</p>
              <dl className="kv"><dt>First login</dt><dd>Unavailable</dd><dt>Password changed</dt><dd>Unavailable</dd><dt>Recovery</dt><dd>Recruit uses that site's own Forgot password page.</dd></dl>
            </div>
          </section>

          <section className="card">
            <div className="hd"><h2>Assignment</h2></div>
            <div className="bd">
              <ActionForm action={updateRecruitAction} submit="Save" variant="secondary" size="small">
                <input type="hidden" name="recruitId" value={id} />
                <label className="f">Owner<select name="ownerAdminId" defaultValue={r.ownerAdminId ?? ""}><option value="">Unassigned</option>{admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                <div className="row"><label className="f">Cohort<input type="text" name="cohort" defaultValue={r.cohort ?? ""} /></label><label className="f">State<input type="text" name="homeState" maxLength={2} defaultValue={r.homeState ?? ""} /></label></div>
                <label className="f">Momentum producer ID <span className="hint">links Momentum AMP production</span><input type="text" name="momentumProducerId" defaultValue={r.momentumProducerId ?? ""} /></label>
              </ActionForm>
            </div>
          </section>

          <section className="card" id="tasks">
            <div className="hd"><h2>Tasks</h2></div>
            <div className="bd">
              <ul className="queue">
                {tasks.length === 0 ? <li className="muted">No tasks.</li> : tasks.map((t) => (
                  <li key={t.id}>
                    <span>{t.status === "done" ? <s>{t.title}</s> : t.title}<div className="small muted">{t.ownerUserId ? `Owner: ${admins.find((a) => a.id === t.ownerUserId)?.name ?? "admin"}` : "Unclaimed"}{t.status === "done" && t.completedAt ? ` · done ${formatDate(t.completedAt)}` : ""}</div></span>
                    <span className="shrink">{t.status === "open" ? (
                      <ActionForm action={taskAction} submit={t.ownerUserId ? "Done" : "Claim"} size="small" variant="secondary" className=""><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="op" value={t.ownerUserId ? "done" : "claim"} /></ActionForm>
                    ) : null}</span>
                  </li>
                ))}
              </ul>
              <details className="disclose"><summary>New task</summary>
                <ActionForm action={createTaskAction} submit="Create task" variant="secondary" size="small">
                  <input type="hidden" name="recruitId" value={id} />
                  <label className="f">Title<input type="text" name="title" required /></label>
                  <div className="row"><label className="f">Owner<select name="ownerUserId">{admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="f">Due<input type="date" name="dueAt" /></label></div>
                </ActionForm>
              </details>
            </div>
          </section>

          <section className="card">
            <div className="hd"><h2>Private notes</h2></div>
            <div className="bd form-grid">
              <ActionForm action={addNoteAction} submit="Add note" variant="secondary" size="small">
                <input type="hidden" name="recruitId" value={id} />
                <label className="f"><span className="sr-only">Note</span><textarea name="body" required placeholder="Visible to admins only" /></label>
              </ActionForm>
              {notes.map(({ n, author }) => <div key={n.id} className="small"><div className="muted">{author ?? "admin"} · {formatDateTime(n.createdAt)}</div><div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div></div>)}
            </div>
          </section>

          <section className="card">
            <div className="hd"><h2>Messages sent</h2></div>
            <div className="bd small">
              {deliveries.length === 0 ? <span className="muted">None yet.</span> : deliveries.map((d) => (
                <div key={d.id} className="row" style={{ marginBottom: 4 }}><span>{d.purpose.replace(/_/g, " ")} · {d.channel}</span><span className="shrink"><Badge tone={d.status === "sent" || d.status === "delivered" ? "ok" : d.status === "suppressed" ? "neutral" : "bad"}>{d.status}</Badge></span></div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="hd"><h2>Record status</h2></div>
            <div className="bd">
              <ActionForm action={setStatusAction} submit={r.status === "active" ? "Archive" : "Reactivate"} variant={r.status === "active" ? "danger" : "secondary"} size="small">
                <input type="hidden" name="recruitId" value={id} />
                <input type="hidden" name="status" value={r.status === "active" ? "archived" : "active"} />
                <label className="f">Reason<input type="text" name="reason" required /></label>
              </ActionForm>
            </div>
          </section>

          <section className="card">
            <div className="hd"><h2>Audit trail</h2></div>
            <div className="bd small" style={{ maxHeight: 360, overflowY: "auto" }}>
              {auditRows.map(({ a, actor }) => (
                <div key={a.id} style={{ marginBottom: 6 }}>
                  <div>{a.action.replace(/[._]/g, " ")}{a.reason ? `: ${a.reason}` : ""}</div>
                  <div className="muted">{actor ?? (a.actorUserId ? "admin" : "system")} · {formatDateTime(a.at)}</div>
                </div>
              ))}
              {activity.filter((x) => x.actorKind !== "recruit").slice(0, 10).map((x) => (
                <div key={x.id} style={{ marginBottom: 6 }}><div>{x.type.replace(/_/g, " ")} ({x.actorKind}, not counted as recruit activity)</div><div className="muted">{formatDateTime(x.at)}</div></div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}

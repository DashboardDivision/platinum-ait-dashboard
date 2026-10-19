import { desc, eq } from "drizzle-orm";
import { can, requireStaffPage } from "@/server/permissions";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { listRecruits, PAGE_SIZE, stageCounts, summaryCounts, type RecruitFilters } from "@/server/admin-queries";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, Empty, ProvisionBadge } from "@/components/ui";
import { formatCents } from "@/domain/money";
import { formatDate, formatDuration, wholeDays } from "@/domain/durations";
import { MILESTONES, nextTarget } from "@/domain/milestones";
import { adminStageLabel, stageTitle } from "@/domain/stages";
import { listPieLeads, pieLeadsConnected, type PieLead } from "@/server/pie-leads";
import { createAitFromPieAction, deleteViewAction, saveViewAction } from "./actions";

export const metadata = { title: "Recruits" };

function qs(f: RecruitFilters, over: Partial<RecruitFilters>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...over })) if (v) p.set(k, String(v));
  return `?${p}`;
}

export default async function AdminHome({ searchParams }: { searchParams: Promise<RecruitFilters> }) {
  const u = await requireStaffPage("ait.view");
  const f = await searchParams;
  const now = new Date();
  const [{ rows, total, page }, counts, byStage, admins, views, pie] = await Promise.all([
    listRecruits(f, now),
    summaryCounts(),
    stageCounts(),
    db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(eq(schema.user.role, "admin")),
    db.select().from(schema.savedView).where(eq(schema.savedView.userId, u.id)).orderBy(desc(schema.savedView.createdAt)),
    // Twenty being slow or down must not take the Recruits page with it.
    pieLeadsConnected() ? listPieLeads().then((leads): { leads: PieLead[]; error?: string } => ({ leads })).catch(() => ({ leads: [] as PieLead[], error: "Couldn't load PIE signups from Twenty right now." })) : null,
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentQuery = qs(f, { page: undefined }).slice(1);

  return (
    <Shell user={u} active="/admin">
      <div className="topbar">
        <div>
          <h1>Recruits</h1>
          <p className="sub">Agent in Training enrollments from Twenty</p>
        </div>
        <div className="row shrink" style={{ gap: 8 }}>
          {can(u, "ait.edit") ? <a className="btn" href="/admin/recruits/new">+ Add New Recruit</a> : null}
          {can(u, "ait.export") ? <a className="btn secondary" href={`/api/admin/export${qs(f, { page: undefined })}`}>Export CSV</a> : null}
        </div>
      </div>

      {(f as { deleted?: string }).deleted ? <p className="alert ok" style={{ marginBottom: 16 }}>{(f as { deleted?: string }).deleted}</p> : null}
      <div className="stats" role="list">
        <a className="stat" role="listitem" href="/admin"><div className="v">{counts.active}</div><div className="l">Active recruits</div></a>
        <a className="stat" role="listitem" href="/admin/queue"><div className="v">{counts.pending_reviews}</div><div className="l">Pending reviews</div></a>
        <a className="stat" role="listitem" href="/admin?stage=5"><div className="v">{counts.training}</div><div className="l">In Stage 5 training</div></a>
        <a className="stat" role="listitem" href="/admin?stage=graduated&status=all"><div className="v">{counts.graduated}</div><div className="l">Graduated</div></a>
        <a className="stat" role="listitem" href="/admin/money"><div className="v">{counts.reimbursements_due}</div><div className="l">Reimbursements due</div></a>
      </div>

      <div className="stats stats-6" role="list" aria-label="Active recruits by stage">
        {[0, 1, 2, 3, 4, 5].map((n) => (
          <a key={n} className="stat" role="listitem" href={`/admin?stage=${n}`} aria-current={f.stage === String(n) ? "true" : undefined}>
            <div className="v">{byStage[n] ?? 0}</div>
            <div className="l">Stage {n}: {adminStageLabel(n)}</div>
          </a>
        ))}
      </div>

      {counts.attention > 0 ? (
        <p className="alert warn" style={{ marginBottom: 16 }}>
          {counts.attention} item{counts.attention === 1 ? " needs" : "s need"} attention. <a href="/admin/queue">Open the attention queue</a>
        </p>
      ) : null}

      {pie ? (
        <section className="card" aria-labelledby="pie-title" style={{ marginBottom: 16 }}>
          <h2 id="pie-title">PIE signups</h2>
          <p className="small muted">Free study-site signups from insurance.getstrategic.vip, newest first. Create AIT dashboard adds them to the AIT program, links the study account they already have, and sends the welcome by email only.</p>
          {pie.error ? <p className="alert warn">{pie.error}</p> : pie.leads.length === 0 ? (
            <Empty>No PIE signups yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="t stack-sm">
                <thead><tr><th>Signup</th><th>Phone</th><th>State</th><th>Signed up</th><th>AIT dashboard</th></tr></thead>
                <tbody>
                  {pie.leads.map((l) => (
                    <tr key={l.leadId}>
                      <td data-label="Signup">{l.name}<div className="small muted">{l.email ?? "no email"}</div></td>
                      <td data-label="Phone" className="tabular">{l.phone ?? <span className="muted">none</span>}</td>
                      <td data-label="State">{l.state ?? <span className="muted">—</span>}</td>
                      <td data-label="Signed up">{l.signedUpAt ? formatDate(new Date(l.signedUpAt)) : "—"}</td>
                      <td data-label="AIT dashboard">
                        {l.recruitId ? (
                          <a href={`/admin/recruits/${l.recruitId}`}>Open AIT record</a>
                        ) : can(u, "ait.edit") ? (
                          <ActionForm action={createAitFromPieAction} submit="Create AIT dashboard" size="small" className=""
                            confirm={`Create an AIT dashboard for ${l.name} and email them their welcome?`}>
                            <input type="hidden" name="leadId" value={l.leadId} />
                          </ActionForm>
                        ) : <span className="muted small">Not in AIT</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      <section className="card" aria-labelledby="table-title">
        <h2 id="table-title" className="sr-only">Recruit list</h2>
        <form className="filters" method="get" role="search">
          <label className="f search">Search<input type="search" name="q" defaultValue={f.q ?? ""} placeholder="Name, email or phone" /></label>
          <label className="f">Stage
            <select name="stage" defaultValue={f.stage ?? ""}>
              <option value="">Any</option>
              {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}. {adminStageLabel(n)}</option>)}
              <option value="graduated">Graduated</option>
            </select>
          </label>
          <label className="f">Login
            <select name="login" defaultValue={f.login ?? ""}>
              <option value="">Any</option><option value="never">Never signed in</option><option value="starter">Still on temporary password</option><option value="changed">Password changed</option>
            </select>
          </label>
          <label className="f">Inactive for
            <select name="inactiveDays" defaultValue={f.inactiveDays ?? ""}>
              <option value="">Any</option><option value="7">7+ days</option><option value="14">14+ days</option><option value="30">30+ days</option>
            </select>
          </label>
          <label className="f">Milestone
            <select name="milestone" defaultValue={f.milestone ?? ""}>
              <option value="">Any</option>{MILESTONES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
          <label className="f">Owner
            <select name="owner" defaultValue={f.owner ?? ""}>
              <option value="">Anyone</option><option value="unassigned">Unassigned</option>{admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="f">Cohort<input type="text" name="cohort" defaultValue={f.cohort ?? ""} /></label>
          <label className="f">Records
            <select name="status" defaultValue={f.status ?? "active"}>
              <option value="active">Active</option><option value="archived">Archived</option><option value="withdrawn">Withdrawn</option><option value="all">All</option>
            </select>
          </label>
          <label className="f">Needs attention
            <select name="attention" defaultValue={f.attention ?? ""}><option value="">Any</option><option value="any">Only flagged</option></select>
          </label>
          <label className="f">Sort
            <select name="sort" defaultValue={f.sort ?? ""}>
              <option value="">Newest enrollment</option><option value="stage_time">Longest in stage</option><option value="inactive">Least recently active</option><option value="premium">Most premium</option><option value="name">Name</option>
            </select>
          </label>
          <div className="shrink"><button className="btn" type="submit">Apply</button></div>
        </form>

        {views.length || currentQuery ? (
          <div className="filters small" style={{ alignItems: "center" }}>
            <span className="shrink muted">Saved views:</span>
            {views.map((v) => (
              <span key={v.id} className="shrink" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <a href={`/admin?${v.query}`}>{v.name}</a>
                <ActionForm action={deleteViewAction} submit="×" variant="secondary" size="small" className="">
                  <input type="hidden" name="viewId" value={v.id} />
                </ActionForm>
              </span>
            ))}
            {currentQuery ? (
              <details className="disclose shrink">
                <summary>Save this view</summary>
                <ActionForm action={saveViewAction} submit="Save view" size="small" className="row">
                  <input type="hidden" name="query" value={currentQuery} />
                  <label className="f">Name<input type="text" name="name" required maxLength={60} /></label>
                </ActionForm>
              </details>
            ) : null}
          </div>
        ) : null}

        {rows.length === 0 ? (
          <Empty>{f.q || f.stage || f.login ? "No recruits match these filters." : "No AIT recruits yet. They appear here automatically when a Platinum AIT record is added in Twenty."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t stack-sm">
              <thead>
                <tr>
                  <th>Recruit</th><th>Current stage</th><th className="num">Days in stage</th><th className="num">Days since signup</th><th>Last activity</th><th className="num">Qualifying premium</th><th>Next milestone</th><th>Attention</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const achieved = new Set(r.milestones ?? []);
                  const next = nextTarget(r.qualifying_cents, achieved);
                  const flags: React.ReactNode[] = [];
                  if (r.dashboard_status && r.dashboard_status !== "ready") flags.push(<ProvisionBadge key="p" status={r.dashboard_status} />);
                  if (r.contact_issue) flags.push(<Badge key="c" tone="warn">Contact fix</Badge>);
                  if (r.pending_docs) flags.push(<Badge key="d" tone="info">{r.pending_docs} proof to review</Badge>);
                  if (r.pending_policies) flags.push(<Badge key="pp" tone="info">{r.pending_policies} policy pending</Badge>);
                  if (r.open_reimbursements) flags.push(<Badge key="rb" tone="warn">Reimbursement open</Badge>);
                  if (r.open_help) flags.push(<Badge key="h" tone="warn">Help request</Badge>);
                  if (r.premium_below) flags.push(<Badge key="b" tone="bad">Premium below achieved</Badge>);
                  if (r.first_login_at && !r.initial_password_changed_at) flags.push(<Badge key="s" tone="neutral">Temporary password</Badge>);
                  return (
                    <tr key={r.id}>
                      <td data-label="Recruit"><a className="rowlink" href={`/admin/recruits/${r.id}`}>{r.full_name}</a><div className="small muted">{r.email ?? "no email"}{r.status !== "active" ? ` · ${r.status}` : ""}</div></td>
                      <td data-label="Current stage">{r.graduated_at ? <Badge tone="ok">Graduated</Badge> : r.current_stage != null ? <>{`${r.current_stage}. ${adminStageLabel(r.current_stage)}`}{r.current_stage === 0 ? <div className="small muted">{r.welcome_status === "suppressed" ? "not sent (quiet backfill)" : r.welcome_status === "failed" ? "email failed" : r.welcome_status === "queued" ? "sending" : "waiting on account"}</div> : null}</> : <span className="muted">Not started</span>}</td>
                      <td data-label="Days in stage" className="num">{r.stage_entered_at && !r.graduated_at ? formatDuration(+now - +new Date(r.stage_entered_at)) : "—"}</td>
                      <td data-label="Days since signup" className="num">{wholeDays(+now - +new Date(r.enrollment_at))}</td>
                      <td data-label="Last activity">{r.last_activity_at ? formatDate(new Date(r.last_activity_at)) : <span className="muted">None yet</span>}</td>
                      <td data-label="Qualifying premium" className="num">{formatCents(r.qualifying_cents, { whole: true })}</td>
                      <td data-label="Next milestone" className="small">{next ? next.label.replace(" Annualized Premium", "") : "—"}</td>
                      <td data-label="Attention"><div className="flags">{flags.length ? flags : <span className="muted small">—</span>}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <span className="muted tabular">{total} recruit{total === 1 ? "" : "s"} · page {page} of {pages}</span>
          <span className="row" style={{ flex: "0 0 auto" }}>
            {page > 1 ? <a className="btn small secondary shrink" href={qs(f, { page: String(page - 1) })}>Previous</a> : null}
            {page < pages ? <a className="btn small secondary shrink" href={qs(f, { page: String(page + 1) })}>Next</a> : null}
          </span>
        </div>
      </section>
    </Shell>
  );
}

import { Shell } from "@/components/shell";
import { Empty } from "@/components/ui";
import { formatDateTime } from "@/domain/durations";
import { can, requireStaffPage } from "@/server/permissions";
import { auditActors, AUDIT_PAGE, listAudit, roleLabel, type AuditFilters } from "@/server/users";

export const metadata = { title: "Audit log" };

const TYPES = ["recruit", "agent", "user", "role", "policy", "document", "reimbursement", "payout", "task", "setting", "twenty_record"];

function targetLink(type: string, id: string | null) {
  if (!id) return null;
  if (type === "recruit") return `/admin/recruits/${id}`;
  if (type === "agent") return `/admin/agents/${id}`;
  return null;
}

/** Every recorded change: who did it, when, to what. Master Admin (or roles granted audit.view). */
export default async function AuditPage({ searchParams }: { searchParams: Promise<AuditFilters> }) {
  const u = await requireStaffPage("audit.view");
  const f = await searchParams;
  const [{ rows, total, page }, actors] = await Promise.all([listAudit(f), auditActors()]);
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE));
  const qs = (over: Partial<AuditFilters>) => `?${new URLSearchParams(Object.entries({ ...f, ...over }).filter(([, v]) => v) as [string, string][])}`;

  return (
    <Shell user={u} active="/admin/audit">
      <div className="topbar">
        <div><h1>Audit log</h1><p className="sub">Every change in the dashboard, who made it and when. Entries can't be edited or deleted.</p></div>
        {can(u, "audit.export") ? <a className="btn secondary" href={`/api/admin/export/audit${qs({ page: undefined })}`}>Export CSV</a> : null}
      </div>
      <section className="card" style={{ marginBottom: 16 }}>
        <form method="get" className="bd row" style={{ alignItems: "end" }}>
          <label className="f">Search action, reason or record id<input type="search" name="q" defaultValue={f.q ?? ""} /></label>
          <label className="f">Who
            <select name="actor" defaultValue={f.actor ?? ""}>
              <option value="">Anyone</option>
              <option value="system">System / automation</option>
              {actors.map((a) => <option key={a.id} value={a.id}>{a.name} ({roleLabel(a.role)})</option>)}
            </select>
          </label>
          <label className="f">Record type
            <select name="type" defaultValue={f.type ?? ""}>
              <option value="">Any</option>
              {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
            </select>
          </label>
          <label className="f">From<input type="date" name="from" defaultValue={f.from ?? ""} /></label>
          <label className="f">To<input type="date" name="to" defaultValue={f.to ?? ""} /></label>
          <div className="shrink"><button className="btn" type="submit">Filter</button></div>
        </form>
      </section>
      <section className="card">
        <div className="hd"><h2>{total} entr{total === 1 ? "y" : "ies"}</h2>{pages > 1 ? <span className="small muted">Page {page} of {pages}</span> : null}</div>
        {!rows.length ? <Empty>No entries match.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Details</th></tr></thead>
              <tbody>
                {rows.map((a) => {
                  const link = targetLink(a.target_type, a.target_id);
                  const meta = a.metadata ? JSON.stringify(a.metadata) : "";
                  return (
                    <tr key={a.id}>
                      <td className="small" style={{ whiteSpace: "nowrap" }}>{formatDateTime(a.at)}</td>
                      <td className="small">
                        {a.actor_name ? <><strong>{a.actor_name}</strong><div className="muted">{roleLabel(a.actor_role ?? "")}</div></> : <span className="muted">System</span>}
                        {a.impersonator_name ? <div className="muted">viewing as, by {a.impersonator_name}</div> : null}
                      </td>
                      <td className="small">{a.action.replace(/[._]/g, " ")}{a.reason ? <div className="muted">Reason: {a.reason}</div> : null}</td>
                      <td className="small">{a.target_type.replace(/_/g, " ")}{a.target_id ? <div>{link ? <a href={link}>open</a> : <span className="muted">{a.target_id.slice(0, 8)}…</span>}</div> : null}</td>
                      <td className="small muted" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>{meta.length > 220 ? `${meta.slice(0, 220)}…` : meta}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 ? (
          <div className="bd row" style={{ justifyContent: "space-between" }}>
            {page > 1 ? <a className="btn small secondary shrink" href={qs({ page: String(page - 1) })}>← Newer</a> : <span />}
            {page < pages ? <a className="btn small secondary shrink" href={qs({ page: String(page + 1) })}>Older →</a> : null}
          </div>
        ) : null}
      </section>
    </Shell>
  );
}

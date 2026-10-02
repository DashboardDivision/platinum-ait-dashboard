import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Empty, PolicyBadge } from "@/components/ui";
import { formatCents } from "@/domain/money";
import { formatDate, formatDay } from "@/domain/durations";
import { reviewPolicyAction } from "../actions";
import { CsvImport } from "./csv-import";

export const metadata = { title: "Policies" };

const STATUSES = ["pending", "approved", "rejected", "cancelled", "duplicate"];
const SOURCES: Record<string, string> = { momentum: "Momentum AMP", admin: "Admin", recruit: "Recruit", csv: "CSV import" };

export default async function PoliciesPage({ searchParams }: { searchParams: Promise<{ status?: string; source?: string; q?: string }> }) {
  const u = await requirePageUser("admin");
  const f = await searchParams;
  const where: SQL[] = [];
  if (f.status && STATUSES.includes(f.status)) where.push(eq(schema.policy.status, f.status));
  if (f.source && f.source in SOURCES) where.push(eq(schema.policy.source, f.source));
  if (f.q) where.push(sql`(${schema.policy.externalRef} ilike ${`%${f.q}%`} or ${schema.recruit.fullName} ilike ${`%${f.q}%`})`);
  const rows = await db
    .select({ p: schema.policy, name: schema.recruit.fullName, rid: schema.recruit.id })
    .from(schema.policy)
    .innerJoin(schema.recruit, eq(schema.recruit.id, schema.policy.recruitId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(schema.policy.writtenDate), desc(schema.policy.createdAt))
    .limit(200);

  return (
    <Shell user={u} active="/admin/policies">
      <div className="topbar">
        <div>
          <h1>Policies</h1>
          <p className="sub">Every policy from Momentum AMP, CSV imports and manual entry. Edit amounts from the recruit's page so history is kept.</p>
        </div>
      </div>

      <section className="card">
        <div className="hd"><h2>Ledger</h2><span className="small muted">{rows.length === 200 ? "Showing the latest 200" : `${rows.length} shown`}</span></div>
        <div className="bd">
          <form className="filters" method="get">
            <label>Search<input name="q" defaultValue={f.q ?? ""} placeholder="Policy number or name" /></label>
            <label>Status<select name="status" defaultValue={f.status ?? ""}><option value="">Any</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            <label>Source<select name="source" defaultValue={f.source ?? ""}><option value="">Any</option>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <div><button className="btn secondary">Filter</button></div>
          </form>
        </div>
        {rows.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Recruit</th><th>Policy</th><th>Type</th><th>Business</th><th>Written</th><th className="num">Annualized</th><th>Source</th><th>Status</th><th>Verify</th></tr></thead>
            <tbody>{rows.map(({ p, name, rid }) => (
              <tr key={p.id}>
                <td><a href={`/admin/recruits/${rid}#production`}>{name}</a></td>
                <td>{p.externalRef}{p.carrier ? <div className="small muted">{p.carrier}</div> : null}</td>
                <td>{p.policyType}</td>
                <td>{p.businessType}</td>
                <td className="tabular">{formatDay(p.writtenDate)}</td>
                <td className="num tabular">{formatCents(p.annualizedCents)}{p.annualizedSource === "calculated" ? <div className="small muted">calculated</div> : null}</td>
                <td>{SOURCES[p.source] ?? p.source}</td>
                <td><PolicyBadge status={p.status} /></td>
                <td>
                  {p.status === "pending" ? (
                    <div className="row">
                      <ActionForm action={reviewPolicyAction} submit="Approve" size="small" className="row">
                        <input type="hidden" name="policyId" value={p.id} />
                        <input type="hidden" name="decision" value="approved" />
                      </ActionForm>
                      <ActionForm action={reviewPolicyAction} submit="Reject" size="small" variant="secondary" className="row">
                        <input type="hidden" name="policyId" value={p.id} />
                        <input type="hidden" name="decision" value="rejected" />
                        <input name="reason" placeholder="Reason" required aria-label="Reason for rejecting" />
                      </ActionForm>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No policies match.</Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>Import from CSV</h2></div>
        <div className="bd"><CsvImport /></div>
      </section>
    </Shell>
  );
}

import { desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, Empty, ReimbursementBadge, type Tone } from "@/components/ui";
import { formatCents } from "@/domain/money";
import { formatDate } from "@/domain/durations";
import { payoutAction } from "../actions";

export const metadata = { title: "Payouts & reimbursements" };

const PAYOUT: Record<string, Tone> = { pending: "info", approved: "warn", paid: "ok", reversed: "neutral" };
const OPEN_REIMB = ["awaiting_receipt", "submitted", "approved", "partially_paid"];

export default async function MoneyPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const u = await requirePageUser("admin");
  const { all } = await searchParams;
  const paidSum = sql<number>`coalesce((select sum(amount_cents) from reimbursement_payment rp where rp.reimbursement_id = ${schema.reimbursement.id}), 0)::bigint`;
  const [reimbursements, payouts] = await Promise.all([
    db.select({ r: schema.reimbursement, name: schema.recruit.fullName, paid: paidSum })
      .from(schema.reimbursement).innerJoin(schema.recruit, eq(schema.recruit.id, schema.reimbursement.recruitId))
      .where(all ? undefined : inArray(schema.reimbursement.status, OPEN_REIMB)).orderBy(desc(schema.reimbursement.createdAt)).limit(200),
    db.select({ p: schema.payout, name: schema.recruit.fullName })
      .from(schema.payout).innerJoin(schema.recruit, eq(schema.recruit.id, schema.payout.recruitId))
      .where(all ? undefined : inArray(schema.payout.status, ["pending", "approved"])).orderBy(desc(schema.payout.createdAt)).limit(200),
  ]);

  return (
    <Shell user={u} active="/admin/money">
      <div className="topbar">
        <div>
          <h1>Payouts & reimbursements</h1>
          <p className="sub">{all ? "Everything, including paid and closed" : "Open items only"} · <a href={all ? "/admin/money" : "/admin/money?all=1"}>{all ? "Show open only" : "Show everything"}</a></p>
        </div>
      </div>

      <section className="card">
        <div className="hd"><h2>Exam reimbursements</h2><span className="small muted">Approve and record payments on the recruit's page</span></div>
        {reimbursements.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Recruit</th><th>Opened</th><th className="num">Test cost</th><th className="num">Approved</th><th className="num">Paid</th><th>Status</th></tr></thead>
            <tbody>{reimbursements.map(({ r, name, paid }) => (
              <tr key={r.id}>
                <td><a href={`/admin/recruits/${r.recruitId}#money`}>{name}</a></td>
                <td className="tabular">{formatDate(r.createdAt)}</td>
                <td className="num tabular">{r.testCostCents == null ? "—" : formatCents(r.testCostCents)}</td>
                <td className="num tabular">{r.approvedCents == null ? "—" : formatCents(r.approvedCents)}</td>
                <td className="num tabular">{formatCents(Number(paid))}</td>
                <td><ReimbursementBadge status={r.status} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No reimbursements to show.</Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>Payouts</h2><span className="small muted">Create payouts on the recruit's page</span></div>
        {payouts.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Recruit</th><th>Type</th><th>Period</th><th className="num">Amount</th><th>Status</th><th>Next step</th></tr></thead>
            <tbody>{payouts.map(({ p, name }) => (
              <tr key={p.id}>
                <td><a href={`/admin/recruits/${p.recruitId}#money`}>{name}</a></td>
                <td>{p.payoutType}{p.basis ? <div className="small muted">{p.basis}</div> : null}</td>
                <td>{p.periodLabel ?? "—"}</td>
                <td className="num tabular">{formatCents(p.amountCents)}</td>
                <td><Badge tone={PAYOUT[p.status] ?? "neutral"}>{p.status}</Badge>{p.paymentRef ? <div className="small muted">ref {p.paymentRef}</div> : null}</td>
                <td>
                  {p.status === "pending" ? (
                    <ActionForm action={payoutAction} submit="Approve" size="small" className="row">
                      <input type="hidden" name="op" value="approve" /><input type="hidden" name="payoutId" value={p.id} />
                    </ActionForm>
                  ) : p.status === "approved" ? (
                    <ActionForm action={payoutAction} submit="Mark paid" size="small" className="row">
                      <input type="hidden" name="op" value="paid" /><input type="hidden" name="payoutId" value={p.id} />
                      <input name="paymentRef" placeholder="Payment ref" required aria-label="Payment reference" />
                      <input type="date" name="paidOn" aria-label="Paid on" />
                    </ActionForm>
                  ) : null}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No payouts to show.</Empty>}
      </section>
    </Shell>
  );
}

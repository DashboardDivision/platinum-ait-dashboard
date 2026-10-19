import { requirePageUser, recruitForUser } from "@/server/session";
import { MilestoneGraph } from "@/components/milestone-graph";
import { redirect as goTo } from "next/navigation";
import { recruitOverview } from "@/server/views";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, Duration, Empty, PolicyBadge, ProgressBar } from "@/components/ui";
import { formatDate, formatDay } from "@/domain/durations";
import { formatCents } from "@/domain/money";
import { getSetting } from "@/server/settings";
import { submitPolicyAction } from "../actions";

export const metadata = { title: "Production" };

export default async function RecruitProduction() {
  const u = await requirePageUser("recruit");
  if (!u.impersonatedBy && !(u.perms ?? []).includes("recruit.production")) goTo("/recruit");
  const r = await recruitForUser(u.id);
  if (!r) return null;
  const o = (await recruitOverview(r.id))!;
  const types = await getSetting("policyTypes");
  const rule = await getSetting("premiumRuleText");
  const p = o.production;
  const byType = new Map<string, number>();
  for (const pol of p.policies.filter((x) => x.status === "approved")) byType.set(pol.policyType, (byType.get(pol.policyType) ?? 0) + 1);

  if (!r.contractSignedAt) {
    return (
      <Shell user={u} active="/recruit/production">
        <div className="topbar"><h1>Production</h1></div>
        <p className="alert info">Production tracking starts after your signed AIT contract is verified.</p>
      </Shell>
    );
  }
  return (
    <Shell user={u} active="/recruit/production">
      <div className="topbar"><h1>Production</h1></div>
      <div className="grid-main">
        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Graduation progress</h2><span className="small muted tabular">{p.percent}%</span></div>
            <div className="bd">
              <div className="tabular" style={{ fontSize: 26, fontWeight: 650 }}>{formatCents(p.qualifyingCents, { whole: true })}</div>
              <p className="small muted" style={{ marginBottom: 8 }}>approved qualifying annualized premium · goal $250,000</p>
              <ProgressBar percent={p.percent} label="Progress toward $250,000 graduation" />
              {p.next ? <p className="small" style={{ marginTop: 10 }}>Next: <strong>{p.next.label}</strong>{p.next.thresholdCents != null ? ` · ${formatCents(p.next.remainingCents, { whole: true })} remaining` : ""}</p> : null}
            </div>
          </section>
          <section className="card">
            <div className="hd"><h2>Milestones</h2></div>
            <div className="bd">
              <MilestoneGraph milestones={p.milestones} qualifyingCents={p.qualifyingCents} />
              <ul className="milestones" style={{ marginTop: 12 }}>
                {p.milestones.map((m) => (
                  <li key={m.key}>
                    <span>{m.achievedAt ? "✓ " : ""}{m.label}</span>
                    <span className="small muted tabular" style={{ textAlign: "right" }}>
                      {m.achievedAt ? (
                        <>
                          {formatDate(m.achievedAt)}
                          {m.sinceContractMs != null ? <> · <Duration ms={m.sinceContractMs} /> after signing</> : null}
                          {m.sincePreviousMs != null ? <> · <Duration ms={m.sincePreviousMs} /> after previous</> : null}
                        </>
                      ) : "Not yet"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <section className="card">
            <div className="hd"><h2>Your policies</h2><span className="small muted">{p.contributingPolicyCount} counting toward premium</span></div>
            {p.policies.length === 0 ? <Empty>No policies yet. Submit one below or wait for Platinum's sync.</Empty> : (
              <div className="table-wrap">
                <table className="t stack-sm">
                  <thead><tr><th>Policy</th><th>Type</th><th>Written</th><th className="num">Annualized</th><th>Status</th></tr></thead>
                  <tbody>
                    {p.policies.map((pol) => (
                      <tr key={pol.id}>
                        <td data-label="Policy">{pol.externalRef.replace(/^[0-9a-f]{8}:/, "")}<div className="small muted">{pol.carrier ?? ""}</div></td>
                        <td data-label="Type">{pol.policyType}{pol.businessType !== "new" ? <div className="small muted">{pol.businessType}</div> : null}</td>
                        <td data-label="Written">{formatDay(pol.writtenDate)}</td>
                        <td data-label="Annualized" className="num">{formatCents(pol.annualizedCents)}</td>
                        <td data-label="Status"><PolicyBadge status={pol.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Submit a policy</h2></div>
            <div className="bd">
              <p className="small muted" style={{ marginBottom: 10 }}>Submitted policies show as pending until Platinum verifies them. Don't include customer details.</p>
              <ActionForm action={submitPolicyAction} submit="Submit for verification" variant="secondary">
                <label className="f">Policy number<input type="text" name="policyNumber" required maxLength={60} /></label>
                <div className="row">
                  <label className="f">Type<select name="policyType" required>{types.map((t) => <option key={t}>{t}</option>)}</select></label>
                  <label className="f">Carrier<input type="text" name="carrier" maxLength={80} /></label>
                </div>
                <div className="row">
                  <label className="f">Written date<input type="date" name="writtenDate" required /></label>
                  <label className="f">Term<select name="termMonths" defaultValue="6"><option value="6">6 months</option><option value="12">12 months</option></select></label>
                </div>
                <label className="f">Full-term premium ($)<input type="text" inputMode="decimal" name="termPremium" required placeholder="850.00" /></label>
              </ActionForm>
            </div>
          </section>
          <section className="card">
            <div className="hd"><h2>Policy types</h2></div>
            <div className="bd small">
              {byType.size === 0 ? <span className="muted">No approved policies yet.</span> : [...byType].map(([t, n]) => <div key={t} className="row"><span>{t}</span><span className="shrink tabular">{n}</span></div>)}
            </div>
          </section>
          <section className="card">
            <div className="hd"><h2>Payouts</h2></div>
            <div className="bd small">
              {o.payouts.length === 0 ? <span className="muted">No payouts recorded.</span> : o.payouts.map((po) => (
                <div key={po.id} className="row"><span>{po.payoutType}{po.periodLabel ? ` · ${po.periodLabel}` : ""}</span><span className="shrink tabular">{formatCents(po.amountCents)} <Badge tone={po.status === "paid" ? "ok" : po.status === "reversed" ? "neutral" : "info"}>{po.status}</Badge></span></div>
              ))}
            </div>
          </section>
          <section className="card"><div className="hd"><h2>How premium counts</h2></div><div className="bd small muted">{rule}</div></section>
        </div>
      </div>
    </Shell>
  );
}

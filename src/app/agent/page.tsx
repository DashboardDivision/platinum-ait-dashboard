import { requirePageUser } from "@/server/session";
import { agentForUser } from "@/server/agents";
import { bookingUrlFor, getSetting } from "@/server/settings";
import { Shell } from "@/components/shell";
import { formatDate } from "@/domain/durations";
import { RECRUITER_NAMES } from "@/domain/programs";

export const metadata = { title: "My progress" };

/** The Free Agent / Group Sell dashboard. Only ever shows the signed-in agent's own program. */
export default async function AgentHome({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const u = await requirePageUser("agent");
  const o = await agentForUser(u.id);
  const { welcome } = await searchParams;
  if (!o || o.agent.status !== "active") {
    return (
      <Shell user={u} active="/agent">
        <p className="alert warn">Your dashboard isn't active. Contact your Platinum recruiter.</p>
      </Shell>
    );
  }
  const p = o.program;
  const a = o.agent;
  const perms = u.perms ?? [];
  const recruiterName = a.recruiter && perms.includes("lead.recruiter") ? RECRUITER_NAMES[a.recruiter] ?? a.recruiter : null;
  const booking = perms.includes("lead.booking") ? bookingUrlFor(await getSetting("bookingLinks"), a.recruiter) : null;
  const help = await getSetting("helpContact");
  const step = o.current ? p.steps[o.current - 1] : null;

  return (
    <Shell user={u} active="/agent">
      <div className="topbar">
        <div>
          <h1>{a.fullName}</h1>
          <p className="sub">{p.label}{a.organization ? ` · ${a.organization}` : ""}{recruiterName ? ` · Your recruiter: ${recruiterName}` : ""}</p>
        </div>
      </div>
      {welcome ? <p className="alert ok" style={{ marginBottom: 16 }}>Your password is set. Step 1 is complete.</p> : null}

      <div className="grid-main">
        <div className="stack">
          <section className="card next-action" aria-labelledby="next-title">
            <div className="bd">
              <div className="eyebrow">{step ? `Step ${o.current} of ${p.steps.length}` : "All done"}</div>
              <h2 id="next-title">{step ? step.title : "Every step is complete"}</h2>
              <p className="muted" style={{ marginBottom: 14 }}>{step ? step.agentText : "Thank you. Your recruiter will be in touch with anything else."}</p>
              {step?.booking ? (
                booking ? (
                  <a className="btn lg" href={booking} target="_blank" rel="noopener noreferrer">Book your 30-minute Gameplan call</a>
                ) : (
                  <p className="alert info">Your recruiter will send you a calendar invite for this call.</p>
                )
              ) : null}
              {step?.booking ? <p className="small muted" style={{ marginTop: 10 }}>This step is marked complete after your call.</p> : null}
            </div>
          </section>

          <section className="card" aria-labelledby="steps-title">
            <div className="hd"><h2 id="steps-title">Your steps</h2></div>
            <div className="bd">
              <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {p.steps.map((s, i) => {
                  const n = i + 1;
                  const done = o.steps.find((x) => x.step === n);
                  return (
                    <li key={n} className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--line-2)", alignItems: "center" }}>
                      <span aria-hidden="true" style={{ width: 28, fontWeight: 700, color: done ? "var(--ok, #1a7f37)" : n === o.current ? "var(--brand)" : "var(--ink-3)" }}>{done ? "✓" : n}</span>
                      <span style={{ flex: 1 }}>
                        <strong>Step {n}: {s.title}</strong>
                        <div className="small muted">{done ? `Completed ${formatDate(done.completedAt)}` : n === o.current ? "In progress" : "Up next"}</div>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Questions?</h2></div>
            <div className="bd small">
              {help ? (
                <p>
                  Contact <strong>{help.name}</strong>
                  {help.phone ? <> · <a href={`tel:${help.phone.replace(/\D/g, "")}`}>{help.phone}</a></> : null}
                  {help.email ? <> · <a href={`mailto:${help.email}`}>{help.email}</a></> : null}
                </p>
              ) : <p>Reach out to your Platinum recruiter.</p>}
              <p className="muted" style={{ marginTop: 8 }}><a href="/change-password">Change your password</a></p>
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}

import { requirePageUser } from "@/server/session";
import { can, requireStaffPage } from "@/server/permissions";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, Empty } from "@/components/ui";
import { formatDate } from "@/domain/durations";
import { PROGRAMS, RECRUITER_NAMES, type AgentProgramKey } from "@/domain/programs";
import { agentStepCounts, agentsByRecord, listTwentyContacts } from "@/server/agents";
import { HttpError } from "@/server/session";
import { inviteAgentAction } from "@/app/admin/actions";

/** Admin section for one agent program: its Twenty records, live, with dashboard status and invites. */
export async function AgentSection({ program, searchParams }: { program: AgentProgramKey; searchParams: { q?: string; after?: string; added?: string; type?: string; deleted?: string } }) {
  const u = await requireStaffPage(`${program}.view`);
  const p = PROGRAMS[program];
  let list: Awaited<ReturnType<typeof listTwentyContacts>> | null = null;
  let error: string | null = null;
  try {
    list = await listTwentyContacts(program, { q: searchParams.q, after: searchParams.after, type: searchParams.type });
  } catch (e) {
    error = e instanceof HttpError ? e.message : "Couldn't reach Twenty.";
  }
  const [local, counts] = await Promise.all([agentsByRecord(program, list?.rows.map((r) => r.id) ?? []), agentStepCounts(program)]);

  return (
    <Shell user={u} active={p.adminPath}>
      <div className="topbar">
        <div>
          <h1>{p.label}</h1>
          <p className="sub">Contacts from Twenty ({p.twentyPlural === "platinumRecruitings" ? "Platinum Recruiting" : "Platinum Legacy"}). Send a contact a dashboard login so they can follow their progress.</p>
        </div>
        <div className="row shrink" style={{ gap: 8 }}>
          {can(u, `${program}.edit`) ? <a className="btn" href={`${p.adminPath}/new`}>+ Add New {program === "group_sell" ? "Group Sell" : "Free Agent"}</a> : null}
          {can(u, `${program}.export`) ? <a className="btn secondary" href={`/api/admin/export/agents?program=${program}`}>Export CSV</a> : null}
        </div>
      </div>
      {searchParams.deleted ? <p className="alert ok" style={{ marginBottom: 16 }}>{searchParams.deleted}</p> : null}
      {searchParams.added ? <p className="alert ok" style={{ marginBottom: 16 }}>Added to Twenty. It's shown below; use “Send dashboard login” when you're ready.</p> : null}

      <div className="stats stats-7 stats-8" role="list" aria-label={`${p.short} contacts with a login, by current step`}>
        <div className="stat" role="listitem"><div className="v">{counts.counts[0] ?? 0}</div><div className="l">Step 0: Email Sent</div></div>
        {p.steps.map((s, i) => (
          <div key={i} className="stat" role="listitem"><div className="v">{counts.counts[i + 1] ?? 0}</div><div className="l">Step {i + 1}: {s.title}</div></div>
        ))}
        <div className="stat" role="listitem"><div className="v">{counts.done}</div><div className="l">All steps done</div></div>
      </div>

      <section className="card">
        <div className="hd">
          <form method="get" className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="search" name="q" defaultValue={searchParams.q ?? ""} placeholder="Search name or email" aria-label="Search" />
            {program === "free_agent" ? (
              <select name="type" defaultValue={searchParams.type ?? ""} aria-label="Lead type" style={{ width: "auto" }}>
                <option value="">All types</option>
                <option value="captive">Captive (Operation Free Agent)</option>
                <option value="independent">Independent (Traditional)</option>
              </select>
            ) : null}
            <button className="btn secondary small" type="submit">Search</button>
            {searchParams.q ? <a className="small" href={p.adminPath}>Clear</a> : null}
          </form>
          {list ? <span className="small muted">{list.total} in Twenty</span> : null}
        </div>
        {error ? <p className="alert bad" style={{ margin: 16 }}>{error}</p> : !list?.rows.length ? (
          <Empty>{searchParams.q ? "No contacts match that search." : "No contacts in Twenty yet."}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Name</th><th>Email</th>{program === "free_agent" ? <th>Type</th> : null}<th>Recruiter</th><th>Twenty stage</th><th>Dashboard</th><th></th></tr></thead>
              <tbody>
                {list.rows.map((c) => {
                  const a = local.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        {a ? <a href={`/admin/agents/${a.agent.id}`}>{c.name}</a> : c.name}
                        {c.organization ? <div className="small muted">{c.organization}</div> : null}
                      </td>
                      <td className="small">{c.email ?? <span className="muted">No email</span>}</td>
                      {program === "free_agent" ? <td className="small">{c.recruitType === "Traditional" ? "Independent" : c.recruitType === "Operation Free Agent" ? "Captive" : <span className="muted">–</span>}</td> : null}
                      <td className="small">{c.recruiter ? RECRUITER_NAMES[c.recruiter] ?? c.recruiter : <span className="muted">Not set</span>}</td>
                      <td className="small">{c.stage?.replace(/_/g, " ").toLowerCase() ?? "–"}</td>
                      <td className="small">
                        {!a?.agent.userId ? <Badge tone="neutral">No login</Badge>
                          : a.agent.status !== "active" ? <Badge tone="neutral">Archived</Badge>
                          : a.done ? <Badge tone="ok">All steps done</Badge>
                          : a.adminCurrent === 0 ? <Badge tone={a.agent.welcomeStatus === "failed" ? "bad" : "neutral"}>Step 0: Email Sent{a.agent.welcomeStatus === "failed" ? " (failed)" : " (sending)"}</Badge>
                          : <Badge tone="info">Step {a.current}: {p.steps[a.current! - 1].title}</Badge>}
                        {a?.agent.invitedAt ? <div className="muted">Invited {formatDate(a.agent.invitedAt)}</div> : null}
                      </td>
                      <td>
                        {a?.agent.userId || !can(u, `${program}.edit`) ? (a?.agent.userId ? (
                          <a className="btn small secondary" href={`/admin/agents/${a.agent.id}`}>Open</a>
                        ) : null) : (
                          <ActionForm action={inviteAgentAction} submit="Send dashboard login" size="small" className="" confirm={`Send ${c.name} a ${p.label} dashboard login at ${c.email ?? "(no email)"}?`}>
                            <input type="hidden" name="program" value={program} />
                            <input type="hidden" name="recordId" value={c.id} />
                          </ActionForm>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {list?.next ? (
          <div className="bd row" style={{ justifyContent: "flex-end" }}>
            <a className="btn small secondary" href={`${p.adminPath}?${new URLSearchParams({ ...(searchParams.q ? { q: searchParams.q } : {}), ...(searchParams.type ? { type: searchParams.type } : {}), after: list.next })}`}>Next page →</a>
          </div>
        ) : null}
      </section>
    </Shell>
  );
}

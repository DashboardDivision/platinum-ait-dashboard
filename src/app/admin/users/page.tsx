import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui";
import { formatDate, formatDateTime } from "@/domain/durations";
import { isLeadRole, isStaffRole, LEAD_ROLES, ROLE_LABELS, STAFF_ROLES } from "@/domain/roles";
import { PROGRAMS, isProgramKey } from "@/domain/programs";
import { requireStaffPage } from "@/server/permissions";
import { listUsers, roleLabel } from "@/server/users";
import { createUserAction, deleteUserAction, setUserActiveAction, setUserRoleAction } from "../actions";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const u = await requireStaffPage("master");
  const users = await listUsers();
  return (
    <Shell user={u} active="/admin/users">
      <div className="topbar">
        <div><h1>Users</h1><p className="sub">Every account. Create staff accounts here; candidates get theirs from their AIT, Free Agent or Group Sell record.</p></div>
        <a className="btn secondary" href="/api/admin/export/users">Export CSV</a>
      </div>

      <div className="grid-main">
        <section className="card">
          <div className="hd"><h2>{users.length} accounts</h2></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Manage</th></tr></thead>
              <tbody>
                {users.map((x) => {
                  const self = x.id === u.id;
                  const family = isStaffRole(x.role) ? STAFF_ROLES : isLeadRole(x.role) ? LEAD_ROLES : null;
                  return (
                    <tr key={x.id}>
                      <td>
                        <strong>{x.name}</strong>{self ? " (you)" : ""}
                        <div className="small muted">{x.email}</div>
                        {x.recruit_id ? <div className="small"><a href={`/admin/recruits/${x.recruit_id}`}>AIT record</a></div> : null}
                        {x.agent_id && x.agent_program && isProgramKey(x.agent_program) ? <div className="small"><a href={`/admin/agents/${x.agent_id}`}>{PROGRAMS[x.agent_program].label} record</a></div> : null}
                      </td>
                      <td className="small">{roleLabel(x.role)}</td>
                      <td className="small">
                        {x.banned ? <Badge tone="neutral">Deactivated</Badge> : x.must_change_password ? <Badge tone="info">Starter password</Badge> : <Badge tone="ok">Active</Badge>}
                        <div className="muted">since {formatDate(x.created_at)}</div>
                      </td>
                      <td className="small">{x.last_sign_in ? formatDateTime(x.last_sign_in) : <span className="muted">Never</span>}</td>
                      <td className="small" style={{ minWidth: 220 }}>
                        {self ? <span className="muted">Your own account</span> : (
                          <details className="disclose">
                            <summary>Manage</summary>
                            <div className="form-grid">
                              {family ? (
                                <ActionForm action={setUserRoleAction} submit="Change role" size="small" variant="secondary">
                                  <input type="hidden" name="userId" value={x.id} />
                                  <label className="f">Role
                                    <select name="role" defaultValue={x.role}>
                                      {family.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                                    </select>
                                  </label>
                                </ActionForm>
                              ) : null}
                              <ActionForm action={setUserActiveAction} submit={x.banned ? "Reactivate" : "Deactivate"} size="small" variant={x.banned ? "secondary" : "danger"} confirm={`${x.banned ? "Reactivate" : "Deactivate"} ${x.name}?`}>
                                <input type="hidden" name="userId" value={x.id} />
                                <input type="hidden" name="active" value={x.banned ? "1" : "0"} />
                                <label className="f">Reason<input name="reason" required maxLength={300} /></label>
                              </ActionForm>
                              {isStaffRole(x.role) ? (
                                <ActionForm action={deleteUserAction} submit="Delete permanently" size="small" variant="danger" confirm={`Permanently delete ${x.name}'s account? This can't be undone.`}>
                                  <input type="hidden" name="userId" value={x.id} />
                                  <label className="f">Type their email to confirm<input name="confirm" required autoComplete="off" /></label>
                                </ActionForm>
                              ) : <p className="muted">Delete candidates from their record page.</p>}
                            </div>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Create staff account</h2></div>
            <div className="bd">
              <ActionForm action={createUserAction} submit="Create and email login">
                <label className="f">Full name<input name="name" required maxLength={120} autoComplete="off" /></label>
                <label className="f">Email<input type="email" name="email" required maxLength={254} autoComplete="off" /></label>
                <label className="f">Mobile phone (U.S.)<input type="tel" name="phone" required maxLength={20} autoComplete="off" placeholder="801-555-0100" /></label>
                <label className="f">Role
                  <select name="role" defaultValue="admin">
                    {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                </label>
                <p className="small muted">Their starter password is this phone number, numbers only. They choose their own at first sign-in.</p>
              </ActionForm>
            </div>
          </section>
          <section className="card">
            <div className="hd"><h2>Roles</h2><a className="small" href="/admin/roles">Edit permissions</a></div>
            <div className="bd small">
              {Object.entries(ROLE_LABELS).map(([k, v]) => <div key={k}>{v}: {users.filter((x) => x.role === k || (k === "captive_lead" && x.role === "agent")).length}</div>)}
            </div>
          </section>
        </div>
      </div>
    </Shell>
  );
}

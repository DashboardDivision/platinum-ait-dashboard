import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { CANDIDATE_TOGGLES, ROLE_LABELS, SECTIONS, type RoleKey } from "@/domain/roles";
import { permsForRole, requireStaffPage } from "@/server/permissions";
import { saveRoleAction } from "../actions";

export const metadata = { title: "Roles" };

const STAFF_EDITABLE: RoleKey[] = ["admin", "admin_readonly"];
const CANDIDATES: RoleKey[] = ["recruit", "captive_lead", "ind_lead", "legacy_lead"];

/** What each role can see and do. Master Admin is always everything and isn't listed as editable. */
export default async function RolesPage() {
  const u = await requireStaffPage("master");
  const perms = Object.fromEntries(await Promise.all([...STAFF_EDITABLE, ...CANDIDATES].map(async (r) => [r, await permsForRole(r)] as const)));
  return (
    <Shell user={u} active="/admin/roles">
      <div className="topbar"><div><h1>Roles</h1><p className="sub">Choose what each role can see and do. Changes apply on their next page load and are recorded in the audit log.</p></div></div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="hd"><h2>Master Admin</h2></div>
        <div className="bd small">Full access to everything, including Users, Roles, deleting and the audit log. Always on; can't be edited.</div>
      </section>

      {STAFF_EDITABLE.map((role) => (
        <section key={role} className="card" style={{ marginBottom: 16 }}>
          <div className="hd"><h2>{ROLE_LABELS[role]}</h2><span className="small muted">Staff</span></div>
          <div className="bd">
            <ActionForm action={saveRoleAction} submit={`Save ${ROLE_LABELS[role]}`}>
              <input type="hidden" name="role" value={role} />
              <div className="table-wrap">
                <table className="t">
                  <thead><tr><th>Section</th><th>View</th><th>Edit</th><th>Delete</th><th>Export</th></tr></thead>
                  <tbody>
                    {SECTIONS.map((s) => (
                      <tr key={s.key}>
                        <td>{s.label}</td>
                        {(["view", "edit", "delete", "export"] as const).map((a) => (
                          <td key={a}>
                            {(s.actions as readonly string[]).includes(a) ? (
                              <input type="checkbox" name="perm" value={`${s.key}.${a}`} defaultChecked={perms[role].includes(`${s.key}.${a}`)} aria-label={`${s.label}: ${a}`} />
                            ) : <span className="muted">–</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted">Edit, delete and export only work on sections the role can also view. Users and Roles stay Master Admin only.</p>
            </ActionForm>
          </div>
        </section>
      ))}

      <section className="card">
        <div className="hd"><h2>Candidate roles</h2><span className="small muted">Each sees only their own dashboard</span></div>
        <div className="bd stack">
          {CANDIDATES.map((role) => (
            <ActionForm key={role} action={saveRoleAction} submit={`Save ${ROLE_LABELS[role]}`} variant="secondary" size="small">
              <input type="hidden" name="role" value={role} />
              <strong>{ROLE_LABELS[role]}</strong>
              <div className="row" style={{ gap: 16 }}>
                {CANDIDATE_TOGGLES[role].map((t) => (
                  <label key={t.key} className="row shrink" style={{ gap: 6, alignItems: "center" }}>
                    <input type="checkbox" name="perm" value={t.key} defaultChecked={perms[role].includes(t.key)} /> {t.label}
                  </label>
                ))}
              </div>
            </ActionForm>
          ))}
        </div>
      </section>
    </Shell>
  );
}

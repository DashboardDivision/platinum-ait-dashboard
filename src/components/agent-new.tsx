import { requirePageUser } from "@/server/session";
import { requireStaffPage } from "@/server/permissions";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { PROGRAMS, RECRUITER_NAMES, type AgentProgramKey } from "@/domain/programs";
import { addAgentContactAction } from "@/app/admin/actions";

/** "+ Add New": creates the contact in this program's Twenty object, optionally sending the login right away. */
export async function AgentNewForm({ program }: { program: AgentProgramKey }) {
  const u = await requireStaffPage(`${program}.edit`);
  const p = PROGRAMS[program];
  const groupSell = program === "group_sell";
  return (
    <Shell user={u} active={p.adminPath}>
      <div className="topbar">
        <div>
          <p className="small"><a href={p.adminPath}>← {p.label}</a></p>
          <h1>Add new {groupSell ? "Group Sell agency" : "Free Agent"}</h1>
          <p className="sub">Creates the contact in Twenty ({groupSell ? "Platinum Legacy" : "Platinum Recruiting"}).</p>
        </div>
        <a className="btn secondary" href={p.adminPath}>Cancel</a>
      </div>
      <section className="card" style={{ maxWidth: 560 }}>
        <div className="bd">
          <ActionForm action={addAgentContactAction} submit="Add to Twenty">
            <input type="hidden" name="program" value={program} />
            <label className="f">{groupSell ? "Owner's full name" : "Full name"}<input type="text" name="name" required maxLength={120} autoComplete="off" placeholder="First Last" /></label>
            {groupSell ? (
              <label className="f">Agency name<input type="text" name="organization" required maxLength={160} autoComplete="off" /></label>
            ) : (
              <label className="f">Current agency (optional)<input type="text" name="organization" maxLength={160} autoComplete="off" /></label>
            )}
            <label className="f">Email<input type="email" name="email" required maxLength={254} autoComplete="off" /></label>
            <label className="f">Mobile phone (U.S.)<input type="tel" name="phone" maxLength={20} autoComplete="off" placeholder="801-555-0100" /></label>
            <label className="f">
              Recruiter
              <select name="recruiter" defaultValue="">
                <option value="">Not set</option>
                {Object.entries(RECRUITER_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input type="checkbox" name="sendLogin" /> Send their dashboard login now (needs a U.S. mobile; it's their starter password)
            </label>
          </ActionForm>
        </div>
      </section>
    </Shell>
  );
}

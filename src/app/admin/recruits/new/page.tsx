import { requirePageUser } from "@/server/session";
import { can, requireStaffPage } from "@/server/permissions";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { RECRUITERS } from "@/server/new-recruit";
import { addRecruitAction } from "../../actions";

export const metadata = { title: "Add new recruit" };

export default async function NewRecruitPage() {
  const u = await requireStaffPage("ait.edit");
  return (
    <Shell user={u} active="/admin">
      <div className="topbar">
        <div>
          <h1>Add new recruit</h1>
          <p className="sub">Creates the Platinum AIT record in Twenty, their dashboard and study-site logins, and sends the welcome email.</p>
        </div>
        <a className="btn secondary" href="/admin">Cancel</a>
      </div>
      <section className="card" style={{ maxWidth: 560 }}>
        <div className="bd">
          <ActionForm action={addRecruitAction} submit="Add recruit and send welcome">
            <label className="f">Full name<input type="text" name="name" required maxLength={120} autoComplete="off" placeholder="First Last" /></label>
            <label className="f">Email<input type="email" name="email" required maxLength={254} autoComplete="off" /></label>
            <label className="f">
              Mobile phone (U.S.)
              <input type="tel" name="phone" required maxLength={20} autoComplete="off" placeholder="801-555-0100" />
            </label>
            <label className="f">
              Recruiter (optional)
              <select name="recruiter" defaultValue="">
                <option value="">Not set</option>
                {RECRUITERS.map((r) => <option key={r} value={r}>{r[0] + r.slice(1).toLowerCase()}</option>)}
              </select>
            </label>
            <p className="small muted">Their username is this email and their starter password is this phone number, numbers only. Both sites make them change it at first sign-in.</p>
          </ActionForm>
        </div>
      </section>
    </Shell>
  );
}

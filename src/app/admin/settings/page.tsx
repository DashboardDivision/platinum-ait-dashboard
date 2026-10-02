import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { getSetting } from "@/server/settings";
import { ADMIN_ALERT_EVENTS } from "@/server/messages";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { alertPrefsAction, saveSettingsAction } from "../actions";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const u = await requirePageUser("admin");
  const [exam, help, types, days, sms, rule, prefs] = await Promise.all([
    getSetting("examScheduling"), getSetting("helpContact"), getSetting("policyTypes"), getSetting("inactivityDays"), getSetting("smsEnabled"), getSetting("premiumRuleText"),
    db.select().from(schema.alertPreference).where(eq(schema.alertPreference.userId, u.id)),
  ]);
  const on = (key: string, dflt: boolean) => prefs.find((p) => p.eventType === key && p.channel === "email")?.enabled ?? dflt;

  return (
    <Shell user={u} active="/admin/settings">
      <div className="topbar"><div><h1>Settings</h1><p className="sub">Changes are audited and apply right away.</p></div></div>

      <section className="card">
        <div className="hd"><h2>Program</h2></div>
        <div className="bd">
          <ActionForm action={saveSettingsAction} submit="Save settings">
            <fieldset className="form-grid">
              <legend>Exam scheduling (Stage 3 button)</legend>
              <label>Default link<input type="url" name="examUrl" defaultValue={exam.defaultUrl ?? ""} placeholder="https://" /></label>
              <label>Button label<input name="examLabel" defaultValue={exam.defaultLabel} /></label>
              <label>Other states, one per line<textarea name="stateOverrides" rows={3} defaultValue={Object.entries(exam.stateOverrides).map(([k, v]) => `${k}, ${v}`).join("\n")} placeholder="ID, https://…" /></label>
            </fieldset>
            <fieldset className="form-grid">
              <legend>“Need help?” contact</legend>
              <label>Name<input name="helpName" defaultValue={help?.name ?? ""} /></label>
              <label>Email<input type="email" name="helpEmail" defaultValue={help?.email ?? ""} /></label>
              <label>Phone<input name="helpPhone" defaultValue={help?.phone ?? ""} /></label>
            </fieldset>
            <label>Policy types, one per line<textarea name="policyTypes" rows={7} defaultValue={types.join("\n")} /></label>
            <label>Inactivity reminder after (days)<input type="number" name="inactivityDays" min={1} max={90} defaultValue={days} /></label>
            <label className="row"><input type="checkbox" name="smsEnabled" defaultChecked={sms} /> Send texts (leave off until the Platinum 10DLC campaign is approved)</label>
          </ActionForm>
          <details className="disclose" style={{ marginTop: 14 }}>
            <summary>Premium credit rule shown to recruits</summary>
            <p className="small">{rule}</p>
          </details>
        </div>
      </section>

      <section className="card">
        <div className="hd"><h2>My email alerts</h2><span className="small muted">Security and required Stage 4 emails always send</span></div>
        <div className="bd">
          <ActionForm action={alertPrefsAction} submit="Save alerts">
            {ADMIN_ALERT_EVENTS.map((e) => (
              <label key={e.key} className="row"><input type="checkbox" name={`email:${e.key}`} defaultChecked={on(e.key, e.defaultOn)} /> {e.label}</label>
            ))}
          </ActionForm>
        </div>
      </section>

      <section className="card">
        <div className="hd"><h2>My password</h2></div>
        <div className="bd"><a className="btn secondary" href="/change-password">Change my password</a></div>
      </section>
    </Shell>
  );
}

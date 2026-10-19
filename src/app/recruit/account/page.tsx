import { desc, eq, and } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser, recruitForUser } from "@/server/session";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { getSetting } from "@/server/settings";
import { env } from "@/lib/env";
import { smsConsentAction } from "../actions";

export const metadata = { title: "Account" };

export default async function RecruitAccount() {
  const u = await requirePageUser("recruit");
  const r = await recruitForUser(u.id);
  if (!r) return null;
  const [latest] = await db.select().from(schema.consent).where(and(eq(schema.consent.recruitId, r.id), eq(schema.consent.channel, "sms"))).orderBy(desc(schema.consent.at)).limit(1);
  const smsOn = Boolean(latest?.granted);
  const smsEnabled = await getSetting("smsEnabled");
  return (
    <Shell user={u} active="/recruit/account">
      <div className="topbar"><h1>Account</h1></div>
      <div className="grid2">
        <section className="card">
          <div className="hd"><h2>Sign-in</h2></div>
          <div className="bd form-grid">
            <dl className="kv"><dt>Username</dt><dd>{u.email}</dd></dl>
            <p className="small muted">Your dashboard and study-site passwords are separate. Changing one doesn't change the other. Use each site's Forgot password link if you get locked out.</p>
            <div className="row">
              <a className="btn secondary shrink" href="/change-password">Change dashboard password</a>
              <a className="btn secondary shrink" href={env().EDUCATION_URL} target="_blank" rel="noopener noreferrer">Go to study site</a>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="hd"><h2>Text messages</h2></div>
          <div className="bd form-grid">
            <p className="small muted">
              Get progress texts at {r.phoneE164 ? r.phoneE164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3") : "your phone"} between 8 am and 9 pm Mountain. Message and data rates may apply. Reply STOP to opt out anytime.
              {!smsEnabled ? " Texting isn't switched on yet, so you'll get email for now." : ""}
            </p>
            <ActionForm action={smsConsentAction} submit={smsOn ? "Turn off texts" : "Turn on texts"} variant="secondary">
              <input type="hidden" name="granted" value={smsOn ? "no" : "yes"} />
              <p className="small">Currently: <strong>{smsOn ? "on" : "off"}</strong></p>
            </ActionForm>
          </div>
        </section>
      </div>
    </Shell>
  );
}

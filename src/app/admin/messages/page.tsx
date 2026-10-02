import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, Empty, type Tone } from "@/components/ui";
import { formatDateTime } from "@/domain/durations";
import { getSetting } from "@/server/settings";
import { retryOutboxAction } from "../actions";

export const metadata = { title: "Messages" };

const DELIVERY: Record<string, Tone> = { queued: "info", sent: "ok", delivered: "ok", bounced: "bad", failed: "bad", suppressed: "neutral" };

/** Mask recipients so this screen doesn't become a contact list. */
function mask(v: string) {
  if (v.includes("@")) { const [a, d] = v.split("@"); return `${a.slice(0, 2)}…@${d}`; }
  return `…${v.slice(-4)}`;
}

export default async function MessagesPage() {
  const u = await requirePageUser("admin");
  const [stuck, deliveries, smsEnabled] = await Promise.all([
    db.select({ o: schema.outbox, name: schema.recruit.fullName }).from(schema.outbox).leftJoin(schema.recruit, eq(schema.recruit.id, schema.outbox.recruitId))
      .where(inArray(schema.outbox.status, ["failed", "pending", "claimed"])).orderBy(desc(schema.outbox.createdAt)).limit(100),
    db.select({ m: schema.messageDelivery, name: schema.recruit.fullName }).from(schema.messageDelivery).leftJoin(schema.recruit, eq(schema.recruit.id, schema.messageDelivery.recruitId))
      .orderBy(desc(schema.messageDelivery.createdAt)).limit(150),
    getSetting("smsEnabled"),
  ]);

  return (
    <Shell user={u} active="/admin/messages">
      <div className="topbar">
        <div>
          <h1>Messages</h1>
          <p className="sub">Email goes out through Google Workspace via n8n. Texts are {smsEnabled ? "on" : "off"}{smsEnabled ? "" : " until the Platinum texting registration is approved"}.</p>
        </div>
      </div>

      <section className="card">
        <div className="hd"><h2>Waiting or failed</h2></div>
        {stuck.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Event</th><th>Recruit</th><th>Queued</th><th>Status</th><th></th></tr></thead>
            <tbody>{stuck.map(({ o, name }) => (
              <tr key={o.id}>
                <td>{o.eventType.replace(/_/g, " ")}{o.lastError ? <div className="small muted">{o.lastError}</div> : null}</td>
                <td>{o.recruitId ? <a href={`/admin/recruits/${o.recruitId}`}>{name}</a> : "—"}</td>
                <td className="tabular">{formatDateTime(o.createdAt)}</td>
                <td><Badge tone={o.status === "failed" ? "bad" : "info"}>{o.status}</Badge> <span className="small muted">{o.attempts} tries</span></td>
                <td>{o.status === "failed" ? (
                  <ActionForm action={retryOutboxAction} submit="Retry" size="small" variant="secondary" className="row">
                    <input type="hidden" name="outboxId" value={o.id} />
                  </ActionForm>
                ) : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>Nothing waiting. Every queued message has been handed off.</Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>Recent deliveries</h2><span className="small muted">Latest 150</span></div>
        {deliveries.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>When</th><th>Purpose</th><th>Recruit</th><th>To</th><th>Channel</th><th>Status</th></tr></thead>
            <tbody>{deliveries.map(({ m, name }) => (
              <tr key={m.id}>
                <td className="tabular">{formatDateTime(m.createdAt)}</td>
                <td>{m.purpose.replace(/_/g, " ")}</td>
                <td>{m.recruitId ? <a href={`/admin/recruits/${m.recruitId}`}>{name}</a> : "Admin"}</td>
                <td>{mask(m.recipient)}</td>
                <td>{m.channel === "sms" ? "Text" : "Email"}</td>
                <td><Badge tone={DELIVERY[m.status] ?? "neutral"}>{m.status}</Badge>{m.detail ? <div className="small muted">{m.detail}</div> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No messages sent yet.</Empty>}
      </section>
    </Shell>
  );
}

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, DocBadge, Empty, PolicyBadge, ProvisionBadge } from "@/components/ui";
import { formatCents } from "@/domain/money";
import { formatDateTime } from "@/domain/durations";
import { retryOutboxAction, retryProvisioningAction, taskAction } from "../actions";

export const metadata = { title: "Attention queue" };

const ATTENTION_TASKS = ["help_request", "contact_fix", "provisioning", "stage4_followup"];
const KIND: Record<string, string> = { help_request: "Help request", contact_fix: "Fix contact info", provisioning: "Account setup", stage4_followup: "Stage 4 follow-up" };

export default async function QueuePage() {
  const u = await requirePageUser("admin");
  const recruitName = { id: schema.recruit.id, name: schema.recruit.fullName };
  const [prov, tasks, docs, policies, failed] = await Promise.all([
    db.select({ p: schema.provisioning, r: recruitName }).from(schema.provisioning).innerJoin(schema.recruit, eq(schema.recruit.id, schema.provisioning.recruitId))
      .where(inArray(schema.provisioning.status, ["missing_information", "needs_match_review", "failed"])).orderBy(asc(schema.provisioning.updatedAt)),
    db.select({ t: schema.task, r: recruitName }).from(schema.task).leftJoin(schema.recruit, eq(schema.recruit.id, schema.task.recruitId))
      .where(and(eq(schema.task.status, "open"), inArray(schema.task.kind, ATTENTION_TASKS))).orderBy(asc(schema.task.createdAt)),
    db.select({ d: schema.document, r: recruitName }).from(schema.document).innerJoin(schema.recruit, eq(schema.recruit.id, schema.document.recruitId))
      .where(eq(schema.document.status, "uploaded")).orderBy(asc(schema.document.uploadedAt)),
    db.select({ p: schema.policy, r: recruitName }).from(schema.policy).innerJoin(schema.recruit, eq(schema.recruit.id, schema.policy.recruitId))
      .where(eq(schema.policy.status, "pending")).orderBy(asc(schema.policy.createdAt)).limit(50),
    db.select().from(schema.outbox).where(eq(schema.outbox.status, "failed")).orderBy(desc(schema.outbox.createdAt)).limit(50),
  ]);
  const total = prov.length + tasks.length + docs.length + policies.length + failed.length;

  return (
    <Shell user={u} active="/admin/queue">
      <div className="topbar">
        <div>
          <h1>Attention queue</h1>
          <p className="sub">{total ? `${total} item${total === 1 ? "" : "s"} need an admin` : "Nothing needs you right now"}</p>
        </div>
      </div>

      <section className="card">
        <div className="hd"><h2>Account setup problems</h2></div>
        {prov.length ? (
          <div className="bd"><ul className="queue">
            {prov.map(({ p, r }) => (
              <li key={p.id}>
                <div>
                  <a href={`/admin/recruits/${r.id}`}>{r.name}</a> · {p.system === "dashboard" ? "Dashboard" : "Education"} <ProvisionBadge status={p.status} />
                  {p.lastError ? <div className="small muted">{p.lastError}</div> : null}
                </div>
                {p.system === "dashboard" && p.status !== "needs_match_review" ? (
                  <ActionForm action={retryProvisioningAction} submit="Retry" size="small" variant="secondary" className="row">
                    <input type="hidden" name="recruitId" value={r.id} />
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul></div>
        ) : <Empty>No account setup problems.</Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>Open follow-ups</h2></div>
        {tasks.length ? (
          <div className="bd"><ul className="queue">
            {tasks.map(({ t, r }) => (
              <li key={t.id}>
                <div>
                  <Badge tone={t.kind === "help_request" ? "warn" : "info"}>{KIND[t.kind] ?? t.kind}</Badge> {t.title}
                  {r?.id ? <> · <a href={`/admin/recruits/${r.id}`}>{r.name}</a></> : null}
                  {t.body ? <div className="small muted">{t.body}</div> : null}
                  <div className="small muted tabular">Opened {formatDateTime(t.createdAt)}</div>
                </div>
                <ActionForm action={taskAction} submit="Mark done" size="small" variant="secondary" className="row">
                  <input type="hidden" name="taskId" value={t.id} />
                  <input type="hidden" name="op" value="done" />
                </ActionForm>
              </li>
            ))}
          </ul></div>
        ) : <Empty>No open follow-ups.</Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>Documents to review</h2></div>
        {docs.length ? (
          <div className="bd"><ul className="queue">
            {docs.map(({ d, r }) => (
              <li key={d.id}>
                <div><a href={`/admin/recruits/${r.id}#documents`}>{r.name}</a> · {d.originalName} <DocBadge status={d.status} /></div>
                <span className="small muted tabular">{formatDateTime(d.uploadedAt)}</span>
              </li>
            ))}
          </ul></div>
        ) : <Empty>No documents waiting.</Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>Policies to verify</h2></div>
        {policies.length ? (
          <div className="bd"><ul className="queue">
            {policies.map(({ p, r }) => (
              <li key={p.id}>
                <div><a href={`/admin/recruits/${r.id}#production`}>{r.name}</a> · {p.policyType} {p.externalRef} <PolicyBadge status={p.status} /></div>
                <span className="tabular">{formatCents(p.annualizedCents)}</span>
              </li>
            ))}
          </ul></div>
        ) : <Empty>No policies waiting. <a href="/admin/policies">Open the ledger</a></Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>Messages that failed</h2></div>
        {failed.length ? (
          <div className="bd"><ul className="queue">
            {failed.map((o) => (
              <li key={o.id}>
                <div>
                  {o.eventType.replace(/_/g, " ")} · {o.attempts} attempt{o.attempts === 1 ? "" : "s"}
                  {o.lastError ? <div className="small muted">{o.lastError}</div> : null}
                </div>
                <ActionForm action={retryOutboxAction} submit="Retry" size="small" variant="secondary" className="row">
                  <input type="hidden" name="outboxId" value={o.id} />
                </ActionForm>
              </li>
            ))}
          </ul></div>
        ) : <Empty>No failed messages.</Empty>}
      </section>
    </Shell>
  );
}

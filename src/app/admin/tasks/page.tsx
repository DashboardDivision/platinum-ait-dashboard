import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageUser } from "@/server/session";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { Badge, Empty } from "@/components/ui";
import { formatDate, formatDateTime } from "@/domain/durations";
import { createTaskAction, taskAction } from "../actions";

export const metadata = { title: "Tasks" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const u = await requirePageUser("admin");
  const { view = "open" } = await searchParams;
  const owner = schema.user;
  const where =
    view === "mine" ? and(eq(schema.task.status, "open"), eq(schema.task.ownerUserId, u.id))
    : view === "unassigned" ? and(eq(schema.task.status, "open"), isNull(schema.task.ownerUserId))
    : view === "done" ? eq(schema.task.status, "done")
    : eq(schema.task.status, "open");
  const [tasks, admins] = await Promise.all([
    db.select({ t: schema.task, recruit: schema.recruit.fullName, owner: owner.name })
      .from(schema.task)
      .leftJoin(schema.recruit, eq(schema.recruit.id, schema.task.recruitId))
      .leftJoin(owner, eq(owner.id, schema.task.ownerUserId))
      .where(where)
      .orderBy(view === "done" ? desc(schema.task.completedAt) : asc(schema.task.dueAt), asc(schema.task.createdAt))
      .limit(200),
    db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(or(eq(schema.user.role, "admin"))),
  ]);
  const now = Date.now();
  const tabs = [["open", "All open"], ["mine", "Mine"], ["unassigned", "Unassigned"], ["done", "Done"]];

  return (
    <Shell user={u} active="/admin/tasks">
      <div className="topbar">
        <div>
          <h1>Tasks</h1>
          <p className="sub">
            {tabs.map(([k, label], i) => (
              <span key={k}>{i ? " · " : ""}{k === view ? <strong>{label}</strong> : <a href={`/admin/tasks?view=${k}`}>{label}</a>}</span>
            ))}
          </p>
        </div>
      </div>

      <section className="card">
        {tasks.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Task</th><th>Recruit</th><th>Owner</th><th>Due</th><th></th></tr></thead>
            <tbody>{tasks.map(({ t, recruit, owner: ownerName }) => (
              <tr key={t.id}>
                <td>{t.title}{t.body ? <div className="small muted">{t.body}</div> : null}<div className="small muted tabular">Opened {formatDateTime(t.createdAt)}</div></td>
                <td>{t.recruitId ? <a href={`/admin/recruits/${t.recruitId}#tasks`}>{recruit}</a> : "—"}</td>
                <td>{ownerName ?? "Unassigned"}</td>
                <td className="tabular">{t.dueAt ? <>{formatDate(t.dueAt)} {t.status === "open" && +t.dueAt < now ? <Badge tone="bad">Overdue</Badge> : null}</> : "—"}</td>
                <td>
                  <div className="row">
                    {t.status === "open" && t.ownerUserId !== u.id ? (
                      <ActionForm action={taskAction} submit="Take it" size="small" variant="secondary" className="row">
                        <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="op" value="claim" />
                      </ActionForm>
                    ) : null}
                    <ActionForm action={taskAction} submit={t.status === "open" ? "Done" : "Reopen"} size="small" variant={t.status === "open" ? undefined : "secondary"} className="row">
                      <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="op" value={t.status === "open" ? "done" : "reopen"} />
                    </ActionForm>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>No tasks here.</Empty>}
      </section>

      <section className="card">
        <div className="hd"><h2>New task</h2><span className="small muted">For a recruit, add it from their page</span></div>
        <div className="bd">
          <ActionForm action={createTaskAction} submit="Create task">
            <label>Title<input name="title" required maxLength={200} /></label>
            <label>Details<textarea name="body" rows={2} maxLength={2000} /></label>
            <label>Owner<select name="ownerUserId" defaultValue={u.id}>{admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <label>Due<input type="date" name="dueAt" /></label>
          </ActionForm>
        </div>
      </section>
    </Shell>
  );
}

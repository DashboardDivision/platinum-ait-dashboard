import { handle } from "@/server/http";
import { HttpError, requireApiUser } from "@/server/session";
import { needPerm } from "@/server/permissions";
import { listAudit, roleLabel, type AuditFilters } from "@/server/users";
import { toCsv } from "@/domain/csv";
import { audit } from "@/server/audit";
import { db } from "@/db";

export const GET = handle(async (req: Request) => {
  const u = await requireApiUser("admin");
  if (u.impersonatedBy) throw new HttpError(403, "Not allowed");
  needPerm(u, "audit.export");
  const f = Object.fromEntries(new URL(req.url).searchParams) as AuditFilters;
  const { rows } = await listAudit({ ...f, page: "1" }, 50_000);
  await audit(db, { actorUserId: u.id, action: "audit.export", targetType: "audit", metadata: { rows: rows.length, filters: f } });
  const csv = toCsv(
    ["When (UTC)", "Who", "Who's role", "Action", "Record type", "Record id", "Reason", "Details", "Viewing as (impersonator)"],
    rows.map((a) => [a.at, a.actor_name ?? "System", a.actor_role ? roleLabel(a.actor_role) : "", a.action, a.target_type, a.target_id ?? "", a.reason ?? "", a.metadata ? JSON.stringify(a.metadata) : "", a.impersonator_name ?? ""]),
  );
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ait-audit-log.csv"`, "cache-control": "no-store" } });
});

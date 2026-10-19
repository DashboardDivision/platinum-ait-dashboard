import { handle } from "@/server/http";
import { HttpError, requireApiUser } from "@/server/session";
import { needMaster } from "@/server/permissions";
import { listUsers, roleLabel } from "@/server/users";
import { toCsv } from "@/domain/csv";
import { audit } from "@/server/audit";
import { db } from "@/db";

export const GET = handle(async () => {
  const u = await requireApiUser("admin");
  if (u.impersonatedBy) throw new HttpError(403, "Not allowed");
  needMaster(u);
  const rows = await listUsers();
  await audit(db, { actorUserId: u.id, action: "users.export", targetType: "user", metadata: { rows: rows.length } });
  const csv = toCsv(
    ["Name", "Email", "Role", "Status", "Created (UTC)", "Last sign-in (UTC)"],
    rows.map((x) => [x.name, x.email, roleLabel(x.role), x.banned ? "Deactivated" : x.must_change_password ? "Starter password" : "Active", x.created_at, x.last_sign_in ?? ""]),
  );
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ait-users.csv"`, "cache-control": "no-store" } });
});

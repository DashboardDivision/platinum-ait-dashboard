import { handle } from "@/server/http";
import { needPerm } from "@/server/permissions";
import { requireApiUser, HttpError } from "@/server/session";
import { listRecruits, type RecruitFilters } from "@/server/admin-queries";
import { toCsv } from "@/domain/csv";
import { adminStageLabel } from "@/domain/stages";
import { audit } from "@/server/audit";
import { db } from "@/db";

/** Validated export with formula-injection protection. Contact details are included for admins only. */
export const GET = handle(async (req: Request) => {
  const u = await requireApiUser("admin");
  if (u.impersonatedBy) throw new HttpError(403, "Not allowed");
  needPerm(u, "ait.export");
  const f = Object.fromEntries(new URL(req.url).searchParams) as RecruitFilters;
  const all = [];
  for (let page = 1; page < 400; page++) {
    const { rows, total } = await listRecruits({ ...f, page: String(page) });
    all.push(...rows);
    if (all.length >= total || rows.length === 0) break;
  }
  await audit(db, { actorUserId: u.id, action: "recruits.export", targetType: "recruit", metadata: { rows: all.length, filters: f } });
  const csv = toCsv(
    ["Name", "Email", "Status", "Current stage", "Enrolled (UTC)", "Last activity (UTC)", "Qualifying premium (USD)", "Graduated (UTC)"],
    all.map((r) => [r.full_name, r.email, r.status, r.graduated_at ? "Graduated" : r.current_stage != null ? `${r.current_stage}. ${adminStageLabel(r.current_stage)}` : "", r.enrollment_at, r.last_activity_at, (r.qualifying_cents / 100).toFixed(2), r.graduated_at]),
  );
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ait-recruits.csv"`, "cache-control": "no-store" } });
});

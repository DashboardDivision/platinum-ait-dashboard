import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";

export type RecruitFilters = {
  q?: string;
  stage?: string; // 1..5 | graduated
  status?: string; // active (default) | archived | withdrawn | all
  login?: string; // never | changed | starter
  inactiveDays?: string;
  attention?: string; // any
  milestone?: string;
  cohort?: string;
  owner?: string;
  page?: string;
  sort?: string;
};

export const PAGE_SIZE = 25;

export type RecruitRow = {
  id: string;
  full_name: string;
  email: string | null;
  status: string;
  cohort: string | null;
  owner_name: string | null;
  current_stage: number | null;
  stage_entered_at: Date | null;
  enrollment_at: Date;
  graduated_at: Date | null;
  last_activity_at: Date | null;
  first_login_at: Date | null;
  initial_password_changed_at: Date | null;
  dashboard_status: string | null;
  pending_docs: number;
  pending_policies: number;
  open_reimbursements: number;
  open_help: number;
  premium_below: string | null;
  contact_issue: string | null;
  qualifying_cents: number;
  milestones: string[] | null;
  total: number;
};

/**
 * Qualifying premium here mirrors src/domain/premium.ts (approved/cancelled new business
 * after contract signing during enrollment, net of adjustments, floored at zero per policy).
 */
export async function listRecruits(f: RecruitFilters, now = new Date()) {
  const where: SQL[] = [];
  const status = f.status || "active";
  if (status !== "all") where.push(sql`r.status = ${status}`);
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase()}%`;
    where.push(sql`(lower(r.full_name) like ${like} or lower(coalesce(r.email,'')) like ${like} or regexp_replace(coalesce(r.phone_e164,''),'\\D','','g') like ${`%${f.q.replace(/\D/g, "") || "~"}%`})`);
  }
  if (f.stage === "graduated") where.push(sql`r.graduated_at is not null`);
  else if (f.stage && /^[1-5]$/.test(f.stage)) where.push(sql`si.stage = ${Number(f.stage)} and r.graduated_at is null`);
  if (f.login === "never") where.push(sql`r.first_login_at is null`);
  if (f.login === "starter") where.push(sql`r.first_login_at is not null and r.initial_password_changed_at is null`);
  if (f.login === "changed") where.push(sql`r.initial_password_changed_at is not null`);
  if (f.inactiveDays && /^\d+$/.test(f.inactiveDays)) where.push(sql`coalesce(r.last_activity_at, r.account_created_at, r.enrollment_at) < ${new Date(+now - Number(f.inactiveDays) * 86_400_000)}`);
  if (f.cohort?.trim()) where.push(sql`r.cohort = ${f.cohort.trim()}`);
  if (f.owner === "unassigned") where.push(sql`r.owner_admin_id is null`);
  else if (f.owner) where.push(sql`r.owner_admin_id = ${f.owner}`);
  if (f.milestone) where.push(sql`exists (select 1 from milestone_achievement m where m.recruit_id = r.id and m.milestone = ${f.milestone})`);
  if (f.attention === "any")
    where.push(sql`(coalesce(d.n,0) > 0 or coalesce(pp.n,0) > 0 or coalesce(rb.n,0) > 0 or coalesce(h.n,0) > 0 or p.status in ('missing_information','needs_match_review','failed') or r.premium_below_threshold is not null or r.contact_issue is not null)`);
  const page = Math.max(1, Number(f.page) || 1);
  const order =
    f.sort === "name" ? sql`r.full_name asc` :
    f.sort === "stage_time" ? sql`si.entered_at asc nulls last` :
    f.sort === "inactive" ? sql`coalesce(r.last_activity_at, r.enrollment_at) asc` :
    f.sort === "premium" ? sql`qualifying_cents desc` :
    sql`r.enrollment_at desc`;

  const res = await db.execute<RecruitRow>(sql`
    with prem as (
      select pol.recruit_id, sum(greatest(0, pol.annualized_cents + coalesce(adj.total,0)))::bigint as cents
      from policy pol
      join recruit rr on rr.id = pol.recruit_id
      left join (select policy_id, sum(delta_cents) total from policy_adjustment group by policy_id) adj on adj.policy_id = pol.id
      where pol.status in ('approved','cancelled')
        and rr.contract_signed_at is not null
        and pol.written_date >= (rr.contract_signed_at at time zone 'America/Denver')::date
        and pol.written_date >= (rr.enrollment_at at time zone 'America/Denver')::date
        and (rr.enrollment_ended_at is null or pol.written_date <= (rr.enrollment_ended_at at time zone 'America/Denver')::date)
        and coalesce(pol.counts_override, pol.business_type = 'new')
      group by pol.recruit_id
    )
    select r.id, r.full_name, r.email, r.status, r.cohort, ou.name as owner_name,
      case when r.graduated_at is not null then 5 else si.stage end as current_stage,
      si.entered_at as stage_entered_at, r.enrollment_at, r.graduated_at, r.last_activity_at, r.first_login_at, r.initial_password_changed_at,
      p.status as dashboard_status,
      coalesce(d.n,0)::int as pending_docs, coalesce(pp.n,0)::int as pending_policies, coalesce(rb.n,0)::int as open_reimbursements, coalesce(h.n,0)::int as open_help,
      r.premium_below_threshold as premium_below, r.contact_issue,
      coalesce(prem.cents,0)::bigint as qualifying_cents,
      (select array_agg(m.milestone) from milestone_achievement m where m.recruit_id = r.id) as milestones,
      count(*) over()::int as total
    from recruit r
    left join "user" ou on ou.id = r.owner_admin_id
    left join stage_interval si on si.recruit_id = r.id and si.completed_at is null
    left join provisioning p on p.recruit_id = r.id and p.system = 'dashboard'
    left join (select recruit_id, count(*) n from document where status = 'uploaded' group by recruit_id) d on d.recruit_id = r.id
    left join (select recruit_id, count(*) n from policy where status = 'pending' group by recruit_id) pp on pp.recruit_id = r.id
    left join (select recruit_id, count(*) n from reimbursement where status in ('awaiting_receipt','submitted','approved','partially_paid') group by recruit_id) rb on rb.recruit_id = r.id
    left join (select recruit_id, count(*) n from task where status = 'open' and kind = 'help_request' group by recruit_id) h on h.recruit_id = r.id
    left join prem on prem.recruit_id = r.id
    ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
    order by ${order}
    limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`);
  const rows = res.rows.map((x) => ({ ...x, qualifying_cents: Number(x.qualifying_cents) }));
  return { rows, total: rows[0]?.total ?? 0, page };
}

export async function summaryCounts() {
  const res = await db.execute<{ active: number; pending_reviews: number; training: number; graduated: number; reimbursements_due: number; attention: number }>(sql`
    select
      (select count(*) from recruit where status = 'active')::int as active,
      ((select count(*) from document where status = 'uploaded') + (select count(*) from policy where status = 'pending'))::int as pending_reviews,
      (select count(*) from recruit r join stage_interval si on si.recruit_id = r.id and si.completed_at is null where si.stage = 5 and r.status = 'active')::int as training,
      (select count(*) from recruit where graduated_at is not null)::int as graduated,
      (select count(*) from reimbursement where status in ('awaiting_receipt','submitted','approved','partially_paid'))::int as reimbursements_due,
      ((select count(*) from provisioning where status in ('missing_information','needs_match_review','failed')) + (select count(*) from task where status = 'open' and kind in ('help_request','contact_fix','provisioning','stage4_followup')) + (select count(*) from outbox where status = 'failed'))::int as attention`);
  return res.rows[0];
}

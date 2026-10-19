/**
 * Roles and permissions. `user.role` stores one of ROLE_KEYS. Staff roles see the admin side
 * (Master Admin always has everything); candidate roles only ever see their own dashboard.
 */
export const ROLE_KEYS = ["master_admin", "admin", "admin_readonly", "recruit", "captive_lead", "ind_lead", "legacy_lead"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  master_admin: "Master Admin",
  admin: "Admin",
  admin_readonly: "Admin read-only",
  recruit: "AIT Recruit",
  captive_lead: "Captive Agency Lead",
  ind_lead: "Ind Agency Lead",
  legacy_lead: "Legacy Lead",
};

export const STAFF_ROLES: RoleKey[] = ["master_admin", "admin", "admin_readonly"];
export const LEAD_ROLES: RoleKey[] = ["captive_lead", "ind_lead", "legacy_lead"];

export function isRoleKey(v: string): v is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(v);
}
export const isStaffRole = (r: string) => STAFF_ROLES.includes(r as RoleKey);
/** Free Agent / Group Sell participants. ("agent" is the pre-roles value, kept for old rows.) */
export const isLeadRole = (r: string) => LEAD_ROLES.includes(r as RoleKey) || r === "agent";

/** Admin-side sections and what can be granted on each. */
export const SECTIONS = [
  { key: "ait", label: "AIT Recruits", path: "/admin", actions: ["view", "edit", "delete", "export"] },
  { key: "free_agent", label: "Operation Free Agent", path: "/admin/free-agent", actions: ["view", "edit", "delete", "export"] },
  { key: "group_sell", label: "Agency Group Sell", path: "/admin/group-sell", actions: ["view", "edit", "delete", "export"] },
  { key: "queue", label: "Attention queue", path: "/admin/queue", actions: ["view"] },
  { key: "policies", label: "Policies", path: "/admin/policies", actions: ["view", "edit"] },
  { key: "money", label: "Payouts & reimbursements", path: "/admin/money", actions: ["view", "edit"] },
  { key: "tasks", label: "Tasks", path: "/admin/tasks", actions: ["view", "edit"] },
  { key: "messages", label: "Messages", path: "/admin/messages", actions: ["view", "edit"] },
  { key: "settings", label: "Settings", path: "/admin/settings", actions: ["view", "edit"] },
  { key: "audit", label: "Audit log", path: "/admin/audit", actions: ["view", "export"] },
] as const;

/** What candidates can see on their own dashboard. */
export const CANDIDATE_TOGGLES: Record<string, { key: string; label: string }[]> = {
  recruit: [
    { key: "recruit.documents", label: "Documents page" },
    { key: "recruit.production", label: "Production page" },
  ],
  captive_lead: [{ key: "lead.recruiter", label: "Their recruiter's name" }, { key: "lead.booking", label: "Gameplan call booking button" }],
  ind_lead: [{ key: "lead.recruiter", label: "Their recruiter's name" }, { key: "lead.booking", label: "Gameplan call booking button" }],
  legacy_lead: [{ key: "lead.recruiter", label: "Their recruiter's name" }, { key: "lead.booking", label: "Gameplan call booking button" }],
};

export const ALL_STAFF_PERMS: string[] = SECTIONS.flatMap((s) => s.actions.map((a) => `${s.key}.${a}`));

export const DEFAULT_PERMS: Record<RoleKey, string[]> = {
  master_admin: ALL_STAFF_PERMS,
  admin: ALL_STAFF_PERMS.filter((p) => !p.endsWith(".delete") && !p.startsWith("audit.")),
  admin_readonly: ALL_STAFF_PERMS.filter((p) => p.endsWith(".view") && !p.startsWith("audit.")),
  recruit: ["recruit.documents", "recruit.production"],
  captive_lead: ["lead.recruiter", "lead.booking"],
  ind_lead: ["lead.recruiter", "lead.booking"],
  legacy_lead: ["lead.recruiter", "lead.booking"],
};

/** Free Agent contacts: Twenty "recruitType" decides captive vs independent. */
export function leadRoleFor(program: "free_agent" | "group_sell", recruitType: string | null): RoleKey {
  if (program === "group_sell") return "legacy_lead";
  return (recruitType ?? "").trim().toLowerCase() === "traditional" ? "ind_lead" : "captive_lead";
}

/** Where a staff member lands: the first section they can view. */
export function firstStaffPath(perms: string[]) {
  return SECTIONS.find((s) => perms.includes(`${s.key}.view`))?.path ?? "/admin/no-access";
}

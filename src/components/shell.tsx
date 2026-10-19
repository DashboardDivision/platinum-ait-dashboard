import { NavWordmark } from "./brand";
import { ROLE_LABELS, type RoleKey } from "@/domain/roles";
import type { CurrentUser } from "@/server/session";
import { SignOutButton } from "./sign-out";
import { StopImpersonating } from "./stop-impersonating";
import { NavDrawer } from "./nav-drawer";

const ADMIN_NAV: { href: string; label: string; perm?: string }[] = [
  { href: "/admin", label: "AIT Recruits", perm: "ait.view" },
  { href: "/admin/meetings", label: "AIT Meetings", perm: "ait.view" },
  { href: "/admin/free-agent", label: "Operation Free Agent", perm: "free_agent.view" },
  { href: "/admin/group-sell", label: "Agency Group Sell", perm: "group_sell.view" },
  { href: "/admin/queue", label: "Attention queue", perm: "queue.view" },
  { href: "/admin/policies", label: "Policies", perm: "policies.view" },
  { href: "/admin/money", label: "Payouts & reimbursements", perm: "money.view" },
  { href: "/admin/tasks", label: "Tasks", perm: "tasks.view" },
  { href: "/admin/messages", label: "Messages", perm: "messages.view" },
  { href: "/admin/settings", label: "Settings", perm: "settings.view" },
  { href: "/admin/audit", label: "Audit log", perm: "audit.view" },
  { href: "/admin/users", label: "Users", perm: "master" },
  { href: "/admin/roles", label: "Roles", perm: "master" },
];

const RECRUIT_NAV: { href: string; label: string; perm?: string }[] = [
  { href: "/recruit", label: "My progress" },
  { href: "/recruit/documents", label: "Documents", perm: "recruit.documents" },
  { href: "/recruit/production", label: "Production", perm: "recruit.production" },
  { href: "/recruit/account", label: "Account" },
];

const AGENT_NAV: { href: string; label: string; perm?: string }[] = [{ href: "/agent", label: "My progress" }];

export function Shell({ user, active, children }: { user: CurrentUser; active: string; children: React.ReactNode }) {
  const all = user.role === "admin" && !user.impersonatedBy ? ADMIN_NAV : user.role === "agent" ? AGENT_NAV : RECRUIT_NAV;
  const perms = user.perms ?? [];
  const nav = all.filter((n: { perm?: string }) => !n.perm || (n.perm === "master" ? user.roleKey === "master_admin" : perms.includes(n.perm)));
  return (
    <>
      {user.impersonatedBy ? (
        <div className="imp-banner" role="status">
          <span>
            You're viewing as <strong>{user.name}</strong>. Your actions are recorded as an admin, and stage actions, signing, password and payment changes are blocked.
          </span>
          <StopImpersonating />
        </div>
      ) : null}
      <div className="shell">
        <NavDrawer brand={<NavWordmark />}>
          <NavWordmark />
          {nav.map((n) => (
            <a key={n.href} className="item" href={n.href} aria-current={active === n.href ? "page" : undefined}>
              {n.label}
            </a>
          ))}
          <div className="spacer" />
          <div className="who">
            {user.email}
            {user.role === "admin" && !user.impersonatedBy ? <div style={{ marginTop: 2 }}>{ROLE_LABELS[user.roleKey as RoleKey] ?? "Admin"}</div> : null}
            <div style={{ marginTop: 6 }}>
              <SignOutButton />
            </div>
          </div>
        </NavDrawer>
        <main className="main" id="main">
          {children}
        </main>
      </div>
    </>
  );
}

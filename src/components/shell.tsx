import { NavWordmark } from "./brand";
import type { CurrentUser } from "@/server/session";
import { SignOutButton } from "./sign-out";
import { StopImpersonating } from "./stop-impersonating";

const ADMIN_NAV = [
  { href: "/admin", label: "Recruits" },
  { href: "/admin/queue", label: "Attention queue" },
  { href: "/admin/policies", label: "Policies" },
  { href: "/admin/money", label: "Payouts & reimbursements" },
  { href: "/admin/tasks", label: "Tasks" },
  { href: "/admin/messages", label: "Messages" },
  { href: "/admin/settings", label: "Settings" },
];

const RECRUIT_NAV = [
  { href: "/recruit", label: "My progress" },
  { href: "/recruit/documents", label: "Documents" },
  { href: "/recruit/production", label: "Production" },
  { href: "/recruit/account", label: "Account" },
];

export function Shell({ user, active, children }: { user: CurrentUser; active: string; children: React.ReactNode }) {
  const nav = user.role === "admin" && !user.impersonatedBy ? ADMIN_NAV : RECRUIT_NAV;
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
        <nav className="nav" aria-label="Main">
          <NavWordmark />
          {nav.map((n) => (
            <a key={n.href} className="item" href={n.href} aria-current={active === n.href ? "page" : undefined}>
              {n.label}
            </a>
          ))}
          <div className="spacer" />
          <div className="who">
            {user.email}
            <div style={{ marginTop: 6 }}>
              <SignOutButton />
            </div>
          </div>
        </nav>
        <main className="main" id="main">
          {children}
        </main>
      </div>
    </>
  );
}

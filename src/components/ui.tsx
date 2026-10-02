import { formatDuration } from "@/domain/durations";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const PROVISION: Record<string, [Tone, string]> = {
  ready: ["ok", "Ready"],
  pending: ["info", "Pending"],
  missing_information: ["warn", "Missing information"],
  needs_match_review: ["warn", "Needs account-match review"],
  failed: ["bad", "Failed"],
  unavailable: ["neutral", "Unavailable"],
};
export function ProvisionBadge({ status }: { status: string }) {
  const [tone, label] = PROVISION[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

const DOC: Record<string, [Tone, string]> = {
  uploaded: ["info", "Uploaded / Awaiting review"],
  approved: ["ok", "Approved"],
  needs_replacement: ["bad", "Needs replacement"],
  quarantined: ["bad", "Quarantined"],
};
export function DocBadge({ status }: { status: string }) {
  const [tone, label] = DOC[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

const REIMB: Record<string, [Tone, string]> = {
  awaiting_receipt: ["warn", "Awaiting receipt"],
  submitted: ["info", "Submitted"],
  approved: ["info", "Approved"],
  partially_paid: ["warn", "Partially paid"],
  paid: ["ok", "Paid"],
  rejected: ["bad", "Rejected"],
};
export function ReimbursementBadge({ status }: { status: string }) {
  const [tone, label] = REIMB[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

const POLICY: Record<string, [Tone, string]> = {
  pending: ["info", "Pending verification"],
  approved: ["ok", "Approved"],
  rejected: ["bad", "Rejected"],
  cancelled: ["warn", "Cancelled"],
  duplicate: ["neutral", "Duplicate"],
};
export function PolicyBadge({ status }: { status: string }) {
  const [tone, label] = POLICY[status] ?? ["neutral", status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Duration({ ms }: { ms: number }) {
  return <span className="tabular">{formatDuration(ms)}</span>;
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
      <span style={{ width: `${p}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

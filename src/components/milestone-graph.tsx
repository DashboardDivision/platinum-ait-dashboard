import { formatCents } from "@/domain/money";
import { formatDate } from "@/domain/durations";
import { GRADUATION_CENTS } from "@/domain/milestones";

type Row = { key: string; label: string; thresholdCents: number | null; achievedAt: Date | null };

const SHORT: Record<string, string> = {
  first_policy: "1st policy",
  premium_25k: "$25k",
  premium_50k: "$50k",
  premium_100k: "$100k",
  premium_200k: "$200k",
  graduation: "$250k",
};
const ICON: Record<string, string> = { first_policy: "✍️", graduation: "🏆" };

/** Position on the $0 → $250k track (first policy sits just inside the start). */
const pos = (m: Row) => (m.thresholdCents == null ? 3 : Math.min(100, (m.thresholdCents / GRADUATION_CENTS) * 100));

/**
 * Milestones as a left-to-right growth track: a rising ramp filled up to the recruit's approved
 * premium, with each milestone at its real dollar position. One measure, one hue; reached milestones
 * become ✓ badges, the next one pulses, graduation is a trophy. A plain list follows for screen
 * readers and anyone who prefers dates.
 */
export function MilestoneGraph({ milestones, qualifyingCents, locked = false }: { milestones: Row[]; qualifyingCents: number; locked?: boolean }) {
  const fill = locked ? 0 : Math.min(100, (Math.max(0, qualifyingCents) / GRADUATION_CENTS) * 100);
  const next = locked ? null : milestones.find((m) => !m.achievedAt) ?? null;
  const reached = milestones.filter((m) => m.achievedAt).length;
  const graduated = milestones.find((m) => m.key === "graduation")?.achievedAt;
  // The ramp rises from 18% to 85% height; the filled part is clipped to the premium position.
  const ramp = "0,100 0,82 100,15 100,100";
  // SVG ids are page-global: make them unique to this graph's state so two graphs never share a fill.
  const uid = `mg${Math.round(fill * 100)}${locked ? "l" : ""}${reached}`;

  return (
    <figure className={`mg${locked ? " mg-locked" : ""}`} aria-labelledby={`${uid}-cap`}>
      <figcaption id={`${uid}-cap`} className="mg-head">
        <div>
          <div className="mg-amount tabular">{formatCents(locked ? 0 : qualifyingCents, { whole: true })}</div>
          <div className="small muted">approved annualized premium of $250,000</div>
        </div>
        <div className="mg-score" aria-label={`${reached} of ${milestones.length} milestones reached`}>
          <span className="mg-score-n">{reached}</span>/{milestones.length}
          <span className="small muted"> reached</span>
        </div>
      </figcaption>

      <div className="mg-plot" aria-hidden="true">
        <svg className="mg-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id={`${uid}-grad`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" style={{ stopColor: "#9fdcf5" }} />
              <stop offset="0.35" style={{ stopColor: "var(--brand-bright, #28ace2)" }} />
              <stop offset="1" style={{ stopColor: "var(--brand, #0b6e99)" }} />
            </linearGradient>
            <clipPath id={`${uid}-clip`}><rect className="mg-fill-rect" x="0" y="0" width={fill} height="100" /></clipPath>
          </defs>
          <polygon points={ramp} className="mg-track" />
          <polygon points={ramp} fill={`url(#${uid}-grad)`} clipPath={`url(#${uid}-clip)`} />
          {milestones.map((m) => <line key={m.key} x1={pos(m)} x2={pos(m)} y1={82 - pos(m) * 0.67} y2="100" className="mg-tick" vectorEffect="non-scaling-stroke" />)}
        </svg>

        {milestones.map((m, i) => {
          const x = pos(m);
          const done = Boolean(m.achievedAt);
          const isNext = next?.key === m.key;
          const tip = done
            ? `${m.label}: reached ${formatDate(m.achievedAt!)}`
            : m.thresholdCents == null
              ? `${m.label}: your first approved policy`
              : `${m.label}: ${formatCents(Math.max(0, m.thresholdCents - (locked ? 0 : qualifyingCents)), { whole: true })} to go`;
          return (
            <div key={m.key} className={`mg-node${done ? " done" : ""}${isNext ? " next" : ""}${m.key === "graduation" ? " grad" : ""}${x < 15 ? " edge-l" : x > 75 ? " edge-r" : ""}`}
              style={{ left: `${x}%`, bottom: `${18 + x * 0.67}%` }} tabIndex={0} aria-label={tip}>
              <span className="mg-dot">{done ? (m.key === "graduation" ? "🏆" : "✓") : ICON[m.key] ?? ""}</span>
              <span className={`mg-label${i === 1 ? " lift" : ""}`}>{m.key === "first_policy" ? <><span className="mg-long">1st policy</span><span className="mg-short">1st</span></> : SHORT[m.key] ?? m.label}</span>
              <span className="mg-tip" role="tooltip">{tip}</span>
            </div>
          );
        })}

        {!locked && qualifyingCents > 0 && !graduated ? (
          <div className={`mg-you${fill > 85 ? " edge-r" : fill < 12 ? " edge-l" : ""}`} style={{ left: `${Math.max(1, Math.min(99, fill))}%`, height: `${18 + fill * 0.67}%` }}>
            <span className="mg-you-flag">You are here</span>
          </div>
        ) : null}
      </div>

      <div className="mg-foot small">
        {locked ? (
          <span className="muted">🔒 Your growth track starts once your contract is signed and you begin writing business.</span>
        ) : graduated ? (
          <strong>🎉 You graduated! $250,000 reached on {formatDate(graduated)}.</strong>
        ) : next ? (
          <span>
            <strong>Next up: {next.label}</strong>
            {next.thresholdCents != null ? <> · <span className="tabular">{formatCents(Math.max(0, next.thresholdCents - qualifyingCents), { whole: true })}</span> to go</> : " · write and get your first policy approved"}
            {reached ? " · keep it rolling! 🚀" : " · let's go! 🚀"}
          </span>
        ) : null}
      </div>

      <ul className="sr-only">
        {milestones.map((m) => <li key={m.key}>{m.label}: {m.achievedAt ? `reached ${formatDate(m.achievedAt)}` : "not yet"}</li>)}
      </ul>
    </figure>
  );
}

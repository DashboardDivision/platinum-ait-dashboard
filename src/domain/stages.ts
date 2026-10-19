export const STAGES = [
  { n: 1, key: "login", title: "Login & Change Password" },
  { n: 2, key: "study", title: "Study for P&C License Exam" },
  { n: 3, key: "schedule", title: "Sign Up for P&C Licensing Exam" },
  { n: 4, key: "pass", title: "Pass P&C Licensing Exam" },
  { n: 5, key: "training", title: "Start Training" },
] as const;

export type StageNumber = 1 | 2 | 3 | 4 | 5;

export type StageInterval = {
  id?: string;
  stage: StageNumber;
  enteredAt: Date;
  completedAt: Date | null;
};

export type StageState = {
  currentStage: StageNumber;
  /** True once stage 5 has completed (graduation). */
  finished: boolean;
};

export function stageTitle(n: number): string {
  return STAGES.find((s) => s.n === n)?.title ?? `Stage ${n}`;
}

/** Current stage = the most recent interval still open; graduation closes stage 5. */
export function deriveState(intervals: StageInterval[]): StageState {
  const open = [...intervals].filter((i) => !i.completedAt).sort((a, b) => +b.enteredAt - +a.enteredAt)[0];
  if (open) return { currentStage: open.stage, finished: false };
  const last = [...intervals].sort((a, b) => +b.enteredAt - +a.enteredAt)[0];
  if (!last) return { currentStage: 1, finished: false };
  return { currentStage: last.stage, finished: last.stage === 5 };
}

export type Transition =
  | { kind: "noop"; reason: string }
  | { kind: "advance"; close: StageInterval; open: StageInterval | null };

/**
 * Complete `stage` at `at`. Only the current open stage can complete, so
 * repeated or out-of-order submissions are idempotent no-ops (they never
 * restart timers or replay congratulations). Adjacent stages share the same
 * boundary timestamp.
 */
export function completeStage(intervals: StageInterval[], stage: StageNumber, at: Date): Transition {
  const open = intervals.find((i) => i.stage === stage && !i.completedAt);
  if (!open) {
    const done = intervals.some((i) => i.stage === stage && i.completedAt);
    return { kind: "noop", reason: done ? "already_completed" : "not_current" };
  }
  const state = deriveState(intervals);
  if (state.currentStage !== stage) return { kind: "noop", reason: "not_current" };
  const close: StageInterval = { ...open, completedAt: at };
  const next = stage < 5 ? ({ stage: (stage + 1) as StageNumber, enteredAt: at, completedAt: null } satisfies StageInterval) : null;
  return { kind: "advance", close, open: next };
}

/** Frozen for completed intervals, running to `now` for the open one. Reopened stages keep separate intervals. */
export function intervalMs(i: StageInterval, now: Date): number {
  return +(i.completedAt ?? now) - +i.enteredAt;
}

export function stageDurationMs(intervals: StageInterval[], stage: StageNumber, now: Date): number {
  return intervals.filter((i) => i.stage === stage).reduce((sum, i) => sum + intervalMs(i, now), 0);
}

/** Admin views only: Stage 0 is "Email Sent" (welcome delivered); candidates never see it. */
export const STAGE0_TITLE = "Email Sent";
export function adminStageLabel(n: number) {
  return n === 0 ? STAGE0_TITLE : stageTitle(n);
}

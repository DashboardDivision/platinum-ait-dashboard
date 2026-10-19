/** The two agent programs that live beside AIT. Each maps to its own Twenty object and six steps. */
export type AgentProgramKey = "free_agent" | "group_sell";

export type ProgramStep = {
  title: string;
  /** What the agent sees while this is their current step. */
  agentText: string;
  /** Step 2 shows the recruiter's 30-minute booking link. */
  booking?: boolean;
};

export type AgentProgram = {
  key: AgentProgramKey;
  label: string;
  short: string;
  twentyObject: string; // singular, as stored on the agent row
  twentyPlural: string; // REST path
  adminPath: string;
  steps: ProgramStep[];
};

export const PROGRAMS: Record<AgentProgramKey, AgentProgram> = {
  free_agent: {
    key: "free_agent",
    label: "Operation Free Agent",
    short: "Free Agent",
    twentyObject: "platinumRecruiting",
    twentyPlural: "platinumRecruitings",
    adminPath: "/admin/free-agent",
    steps: [
      { title: "Login to your dashboard", agentText: "Sign in and choose your own password." },
      { title: "Consultation Gameplan call", agentText: "Book a 30-minute video call with your recruiter to map out your move.", booking: true },
      { title: "Scrape data", agentText: "Your recruiter is gathering your book-of-business data. They'll reach out if they need anything." },
      { title: "Set up LLC", agentText: "Set up your LLC. Your recruiter will walk you through it." },
      { title: "Contracts signed", agentText: "Review and sign your contracts with your recruiter." },
      { title: "Begin migration", agentText: "Your migration to Platinum is underway." },
    ],
  },
  group_sell: {
    key: "group_sell",
    label: "Agency Group Sell",
    short: "Group Sell",
    twentyObject: "platinumLegacy",
    twentyPlural: "platinumLegacies",
    adminPath: "/admin/group-sell",
    steps: [
      { title: "Login to your dashboard", agentText: "Sign in and choose your own password." },
      { title: "Schedule Gameplan call", agentText: "Book a 30-minute call with your recruiter to talk through the sale.", booking: true },
      { title: "Sign NDA", agentText: "Sign the non-disclosure agreement your recruiter sends you." },
      { title: "Internal audit and valuation", agentText: "Your recruiter is setting up the internal audit and valuation of your agency." },
      { title: "Sign contract", agentText: "Review and sign your contract with your recruiter." },
      { title: "Wait for group sell", agentText: "You're all set. Your recruiter will keep you posted as the group sell comes together." },
    ],
  },
};

export const PROGRAM_KEYS = Object.keys(PROGRAMS) as AgentProgramKey[];

export function isProgramKey(v: string): v is AgentProgramKey {
  return v === "free_agent" || v === "group_sell";
}

/** Steps are completed in order, so the current step is one past the highest completed step. */
export function currentStep(completed: number[], total = 6): { current: number | null; done: boolean } {
  const set = new Set(completed);
  for (let n = 1; n <= total; n += 1) if (!set.has(n)) return { current: n, done: false };
  return { current: null, done: true };
}

export const RECRUITER_NAMES: Record<string, string> = { COLTON: "Colton", JESSE: "Jesse", PARKER: "Parker" };

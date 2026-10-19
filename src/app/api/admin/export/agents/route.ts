import { inArray, eq } from "drizzle-orm";
import { handle } from "@/server/http";
import { HttpError, requireApiUser } from "@/server/session";
import { needPerm } from "@/server/permissions";
import { toCsv } from "@/domain/csv";
import { currentStep, isProgramKey, PROGRAMS, RECRUITER_NAMES } from "@/domain/programs";
import { audit } from "@/server/audit";
import { db, schema } from "@/db";

/** Free Agent / Group Sell contacts that have a dashboard login, with their current step. */
export const GET = handle(async (req: Request) => {
  const u = await requireApiUser("admin");
  if (u.impersonatedBy) throw new HttpError(403, "Not allowed");
  const program = new URL(req.url).searchParams.get("program") ?? "";
  if (!isProgramKey(program)) throw new HttpError(400, "Unknown program");
  needPerm(u, `${program}.export`);
  const p = PROGRAMS[program];
  const agents = await db.select().from(schema.agent).where(eq(schema.agent.program, program));
  const steps = agents.length ? await db.select().from(schema.agentStep).where(inArray(schema.agentStep.agentId, agents.map((a) => a.id))) : [];
  await audit(db, { actorUserId: u.id, action: `${program}.export`, targetType: "agent", metadata: { rows: agents.length } });
  const csv = toCsv(
    ["Name", "Organization", "Email", "Phone", "Recruiter", "Status", "Current step", "Welcome email", "Invited (UTC)", "First sign-in (UTC)", ...p.steps.map((s, i) => `Step ${i + 1} done (UTC)`)],
    agents.map((a) => {
      const mine = steps.filter((s) => s.agentId === a.id);
      const c = currentStep(mine.map((s) => s.step), p.steps.length);
      const stepLabel = c.done ? "All steps done" : c.current === 1 && a.welcomeStatus !== "sent" ? "0. Email Sent" : `${c.current}. ${p.steps[c.current! - 1].title}`;
      return [a.fullName, a.organization ?? "", a.email, a.phoneE164 ?? "", a.recruiter ? RECRUITER_NAMES[a.recruiter] ?? a.recruiter : "", a.status, stepLabel, a.welcomeStatus,
        a.invitedAt ?? "", a.firstLoginAt ?? "", ...p.steps.map((_, i) => mine.find((s) => s.step === i + 1)?.completedAt ?? "")];
    }),
  );
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${program.replace("_", "-")}.csv"`, "cache-control": "no-store" } });
});

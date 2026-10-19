import { env } from "@/lib/env";
import { HttpError, requireApiUser } from "@/server/session";
import { recordExamClick, recordStudyClick } from "@/server/recruit-actions";

/**
 * Called by the dashboard's "open in a new tab" buttons. Records the click (study visit, or exam
 * scheduling, which completes Stage 3) and returns where the new tab should go.
 */
export async function POST(req: Request, { params }: { params: Promise<{ target: string }> }) {
  // Same-origin only: another site can't record clicks for a signed-in recruit.
  if (req.headers.get("origin") !== new URL(env().APP_URL).origin) return reply(403, { error: "This link has to be opened from your dashboard." });
  const { target } = await params;
  try {
    const u = await requireApiUser("recruit");
    const url = target === "study" ? await recordStudyClick(u, env().EDUCATION_URL) : target === "exam" ? await recordExamClick(u) : null;
    return url ? reply(200, { url }) : reply(404, { error: "Not found." });
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, { error: e.message });
    throw e;
  }
}

function reply(status: number, body: Record<string, string>) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

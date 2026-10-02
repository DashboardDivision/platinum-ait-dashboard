import { env } from "@/lib/env";
import { handle, json } from "@/server/http";
import { handleAdobeSignCallback } from "@/server/contracts";

/** Adobe Acrobat Sign verifies a webhook URL by expecting its client id echoed back. */
export const GET = handle(async (req: Request) => {
  const clientId = req.headers.get("x-adobesign-clientid");
  if (!clientId || clientId !== env().ADOBE_SIGN_CLIENT_ID) return json({ error: "unknown client" }, 403);
  return json({ xAdobeSignClientId: clientId }, 200);
});

export const POST = handle(async (req: Request) => {
  const clientId = req.headers.get("x-adobesign-clientid");
  if (!clientId || clientId !== env().ADOBE_SIGN_CLIENT_ID) return json({ error: "unknown client" }, 403);
  const body = (await req.json()) as { agreement?: { id?: string } };
  const id = body.agreement?.id;
  // Completion is confirmed by fetching the agreement from Adobe, never from this payload.
  if (id) await handleAdobeSignCallback(id);
  return json({ xAdobeSignClientId: clientId });
});

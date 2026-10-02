import { handle, json, requireIntegrationToken } from "@/server/http";
import { scanInactivity } from "@/server/inactivity";

export const POST = handle(async (req: Request) => {
  requireIntegrationToken(req);
  return json(await scanInactivity());
});

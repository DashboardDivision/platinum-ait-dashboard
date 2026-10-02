import { handle, json, requireIntegrationToken } from "@/server/http";
import { reconcileProvisioning } from "@/server/provisioning";

export const POST = handle(async (req: Request) => {
  requireIntegrationToken(req);
  return json({ results: await reconcileProvisioning() });
});

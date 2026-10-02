import { z } from "zod";
import { handle, json, requireIntegrationToken } from "@/server/http";
import { provisionFromTwenty } from "@/server/provisioning";

const Body = z.object({
  workspaceId: z.string().min(1),
  object: z.string().min(1),
  recordId: z.string().min(1),
  eventId: z.string().min(1),
  sourceTime: z.string().nullish(),
  record: z.object({
    name: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    stage: z.string().nullish(),
    createdAt: z.string().nullish(),
    deletedAt: z.string().nullish(),
  }),
});

/** Called by n8n after it authenticates the Twenty webhook and re-fetches the record. */
export const POST = handle(async (req: Request) => {
  requireIntegrationToken(req);
  const body = Body.parse(await req.json());
  const out = await provisionFromTwenty({
    ...body,
    record: { name: body.record.name ?? null, email: body.record.email ?? null, phone: body.record.phone ?? null, stage: body.record.stage, createdAt: body.record.createdAt, deletedAt: body.record.deletedAt },
  });
  return json(out);
});

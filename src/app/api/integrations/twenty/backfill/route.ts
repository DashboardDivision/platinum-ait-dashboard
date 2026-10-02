import { z } from "zod";
import { handle, json, requireIntegrationToken } from "@/server/http";
import { previewBackfill, provisionFromTwenty } from "@/server/provisioning";

const Record = z.object({
  recordId: z.string().min(1),
  name: z.string().nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  stage: z.string().nullish(),
  createdAt: z.string().nullish(),
  deletedAt: z.string().nullish(),
});
const Body = z.object({
  mode: z.enum(["preview", "apply"]),
  workspaceId: z.string().min(1),
  sendWelcome: z.boolean().default(false),
  records: z.array(Record).max(1000),
});

/**
 * Enrolls Twenty records that existed before go-live. Run "preview" first and get
 * Colton's OK on the list (and on whether welcomes go out) before "apply".
 */
export const POST = handle(async (req: Request) => {
  requireIntegrationToken(req);
  const body = Body.parse(await req.json());
  const records = body.records.map((r) => ({ ...r, name: r.name ?? null, email: r.email ?? null, phone: r.phone ?? null }));
  if (body.mode === "preview") return json({ preview: await previewBackfill(body.workspaceId, records) });
  const results = [];
  for (const r of records) {
    results.push(await provisionFromTwenty({ workspaceId: body.workspaceId, object: "platinumAit", recordId: r.recordId, eventId: `backfill:${r.recordId}`, record: r, backfill: { sendWelcome: body.sendWelcome } }));
  }
  return json({ results });
});

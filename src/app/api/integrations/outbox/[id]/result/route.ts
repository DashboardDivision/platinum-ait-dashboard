import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { handle, json, requireIntegrationToken } from "@/server/http";
import { completeOutbox } from "@/server/outbox";
import { recordDelivery, settleOutbox } from "@/server/messages";

const Body = z.object({
  deliveries: z.array(z.object({
    dedupeKey: z.string(),
    recipient: z.string(),
    channel: z.enum(["email", "sms"]),
    purpose: z.string(),
    status: z.enum(["sent", "delivered", "bounced", "failed", "suppressed"]),
    providerRef: z.string().nullish(),
    detail: z.string().nullish(),
  })).min(1),
});

/**
 * n8n reports each message as it goes out (one or many per call). The event is
 * finished only once every current message for it is sent; a failure schedules a retry
 * that skips recipients who already got it.
 */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  requireIntegrationToken(req);
  const { id } = await ctx.params;
  const body = Body.parse(await req.json());
  const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.id, id));
  if (!row) return json({ error: "Unknown event" }, 404);
  for (const d of body.deliveries) {
    await recordDelivery({ outboxId: id, recruitId: row.recruitId, purpose: d.purpose, recipient: d.recipient, channel: d.channel, dedupeKey: d.dedupeKey, status: d.status, providerRef: d.providerRef, detail: d.detail });
  }
  const failed = body.deliveries.filter((d) => d.status === "failed");
  if (failed.length) {
    return json({ result: await completeOutbox(id, false, failed.map((d) => `${d.channel}: ${d.detail ?? "failed"}`).join("; ")) });
  }
  if (row.status !== "claimed") return json({ result: row.status });
  return json({ result: await settleOutbox(row) });
});

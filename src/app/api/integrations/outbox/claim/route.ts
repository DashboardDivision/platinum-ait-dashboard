import { handle, json, requireIntegrationToken } from "@/server/http";
import { claimBatch } from "@/server/outbox";
import { alreadySent, buildMessages, settleOutbox } from "@/server/messages";

/**
 * n8n polls this. Each event comes back with fully rendered messages for
 * recipients resolved right now. Messages already sent are left out, so a
 * retried event never re-sends to someone who already got it, and texts in
 * quiet hours are held back until the window opens.
 */
export const POST = handle(async (req: Request) => {
  requireIntegrationToken(req);
  const rows = await claimBatch(20);
  const events = [];
  for (const row of rows) {
    const messages = await buildMessages(row);
    const sent = await alreadySent(messages.map((m) => m.dedupeKey));
    const ready = messages.filter((m) => !sent.has(m.dedupeKey) && !m.deferUntilWindow);
    if (!ready.length) {
      await settleOutbox(row);
      continue;
    }
    events.push({ id: row.id, eventType: row.eventType, recruitId: row.recruitId, messages: ready });
  }
  return json({ events });
});

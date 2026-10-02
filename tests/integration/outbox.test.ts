import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { enqueue } from "@/server/outbox";
import { nextSmsWindowStart } from "@/domain/durations";
import { POST as claim } from "@/app/api/integrations/outbox/claim/route";
import { POST as result } from "@/app/api/integrations/outbox/[id]/result/route";

const auth = { authorization: `Bearer ${process.env.INTEGRATION_TOKEN}`, "content-type": "application/json" };
type Msg = { to: string; channel: "email" | "sms"; dedupeKey: string; purpose: string };

async function claimNow() {
  const res = await claim(new Request("http://x/api/integrations/outbox/claim", { method: "POST", headers: auth }));
  return ((await res.json()) as { events: { id: string; messages: Msg[] }[] }).events;
}
async function report(id: string, m: Msg, status: "sent" | "failed") {
  const body = JSON.stringify({ deliveries: [{ dedupeKey: m.dedupeKey, recipient: m.to, channel: m.channel, purpose: m.purpose, status, detail: status === "failed" ? "smtp timeout" : null }] });
  const res = await result(new Request(`http://x/api/integrations/outbox/${id}/result`, { method: "POST", headers: auth, body }), { params: Promise.resolve({ id }) });
  return ((await res.json()) as { result: string }).result;
}
async function statusOf(id: string) {
  const [r] = await db.select().from(schema.outbox).where(eq(schema.outbox.id, id));
  return r;
}

describe("outbox delivery reports from n8n", () => {
  beforeEach(async () => {
    await resetDb();
    await db.insert(schema.user).values([
      { id: "a1", name: "Admin One", email: "one@example.com", role: "admin" },
      { id: "a2", name: "Admin Two", email: "two@example.com", role: "admin" },
    ]);
  });

  it("rejects calls without the integration token", async () => {
    const res = await claim(new Request("http://x", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("finishes an event only after every recipient is reported sent", async () => {
    await enqueue(db, { eventType: "admin_alert", dedupeKey: "alert:x", payload: { kind: "test" } });
    const [ev] = await claimNow();
    expect(ev.messages.map((m) => m.to).sort()).toEqual(["one@example.com", "two@example.com"]);
    expect(await report(ev.id, ev.messages[0], "sent")).toBe("waiting");
    expect((await statusOf(ev.id)).status).toBe("claimed");
    expect(await report(ev.id, ev.messages[1], "sent")).toBe("done");
    expect((await statusOf(ev.id)).status).toBe("done");
  });

  it("retries a failure without re-sending to the recipient who already got it", async () => {
    await enqueue(db, { eventType: "admin_alert", dedupeKey: "alert:y", payload: { kind: "test" } });
    const [ev] = await claimNow();
    const [first, second] = ev.messages;
    await report(ev.id, first, "sent");
    expect(await report(ev.id, second, "failed")).toBe("retry");
    const row = await statusOf(ev.id);
    expect(row.status).toBe("pending");
    expect(row.lastError).toContain("smtp timeout");
    await db.update(schema.outbox).set({ availableAt: new Date() }).where(eq(schema.outbox.id, ev.id));
    const [again] = await claimNow();
    expect(again.messages.map((m) => m.to)).toEqual([second.to]);
    expect(await report(again.id, again.messages[0], "sent")).toBe("done");
  });

  it("puts quiet-hours texts off until 8 am Denver", () => {
    const lateNight = new Date("2026-10-03T05:30:00Z"); // 11:30 pm MDT
    expect(nextSmsWindowStart(lateNight).toISOString()).toBe("2026-10-03T14:00:00.000Z");
    const midday = new Date("2026-10-03T18:00:00Z");
    expect(nextSmsWindowStart(midday)).toBe(midday);
  });
});

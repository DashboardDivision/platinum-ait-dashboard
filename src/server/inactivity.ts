import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { enqueue } from "./outbox";
import { getSetting } from "./settings";

/** Reminds active, ungraduated recruits with no real activity for N days. One reminder per inactivity window. */
export async function scanInactivity(now = new Date()) {
  const days = await getSetting("inactivityDays");
  const cutoff = new Date(+now - days * 86_400_000);
  const rows = await db
    .select()
    .from(schema.recruit)
    .where(and(eq(schema.recruit.status, "active"), isNull(schema.recruit.graduatedAt), or(lt(schema.recruit.lastActivityAt, cutoff), and(isNull(schema.recruit.lastActivityAt), lt(schema.recruit.accountCreatedAt, cutoff)))));
  let queued = 0;
  for (const r of rows) {
    if (!r.userId) continue;
    const since = (r.lastActivityAt ?? r.accountCreatedAt ?? r.enrollmentAt).toISOString().slice(0, 10);
    const id = await enqueue(db, { eventType: "inactivity_reminder", dedupeKey: `inactive:${r.id}:${since}`, recruitId: r.id, payload: { days } });
    if (id) queued++;
  }
  return { checked: rows.length, queued };
}

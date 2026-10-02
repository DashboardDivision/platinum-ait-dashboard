/**
 * Fills a DEMO database with fictitious recruits at every stage.
 * Refuses to run unless APP_ENV=demo. Never point this at the production database.
 * Every demo recruit's starter password is the fake phone number shown below; demo admin credentials are printed once.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../src/db";
import { auth } from "../src/lib/auth";
import { env } from "../src/lib/env";
import { provisionFromTwenty } from "../src/server/provisioning";
import { markReadyToSchedule, recordExamClick, recordStudyClick, startTraining } from "../src/server/recruit-actions";
import { reviewDocument, uploadDocument } from "../src/server/documents";
import { approveExternalContract } from "../src/server/contracts";
import { recomputeProduction, upsertPolicy } from "../src/server/production";
import { completeStageTx } from "../src/server/stages";
import type { CurrentUser } from "../src/server/session";

if (env().APP_ENV !== "demo") {
  console.error("Refusing to seed: APP_ENV must be 'demo'.");
  process.exit(1);
}
const [{ count }] = (await pool.query<{ count: number }>("select count(*)::int as count from recruit")).rows;
if (count > 0) {
  console.error("Refusing to seed: the demo database already has recruits.");
  await pool.end();
  process.exit(1);
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");
const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
const dayStr = (d: number) => new Date(Date.now() - d * day).toISOString().slice(0, 10);

const adminPassword = randomBytes(12).toString("base64url");
const adminId = randomUUID();
await db.insert(schema.user).values({ id: adminId, name: "Demo Admin", email: "admin@demo.invalid", role: "admin" });
await db.insert(schema.account).values({ id: randomUUID(), accountId: adminId, providerId: "credential", userId: adminId, password: await (await auth().$context).password.hash(adminPassword) });

const people = [
  ["Avery Demo", 2, 1], ["Jordan Sample", 9, 2], ["Riley Example", 16, 3], ["Morgan Testcase", 25, 4],
  ["Quinn Placeholder", 40, 5], ["Taylor Fictional", 70, 6], ["Casey Notreal", 120, 7], ["Drew Missingphone", 3, 0],
] as const;

for (const [i, [name, startedDaysAgo, depth]] of people.entries()) {
  const phone = depth === 0 ? null : `801555${String(100 + i).padStart(4, "0")}`;
  const email = `${name.split(" ")[0].toLowerCase()}@demo.invalid`;
  await provisionFromTwenty({ workspaceId: "demo", object: "platinumAit", recordId: `demo-${i}`, eventId: `demo-${i}`, record: { name, email, phone, createdAt: ago(startedDaysAgo) } });
  if (depth < 2) continue;
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.twentyRecordId, `demo-${i}`));
  const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId!));
  const me: CurrentUser = { id: u.id, email: u.email, name: u.name, role: "recruit", mustChangePassword: false, impersonatedBy: null, sessionCreatedAt: new Date() };
  await db.update(schema.user).set({ mustChangePassword: false }).where(eq(schema.user.id, u.id));
  await db.transaction((tx) => completeStageTx(tx, r.id, 1, new Date(ago(startedDaysAgo - 1)), { source: "demo_seed" }, null));
  await db.update(schema.recruit).set({ firstLoginAt: new Date(ago(startedDaysAgo - 1)), initialPasswordChangedAt: new Date(ago(startedDaysAgo - 1)) }).where(eq(schema.recruit.id, r.id));
  if (depth < 3) continue;
  await recordStudyClick(me, env().EDUCATION_URL);
  await markReadyToSchedule(me);
  if (depth < 4) continue;
  await recordExamClick(me);
  const doc = await uploadDocument(me, { recruitId: r.id, kind: "exam_result", fileName: "exam-results.pdf", data: PDF, state: "UT", examDate: dayStr(3) });
  if (depth < 5) continue;
  await reviewDocument(adminId, doc.id, "approve", null);
  if (depth < 6) continue;
  const contract = await uploadDocument({ ...me, id: adminId, role: "admin" }, { recruitId: r.id, kind: "contract_external", fileName: "contract.pdf", data: PDF });
  await approveExternalContract(adminId, r.id, contract.id, dayStr(20), "Demo contract");
  await startTraining(me);
  const premiums = depth === 7 ? [9_000_000, 8_000_000, 9_500_000] : [1_850_000, 800_000];
  for (const [n, cents] of premiums.entries()) {
    await upsertPolicy({ recruitId: r.id, source: "admin", externalRef: `DEMO-${i}-${n}`, policyType: n ? "Home" : "Auto", carrier: "Demo Mutual", businessType: "new", writtenDate: dayStr(10 - n), effectiveDate: null, termMonths: 12, termPremiumCents: cents, annualizedCents: null, status: "approved" }, adminId);
  }
  await recomputeProduction(r.id);
}

// Demo has no n8n: mark queued messages as handled so nothing is ever sent from demo data.
await db.update(schema.outbox).set({ status: "done" });
await pool.end();
console.log("Demo data loaded. Recruit starter passwords are their fake 801-555 numbers.");
console.log(`Demo admin: admin@demo.invalid / ${adminPassword} (shown once)`);

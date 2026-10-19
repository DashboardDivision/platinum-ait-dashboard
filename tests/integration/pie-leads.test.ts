import "./helpers";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

// Stand-ins for Twenty's REST API and the study site's provisioning endpoint, set before env() is first read.
const PORT = 48_789;
const EDU_PORT = 48_790;
process.env.TWENTY_URL = `http://127.0.0.1:${PORT}`;
process.env.TWENTY_API_KEY = "twenty-test-key-0123456789abcdef";
process.env.TWENTY_WORKSPACE_ID = "ws";
process.env.EDUCATION_PROVISION_URL = `http://127.0.0.1:${EDU_PORT}/internal/provision`;
process.env.EDUCATION_PROVISION_TOKEN = "edu-provision-token-for-tests-0123456789";

import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { createAitFromPieLead, listPieLeads } from "@/server/pie-leads";
import { provisionFromTwenty } from "@/server/provisioning";
import { buildMessages } from "@/server/messages";
import { putSetting } from "@/server/settings";
import { HttpError, type CurrentUser } from "@/server/session";

const PIE_LEAD = "aaaaaaaa-1111-4111-8111-111111111111";
const LIST_LEAD = "bbbbbbbb-2222-4222-8222-222222222222";
const recruiting: Record<string, Record<string, unknown>> = {
  [PIE_LEAD]: { id: PIE_LEAD, name: "Riley Park", createdAt: "2026-10-08T15:00:00Z", sourceSystem: "PIE", sourceRecordId: "pie-user-77", states: "UT, ID", recruiter: "COLTON", emails: { primaryEmail: "Riley.Park@Example.com" }, phones: { primaryPhoneNumber: "8015550188", primaryPhoneCallingCode: "+1" } },
  [LIST_LEAD]: { id: LIST_LEAD, name: "Top 200 Agent", sourceSystem: "Top 200 PDF Checklists", sourceRecordId: "PHX-0001", emails: { primaryEmail: "agent@example.com" }, phones: { primaryPhoneNumber: "4805550100" } },
};
const aits: Record<string, Record<string, unknown>> = {};
const eduCalls: unknown[] = [];
let twentyServer: Server;
let eduServer: Server;

beforeAll(async () => {
  twentyServer = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const [, , plural, id] = url.pathname.split("/");
    const filter = url.searchParams.get("filter") ?? "";
    res.setHeader("content-type", "application/json");
    if (plural === "platinumAits") {
      if (req.method === "POST") {
        let raw = ""; for await (const c of req) raw += c;
        const rec = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...JSON.parse(raw) };
        aits[rec.id] = rec;
        res.writeHead(201).end(JSON.stringify({ data: { createPlatinumAit: rec } }));
        return;
      }
      const email = /primaryEmail\[ilike\]:"([^"%]+)"/.exec(filter)?.[1]?.toLowerCase();
      const rows = Object.values(aits).filter((r) => String((r.emails as { primaryEmail?: string }).primaryEmail).toLowerCase() === email);
      res.writeHead(200).end(JSON.stringify({ data: { platinumAits: rows } }));
      return;
    }
    if (id) {
      const r = recruiting[id];
      res.writeHead(r ? 200 : 404).end(JSON.stringify(r ? { data: { platinumRecruiting: r } } : { error: "nf" }));
      return;
    }
    // Real Twenty filter syntax; anything else would be ignored by Twenty and return every lead.
    const source = /^sourceSystem\[eq\]:"([^"]+)"$/.exec(filter)?.[1];
    const rows = Object.values(recruiting).filter((r) => !source || r.sourceSystem === source);
    res.writeHead(200).end(JSON.stringify({ data: { platinumRecruitings: rows } }));
  });
  eduServer = createServer((req, res) => { eduCalls.push(req.url); res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ status: "created", userId: "new-study-user" })); });
  await new Promise<void>((r) => twentyServer.listen(PORT, "127.0.0.1", r));
  await new Promise<void>((r) => eduServer.listen(EDU_PORT, "127.0.0.1", r));
});
afterAll(async () => {
  await new Promise<void>((r) => twentyServer.close(() => r()));
  await new Promise<void>((r) => eduServer.close(() => r()));
});

const admin: CurrentUser = { id: "admin-1", email: "boss@platinum.test", name: "Boss", role: "admin", mustChangePassword: false, impersonatedBy: null, sessionCreatedAt: new Date() };

async function welcomeFor(recruitId: string) {
  const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `welcome:${recruitId}`));
  expect(row).toBeTruthy();
  return buildMessages(row);
}

describe("Create AIT dashboard from a PIE signup", () => {
  beforeEach(async () => {
    await resetDb();
    await db.insert(schema.user).values({ id: "admin-1", name: "Boss", email: "boss@platinum.test", role: "admin" });
    await putSetting("smsEnabled", true, "admin-1");
    for (const k of Object.keys(aits)) delete aits[k];
    eduCalls.length = 0;
  });

  it("lists only PIE signups, newest first, with no AIT dashboard yet", async () => {
    const leads = await listPieLeads();
    expect(leads).toEqual([{ leadId: PIE_LEAD, name: "Riley Park", email: "riley.park@example.com", phone: "+18015550188", state: "UT", signedUpAt: "2026-10-08T15:00:00Z", recruitId: null }]);
  });

  it("creates the dashboard, links the existing study account, and welcomes by email only", async () => {
    const recruitId = await createAitFromPieLead(admin, PIE_LEAD);

    const [ait] = Object.values(aits);
    expect(ait).toMatchObject({ name: "Riley Park", stage: "APPLICANT", sourceSystem: "PIE", sourceRecordId: PIE_LEAD, recruiter: "COLTON",
      emails: { primaryEmail: "riley.park@example.com" }, phones: { primaryPhoneNumber: "8015550188" } });

    const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.id, recruitId));
    expect(r).toMatchObject({ source: "pie", email: "riley.park@example.com", phoneE164: "+18015550188" });
    expect(r.userId).toBeTruthy();
    const prov = await db.select().from(schema.provisioning).where(eq(schema.provisioning.recruitId, recruitId));
    expect(prov.find((p) => p.system === "dashboard")).toMatchObject({ status: "ready" });
    expect(prov.find((p) => p.system === "education")).toMatchObject({ status: "ready", linkedExisting: true, externalAccountId: "pie-user-77" });
    expect(eduCalls).toHaveLength(0); // no new study account

    // Even with texting on and SMS consent recorded, the PIE welcome is email only.
    await db.insert(schema.consent).values({ recruitId, channel: "sms", granted: true, source: "test" });
    const msgs = await welcomeFor(recruitId);
    expect(msgs.map((m) => m.channel)).toEqual(["email"]);
    expect(msgs[0].to).toBe("riley.park@example.com");
    expect(msgs[0].text).toContain("Your Platinum AIT dashboard and P&C study accounts are ready.");
    expect(msgs[0].text).toContain("Dashboard: your temporary password is your phone number");
    expect(msgs[0].text).toContain("Study site: you already had an account there, so use your existing study password");

    expect((await listPieLeads())[0].recruitId).toBe(recruitId);
    await expect(createAitFromPieLead(admin, PIE_LEAD)).rejects.toMatchObject({ status: 409 });
    expect(Object.values(aits)).toHaveLength(1);
  });

  it("still texts the welcome to other recruits who opted in", async () => {
    const out = await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "intake-1", eventId: "e1",
      record: { name: "Casey Intake", email: "casey@example.com", phone: "8015550199", stage: "APPLICANT", createdAt: new Date().toISOString() } });
    await db.insert(schema.consent).values({ recruitId: out.recruitId!, channel: "sms", granted: true, source: "test" });
    expect((await welcomeFor(out.recruitId!)).map((m) => m.channel).sort()).toEqual(["email", "sms"]);
  });

  it("refuses leads that aren't PIE signups", async () => {
    await expect(createAitFromPieLead(admin, LIST_LEAD)).rejects.toBeInstanceOf(HttpError);
    await expect(createAitFromPieLead(admin, "not-an-id")).rejects.toMatchObject({ status: 400 });
    expect(Object.values(aits)).toHaveLength(0);
  });
});

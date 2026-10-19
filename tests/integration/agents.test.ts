import "./helpers";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

// Stand-in for Twenty's REST API, set before env() is first read.
const PORT = 48_788;
process.env.TWENTY_URL = `http://127.0.0.1:${PORT}`;
process.env.TWENTY_API_KEY = "twenty-test-key-0123456789abcdef";
process.env.TWENTY_WORKSPACE_ID = "ws";

import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { createTwentyContact, inviteAgent, listTwentyContacts, markAgentStep, setAgentStatus, undoAgentStep, agentOverview } from "@/server/agents";
import { provisionFromTwenty } from "@/server/provisioning";
import { changePassword } from "@/server/account";
import { buildMessages } from "@/server/messages";
import { listRecruits, summaryCounts } from "@/server/admin-queries";
import type { CurrentUser } from "@/server/session";

const records: Record<string, Record<string, unknown>> = {
  "11111111-1111-4111-8111-111111111111": { id: "11111111-1111-4111-8111-111111111111", name: "Dana Cole", emails: { primaryEmail: "Dana.Cole@Example.com" }, phones: { primaryPhoneNumber: "8015550177", primaryPhoneCallingCode: "+1" }, recruiter: "JESSE", stage: "NEW_LEAD", currentOrganization: "Cole Insurance" },
  "22222222-2222-4222-8222-222222222222": { id: "22222222-2222-4222-8222-222222222222", name: "Rivera Agency", ownerName: "Jamie Rivera", emails: { primaryEmail: "jamie.rivera@example.com" }, phones: { primaryPhoneNumber: "8015550142", primaryPhoneCallingCode: "+1" }, recruiter: "COLTON", stage: "IDENTIFIED" },
  "33333333-3333-4333-8333-333333333333": { id: "33333333-3333-4333-8333-333333333333", name: "No Phone", emails: { primaryEmail: "nophone@example.com" }, phones: { primaryPhoneNumber: "" } },
};
let server: Server;
const posted: { plural: string; rec: Record<string, unknown> }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const [, , plural, id] = url.pathname.split("/");
    const singular = plural === "platinumLegacies" ? "platinumLegacy" : "platinumRecruiting";
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      const rec = { id: crypto.randomUUID(), ...JSON.parse(raw) };
      records[rec.id] = rec;
      posted.push({ plural, rec });
      res.writeHead(201).end(JSON.stringify({ data: { [`create${singular[0].toUpperCase()}${singular.slice(1)}`]: rec } }));
      return;
    }
    const emailFilter = /primaryEmail\[ilike\]:"([^"%]+)"/.exec(url.searchParams.get("filter") ?? "")?.[1];
    if (emailFilter && !id) {
      const rows = Object.values(records).filter((r) => String((r.emails as { primaryEmail?: string })?.primaryEmail ?? "").toLowerCase() === emailFilter.toLowerCase());
      res.writeHead(200).end(JSON.stringify({ data: { [plural]: rows }, totalCount: rows.length, pageInfo: { hasNextPage: false } }));
      return;
    }
    if (id) {
      const r = records[id];
      res.writeHead(r ? 200 : 404).end(JSON.stringify(r ? { data: { [singular]: r } } : { error: "nf" }));
    } else {
      const rows = Object.values(records);
      res.writeHead(200).end(JSON.stringify({ data: { [plural]: rows }, totalCount: rows.length, pageInfo: { hasNextPage: false } }));
    }
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const admin: CurrentUser = { id: "admin-1", email: "boss@platinum.test", name: "Boss", role: "admin", mustChangePassword: false, impersonatedBy: null, sessionCreatedAt: new Date() };

describe("Operation Free Agent and Agency Group Sell", () => {
  beforeEach(async () => {
    await resetDb();
    await db.insert(schema.user).values([
      { id: "admin-1", name: "Boss", email: "boss@platinum.test", role: "admin" },
      { id: "admin-2", name: "Jesse", email: "jesse@platinum.test", role: "admin" },
    ]);
  });

  it("reads Twenty, sends a login with the phone starter password, and emails a branded welcome", async () => {
    const list = await listTwentyContacts("group_sell", {});
    expect(list.rows.find((r) => r.id.startsWith("2222"))).toMatchObject({ name: "Jamie Rivera", organization: "Rivera Agency", recruiter: "COLTON" });

    const id = await inviteAgent(admin, "free_agent", "11111111-1111-4111-8111-111111111111");
    const o = (await agentOverview(id))!;
    expect(o.agent).toMatchObject({ program: "free_agent", email: "dana.cole@example.com", recruiter: "JESSE", welcomeStatus: "queued" });
    expect(o.current).toBe(1);
    expect(o.adminCurrent).toBe(0); // recruiters see Step 0 until the email is delivered
    await db.update(schema.agent).set({ welcomeStatus: "sent" }).where(eq(schema.agent.id, id));
    expect((await agentOverview(id))!.adminCurrent).toBe(1);
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, o.agent.userId!));
    expect(u).toMatchObject({ role: "captive_lead", mustChangePassword: true });

    const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "agent_welcome"));
    const [m] = await buildMessages(row);
    expect(m.to).toBe("dana.cole@example.com");
    expect(m.subject).toBe("Your Operation Free Agent dashboard is ready");
    expect(m.text.startsWith("Hi, Dana\n")).toBe(true);
    expect(m.text).toContain("Your temporary password is your phone number, numbers only.");
    expect(m.text).toContain("Your recruiter: Jesse");
    expect(m.text).not.toMatch(/study|insurance\.getstrategic/i);
    expect(m.html).toContain("platinum-logo");

    // Agents never appear in the AIT program.
    expect((await listRecruits({}, new Date())).rows).toHaveLength(0);
    expect((await summaryCounts()).active).toBe(0);

    await expect(inviteAgent(admin, "free_agent", "33333333-3333-4333-8333-333333333333")).rejects.toThrow(/U.S. phone/);
  });

  it("keeps one email in one program", async () => {
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "ait-1", eventId: "e1", record: { name: "Jamie Rivera", email: "jamie.rivera@example.com", phone: "801-555-0142", createdAt: "2026-10-06T10:00:00Z" } });
    await expect(inviteAgent(admin, "group_sell", "22222222-2222-4222-8222-222222222222")).rejects.toThrow(/already has an AIT dashboard login/);
  });

  it("completes step 1 at the first password change, then recruiters mark steps in order and every admin is emailed", async () => {
    const id = await inviteAgent(admin, "group_sell", "22222222-2222-4222-8222-222222222222");
    const res = await auth().api.signInEmail({ body: { email: "jamie.rivera@example.com", password: "8015550142" }, returnHeaders: true });
    const headers = new Headers({ cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") });
    const userId = (await agentOverview(id))!.agent.userId!;
    await changePassword({ userId, currentPassword: "8015550142", newPassword: "Jamie-agency-77", headers, impersonatedBy: null });
    expect((await agentOverview(id))!.current).toBe(2);

    const [s1] = await db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `agent_step:${id}:1`));
    const notices = await buildMessages(s1);
    expect(notices.map((n) => n.to).sort()).toEqual(["boss@platinum.test", "jesse@platinum.test"]);
    expect(notices[0]).toMatchObject({ required: true, subject: "[Group Sell] Jamie Rivera completed Step 1: Login to your dashboard" });
    expect(notices[0].text).toContain(`/admin/agents/${id}`);

    await expect(markAgentStep(admin, id, 3, null)).rejects.toThrow(/Step 2 comes first/);
    await markAgentStep(admin, id, 2, "Call held");
    await markAgentStep(admin, id, 3, null);
    expect((await agentOverview(id))!.current).toBe(4);
    await undoAgentStep(admin, id, "Marked too early");
    expect((await agentOverview(id))!.current).toBe(3);
    expect(await db.select().from(schema.outbox).where(and(eq(schema.outbox.dedupeKey, `agent_step:${id}:3`)))).toHaveLength(0);

    await setAgentStatus(admin, id, "archived", "Deal paused");
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
    expect(u.banned).toBe(true);
    await expect(markAgentStep(admin, id, 3, null)).rejects.toThrow(/Reactivate/);
  });

  it("'+ Add New' creates the contact in the right Twenty object, blocks duplicates, and can send the login", async () => {
    const fa = await createTwentyContact(admin, "free_agent", { name: "Morgan Lee", organization: "", email: "Morgan.Lee@example.com", phone: "801-555-0190", recruiter: "parker" });
    expect(posted.at(-1)).toMatchObject({ plural: "platinumRecruitings", rec: { name: "Morgan Lee", stage: "NEW_LEAD", recruiter: "PARKER", emails: { primaryEmail: "morgan.lee@example.com" }, phones: { primaryPhoneNumber: "8015550190" } } });
    await expect(createTwentyContact(admin, "free_agent", { name: "Morgan Lee", organization: "", email: "morgan.lee@example.com", phone: "", recruiter: "" })).rejects.toThrow(/already has a contact/);
    const id = await inviteAgent(admin, "free_agent", fa);
    expect((await agentOverview(id))!.agent).toMatchObject({ fullName: "Morgan Lee", recruiter: "PARKER" });

    await createTwentyContact(admin, "group_sell", { name: "Pat Owner", organization: "Owner Insurance LLC", email: "pat@owner.example", phone: "", recruiter: "JESSE" });
    expect(posted.at(-1)).toMatchObject({ plural: "platinumLegacies", rec: { name: "Owner Insurance LLC", ownerName: "Pat Owner", stage: "IDENTIFIED", recruiter: "JESSE" } });
    expect(posted.at(-1)!.rec.phones).toBeUndefined();
    await expect(createTwentyContact(admin, "group_sell", { name: "Pat Owner", organization: "", email: "x@y.example", phone: "", recruiter: "" })).rejects.toThrow(/agency name/);
    await expect(createTwentyContact(admin, "free_agent", { name: "Solo", organization: "", email: "solo@y.example", phone: "", recruiter: "" })).rejects.toThrow(/first and last/);
  });
});

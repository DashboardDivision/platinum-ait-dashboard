import "./helpers";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

const PORT = 48_789;
process.env.TWENTY_URL = `http://127.0.0.1:${PORT}`;
process.env.TWENTY_API_KEY = "twenty-test-key-0123456789abcdef";
process.env.TWENTY_WORKSPACE_ID = "ws";

import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { provisionFromTwenty } from "@/server/provisioning";
import { saveTwentyDetails, fromDenverLocal, toDenverLocal } from "@/server/twenty-edit";
import { buildMessages } from "@/server/messages";
import { permsForRole } from "@/server/permissions";
import { listAudit } from "@/server/users";
import type { CurrentUser } from "@/server/session";

const F = (name: string, type: string, label = name, extra: Record<string, unknown> = {}) => ({ name, type, label, isActive: true, isNullable: true, ...extra });
const META = [
  { namePlural: "platinumAits", fields: [
    F("name", "TEXT", "Candidate Name"), F("emails", "EMAILS", "Email"), F("phones", "PHONES", "Phone"),
    F("stage", "SELECT", "Stage", { isNullable: false, options: [{ value: "APPLICANT", label: "Applicant", position: 0 }, { value: "ENROLLED", label: "Enrolled", position: 1 }] }),
    F("interviewRating", "NUMBER", "Interview Rating"), F("interviewDate", "DATE_TIME", "Interview Date"), F("examDate", "DATE", "Exam Date"),
    F("followUpDue", "BOOLEAN", "Follow-up Due"), F("notes", "RICH_TEXT", "AIT Notes"), F("sourceSystem", "TEXT", "Source System"),
    F("automationStatus", "SELECT", "Automation Status"), F("id", "UUID", "Id", { isSystem: true }),
  ] },
  { namePlural: "platinumLegacies", fields: [F("name", "TEXT", "Agency Name"), F("ownerName", "TEXT", "Owner Name"), F("emails", "EMAILS", "Email"), F("phones", "PHONES", "Phone"), F("askingPrice", "CURRENCY", "Asking Price"),
    F("recruiter", "SELECT", "Recruiter", { options: [{ value: "COLTON", label: "Colton" }, { value: "JESSE", label: "Jesse" }] })] },
];
const records: Record<string, Record<string, unknown>> = {};
const patches: { path: string; body: Record<string, unknown> }[] = [];
let failPatch = false;
let server: Server;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/rest/metadata/objects") return res.writeHead(200).end(JSON.stringify({ data: { objects: META } }));
    const [, , plural, id] = url.pathname.split("/");
    const singular = plural === "platinumLegacies" ? "platinumLegacy" : "platinumAit";
    if (req.method === "PATCH") {
      let raw = ""; for await (const c of req) raw += c;
      if (failPatch) return res.writeHead(400).end(JSON.stringify({ messages: ["nope"] }));
      const body = JSON.parse(raw); patches.push({ path: url.pathname, body });
      Object.assign(records[id], body);
      return res.writeHead(200).end(JSON.stringify({ data: { [`update${singular}`]: records[id] } }));
    }
    const r = records[id];
    res.writeHead(r ? 200 : 404).end(JSON.stringify(r ? { data: { [singular]: r } } : {}));
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const REC = "11111111-1111-4111-8111-111111111111";
const staff = async (roleKey: string): Promise<CurrentUser> => ({ id: "admin-1", email: "boss@platinum.test", name: "Boss", role: "admin", roleKey, perms: await permsForRole(roleKey), mustChangePassword: false, impersonatedBy: null, sessionCreatedAt: new Date() });

describe("editing prospects' Twenty records from the dashboard", () => {
  beforeEach(async () => {
    await resetDb();
    patches.length = 0; failPatch = false;
    records[REC] = { id: REC, name: "Casey Morgan", emails: { primaryEmail: "casey@example.com", additionalEmails: [] }, phones: { primaryPhoneNumber: "8015550100", primaryPhoneCountryCode: "US", primaryPhoneCallingCode: "+1", additionalPhones: [] },
      stage: "APPLICANT", interviewRating: null, interviewDate: null, examDate: null, followUpDue: false, notes: { markdown: "", blocknote: null }, sourceSystem: "intake" };
    await db.insert(schema.user).values({ id: "admin-1", name: "Boss", email: "boss@platinum.test", role: "admin" });
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: REC, eventId: "e1", record: { name: "Casey Morgan", email: "casey@example.com", phone: "801-555-0100", createdAt: "2026-10-06T15:00:00Z" } });
  });

  const form = (o: Record<string, string>) => new Map(Object.entries(o));
  const current = () => ({ name: "Casey Morgan", emails: "casey@example.com", phones: "8015550100", stage: "APPLICANT", interviewRating: "", interviewDate: "", examDate: "", followUpDue: "false", notes: "", sourceSystem: "intake" });

  it("sends only changed fields, converts types, and keeps the dashboard copy and login email in step", async () => {
    const [r] = await db.select().from(schema.recruit);
    const admin = await staff("admin");
    expect(await saveTwentyDetails(admin, { kind: "ait", id: r.id }, form(current()))).toBe("Nothing changed.");

    const msg = await saveTwentyDetails(admin, { kind: "ait", id: r.id }, form({
      ...current(), name: "Casey Morgan-Lee", emails: "Casey.New@Example.com", phones: "(801) 555-0199", stage: "ENROLLED",
      interviewRating: "4", interviewDate: "2026-10-20T14:30", examDate: "2026-11-02", followUpDue: "true", notes: "Great call.\nFollow up Friday.", sourceSystem: "hacked",
    }));
    expect(msg).toMatch(/Saved 9 fields to Twenty\. Their sign-in email changed too/);
    const body = patches[0].body;
    expect(Object.keys(body).sort()).toEqual(["emails", "examDate", "followUpDue", "interviewDate", "interviewRating", "name", "notes", "phones", "stage"]);
    expect(body).toMatchObject({ name: "Casey Morgan-Lee", stage: "ENROLLED", interviewRating: 4, examDate: "2026-11-02", followUpDue: true,
      emails: { primaryEmail: "casey.new@example.com" }, phones: { primaryPhoneNumber: "8015550199", primaryPhoneCallingCode: "+1" }, interviewDate: "2026-10-20T20:30:00.000Z" });
    expect((body.notes as { markdown: string }).markdown).toBe("Great call.\nFollow up Friday.");
    expect(JSON.parse((body.notes as { blocknote: string }).blocknote)).toHaveLength(2);

    const [after] = await db.select().from(schema.recruit);
    expect(after).toMatchObject({ fullName: "Casey Morgan-Lee", email: "casey.new@example.com", phoneE164: "+18015550199" });
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId!));
    expect(u.email).toBe("casey.new@example.com");
    const [notice] = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "login_email_changed"));
    expect((await buildMessages(notice)).map((m) => m.to).sort()).toEqual(["casey.new@example.com", "casey@example.com"]);
    const { rows } = await listAudit({ q: "twenty.record_updated" });
    expect((rows[0].metadata as { changes: Record<string, { from: string; to: string }> }).changes.stage).toEqual({ from: "APPLICANT", to: "ENROLLED" });

    // Twenty's own update webhook afterwards finds nothing to review.
    await provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: REC, eventId: "e2", record: { name: "Casey Morgan-Lee", email: "casey.new@example.com", phone: "801-555-0199" } });
    expect(await db.select().from(schema.task).where(eq(schema.task.kind, "contact_fix"))).toHaveLength(0);
  });

  it("rejects bad values and duplicate emails, and rolls back if Twenty refuses", async () => {
    const [r] = await db.select().from(schema.recruit);
    const admin = await staff("admin");
    await expect(saveTwentyDetails(admin, { kind: "ait", id: r.id }, form({ ...current(), interviewRating: "lots", phones: "12" }))).rejects.toThrow(/(?=.*Interview Rating: enter a number)(?=.*Enter a valid phone number)/);
    await db.insert(schema.user).values({ id: "other", name: "Other", email: "taken@example.com", role: "recruit" });
    await expect(saveTwentyDetails(admin, { kind: "ait", id: r.id }, form({ ...current(), emails: "taken@example.com" }))).rejects.toThrow(/already uses that email/);
    await expect(saveTwentyDetails(await staff("admin_readonly"), { kind: "ait", id: r.id }, form({ ...current(), name: "X Y" }))).rejects.toThrow(/doesn't allow/);

    failPatch = true;
    await expect(saveTwentyDetails(admin, { kind: "ait", id: r.id }, form({ ...current(), name: "Changed Name", emails: "changed@example.com" }))).rejects.toThrow(/didn't accept/);
    const [after] = await db.select().from(schema.recruit);
    expect(after).toMatchObject({ fullName: "Casey Morgan", email: "casey@example.com" });
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId!));
    expect(u.email).toBe("casey@example.com");
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "login_email_changed"))).toHaveLength(0);
  });

  it("maps Group Sell owner and agency names, money and recruiter onto the contact", async () => {
    const LID = "22222222-2222-4222-8222-222222222222";
    records[LID] = { id: LID, name: "Rivera Agency", ownerName: "Jamie Rivera", emails: { primaryEmail: "jamie@example.com", additionalEmails: [] }, phones: null, askingPrice: { amountMicros: null, currencyCode: "USD" }, recruiter: null };
    const [a] = await db.insert(schema.agent).values({ program: "group_sell", twentyWorkspaceId: "ws", twentyObject: "platinumLegacy", twentyRecordId: LID, fullName: "Jamie Rivera", organization: "Rivera Agency", email: "jamie@example.com" }).returning();
    await saveTwentyDetails(await staff("master_admin"), { kind: "agent", id: a.id }, form({ name: "Rivera & Sons Agency", ownerName: "Jamie Rivera", emails: "jamie@example.com", phones: "", askingPrice: "1,250,000", recruiter: "JESSE" }));
    expect(patches.at(-1)!.body).toEqual({ name: "Rivera & Sons Agency", askingPrice: { amountMicros: 1_250_000_000_000, currencyCode: "USD" }, recruiter: "JESSE" });
    const [after] = await db.select().from(schema.agent).where(eq(schema.agent.id, a.id));
    expect(after).toMatchObject({ fullName: "Jamie Rivera", organization: "Rivera & Sons Agency", recruiter: "JESSE" });
  });

  it("converts Mountain Time both ways, including daylight saving", () => {
    expect(fromDenverLocal("2026-07-01T09:00")).toBe("2026-07-01T15:00:00.000Z");
    expect(fromDenverLocal("2026-12-01T09:00")).toBe("2026-12-01T16:00:00.000Z");
    expect(toDenverLocal("2026-12-01T16:00:00.000Z")).toBe("2026-12-01T09:00");
  });
});

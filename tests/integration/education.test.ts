import "./helpers";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

// A stand-in for the study site's internal provisioning endpoint. Set before env() is first read.
const PORT = 48_787;
const TOKEN = "edu-provision-token-for-tests-0123456789";
process.env.EDUCATION_PROVISION_URL = `http://127.0.0.1:${PORT}/internal/provision`;
process.env.EDUCATION_PROVISION_TOKEN = TOKEN;

import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { provisionFromTwenty, reconcileProvisioning } from "@/server/provisioning";
import { buildMessages } from "@/server/messages";
import { changePassword } from "@/server/account";
import { markReadyToSchedule, recordExamClick, recordStudyClick, stepBackStage } from "@/server/recruit-actions";
import { deriveState } from "@/domain/stages";
import { loadIntervals } from "@/server/stages";
import { HttpError, type CurrentUser } from "@/server/session";

let mode: "ok" | "fail" = "ok";
const calls: { auth: string | undefined; body: Record<string, string> }[] = [];
let server: Server;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    if (mode === "fail") { res.writeHead(503).end(); return; }
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ status: "created", userId: "pie-user-1", username: "jamie.rivera" }));
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const record = { name: "Jamie Rivera", email: "Jamie.Rivera@Example.com", phone: "(801) 555-0142", stage: "APPLICANT", createdAt: "2026-10-06T16:00:00Z" };
const enroll = (eventId = crypto.randomUUID()) => provisionFromTwenty({ workspaceId: "ws", object: "platinumAit", recordId: "rec-1", eventId, record });

async function welcomeMessage() {
  const [row] = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "welcome"));
  expect(row).toBeTruthy();
  const [m] = await buildMessages(row);
  return m;
}

describe("study-site accounts", () => {
  beforeEach(async () => {
    await resetDb();
    calls.length = 0;
    mode = "ok";
  });

  it("creates the study account with the same email and starter password, then sends one branded welcome", async () => {
    const out = await enroll();
    expect(out).toMatchObject({ dashboard: "ready", education: "ready" });
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].body).toMatchObject({ email: "jamie.rivera@example.com", firstName: "Jamie", lastName: "Rivera", password: "8015550142" });

    await enroll(); // a replayed webhook doesn't call the study site again or re-queue the welcome
    expect(calls).toHaveLength(1);
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "welcome"))).toHaveLength(1);

    const m = await welcomeMessage();
    expect(m.text.startsWith("Hi, Jamie\n")).toBe(true);
    expect(m.text).toContain("Username: jamie.rivera@example.com (your email, for both sites)");
    expect(m.text).toContain("Your temporary password is your phone number, numbers only. Change it when you first sign in to each site.");
    expect(m.text).toContain("P&C study site: https://insurance.getstrategic.vip/#/login");
    expect(m.text).not.toContain("Sign up");
    expect(m.text).not.toContain("8015550142");
    expect(m.html).toContain("/brand/platinum-logo-transparent.png");
    expect(m.html!.indexOf("platinum-logo")).toBeLessThan(m.html!.indexOf("Hi, Jamie"));
  });

  it("doesn't hold the welcome when the study site is down, and retries on the hourly reconcile", async () => {
    mode = "fail";
    const out = await enroll();
    expect(out).toMatchObject({ dashboard: "ready", education: "failed" });
    const m = await welcomeMessage();
    expect(m.text).toContain("Create your study account there with the Sign up link");
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "admin_alert"))).toHaveLength(1);

    mode = "ok";
    const results = await reconcileProvisioning();
    expect(Object.values(results)).toContain("ready");
    const [edu] = await db.select().from(schema.provisioning).where(eq(schema.provisioning.system, "education"));
    expect(edu).toMatchObject({ status: "ready", externalAccountId: "pie-user-1" });
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "welcome"))).toHaveLength(1);
  });

  it("lets a recruit step back from Stage 3 or 4 until they've moved on", async () => {
    await enroll();
    const [r] = await db.select().from(schema.recruit);
    const res = await auth().api.signInEmail({ body: { email: "jamie.rivera@example.com", password: "8015550142" }, returnHeaders: true });
    const headers = new Headers({ cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") });
    await changePassword({ userId: r.userId!, currentPassword: "8015550142", newPassword: "Jamie-new-pass-77", headers, impersonatedBy: null });
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId!));
    const me: CurrentUser = { id: u.id, email: u.email, name: u.name, role: "recruit", mustChangePassword: false, impersonatedBy: null, sessionCreatedAt: new Date() };
    const stage = async () => deriveState(await loadIntervals(db, r.id)).currentStage;

    await recordStudyClick(me, "https://insurance.getstrategic.vip");
    await markReadyToSchedule(me);
    expect(await stage()).toBe(3);
    await expect(stepBackStage({ ...me, impersonatedBy: "admin-1" })).rejects.toBeInstanceOf(HttpError);

    await stepBackStage(me);
    expect(await stage()).toBe(2);
    const [after] = await db.select().from(schema.recruit);
    expect(after.readyToScheduleAt).toBeNull();
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `stage_completed:${r.id}:2`))).toHaveLength(0);
    expect((await loadIntervals(db, r.id)).filter((i) => !i.completedAt)).toHaveLength(1);

    await markReadyToSchedule(me);
    expect(await stage()).toBe(3);

    // Stage 4 -> 3: undo an accidental exam-scheduling click, until proof is uploaded.
    await recordExamClick(me);
    expect(await stage()).toBe(4);
    await stepBackStage(me);
    expect(await stage()).toBe(3);
    expect((await db.select().from(schema.recruit))[0].examLinkClickedAt).toBeNull();
    await recordExamClick(me);
    expect(await stage()).toBe(4);
    await db.insert(schema.document).values({ recruitId: r.id, kind: "exam_result", storageKey: "k1", originalName: "r.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "x" });
    await expect(stepBackStage(me)).rejects.toThrow(/already uploaded results/);
  });
});

import "./helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";
import { db, schema } from "@/db";
import { auth } from "@/lib/auth";
import { provisionFromTwenty, retryDashboardProvisioning, type TwentyRecruitInput } from "@/server/provisioning";

const base = (over: Partial<TwentyRecruitInput["record"]> = {}, eventId = crypto.randomUUID(), recordId = "rec-1"): TwentyRecruitInput => ({
  workspaceId: "ws-life-crm",
  object: "platinumAit",
  recordId,
  eventId,
  record: { name: "Jamie Rivera", email: "Jamie.Rivera@Example.com", phone: "(801) 555-0142", stage: "APPLICANT", createdAt: "2026-09-01T16:00:00Z", ...over },
});

async function signIn(email: string, password: string) {
  try {
    const r = await auth().api.signInEmail({ body: { email, password } });
    return Boolean(r?.user);
  } catch {
    return false;
  }
}

describe("Twenty → dashboard provisioning", () => {
  beforeEach(resetDb);

  it("creates exactly one recruit account with email username and phone-number starter password", async () => {
    const out = await provisionFromTwenty(base());
    expect(out.dashboard).toBe("ready");
    expect(out.education).toBe("unavailable");
    const users = await db.select().from(schema.user);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "jamie.rivera@example.com", role: "recruit", mustChangePassword: true, emailVerified: false });
    expect(await signIn("jamie.rivera@example.com", "8015550142")).toBe(true);
    expect(await signIn("jamie.rivera@example.com", "wrong-password")).toBe(false);
    const welcome = await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "welcome"));
    expect(welcome).toHaveLength(1);
    expect(JSON.stringify(welcome[0].payload)).not.toContain("8015550142");
    const stages = await db.select().from(schema.stageInterval);
    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe(1);
  });

  it("dedupes repeated and concurrent webhooks: one user, one welcome", async () => {
    const evt = base({}, "evt-1");
    await Promise.all([provisionFromTwenty(evt), provisionFromTwenty(evt), provisionFromTwenty(base({}, "evt-2")), provisionFromTwenty(base({}, "evt-3"))]);
    expect(await db.select().from(schema.user)).toHaveLength(1);
    expect(await db.select().from(schema.recruit)).toHaveLength(1);
    expect(await db.select().from(schema.outbox).where(eq(schema.outbox.eventType, "welcome"))).toHaveLength(1);
    const again = await provisionFromTwenty(evt);
    expect(again.duplicateEvent).toBe(true);
  });

  it("queues a name-only record and resumes when contact fields arrive", async () => {
    const first = await provisionFromTwenty(base({ email: null, phone: null }));
    expect(first.dashboard).toBe("missing_information");
    expect(await db.select().from(schema.user)).toHaveLength(0);
    const tasks = await db.select().from(schema.task);
    expect(tasks.map((t) => t.kind)).toContain("contact_fix");
    const second = await provisionFromTwenty(base({ email: "jamie@example.com", phone: "801-555-0142" }));
    expect(second.dashboard).toBe("ready");
    expect(await signIn("jamie@example.com", "8015550142")).toBe(true);
  });

  it("refuses non-U.S. numbers rather than guessing a password", async () => {
    const out = await provisionFromTwenty(base({ phone: "+44 7911 123456" }));
    expect(out.dashboard).toBe("missing_information");
    expect(await db.select().from(schema.user)).toHaveLength(0);
  });

  it("never links or overwrites an existing account with a matching email", async () => {
    await provisionFromTwenty(base({ email: "shared@example.com" }, "e1", "rec-A"));
    const out = await provisionFromTwenty(base({ email: "shared@example.com", phone: "801-555-0199", name: "Other Person" }, "e2", "rec-B"));
    expect(out.dashboard).toBe("needs_match_review");
    expect(await db.select().from(schema.user)).toHaveLength(1);
    expect(await signIn("shared@example.com", "8015550142")).toBe(true);
  });

  it("a CRM phone change or webhook replay never resets an established password", async () => {
    await provisionFromTwenty(base());
    const [u] = await db.select().from(schema.user);
    // Recruit sets their own password.
    const ctx = await auth().$context;
    await db.update(schema.account).set({ password: await ctx.password.hash("my-own-secret-pass") }).where(eq(schema.account.userId, u.id));
    await db.update(schema.user).set({ mustChangePassword: false }).where(eq(schema.user.id, u.id));
    await provisionFromTwenty(base({ phone: "801-555-0177" }));
    const [r] = await db.select().from(schema.recruit);
    expect(r.phoneE164).toBe("+18015550177");
    await provisionFromTwenty(base({ phone: "801-555-0177" }));
    await retryDashboardProvisioning(r.id, "admin-x");
    expect(await signIn("jamie.rivera@example.com", "my-own-secret-pass")).toBe(true);
    expect(await signIn("jamie.rivera@example.com", "8015550177")).toBe(false);
  });

  it("ignores unrelated objects and NOT_MOVING_FORWARD records", async () => {
    expect((await provisionFromTwenty({ ...base(), object: "person" })).dashboard).toBe("ignored");
    expect((await provisionFromTwenty(base({ stage: "NOT_MOVING_FORWARD" }))).dashboard).toBe("ignored");
    expect(await db.select().from(schema.user)).toHaveLength(0);
  });

  it("flags a CRM email change on a linked account for review instead of taking it over", async () => {
    await provisionFromTwenty(base());
    await provisionFromTwenty(base({ email: "new.address@example.com" }));
    const [r] = await db.select().from(schema.recruit);
    expect(r.email).toBe("jamie.rivera@example.com");
    expect(r.contactIssue).toBe("crm_email_changed_review");
    const [u] = await db.select().from(schema.user);
    expect(u.email).toBe("jamie.rivera@example.com");
  });
});

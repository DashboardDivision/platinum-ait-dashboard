import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";
import { isPhoneLikePassword } from "@/domain/phone";
import { REAUTH_COOKIE, readCookie, verifyReauth } from "@/server/reauth";
import { nextCookies } from "better-auth/next-js";
import { db, schema } from "@/db";
import { env } from "./env";
import { sendSecurityEmail } from "./mailer";
import { onRecruitSessionCreated, onPasswordRecovered } from "@/server/auth-events";

function build() {
  const e = env();
  return betterAuth({
    appName: "Platinum AIT",
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.APP_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        rateLimit: schema.rateLimit,
      },
    }),
    // Password-only sign-in. No email verification gate, no MFA, no public sign-up.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      autoSignIn: false,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendSecurityEmail(
          user.email,
          "Reset your Platinum AIT password",
          [
            `Someone asked to reset the password for ${user.email} on the Platinum AIT dashboard.`,
            "",
            `Choose a new password here (the link works once and expires in 1 hour):`,
            url,
            "",
            "If you didn't ask for this, you can ignore this email. Your password won't change.",
          ].join("\n"),
        );
      },
      onPasswordReset: async ({ user }) => {
        await onPasswordRecovered(user.id);
      },
    },
    user: {
      additionalFields: {
        mustChangePassword: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 300, max: 8 },
        "/request-password-reset": { window: 900, max: 3 },
        "/reset-password": { window: 900, max: 10 },
        "/change-password": { window: 300, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: "ait",
      useSecureCookies: e.APP_URL.startsWith("https://"),
      // Host-only cookies: never shared across *.getstrategic.vip.
      crossSubDomainCookies: { enabled: false },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // New passwords may never be the recruit's phone number, whichever route sets them.
        if (ctx.path === "/reset-password" || ctx.path === "/change-password") {
          const pw = String((ctx.body as Record<string, unknown> | undefined)?.newPassword ?? "");
          let userId: string | null = null;
          if (ctx.path === "/change-password") {
            const s = await getSessionFromCtx(ctx);
            userId = s?.user.id ?? null;
          } else {
            const token = String((ctx.body as Record<string, unknown> | undefined)?.token ?? ctx.query?.token ?? "");
            const v = token ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`) : null;
            userId = v?.value ?? null;
          }
          if (userId) {
            const [r] = await db.select({ phone: schema.recruit.phoneE164 }).from(schema.recruit).where(eq(schema.recruit.userId, userId));
            if (r && isPhoneLikePassword(pw, r.phone)) throw new APIError("BAD_REQUEST", { message: "Your new password can't be your phone number." });
          }
          if (/^\d+$/.test(pw)) throw new APIError("BAD_REQUEST", { message: "Use more than just numbers." });
        }
        // "Login as AIT" needs a recently re-entered admin password (password only; no second factor).
        if (ctx.path === "/admin/impersonate-user") {
          const s = await getSessionFromCtx(ctx);
          const token = readCookie(ctx.headers?.get("cookie") ?? null, REAUTH_COOKIE);
          if (!s || !verifyReauth(token, s.user.id)) throw new APIError("FORBIDDEN", { message: "Re-enter your password to continue." });
        }
        // Admin endpoints that would bypass app rules are disabled; the app's audited actions replace them.
        if (["/admin/set-user-password", "/admin/remove-user", "/admin/create-user", "/admin/set-role", "/admin/update-user"].includes(ctx.path) && ctx.request) {
          throw new APIError("FORBIDDEN", { message: "Use the dashboard's admin actions." });
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            await onRecruitSessionCreated({
              userId: session.userId,
              impersonatedBy: (session as { impersonatedBy?: string | null }).impersonatedBy ?? null,
              at: session.createdAt ?? new Date(),
            });
          },
        },
      },
    },
    plugins: [
      admin({
        defaultRole: "recruit",
        adminRoles: ["admin"],
        impersonationSessionDuration: 30 * 60,
        allowImpersonatingAdmins: false,
      }),
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof build>;
const g = globalThis as unknown as { aitAuth?: Auth };
export function auth(): Auth {
  if (!g.aitAuth) g.aitAuth = build();
  return g.aitAuth;
}

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "demo", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  APP_URL: z.url().default("http://localhost:3000"),
  EDUCATION_URL: z.url().default("https://insurance.getstrategic.vip"),
  // Study-site account provisioning (internal Docker network only). Both unset = learners sign up themselves.
  EDUCATION_PROVISION_URL: z.url().optional(),
  EDUCATION_PROVISION_TOKEN: z.string().min(32).optional(),
  TWENTY_URL: z.url().default("https://crm.getstrategic.vip"),
  // "+ Add New Recruit" creates the Platinum AIT record in Twenty with these (same workspace n8n uses).
  TWENTY_API_KEY: z.string().min(20).optional(),
  TWENTY_WORKSPACE_ID: z.string().min(1).optional(),
  // Bearer token n8n uses for /api/integrations/*. Not a login factor; service auth only.
  INTEGRATION_TOKEN: z.string().min(32),
  // Twenty records created before this instant are only enrolled through the previewed backfill.
  PROVISION_FROM: z.iso.datetime({ offset: true }).optional(),
  DOCUMENT_DIR: z.string().default("./data/documents"),
  MAX_UPLOAD_BYTES: z.coerce.number().default(15 * 1024 * 1024),
  // Password-recovery email is sent by the app itself so reset links never pass through n8n logs.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("Colton Elliott <celliott@platinuminsgroup.com>"),
  ADOBE_SIGN_API_BASE: z.string().optional(),
  ADOBE_SIGN_ACCESS_TOKEN: z.string().optional(),
  ADOBE_SIGN_CLIENT_ID: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export const isProd = () => env().APP_ENV === "production";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type DbOrTx } from "@/db";

export const SETTING_SCHEMAS = {
  examScheduling: z.object({
    defaultUrl: z.url().nullable(),
    defaultLabel: z.string(),
    stateOverrides: z.record(z.string().length(2), z.url()),
  }),
  helpContact: z.object({ name: z.string(), email: z.email().nullable(), phone: z.string().nullable() }).nullable(),
  policyTypes: z.array(z.string().min(1)).min(1),
  inactivityDays: z.number().int().min(1).max(90),
  smsEnabled: z.boolean(),
  premiumRuleText: z.string(),
  // Free Agent / Group Sell step 2: each recruiter's 30-minute booking page.
  bookingLinks: z.object({ COLTON: z.url().nullable(), JESSE: z.url().nullable(), PARKER: z.url().nullable(), fallback: z.url().nullable() }),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  // Verified 2026-10-02 at insurance.utah.gov/licensees/producers/exam: Utah exams are registered through Prometric.
  examScheduling: { defaultUrl: "https://www.prometric.com/utah/insurance", defaultLabel: "Prometric (Utah)", stateOverrides: {} },
  helpContact: { name: "Colton Elliott", email: "celliott@platinuminsgroup.com", phone: "385-469-8200" },
  policyTypes: ["Auto", "Home", "Renters", "Condo", "Umbrella", "Commercial", "Other"],
  inactivityDays: 7,
  // Off until a Platinum 10DLC brand/campaign is approved for the sending number.
  smsEnabled: false,
  bookingLinks: { COLTON: null, JESSE: null, PARKER: null, fallback: null },
  premiumRuleText:
    "Approved new-business policies written during the AIT enrollment and after the contract is signed count toward annualized premium, net of approved cancellations and corrections. Renewals, quotes, rejected records and duplicates do not count. Six-month premiums are doubled; twelve-month premiums count as written.",
};

export async function getSetting<K extends SettingKey>(key: K, tx: DbOrTx = db): Promise<SettingValue<K>> {
  const [row] = await tx.select().from(schema.setting).where(eq(schema.setting.key, key));
  if (!row) return SETTING_DEFAULTS[key];
  const parsed = SETTING_SCHEMAS[key].safeParse(row.value);
  return (parsed.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<K>;
}

export async function putSetting<K extends SettingKey>(key: K, value: SettingValue<K>, userId: string, tx: DbOrTx = db) {
  const parsed = SETTING_SCHEMAS[key].parse(value);
  await tx
    .insert(schema.setting)
    .values({ key, value: parsed as object, updatedByUserId: userId })
    .onConflictDoUpdate({ target: schema.setting.key, set: { value: parsed as object, updatedByUserId: userId, updatedAt: new Date() } });
}

export function bookingUrlFor(cfg: SettingValue<"bookingLinks">, recruiter: string | null): string | null {
  const own = recruiter && recruiter in cfg ? cfg[recruiter as "COLTON" | "JESSE" | "PARKER"] : null;
  return own ?? cfg.fallback;
}

export function examUrlFor(cfg: SettingValue<"examScheduling">, state: string | null): string | null {
  if (state && cfg.stateOverrides[state.toUpperCase()]) return cfg.stateOverrides[state.toUpperCase()];
  return cfg.defaultUrl;
}

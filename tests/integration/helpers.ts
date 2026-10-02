import { execSync } from "node:child_process";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://ait:ait@localhost/ait_test";

process.env.DATABASE_URL = TEST_DB;
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-123";
process.env.INTEGRATION_TOKEN ??= "test-integration-token-test-integration-token";
process.env.APP_URL ??= "http://localhost:3000";

let migrated = false;
export async function resetDb() {
  const { pool } = await import("@/db");
  if (!migrated) {
    await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
    execSync("npx tsx scripts/migrate.ts", { env: { ...process.env, DATABASE_URL: TEST_DB }, stdio: "ignore" });
    migrated = true;
  }
  const { rows } = await pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public'");
  await pool.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(",")} restart identity cascade`);
}

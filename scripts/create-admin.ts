/**
 * Creates one admin account and prints a generated password exactly once.
 * Usage: npm run admin:create -- --email someone@platinuminsgroup.com --name "Full Name"
 * The admin must choose their own password at first sign-in.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../src/db";
import { auth } from "../src/lib/auth";
import { normalizeEmail } from "../src/domain/email";
import { audit } from "../src/server/audit";

const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } });
const email = normalizeEmail(values.email ?? "");
if (!email || !values.name?.trim()) {
  console.error('Usage: npm run admin:create -- --email you@example.com --name "Full Name"');
  process.exit(2);
}

const [existing] = await db.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).where(eq(schema.user.email, email));
if (existing) {
  // Never overwrite an existing account's password or role from a script.
  console.error(`An account with ${email} already exists (role: ${existing.role}). Nothing was changed.`);
  await pool.end();
  process.exit(1);
}

// 20 characters from a URL-safe alphabet, about 120 bits.
const password = randomBytes(15).toString("base64url");
const hash = await (await auth().$context).password.hash(password);
const id = randomUUID();
const now = new Date();
await db.transaction(async (tx) => {
  await tx.insert(schema.user).values({ id, name: values.name!.trim(), email, role: "admin", emailVerified: false, mustChangePassword: true, createdAt: now, updatedAt: now });
  await tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: now, updatedAt: now });
  await audit(tx, { actorUserId: null, action: "admin.created", targetType: "user", targetId: id, metadata: { via: "cli" } });
});
await pool.end();

console.log(`Admin created for ${email}.`);
console.log(`One-time password (shown only now; you'll be asked to change it at first sign-in): ${password}`);

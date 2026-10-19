import { eq } from "drizzle-orm";
import { cache } from "react";
import { db, schema, type DbOrTx } from "@/db";
import { ALL_STAFF_PERMS, DEFAULT_PERMS, isRoleKey, type RoleKey } from "@/domain/roles";

/** A role's permissions: the saved Roles-screen settings, or the defaults. Master Admin is always everything. */
export async function permsForRole(role: string, tx: DbOrTx = db): Promise<string[]> {
  if (role === "master_admin") return ALL_STAFF_PERMS;
  const key: RoleKey | null = isRoleKey(role) ? role : role === "agent" ? "captive_lead" : null;
  if (!key) return [];
  const [row] = await tx.select().from(schema.rolePermission).where(eq(schema.rolePermission.role, key));
  return row ? (row.perms as string[]) : DEFAULT_PERMS[key];
}

export const cachedPermsForRole = cache((role: string) => permsForRole(role));

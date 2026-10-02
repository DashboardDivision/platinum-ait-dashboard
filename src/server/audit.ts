import { schema, type DbOrTx } from "@/db";

export type AuditInput = {
  actorUserId: string | null;
  impersonatorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
};

/** Audit metadata must never include passwords, tokens or document contents. */
export async function audit(tx: DbOrTx, input: AuditInput) {
  await tx.insert(schema.auditEvent).values({
    actorUserId: input.actorUserId,
    impersonatorUserId: input.impersonatorUserId ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? null,
    ip: input.ip ?? null,
  });
}

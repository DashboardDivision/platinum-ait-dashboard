import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { audit } from "./audit";
import { enqueue } from "./outbox";
import { recomputeProduction } from "./production";
import { HttpError } from "./session";

export function adobeSignConfigured() {
  const e = env();
  return Boolean(e.ADOBE_SIGN_API_BASE && e.ADOBE_SIGN_ACCESS_TOKEN);
}

/** Marks a contract verified and records contract_signed_at once. */
async function markSigned(contractId: string, signedAt: Date, actorUserId: string | null, evidence: Record<string, unknown>) {
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(schema.contractInstance).where(eq(schema.contractInstance.id, contractId)).for("update");
    if (!c) throw new HttpError(404, "Contract not found");
    await tx.update(schema.contractInstance).set({ status: c.source === "adobe_sign" ? "signed" : "verified_upload", signedAt, auditEvidence: evidence }).where(eq(schema.contractInstance.id, c.id));
    const [r] = await tx.select().from(schema.recruit).where(eq(schema.recruit.id, c.recruitId));
    if (!r.contractSignedAt) {
      await tx.update(schema.recruit).set({ contractSignedAt: signedAt }).where(eq(schema.recruit.id, r.id));
      await enqueue(tx, { eventType: "contract_signed", dedupeKey: `contract_signed:${r.id}`, recruitId: r.id, payload: { source: c.source } });
    }
    await audit(tx, { actorUserId, action: "contract.verified", targetType: "contract", targetId: c.id, metadata: { source: c.source, recruitId: c.recruitId } });
  });
  const [c] = await db.select().from(schema.contractInstance).where(eq(schema.contractInstance.id, contractId));
  await recomputeProduction(c.recruitId);
}

/**
 * Contracts signed outside the integrated service. Labeled as an admin-reviewed
 * upload, never as verified e-signature evidence.
 */
export async function approveExternalContract(adminUserId: string, recruitId: string, documentId: string, signedOn: string, reason: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) throw new HttpError(400, "Enter the signing date as YYYY-MM-DD.");
  const [d] = await db.select().from(schema.document).where(eq(schema.document.id, documentId));
  if (!d || d.recruitId !== recruitId || d.kind !== "contract_external") throw new HttpError(400, "Pick a contract file uploaded for this recruit.");
  await db.update(schema.document).set({ status: "approved", reviewedByUserId: adminUserId, reviewedAt: new Date(), reviewReason: reason }).where(eq(schema.document.id, d.id));
  const [c] = await db
    .insert(schema.contractInstance)
    .values({ recruitId, source: "external_upload", status: "uploaded_pending_review", signedDocumentId: d.id })
    .returning();
  await markSigned(c.id, new Date(`${signedOn}T12:00:00-07:00`), adminUserId, { method: "admin_reviewed_upload", note: reason, documentSha256: d.sha256 });
}

/**
 * Adobe Acrobat Sign callback. The webhook body is never trusted for completion:
 * we fetch the agreement from Adobe and only a SIGNED status counts.
 */
export async function handleAdobeSignCallback(agreementId: string) {
  if (!adobeSignConfigured()) throw new HttpError(503, "Adobe Sign isn't configured");
  const e = env();
  const res = await fetch(`${e.ADOBE_SIGN_API_BASE}/api/rest/v6/agreements/${encodeURIComponent(agreementId)}`, {
    headers: { Authorization: `Bearer ${e.ADOBE_SIGN_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new HttpError(502, `Adobe Sign returned ${res.status}`);
  const agreement = (await res.json()) as { id: string; status: string };
  const [c] = await db.select().from(schema.contractInstance).where(eq(schema.contractInstance.providerRef, agreement.id));
  if (!c) return { matched: false };
  if (agreement.status === "SIGNED" || agreement.status === "APPROVED") {
    if (!c.signedAt) await markSigned(c.id, new Date(), null, { provider: "adobe_sign", agreementStatus: agreement.status });
    return { matched: true, signed: true };
  }
  const status = agreement.status === "OUT_FOR_SIGNATURE" ? "sent" : agreement.status.toLowerCase();
  await db.update(schema.contractInstance).set({ status }).where(eq(schema.contractInstance.id, c.id));
  return { matched: true, signed: false };
}

export async function adminCorrectTrainingStart(adminUserId: string, recruitId: string, date: string, reason: string) {
  if (!reason.trim()) throw new HttpError(400, "A reason is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Use YYYY-MM-DD.");
  await db.transaction(async (tx) => {
    const [r] = await tx.select().from(schema.recruit).where(eq(schema.recruit.id, recruitId));
    if (!r?.contractSignedAt) throw new HttpError(409, "The contract must be verified first.");
    await tx.update(schema.recruit).set({ trainingStartedAt: new Date(`${date}T12:00:00-07:00`), stage5Substatus: "in_training" }).where(eq(schema.recruit.id, recruitId));
    await audit(tx, { actorUserId: adminUserId, action: "training_start.corrected", targetType: "recruit", targetId: recruitId, reason, metadata: { from: r.trainingStartedAt?.toISOString() ?? null, to: date } });
  });
}

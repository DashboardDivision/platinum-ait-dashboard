import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/lib/env";
import { completeStageTx } from "./stages";
import { enqueue } from "./outbox";
import { audit } from "./audit";
import { HttpError, type CurrentUser, actorKind } from "./session";

type Kind = (typeof schema.documentKind.enumValues)[number];

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];

// Active PDF content we refuse outright. Files are also only ever served as downloads with nosniff.
const PDF_ACTIVE = [/\/JavaScript\b/, /\/JS\b/, /\/Launch\b/, /\/EmbeddedFile\b/, /\/RichMedia\b/, /\/OpenAction\b/, /\/AA\b/, /\/XFA\b/];

export type ValidatedFile = { mime: string; ext: string; size: number; sha256: string };

export function validateUpload(buf: Buffer, declaredName: string): ValidatedFile {
  const max = env().MAX_UPLOAD_BYTES;
  if (buf.length === 0) throw new HttpError(400, "The file is empty.");
  if (buf.length > max) throw new HttpError(413, `Files must be ${Math.round(max / 1024 / 1024)} MB or smaller.`);
  const sig = SIGNATURES.find((s) => s.test(buf));
  if (!sig) {
    const lower = declaredName.toLowerCase();
    if (/\.(heic|heif)$/.test(lower) || buf.subarray(4, 12).toString("latin1").includes("ftyphei")) {
      throw new HttpError(415, "iPhone HEIC photos aren't supported. In Settings > Camera > Formats choose Most Compatible, or take a screenshot of the photo and upload that.");
    }
    throw new HttpError(415, "Upload a PDF, JPEG or PNG file.");
  }
  if (sig.mime === "application/pdf") {
    const text = buf.toString("latin1");
    if (PDF_ACTIVE.some((re) => re.test(text))) throw new HttpError(415, "This PDF contains scripts or embedded files and can't be accepted. Print it to a new PDF and try again.");
  }
  return { mime: sig.mime, ext: sig.ext, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

export function safeOriginalName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return base || "upload";
}

async function store(buf: Buffer, ext: string): Promise<string> {
  const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${ext}`;
  const full = path.join(env().DOCUMENT_DIR, key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, buf, { mode: 0o600 });
  return key;
}

export async function readStored(key: string): Promise<Buffer> {
  if (key.includes("..")) throw new HttpError(400, "bad key");
  return readFile(path.join(env().DOCUMENT_DIR, key));
}

export async function uploadDocument(u: CurrentUser, input: { recruitId: string; kind: Kind; fileName: string; data: Buffer; state?: string | null; examDate?: string | null; licenseNumber?: string | null }) {
  const f = validateUpload(input.data, input.fileName);
  const key = await store(input.data, f.ext);
  const kind = actorKind(u);
  const [doc] = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(schema.document)
      .values({
        recruitId: input.recruitId,
        kind: input.kind,
        storageKey: key,
        originalName: safeOriginalName(input.fileName),
        mimeType: f.mime,
        sizeBytes: f.size,
        sha256: f.sha256,
        state: input.state?.toUpperCase().slice(0, 2) || null,
        examDate: input.examDate || null,
        licenseNumber: input.licenseNumber?.slice(0, 40) || null,
        uploadedByUserId: u.id,
      })
      .returning();
    await tx.insert(schema.activityEvent).values({ recruitId: input.recruitId, type: "proof_uploaded", actorKind: kind, actorUserId: u.id, impersonatorUserId: u.impersonatedBy, metadata: { kind: input.kind, documentId: rows[0].id } });
    if (input.kind === "receipt") {
      // A receipt attaches to the recruit's open reimbursement case if there is one.
      const [case_] = await tx.select().from(schema.reimbursement).where(eq(schema.reimbursement.recruitId, input.recruitId));
      if (case_ && !case_.receiptDocumentId) {
        await tx.update(schema.reimbursement).set({ receiptDocumentId: rows[0].id, status: case_.status === "awaiting_receipt" ? "submitted" : case_.status }).where(eq(schema.reimbursement.id, case_.id));
        await enqueue(tx, { eventType: "reimbursement_updated", dedupeKey: `reimb:${case_.id}:receipt`, recruitId: input.recruitId, payload: { status: "submitted" } });
      }
    }
    return rows;
  });
  return doc;
}

/**
 * Admin review. Approving official exam results or a license completes Stage 4
 * (once), creates exactly one reimbursement case and one shared follow-up task,
 * and queues the mandatory all-admin email. Upload alone never does.
 */
export async function reviewDocument(adminUserId: string, documentId: string, decision: "approve" | "reject", reason: string | null) {
  if (decision === "reject" && !reason?.trim()) throw new HttpError(400, "Give the recruit a reason so they know what to replace.");
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(schema.document).where(eq(schema.document.id, documentId)).for("update");
    if (!d) throw new HttpError(404, "Document not found");
    const now = new Date();
    await tx
      .update(schema.document)
      .set({ status: decision === "approve" ? "approved" : "needs_replacement", reviewedByUserId: adminUserId, reviewedAt: now, reviewReason: reason?.trim() || null })
      .where(eq(schema.document.id, d.id));
    await audit(tx, { actorUserId: adminUserId, action: `document.${decision}`, targetType: "document", targetId: d.id, reason, metadata: { kind: d.kind, recruitId: d.recruitId } });
    if (decision !== "approve") return { stageCompleted: false };

    if (d.kind === "exam_result") await tx.update(schema.recruit).set({ examPassedAt: now }).where(eq(schema.recruit.id, d.recruitId));
    if (d.kind === "license") await tx.update(schema.recruit).set({ licenseIssuedAt: now, licenseNumber: d.licenseNumber, licenseState: d.state }).where(eq(schema.recruit.id, d.recruitId));
    if (d.kind === "contract_external") return { stageCompleted: false };
    if (d.kind !== "exam_result" && d.kind !== "license") return { stageCompleted: false };

    const res = await completeStageTx(tx, d.recruitId, 4, now, { proofDocumentId: d.id, proofKind: d.kind, approvedBy: adminUserId }, adminUserId);
    if (!res.advanced) return { stageCompleted: false };

    const [r] = await tx.select().from(schema.recruit).where(eq(schema.recruit.id, d.recruitId));
    const [t] = await tx
      .insert(schema.task)
      .values({
        recruitId: d.recruitId,
        kind: "stage4_followup",
        dedupeKey: `stage4:${d.recruitId}`,
        title: `Congratulate ${r.fullName} and handle the exam reimbursement`,
        body: "Personally congratulate the recruit on passing. Collect the test receipt and process the exam reimbursement. Claim this task so only one admin reimburses the test.",
      })
      .onConflictDoNothing({ target: schema.task.dedupeKey })
      .returning();
    const [case_] = await tx
      .insert(schema.reimbursement)
      .values({ recruitId: d.recruitId, examProofDocumentId: d.id, taskId: t?.id ?? null })
      .onConflictDoNothing()
      .returning();
    // Link a receipt the recruit already uploaded before approval.
    const [receipt] = await tx.select().from(schema.document).where(and(eq(schema.document.recruitId, d.recruitId), eq(schema.document.kind, "receipt")));
    if (case_ && receipt) await tx.update(schema.reimbursement).set({ receiptDocumentId: receipt.id, status: "submitted" }).where(eq(schema.reimbursement.id, case_.id));
    await enqueue(tx, { eventType: "stage4_admin_followup", dedupeKey: `stage4_admin:${d.recruitId}`, recruitId: d.recruitId, payload: { taskId: t?.id, reimbursementId: case_?.id, receiptOnFile: Boolean(receipt) } });
    return { stageCompleted: true };
  });
}

/** Ownership-checked document fetch. Recruits get only their own non-internal files. */
export async function authorizeDocument(u: CurrentUser, documentId: string) {
  const [d] = await db.select().from(schema.document).where(eq(schema.document.id, documentId));
  if (!d) throw new HttpError(404, "Not found");
  if (u.role === "admin" && !u.impersonatedBy) return d;
  const [r] = await db.select().from(schema.recruit).where(eq(schema.recruit.userId, u.id));
  if (!r || r.id !== d.recruitId) throw new HttpError(404, "Not found");
  return d;
}

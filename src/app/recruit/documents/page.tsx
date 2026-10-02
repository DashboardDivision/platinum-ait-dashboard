import { requirePageUser, recruitForUser } from "@/server/session";
import { recruitOverview } from "@/server/views";
import { Shell } from "@/components/shell";
import { ActionForm } from "@/components/action-form";
import { DocBadge, Empty, ReimbursementBadge, Badge } from "@/components/ui";
import { formatDate, formatDateTime } from "@/domain/durations";
import { formatCents } from "@/domain/money";
import { uploadAction } from "../actions";

export const metadata = { title: "Documents" };

const KIND: Record<string, string> = {
  exam_result: "Official exam results",
  license: "State insurance license",
  receipt: "Exam fee receipt",
  contract_signed: "Signed AIT contract",
  contract_external: "AIT contract (uploaded copy)",
};

export default async function RecruitDocuments() {
  const u = await requirePageUser("recruit");
  const r = await recruitForUser(u.id);
  if (!r) return null;
  const o = (await recruitOverview(r.id))!;
  const examStatus = r.examPassedAt ? "Exam passed (approved)" : null;
  const licStatus = r.licenseIssuedAt ? `License on file${r.licenseState ? ` (${r.licenseState})` : ""}` : null;
  return (
    <Shell user={u} active="/recruit/documents">
      <div className="topbar"><h1>Documents</h1></div>
      <div className="grid2">
        <section className="card" aria-labelledby="up-title">
          <div className="hd"><h2 id="up-title">Upload proof</h2></div>
          <div className="bd">
            <p className="small muted" style={{ marginBottom: 12 }}>
              PDF, JPEG or PNG up to 15 MB. On iPhone, choose a photo or screenshot (HEIC photos aren't accepted). Passing the exam and getting a license are tracked separately. Neither one authorizes you to sell insurance; your state license does.
            </p>
            <ActionForm action={uploadAction} submit="Upload">
              <label className="f">
                What is it?
                <select name="kind" required defaultValue="">
                  <option value="" disabled>Choose…</option>
                  <option value="exam_result">Official passing exam results</option>
                  <option value="license">State-issued insurance license</option>
                  <option value="receipt">Exam fee receipt (for reimbursement)</option>
                </select>
              </label>
              <div className="row">
                <label className="f">State<input type="text" name="state" maxLength={2} placeholder="UT" /></label>
                <label className="f">Exam date<input type="date" name="examDate" /></label>
              </div>
              <label className="f">License number <span className="hint">If uploading a license</span><input type="text" name="licenseNumber" maxLength={40} /></label>
              <label className="f">File<input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required /></label>
            </ActionForm>
          </div>
        </section>
        <div className="stack">
          <section className="card">
            <div className="hd"><h2>Status</h2></div>
            <div className="bd small">
              <div className="flags">
                {examStatus ? <Badge tone="ok">{examStatus}</Badge> : <Badge tone="neutral">Exam: not verified yet</Badge>}
                {licStatus ? <Badge tone="ok">{licStatus}</Badge> : <Badge tone="neutral">License: not verified yet</Badge>}
              </div>
            </div>
          </section>
          {o.reimbursements.map((c) => (
            <section className="card" key={c.id}>
              <div className="hd"><h2>Exam reimbursement</h2><ReimbursementBadge status={c.status} /></div>
              <div className="bd small">
                <dl className="kv">
                  <dt>Receipt</dt><dd>{c.receiptDocumentId ? "On file" : "Not uploaded yet"}</dd>
                  <dt>Approved amount</dt><dd className="tabular">{c.approvedCents != null ? formatCents(c.approvedCents) : "—"}</dd>
                  <dt>Paid</dt><dd className="tabular">{formatCents(c.payments.reduce((s, p) => s + p.amountCents, 0))}</dd>
                </dl>
              </div>
            </section>
          ))}
        </div>
      </div>
      <section className="card" style={{ marginTop: 16 }} aria-labelledby="list-title">
        <div className="hd"><h2 id="list-title">Your files</h2></div>
        {o.documents.length === 0 ? (
          <Empty>No files yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t stack-sm">
              <thead><tr><th>Type</th><th>File</th><th>Uploaded</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>
                {o.documents.map((d) => (
                  <tr key={d.id}>
                    <td data-label="Type">{KIND[d.kind] ?? d.kind}</td>
                    <td data-label="File"><a href={`/api/files/${d.id}`}>{d.originalName}</a></td>
                    <td data-label="Uploaded">{formatDateTime(d.uploadedAt)}</td>
                    <td data-label="Status"><DocBadge status={d.status} /></td>
                    <td data-label="Note">{d.status === "needs_replacement" ? d.reviewReason : d.examDate ? `Exam ${formatDate(new Date(d.examDate + "T12:00:00Z"))}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

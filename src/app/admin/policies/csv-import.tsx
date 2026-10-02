"use client";
import { useActionState } from "react";
import { ActionForm } from "@/components/action-form";
import { commitCsvAction, previewCsvAction } from "../actions";

const money = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

export function CsvImport() {
  const [state, preview, pending] = useActionState(previewCsvAction, {});
  const rows = state.rows ?? [];
  const good = rows.filter((r) => !r.error).length;
  return (
    <div className="form-grid">
      <form action={preview} className="form-grid">
        <label>
          CSV file
          <input type="file" name="file" accept=".csv,text/csv" required />
        </label>
        <p className="small muted">
          Columns: recruit_email, policy_number, policy_type, written_date (required); carrier, business_type, effective_date, term_months, term_premium, annualized_premium. Nothing is saved until you confirm.
        </p>
        <div><button className="btn secondary" disabled={pending}>{pending ? "Reading…" : "Preview import"}</button></div>
        {state.error ? <p className="alert bad" role="alert">{state.error}</p> : null}
      </form>
      {rows.length ? (
        <>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Line</th><th>Recruit</th><th>Policy</th><th>Type</th><th>Written</th><th className="num">Annualized</th><th>Result</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.line}>
                <td className="tabular">{r.line}</td>
                <td>{r.recruitEmail}</td>
                <td>{r.input?.externalRef}</td>
                <td>{r.input?.policyType} {r.input?.businessType !== "new" ? `(${r.input?.businessType})` : ""}</td>
                <td className="tabular">{r.input?.writtenDate}</td>
                <td className="num tabular">{money(r.input?.annualizedCents ?? (r.input?.termPremiumCents != null && r.input.termMonths === 6 ? r.input.termPremiumCents * 2 : r.input?.termPremiumCents))}</td>
                <td>{r.error ? <span className="badge bad">{r.error}</span> : r.exists ? <span className="badge info">Updates existing</span> : <span className="badge ok">New</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <ActionForm action={commitCsvAction} submit={`Import ${good} row${good === 1 ? "" : "s"} as pending`} confirm={`Import ${good} rows? Rows with errors are skipped.`}>
            <input type="hidden" name="csv" value={state.csv ?? ""} />
          </ActionForm>
        </>
      ) : null}
    </div>
  );
}

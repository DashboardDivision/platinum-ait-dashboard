import { ActionForm } from "@/components/action-form";
import { displayValue, loadTwentyDetails, type Target, type TwentyField } from "@/server/twenty-edit";
import { HttpError } from "@/server/session";
import { saveTwentyDetailsAction } from "@/app/admin/actions";

function Field({ f, value, disabled }: { f: TwentyField; value: string; disabled: boolean }) {
  const name = `field:${f.name}`;
  const common = { name, disabled: disabled || f.readOnly, defaultValue: value, "aria-label": f.label };
  switch (f.type) {
    case "RICH_TEXT": return <textarea {...common} rows={5} />;
    case "SELECT":
      return (
        <select {...common}>
          {f.nullable ? <option value="">—</option> : null}
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case "BOOLEAN":
      return <select {...common}><option value="false">No</option><option value="true">Yes</option></select>;
    case "NUMBER": return <input type="text" inputMode="decimal" {...common} />;
    case "CURRENCY": return <input type="text" inputMode="decimal" placeholder="$" {...common} />;
    case "DATE": return <input type="date" {...common} />;
    case "DATE_TIME": return <input type="datetime-local" {...common} />;
    case "EMAILS": return <input type="email" {...common} />;
    case "PHONES": return <input type="tel" {...common} />;
    default: return <input type="text" {...common} />;
  }
}

/** Every field on the prospect's Twenty record, editable here (changes save to Twenty). */
export async function TwentyDetails({ target, canEdit }: { target: Target; canEdit: boolean }) {
  let data: Awaited<ReturnType<typeof loadTwentyDetails>> | null = null;
  let error: string | null = null;
  try {
    data = await loadTwentyDetails(target);
  } catch (e) {
    error = e instanceof HttpError ? e.message : "Couldn't reach Twenty.";
  }
  return (
    <section className="card" aria-labelledby="twenty-details-title">
      <div className="hd">
        <h2 id="twenty-details-title">Details</h2>
        <span className="small muted">{canEdit ? "Saved to Twenty" : "Read-only"}</span>
      </div>
      <div className="bd">
        {error ? <p className="alert bad">{error}</p> : data ? (
          <ActionForm action={saveTwentyDetailsAction} submit="Save changes to Twenty" className="form-grid">
            <input type="hidden" name="kind" value={target.kind} />
            <input type="hidden" name="id" value={target.id} />
            <div className="details-grid">
              {data.fields.filter((f) => f.type !== "RICH_TEXT").map((f) => (
                <label key={f.name} className="f">
                  {f.label}{f.readOnly ? <span className="hint"> (set by the source system)</span> : null}
                  <Field f={f} value={displayValue(f, data!.record[f.name])} disabled={!canEdit} />
                </label>
              ))}
            </div>
            {data.fields.filter((f) => f.type === "RICH_TEXT").map((f) => (
              <label key={f.name} className="f">{f.label}<Field f={f} value={displayValue(f, data!.record[f.name])} disabled={!canEdit} /></label>
            ))}
            <p className="small muted">Dates and times are Mountain Time. Only the fields you change are sent, and every change is recorded in the audit log.</p>
          </ActionForm>
        ) : null}
      </div>
    </section>
  );
}

import { existsSync } from "node:fs";
import path from "node:path";

/** Uses the approved Platinum logo if brand files are present in /public/brand, otherwise a text wordmark. */
function logo(file: string) {
  return existsSync(path.join(process.cwd(), "public", "brand", file)) ? `/brand/${file}` : null;
}

export function NavWordmark() {
  const icon = logo("platinum-insurance-group-logo.png");
  return (
    <a className="wordmark" href="/">
      {icon ? <img src={icon} alt="" width={28} height={28} /> : null}
      <span>
        Platinum
        <small>Agent in Training</small>
      </span>
    </a>
  );
}

export function AuthBrand() {
  const full = logo("platinum-logo-transparent.png");
  return (
    <div className="auth-brand">
      {full ? <img src={full} alt="Platinum Insurance Group" width={161} height={44} /> : <div className="text">Platinum Insurance Group</div>}
      <div className="sub">Agent in Training</div>
    </div>
  );
}

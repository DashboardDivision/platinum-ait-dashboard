#!/usr/bin/env node
/**
 * Installs the dashboard's n8n credentials and workflows through the n8n public API.
 * Run on the VPS:  node install.mjs /opt/ait/n8n-install.env [--activate]
 *
 * Safe to re-run: credentials are created once (ids kept in ./.n8n-state.json, mode 600),
 * workflows are matched by name and updated in place. Workflows stay inactive unless
 * --activate is passed; the Momentum and backfill workflows are never auto-activated.
 * No secret is printed.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { buildWorkflows } from "./workflows.mjs";

const [envFile, ...flags] = process.argv.slice(2);
if (!envFile) { console.error("usage: node install.mjs <env-file> [--activate]"); process.exit(2); }
const cfg = Object.fromEntries(
  readFileSync(envFile, "utf8").split("\n").filter((l) => /^\s*[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]; }),
);
const need = ["N8N_URL", "N8N_API_KEY", "APP_URL", "INTEGRATION_TOKEN", "TWENTY_URL", "TWENTY_API_KEY", "TWENTY_WORKSPACE_ID", "TWENTY_WEBHOOK_PATH", "TWENTY_WEBHOOK_SECRET", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM", "TELNYX_FROM"];
const missing = need.filter((k) => !cfg[k]);
if (missing.length) { console.error(`Missing in ${envFile}: ${missing.join(", ")}`); process.exit(2); }

const api = async (method, path, body) => {
  const res = await fetch(`${cfg.N8N_URL.replace(/\/$/, "")}/api/v1${path}`, { method, headers: { "X-N8N-API-KEY": cfg.N8N_API_KEY, "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const STATE = new URL("./.n8n-state.json", import.meta.url);
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { credentials: {} };
const save = () => { writeFileSync(STATE, JSON.stringify(state, null, 2)); chmodSync(STATE, 0o600); };

/** Only send fields the credential type's schema knows, so the API never rejects extras. */
async function credential(key, name, type, data) {
  if (state.credentials[key]) return state.credentials[key];
  let allowed = null;
  try { allowed = Object.keys((await api("GET", `/credentials/schema/${type}`)).properties ?? {}); } catch { /* older API: send as-is */ }
  const body = allowed ? Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k))) : data;
  const created = await api("POST", "/credentials", { name, type, data: body });
  state.credentials[key] = { id: created.id, name };
  save();
  console.log(`credential created: ${name}`);
  return state.credentials[key];
}

const bearer = (v) => ({ name: "Authorization", value: `Bearer ${v}` });
const creds = {
  app: await credential("app", "Platinum AIT - Dashboard integration", "httpHeaderAuth", bearer(cfg.INTEGRATION_TOKEN)),
  twenty: await credential("twenty", "Platinum AIT - Twenty API", "httpHeaderAuth", bearer(cfg.TWENTY_API_KEY)),
  smtp: await credential("smtp", "Platinum AIT - Gmail (celliott)", "smtp", { user: cfg.SMTP_USER, password: cfg.SMTP_PASSWORD, host: cfg.SMTP_HOST || "smtp.gmail.com", port: Number(cfg.SMTP_PORT || 465), secure: (cfg.SMTP_PORT || "465") === "465" }),
  // Texts are off in the dashboard until a Platinum-scoped Telnyx key and 10DLC campaign exist; the placeholder keeps the workflow valid.
  telnyx: await credential("telnyx", "Platinum AIT - Telnyx", "httpHeaderAuth", bearer(cfg.TELNYX_API_KEY || "not-configured")),
  momentum: await credential("momentum", "Platinum AIT - Momentum AMP (read-only)", "httpHeaderAuth", bearer(cfg.MOMENTUM_API_KEY || "not-configured")),
};

const workflows = buildWorkflows({ ...cfg, MOMENTUM_POLICIES_URL: cfg.MOMENTUM_POLICIES_URL || "https://api.momentumamp.com/not-configured" }, creds);
const existing = (await api("GET", "/workflows?limit=250")).data ?? [];
const NEVER_AUTO = ["Momentum AMP", "Backfill"];
for (const wf of workflows) {
  const found = existing.find((w) => w.name === wf.name);
  const saved = found ? await api("PUT", `/workflows/${found.id}`, wf) : await api("POST", "/workflows", wf);
  console.log(`${found ? "updated" : "created"}: ${wf.name} (${saved.id})`);
  if (flags.includes("--activate") && !NEVER_AUTO.some((n) => wf.name.includes(n))) {
    await api("POST", `/workflows/${saved.id}/activate`);
    console.log(`  activated`);
  }
}
console.log(`Twenty webhook URL: ${cfg.N8N_URL.replace(/\/$/, "")}/webhook/${cfg.TWENTY_WEBHOOK_PATH}`);

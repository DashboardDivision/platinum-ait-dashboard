/**
 * The dashboard's n8n workflows, built from deploy config so nothing secret lives in git.
 * install.mjs creates the credentials, then these workflows, through the n8n public API.
 *
 * Execution data: workflows that carry names, emails, phone numbers or message text keep
 * no execution history (success or error). The dashboard records every outcome itself.
 */

const PRIVATE = { executionOrder: "v1", saveManualExecutions: false, saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveExecutionProgress: false, timezone: "America/Denver", executionTimeout: 300 };
const UPKEEP = { ...PRIVATE, saveDataErrorExecution: "all" };

let seq = 0;
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({ id: `ait-${++seq}`, name, type, typeVersion, position, parameters, ...extra });
const link = (...names) => {
  const c = {};
  for (let i = 0; i < names.length - 1; i++) {
    const [from, out = 0] = Array.isArray(names[i]) ? names[i] : [names[i]];
    c[from] ??= { main: [] };
    c[from].main[out] ??= [];
    c[from].main[out].push({ node: Array.isArray(names[i + 1]) ? names[i + 1][0] : names[i + 1], type: "main", index: 0 });
  }
  return c;
};
const merge = (...cs) => {
  const out = {};
  for (const c of cs) for (const [k, v] of Object.entries(c)) {
    out[k] ??= { main: [] };
    v.main.forEach((arr, i) => { out[k].main[i] = [...(out[k].main[i] ?? []), ...(arr ?? [])]; });
  }
  return out;
};
const headerAuth = (credId, credName) => ({ authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", _cred: { httpHeaderAuth: { id: credId, name: credName } } });
function http(name, position, { method = "GET", url, auth, body, retry = true, continueOnError = false, pagination, query }) {
  const { _cred, ...authParams } = auth;
  return node(name, "n8n-nodes-base.httpRequest", 4.2, position, {
    method, url, ...authParams,
    ...(query ? { sendQuery: true, queryParameters: { parameters: query } } : {}),
    ...(body ? { sendBody: true, specifyBody: "json", jsonBody: body } : {}),
    options: { timeout: 30000, ...(pagination ? { pagination: { pagination } } : {}) },
  }, {
    credentials: _cred,
    ...(retry ? { retryOnFail: true, maxTries: 4, waitBetweenTries: 5000 } : {}),
    ...(continueOnError ? { onError: "continueRegularOutput" } : {}),
  });
}
const code = (name, position, jsCode, mode = "runOnceForAllItems") => node(name, "n8n-nodes-base.code", 2, position, { mode, jsCode });
const every = (name, position, field, n) => node(name, "n8n-nodes-base.scheduleTrigger", 1.2, position, { rule: { interval: [{ field, [`${field}Interval`]: n }] } });

// Shared mapping from a Twenty platinumAit record to the dashboard's provisioning input.
const MAP_TWENTY = `
function mapRecord(rec) {
  const name = typeof rec.name === "string" ? rec.name : [rec.name?.firstName, rec.name?.lastName].filter(Boolean).join(" ");
  const email = rec.emails?.primaryEmail ?? rec.email ?? null;
  const p = rec.phones ?? {};
  const number = p.primaryPhoneNumber ?? rec.phone ?? null;
  const calling = p.primaryPhoneCallingCode ?? (p.primaryPhoneCountryCode === "US" ? "+1" : "");
  const phone = number ? (String(number).startsWith("+") ? String(number) : \`\${calling}\${number}\`) : null;
  return { name: name || null, email, phone, stage: rec.stage ?? null, createdAt: rec.createdAt ?? null, deletedAt: rec.deletedAt ?? null };
}`;

export function buildWorkflows(cfg, creds) {
  const app = cfg.APP_URL.replace(/\/$/, "");
  const twenty = cfg.TWENTY_URL.replace(/\/$/, "");
  const appAuth = headerAuth(creds.app.id, creds.app.name);
  const twentyAuth = headerAuth(creds.twenty.id, creds.twenty.name);
  const twentyPages = {
    paginationMode: "updateAParameterInEachRequest",
    parameters: { parameters: [{ type: "qs", name: "starting_after", value: "={{ $response.body.pageInfo?.endCursor }}" }] },
    paginationCompleteWhen: "other",
    completeExpression: "={{ !$response.body.pageInfo?.hasNextPage }}",
    limitPagesFetched: true,
    maxRequests: 50,
  };

  /* 1. Twenty webhook → re-fetch the record → dashboard. */
  const sync = {
    name: "Platinum AIT - Twenty recruit sync",
    settings: PRIVATE,
    nodes: [
      node("Twenty webhook", "n8n-nodes-base.webhook", 2, [0, 0], { httpMethod: "POST", path: cfg.TWENTY_WEBHOOK_PATH, responseMode: "onReceived", options: { responseCode: 200 } }, { webhookId: cfg.TWENTY_WEBHOOK_PATH }),
      node("Expected signature", "n8n-nodes-base.crypto", 1, [220, 0], {
        action: "hmac", type: "SHA256", encoding: "hex", dataPropertyName: "expectedSignature", secret: cfg.TWENTY_WEBHOOK_SECRET,
        value: "={{ String($json.headers['x-twenty-webhook-timestamp'] ?? '') + ':' + JSON.stringify($json.body) }}",
      }),
      code("Check and pick record", [440, 0], `
// Twenty signs "timestamp:body" with the webhook secret. Unsigned, stale or foreign events stop here.
const out = [];
for (const { json } of $input.all()) {
  const sig = String(json.headers?.["x-twenty-webhook-signature"] ?? "");
  const ts = Number(json.headers?.["x-twenty-webhook-timestamp"] ?? 0);
  const fresh = Math.abs(Date.now() - (ts < 1e12 ? ts * 1000 : ts)) < 5 * 60 * 1000;
  const event = String(json.body?.eventName ?? "");
  const id = json.body?.record?.id;
  if (!sig || sig !== json.expectedSignature || !fresh) continue;
  if (!event.startsWith("platinumAit.") || !id) continue;
  out.push({ json: {
    recordId: id,
    eventName: event,
    workspaceId: ${JSON.stringify(cfg.TWENTY_WORKSPACE_ID)},
    eventId: String(json.headers?.["x-twenty-webhook-nonce"] ?? \`\${event}:\${id}:\${json.body?.eventDate ?? ts}\`),
    sourceTime: json.body?.eventDate ?? null,
  } });
}
return out;`),
      http("Fetch record from Twenty", [660, 0], { url: `=${twenty}/rest/platinumAits/{{ $json.recordId }}`, auth: twentyAuth, continueOnError: true }),
      code("Build provisioning request", [880, 0], `${MAP_TWENTY}
// The webhook only says which record changed; Twenty's API is the source of truth.
const ev = $('Check and pick record').item.json;
const rec = $json.data?.platinumAit ?? $json.data ?? null;
if (!rec || $json.error) {
  if (!/\\.(deleted|destroyed)$/.test(ev.eventName)) throw new Error("Couldn't read the record from Twenty");
  return { json: { workspaceId: ev.workspaceId, object: "platinumAit", recordId: ev.recordId, eventId: ev.eventId, sourceTime: ev.sourceTime, record: { name: null, email: null, phone: null, deletedAt: new Date().toISOString() } } };
}
return { json: { workspaceId: ev.workspaceId, object: "platinumAit", recordId: ev.recordId, eventId: ev.eventId, sourceTime: ev.sourceTime, record: mapRecord(rec) } };`, "runOnceForEachItem"),
      http("Send to dashboard", [1100, 0], { method: "POST", url: `${app}/api/integrations/twenty/recruit`, auth: appAuth, body: "={{ JSON.stringify($json) }}" }),
    ],
    connections: link("Twenty webhook", "Expected signature", "Check and pick record", "Fetch record from Twenty", "Build provisioning request", "Send to dashboard"),
  };

  /* 2. Catch-up: recently changed records, in case a webhook was missed. The app ignores pre-go-live records. */
  const catchUp = {
    name: "Platinum AIT - Twenty catch-up",
    settings: PRIVATE,
    nodes: [
      every("Every 15 minutes", [0, 0], "minutes", 15),
      http("Recently changed records", [220, 0], {
        url: `${twenty}/rest/platinumAits`, auth: twentyAuth, pagination: twentyPages,
        query: [{ name: "limit", value: "60" }, { name: "filter", value: "=updatedAt[gte]:\"{{ $now.minus({ hours: 2 }).toUTC().toISO() }}\"" }],
      }),
      code("One request per record", [440, 0], `${MAP_TWENTY}
const out = [];
for (const { json } of $input.all()) {
  for (const rec of json.data?.platinumAits ?? []) {
    out.push({ json: { workspaceId: ${JSON.stringify(cfg.TWENTY_WORKSPACE_ID)}, object: "platinumAit", recordId: rec.id, eventId: \`poll:\${rec.id}:\${rec.updatedAt}\`, sourceTime: rec.updatedAt ?? null, record: mapRecord(rec) } });
  }
}
return out;`),
      http("Send to dashboard", [660, 0], { method: "POST", url: `${app}/api/integrations/twenty/recruit`, auth: appAuth, body: "={{ JSON.stringify($json) }}" }),
    ],
    connections: link("Every 15 minutes", "Recently changed records", "One request per record", "Send to dashboard"),
  };

  /* 3. Outbox: claim rendered messages, send each, report each. */
  const send = {
    name: "Platinum AIT - Send messages",
    settings: PRIVATE,
    nodes: [
      every("Every minute", [0, 0], "minutes", 1),
      http("Claim messages", [220, 0], { method: "POST", url: `${app}/api/integrations/outbox/claim`, auth: appAuth, body: "{}" }),
      code("One item per message", [440, 0], `
const out = [];
for (const ev of $input.first().json.events ?? []) for (const m of ev.messages) out.push({ json: { eventId: ev.id, ...m } });
return out;`),
      node("Email or text?", "n8n-nodes-base.if", 2, [660, 0], {
        conditions: { options: { caseSensitive: true, typeValidation: "strict" }, combinator: "and", conditions: [{ id: "c1", leftValue: "={{ $json.channel }}", rightValue: "email", operator: { type: "string", operation: "equals" } }] },
        options: {},
      }),
      node("Send email", "n8n-nodes-base.emailSend", 2.1, [880, -100], {
        fromEmail: cfg.MAIL_FROM, toEmail: "={{ $json.to }}", subject: "={{ $json.subject }}", emailFormat: "both", text: "={{ $json.text }}", html: "={{ $json.html || $json.text }}",
        options: { appendAttribution: false },
      }, { credentials: { smtp: { id: creds.smtp.id, name: creds.smtp.name } }, onError: "continueRegularOutput" }),
      http("Send text (Telnyx)", [880, 100], {
        method: "POST", url: "https://api.telnyx.com/v2/messages", auth: headerAuth(creds.telnyx.id, creds.telnyx.name), retry: false, continueOnError: true,
        body: `={{ JSON.stringify({ from: ${JSON.stringify(cfg.TELNYX_FROM)}, to: $json.to, text: $json.text }) }}`,
      }),
      code("Delivery report", [1100, 0], `
const m = $('One item per message').item.json;
const failed = Boolean($json.error);
const detail = failed ? String($json.error?.message ?? $json.error).slice(0, 200) : null;
return { json: { eventId: m.eventId, deliveries: [{ dedupeKey: m.dedupeKey, recipient: m.to, channel: m.channel, purpose: m.purpose, status: failed ? "failed" : "sent", providerRef: $json.messageId ?? $json.data?.id ?? null, detail }] } };`, "runOnceForEachItem"),
      http("Report to dashboard", [1320, 0], { method: "POST", url: `=${app}/api/integrations/outbox/{{ $json.eventId }}/result`, auth: appAuth, body: "={{ JSON.stringify({ deliveries: $json.deliveries }) }}" }),
    ],
    connections: merge(
      link("Every minute", "Claim messages", "One item per message", "Email or text?"),
      link(["Email or text?", 0], "Send email", "Delivery report"),
      link(["Email or text?", 1], "Send text (Telnyx)", "Delivery report"),
      link("Delivery report", "Report to dashboard"),
    ),
  };

  /* 4. Upkeep: resume stuck account setup hourly; inactivity reminders daily at 9 am Denver. */
  const upkeep = {
    name: "Platinum AIT - Upkeep",
    settings: UPKEEP,
    nodes: [
      every("Hourly", [0, 0], "hours", 1),
      http("Resume account setup", [220, 0], { method: "POST", url: `${app}/api/integrations/reconcile`, auth: appAuth, body: "{}" }),
      node("Daily 9 am", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 200], { rule: { interval: [{ field: "days", daysInterval: 1, triggerAtHour: 9 }] } }),
      http("Inactivity reminders", [220, 200], { method: "POST", url: `${app}/api/integrations/inactivity`, auth: appAuth, body: "{}" }),
    ],
    connections: merge(link("Hourly", "Resume account setup"), link("Daily 9 am", "Inactivity reminders")),
  };

  /* 5. Momentum AMP read-only sync. Field mapping is finished once the API key and docs are in hand. */
  const momentum = {
    name: "Platinum AIT - Momentum AMP sync",
    settings: PRIVATE,
    nodes: [
      every("Every 30 minutes", [0, 0], "minutes", 30),
      http("Read policies from Momentum", [220, 0], { url: cfg.MOMENTUM_POLICIES_URL, auth: headerAuth(creds.momentum.id, creds.momentum.name), query: [{ name: "updatedSince", value: "={{ $now.minus({ days: 3 }).toISODate() }}" }] }),
      code("Map to dashboard policies", [440, 0], `
// Momentum AMP → dashboard policy rows. Adjust the field names below to the API's actual response
// (confirm against a real read-only response before activating). Unknown business types are sent as "quote" so they never count.
const rows = [];
const items = $input.all().flatMap(({ json }) => json.data ?? json.policies ?? json.items ?? (Array.isArray(json) ? json : [json]));
const cents = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 100));
const kind = (v) => { const s = String(v ?? "").toLowerCase(); return s.includes("renew") ? "renewal" : s.includes("rewrite") ? "rewrite" : s.includes("endorse") ? "endorsement" : s.includes("new") ? "new" : "quote"; };
for (const p of items) {
  const producerId = p.producerId ?? p.producer_id ?? p.agentId ?? p.agent_id;
  const externalRef = p.policyNumber ?? p.policy_number ?? p.id;
  const written = String(p.writtenDate ?? p.written_date ?? p.dateWritten ?? "").slice(0, 10);
  if (!producerId || !externalRef || !/^\\d{4}-\\d{2}-\\d{2}$/.test(written)) continue;
  const status = String(p.status ?? "").toLowerCase();
  rows.push({
    producerId: String(producerId), externalRef: String(externalRef),
    policyType: String(p.lineOfBusiness ?? p.policyType ?? p.line ?? "Other"), carrier: p.carrier ?? p.carrierName ?? null,
    businessType: kind(p.businessType ?? p.transactionType ?? p.type), writtenDate: written,
    effectiveDate: p.effectiveDate ? String(p.effectiveDate).slice(0, 10) : null,
    termMonths: p.termMonths ?? p.term ?? null, termPremiumCents: cents(p.premium ?? p.termPremium ?? p.writtenPremium),
    annualizedCents: cents(p.annualizedPremium ?? p.annualPremium),
    cancelled: status.includes("cancel"),
  });
}
return [{ json: { rows } }];`),
      http("Send to dashboard", [660, 0], { method: "POST", url: `${app}/api/integrations/momentum/policies`, auth: appAuth, body: "={{ JSON.stringify($json) }}" }),
    ],
    connections: link("Every 30 minutes", "Read policies from Momentum", "Map to dashboard policies", "Send to dashboard"),
  };

  /* 6. Backfill of records that predate go-live. Manual only: preview, get Colton's OK, then switch mode to "apply". */
  const backfill = {
    name: "Platinum AIT - Backfill (manual, preview first)",
    settings: PRIVATE,
    nodes: [
      node("Run by hand", "n8n-nodes-base.manualTrigger", 1, [0, 0], {}),
      node("Options", "n8n-nodes-base.set", 3.4, [220, 0], { mode: "raw", jsonOutput: '{ "mode": "preview", "sendWelcome": false }', options: {} }),
      http("All Platinum AIT records", [440, 0], { url: `${twenty}/rest/platinumAits`, auth: twentyAuth, pagination: twentyPages, query: [{ name: "limit", value: "60" }] }),
      code("Build backfill request", [660, 0], `${MAP_TWENTY}
const opts = $('Options').first().json;
const records = $input.all().flatMap(({ json }) => json.data?.platinumAits ?? []).map((rec) => ({ recordId: rec.id, ...mapRecord(rec) }));
return [{ json: { mode: opts.mode === "apply" ? "apply" : "preview", sendWelcome: opts.sendWelcome === true, workspaceId: ${JSON.stringify(cfg.TWENTY_WORKSPACE_ID)}, records } }];`),
      http("Dashboard backfill", [880, 0], { method: "POST", url: `${app}/api/integrations/twenty/backfill`, auth: appAuth, body: "={{ JSON.stringify($json) }}", retry: false }),
    ],
    connections: link("Run by hand", "Options", "All Platinum AIT records", "Build backfill request", "Dashboard backfill"),
  };

  return [sync, catchUp, send, upkeep, momentum, backfill];
}

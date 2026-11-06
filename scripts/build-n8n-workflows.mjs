#!/usr/bin/env node
// Generates the version-controlled n8n workflow exports in workflows/n8n/.
// Workflows call the hub over the private Docker network with the "Household Hub API token" credential,
// which is created at import time from .env (scripts/n8n-import.sh) and never stored in these files.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "../workflows/n8n");
fs.mkdirSync(OUT, { recursive: true });
const HUB = "http://hub:3000";
const CREDENTIAL = { httpHeaderAuth: { id: "hubApiToken", name: "Household Hub API token" } };

// Deterministic ids so regenerating does not churn the diff.
const uid = (seed) => {
  const h = crypto.createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const schedule = (wf, name, cron, x = 0) => ({
  id: uid(`${wf}:${name}`),
  name,
  type: "n8n-nodes-base.scheduleTrigger",
  typeVersion: 1.2,
  position: [x, 0],
  parameters: { rule: { interval: [{ field: "cronExpression", expression: cron }] } },
});

const hubCall = (wf, name, method, pathname, x, timeout = 60000) => ({
  id: uid(`${wf}:${name}`),
  name,
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position: [x, 0],
  parameters: {
    method,
    url: `${HUB}${pathname}`,
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    sendBody: method !== "GET",
    specifyBody: "json",
    jsonBody: "={}",
    options: { timeout },
  },
  credentials: CREDENTIAL,
  retryOnFail: true,
  maxTries: 3,
  waitBetweenTries: 5000,
});

const ifNotEmpty = (wf, name, expr, x) => ({
  id: uid(`${wf}:${name}`),
  name,
  type: "n8n-nodes-base.if",
  typeVersion: 2.2,
  position: [x, 0],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
      conditions: [{ id: uid(`${wf}:${name}:c`), leftValue: expr, rightValue: "", operator: { type: "string", operation: "notEmpty", singleValue: true } }],
      combinator: "and",
    },
    options: {},
  },
});

// Optional phone push. Disabled by default: set your own ntfy topic (or replace with email/Slack) and enable.
const push = (wf, title, x) => ({
  id: uid(`${wf}:push`),
  name: "Send push notification (optional)",
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position: [x, -120],
  disabled: true,
  notes: "Replace <your-private-topic> with your own ntfy topic, or swap this node for Email/Slack. The message is also in the hub's notification feed.",
  parameters: {
    method: "POST",
    url: "https://ntfy.sh/<your-private-topic>",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: "Title", value: title }, { name: "Click", value: "={{ $json.link || '' }}" }] },
    sendBody: true,
    contentType: "raw",
    rawContentType: "text/plain",
    body: "={{ $json.message }}",
    options: {},
  },
});

const note = (wf, text, x = -40, y = -320) => ({
  id: uid(`${wf}:note`),
  name: "About",
  type: "n8n-nodes-base.stickyNote",
  typeVersion: 1,
  position: [x, y],
  parameters: { content: text, height: 200, width: 520 },
});

const connect = (...names) => {
  const c = {};
  for (let i = 0; i < names.length - 1; i++) {
    const [from, to, branch] = Array.isArray(names[i + 1]) ? [names[i], names[i + 1][0], names[i + 1][1]] : [names[i], names[i + 1], 0];
    const fromName = Array.isArray(from) ? from[0] : from;
    c[fromName] ??= { main: [] };
    c[fromName].main[branch] ??= [];
    c[fromName].main[branch].push({ node: to, type: "main", index: 0 });
  }
  return c;
};

function workflow(file, name, nodes, connections, description) {
  const wf = {
    id: uid(`workflow:${file}`).replace(/-/g, "").slice(0, 16),
    name,
    active: false,
    nodes,
    connections,
    settings: { executionOrder: "v1", timezone: "America/Los_Angeles", saveDataErrorExecution: "all", saveDataSuccessExecution: "none" },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
    description,
  };
  fs.writeFileSync(path.join(OUT, `${file}.json`), `${JSON.stringify(wf, null, 2)}\n`);
}

// 1. Weekly meal planning — Saturday 09:00: draft next week's plan (not saved to Mealie) and notify.
workflow(
  "weekly-meal-planning",
  "Household Hub · Weekly meal planning",
  [
    note("wmp", "## Weekly meal planning\nSaturday 09:00. Asks the hub for a draft plan for next week's empty slots (cloud AI if configured, otherwise the built-in planner). The draft is **not** written to Mealie: someone reviews and saves it on /meals. A notification is added to the hub's feed."),
    schedule("wmp", "Saturday 09:00", "0 9 * * 6"),
    hubCall("wmp", "Draft next week's plan", "POST", "/api/automation/meal-plan", 260, 180000),
    ifNotEmpty("wmp", "Draft created?", "={{ $json.message }}", 520),
    push("wmp", "Meal plan draft ready", 780),
  ],
  connect("Saturday 09:00", "Draft next week's plan", "Draft created?", "Send push notification (optional)"),
  "Drafts next week's meals from inventory and preferences; a person approves them.",
);

// 2. Shopping preparation — Saturday 10:00: requirements − stock → store lists in Mealie.
workflow(
  "shopping-preparation",
  "Household Hub · Shopping preparation",
  [
    note("shp", "## Shopping preparation\nSaturday 10:00. Computes ingredients for the next 7 days of planned meals, subtracts usable stock, adds low-stock items, and updates the per-store lists (Trader Joe's, Grocery Outlet, Amazon Fresh) in Mealie. Idempotent. Never orders anything."),
    schedule("shp", "Saturday 10:00", "0 10 * * 6"),
    hubCall("shp", "Update store lists", "POST", "/api/automation/shopping", 260, 120000),
    ifNotEmpty("shp", "Lists changed?", "={{ $json.message }}", 520),
    push("shp", "Shopping lists updated", 780),
  ],
  connect("Saturday 10:00", "Update store lists", "Lists changed?", "Send push notification (optional)"),
  "Builds store-specific shopping lists from the meal plan and stock.",
);

// 3. Inventory alerts — daily 08:00: expiring / expired / low stock, deduplicated by the hub.
workflow(
  "inventory-alerts",
  "Household Hub · Inventory alerts",
  [
    note("alr", "## Inventory alerts\nDaily 08:00. The hub reports expiring, expired and below-minimum items. An unchanged alert is not repeated within `alerts.repeatAfterHours` (config/household.yaml), so this stays quiet unless something changed."),
    schedule("alr", "Daily 08:00", "0 8 * * *"),
    hubCall("alr", "Check inventory", "POST", "/api/automation/alerts", 260),
    ifNotEmpty("alr", "Anything new?", "={{ $json.message }}", 520),
    push("alr", "Kitchen check", 780),
  ],
  connect("Daily 08:00", "Check inventory", "Anything new?", "Send push notification (optional)"),
  "Low-stock and expiry alerts without repeats.",
);

// 4. Inventory reconciliation — Sunday 18:00: ask the household to check uncertain/perishable stock.
workflow(
  "inventory-reconciliation",
  "Household Hub · Inventory reconciliation",
  [
    note("rec", "## Inventory reconciliation\nSunday 18:00. Lists opened, perishable (product groups in config) and past-date items worth a quick physical check. Corrections are made on the product page in the hub (“Correct the count”)."),
    schedule("rec", "Sunday 18:00", "0 18 * * 0"),
    hubCall("rec", "Find items to check", "POST", "/api/automation/audit", 260),
    ifNotEmpty("rec", "Anything to check?", "={{ $json.message }}", 520),
    push("rec", "Quick inventory check", 780),
  ],
  connect("Sunday 18:00", "Find items to check", "Anything to check?", "Send push notification (optional)"),
  "Weekly prompt to audit uncertain or perishable stock.",
);

// 5. Maintenance — every 6 hours: finish Mealie bookkeeping for cooked meals.
workflow(
  "maintenance",
  "Household Hub · Maintenance",
  [
    note("mnt", "## Maintenance\nEvery 6 hours. Retries Mealie “last made” / timeline updates for meals whose stock was already deducted while Mealie was unreachable. Never changes stock."),
    schedule("mnt", "Every 6 hours", "0 */6 * * *"),
    hubCall("mnt", "Sync cooking records to Mealie", "POST", "/api/automation/maintenance", 260),
  ],
  connect("Every 6 hours", "Sync cooking records to Mealie"),
  "Retries best-effort Mealie bookkeeping.",
);

// 6. Receipt ingestion — template only (inactive). Needs a receipt source; no email credentials are included.
workflow(
  "receipt-ingestion-template",
  "Household Hub · Receipt ingestion (template)",
  [
    note("rcp", "## Receipt ingestion (template, inactive)\nReplace the webhook with your receipt source (e.g. an IMAP trigger + parser). Post receipts in the format of `apps/web/lib/receipts.ts`. The hub validates them but does not ingest yet (returns 501): receipts must never add stock directly — scanning is the single source of truth."),
    {
      id: uid("rcp:webhook"),
      name: "Receipt received",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2,
      position: [0, 0],
      webhookId: uid("rcp:webhookid"),
      parameters: { httpMethod: "POST", path: "household-receipts", responseMode: "onReceived", options: {} },
    },
    {
      ...hubCall("rcp", "Send to hub", "POST", "/api/automation/receipts", 260),
      parameters: {
        ...hubCall("rcp", "x", "POST", "/api/automation/receipts", 0).parameters,
        jsonBody: "={{ JSON.stringify($json.body) }}",
      },
    },
  ],
  connect("Receipt received", "Send to hub"),
  "Template for future receipt ingestion.",
);

console.log(`workflows written to ${OUT}`);

#!/usr/bin/env node
// Household Hub bootstrap: prepares .env, then connects to freshly started Grocy and Mealie to create
// API credentials, replace default admin passwords and create the Mealie lists/actions the hub uses.
// Idempotent: re-running reuses whatever already works. Never prints secret values.
//
// Usually run through scripts/bootstrap.sh, which starts the containers first.
//   node scripts/bootstrap.mjs env        # only create/complete .env
//   node scripts/bootstrap.mjs services   # configure Grocy + Mealie (they must be running)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const EXAMPLE = path.join(ROOT, ".env.example");
const GENERATED = new Set(["", "<GENERATED>"]);

function readEnv(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/** Update keys in .env in place, preserving comments and order; append unknown keys. */
function writeEnv(updates) {
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : fs.readFileSync(EXAMPLE, "utf8");
  const seen = new Set();
  const lines = text.split(/\r?\n/).map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && m[1] in updates) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
}

const rand = (bytes) => crypto.randomBytes(bytes).toString("base64url");
const log = (msg) => console.log(`• ${msg}`);

function prepareEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(EXAMPLE, ENV_FILE);
    fs.chmodSync(ENV_FILE, 0o600);
    log("created .env from .env.example");
  }
  const env = readEnv(ENV_FILE);
  const updates = {};
  const gen = (key, value) => {
    if (GENERATED.has(env.get(key) ?? "")) updates[key] = value;
  };
  gen("HUB_PASSWORD", rand(12));
  gen("HUB_SESSION_SECRET", rand(48));
  gen("HUB_API_TOKEN", rand(32));
  gen("GMS_AUTH_SECRET", rand(32));
  gen("N8N_ENCRYPTION_KEY", rand(32));
  gen("GROCY_ADMIN_PASSWORD", rand(18));
  gen("MEALIE_ADMIN_PASSWORD", rand(18));
  if (process.env.DETECTED_LAN_IP && (env.get("HUB_HOSTNAME") ?? "") === "192.168.1.105" && process.env.DETECTED_LAN_IP !== "192.168.1.105") {
    const ip = process.env.DETECTED_LAN_IP;
    Object.assign(updates, { HUB_HOSTNAME: ip, PUBLIC_BASE_URL: `https://${ip}`, MEALIE_PUBLIC_URL: `https://${ip}:9443` });
  }
  if ((env.get("OFF_USER_AGENT") ?? "").includes("<CONTACT_EMAIL>")) updates.OFF_USER_AGENT = "HouseholdHub/0.1 (self-hosted)";
  if (Object.keys(updates).length) {
    writeEnv(updates);
    log(`set ${Object.keys(updates).join(", ")} in .env (values not shown)`);
  } else {
    log(".env already complete");
  }
}

// ---- HTTP helpers --------------------------------------------------------

async function waitFor(name, url, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${name} did not become reachable at ${url}`);
}

function cookieJar() {
  const jar = new Map();
  return {
    store(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

// ---- Grocy ---------------------------------------------------------------

async function grocyKeyWorks(base, key) {
  if (!key) return false;
  const r = await fetch(`${base}/api/system/info`, { headers: { "GROCY-API-KEY": key } });
  return r.ok;
}

async function grocyLogin(base, username, password) {
  const jar = cookieJar();
  jar.store(await fetch(`${base}/login`, { redirect: "manual" }));
  // Grocy 4.7's login form submits the password base64-encoded (field "password_base64").
  const r = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
    body: new URLSearchParams({ username, password_base64: Buffer.from(password, "utf8").toString("base64"), remember_me: "on" }),
    redirect: "manual",
  });
  jar.store(r);
  // A successful login redirects away from /login.
  const location = r.headers.get("location") ?? "";
  if (r.status >= 300 && r.status < 400 && !location.includes("login")) return jar;
  return null;
}

async function setupGrocy(env, updates) {
  const base = process.env.GROCY_BOOTSTRAP_URL ?? `http://127.0.0.1:${env.get("GROCY_ADMIN_PORT") || 9283}`;
  await waitFor("Grocy", `${base}/login`);
  // Grocy creates/migrates its database only when the root page is requested.
  const root = await fetch(`${base}/`, { redirect: "manual" });
  if (root.status >= 500) throw new Error(`Grocy database migration failed (HTTP ${root.status}); see docker compose logs grocy`);
  if (await grocyKeyWorks(base, env.get("GROCY_API_KEY"))) {
    log("Grocy API key already works");
    return;
  }
  const desired = env.get("GROCY_ADMIN_PASSWORD");
  let jar = await grocyLogin(base, "admin", "admin");
  const usedDefault = !!jar;
  if (!jar) jar = await grocyLogin(base, "admin", desired);
  if (!jar) throw new Error("Could not sign in to Grocy as admin (neither the default nor GROCY_ADMIN_PASSWORD worked)");

  // Grocy's own "Add API key" action creates a key for the signed-in user and redirects to ?key=<id>.
  // API keys are not exposed through Grocy's REST API, so the new key is read from that page.
  const created = await fetch(`${base}/manageapikeys/new`, { headers: { Cookie: jar.header() }, redirect: "manual" });
  jar.store(created);
  const keyId = (created.headers.get("location") ?? "").match(/[?&]key=(\d+)/)?.[1];
  if (!keyId) throw new Error("Grocy did not create an API key");
  const page = await (await fetch(`${base}/manageapikeys?key=${keyId}`, { headers: { Cookie: jar.header() } })).text();
  const apiKey = page.match(new RegExp(`data-apikey-id="${keyId}"\\s+data-apikey-key="([A-Za-z0-9]+)"`))?.[1];
  if (!apiKey || !(await grocyKeyWorks(base, apiKey))) throw new Error("Could not read the new Grocy API key");
  updates.GROCY_API_KEY = apiKey;
  log("created a Grocy API key");

  if (usedDefault) {
    const users = await (await fetch(`${base}/api/users`, { headers: { "GROCY-API-KEY": apiKey } })).json();
    const admin = users.find((u) => u.username === "admin");
    const res = await fetch(`${base}/api/users/${admin.id}`, {
      method: "PUT",
      headers: { "GROCY-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", first_name: admin.first_name ?? "", last_name: admin.last_name ?? "", password: desired }),
    });
    if (!res.ok) throw new Error(`Could not change Grocy's default admin password (HTTP ${res.status})`);
    if (!(await grocyLogin(base, "admin", desired))) throw new Error("Grocy did not accept the new admin password");
    log("replaced Grocy's default admin password (GROCY_ADMIN_PASSWORD)");
  }
}

// ---- Mealie --------------------------------------------------------------

async function mealieToken(base, username, password) {
  const r = await fetch(`${base}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
  });
  if (!r.ok) return null;
  return (await r.json()).access_token ?? null;
}

async function mealie(base, token, method, p, body) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Mealie ${method} ${p} → HTTP ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function setupMealie(env, updates) {
  const base = process.env.MEALIE_BOOTSTRAP_URL ?? `http://127.0.0.1:${env.get("MEALIE_ADMIN_PORT") || 9925}`;
  await waitFor("Mealie", `${base}/api/app/about`);
  let token = env.get("MEALIE_API_TOKEN");
  const works = token ? (await fetch(`${base}/api/users/self`, { headers: { Authorization: `Bearer ${token}` } })).ok : false;

  if (!works) {
    const email = env.get("MEALIE_ADMIN_EMAIL") || "admin@household.local";
    const desired = env.get("MEALIE_ADMIN_PASSWORD");
    let session = await mealieToken(base, "changeme@example.com", "MyPassword");
    const usedDefault = !!session;
    if (!session) session = await mealieToken(base, email, desired);
    if (!session) throw new Error("Could not sign in to Mealie (neither the default admin nor MEALIE_ADMIN_EMAIL/PASSWORD worked)");

    const created = await mealie(base, session, "POST", "/api/users/api-tokens", { name: `household-hub-${new Date().toISOString().slice(0, 10)}` });
    token = created.token;
    updates.MEALIE_API_TOKEN = token;
    log("created a Mealie API token");

    if (usedDefault) {
      const self = await mealie(base, session, "GET", "/api/users/self");
      await mealie(base, session, "PUT", "/api/users/password", { currentPassword: "MyPassword", newPassword: desired });
      await mealie(base, token, "PUT", `/api/users/${self.id}`, { ...self, email, username: self.username ?? "admin" });
      log("replaced Mealie's default admin login (MEALIE_ADMIN_EMAIL / MEALIE_ADMIN_PASSWORD)");
    }
  } else {
    log("Mealie API token already works");
  }

  // Shopping list that Grocy-Mealie Sync fills from Grocy low stock.
  const lists = (await mealie(base, token, "GET", "/api/households/shopping/lists?perPage=-1")).items;
  let needs = lists.find((l) => l.id === env.get("MEALIE_NEEDS_LIST_ID")) ?? lists.find((l) => l.extras?.hub_role === "gms_needs");
  if (!needs) {
    needs = await mealie(base, token, "POST", "/api/households/shopping/lists", { name: "Low stock (synced from Grocy)", extras: { hub_role: "gms_needs" } });
    log("created the Mealie low-stock list for Grocy-Mealie Sync");
  }
  if (env.get("MEALIE_NEEDS_LIST_ID") !== needs.id) updates.MEALIE_NEEDS_LIST_ID = needs.id;

  // Recipe action: opens the hub's "we cooked this" page from any Mealie recipe.
  const hubUrl = (updates.PUBLIC_BASE_URL ?? env.get("PUBLIC_BASE_URL") ?? "https://localhost").replace(/\/$/, "");
  const actionUrl = `${hubUrl}/cook/\${slug}?servings=\${servings}`;
  const actions = (await mealie(base, token, "GET", "/api/households/recipe-actions?perPage=-1")).items;
  const existing = actions.find((a) => a.title === "Mark cooked in Household Hub");
  if (!existing) {
    await mealie(base, token, "POST", "/api/households/recipe-actions", { actionType: "link", title: "Mark cooked in Household Hub", url: actionUrl });
    log("added the Mealie recipe action “Mark cooked in Household Hub”");
  } else if (existing.url !== actionUrl) {
    await mealie(base, token, "PUT", `/api/households/recipe-actions/${existing.id}`, { ...existing, url: actionUrl });
    log("updated the Mealie recipe action URL");
  }
}

// ---- main ----------------------------------------------------------------

const mode = process.argv[2] ?? "all";
try {
  if (mode === "env" || mode === "all") prepareEnv();
  if (mode === "services" || mode === "all") {
    const env = readEnv(ENV_FILE);
    const updates = {};
    try {
      await setupGrocy(env, updates);
      await setupMealie(env, updates);
    } finally {
      if (Object.keys(updates).length) writeEnv(updates);
    }
  }
  log("bootstrap step complete");
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

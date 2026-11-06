#!/usr/bin/env node
// Deterministic stand-in for Grocy 4.x, Mealie v3, Grocy-Mealie Sync and Open Food Facts, used by the
// browser (E2E) tests while no real stack is available. It implements only what the hub calls, with the
// semantics the hub relies on. Passing E2E tests against this mock does NOT verify the real services.
//
//   node tests/support/mock-upstreams.mjs [port]      (default 4010)
//   GET  /__state   → stock totals, calls, shopping items
//   POST /__reset   → back to the seed state
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 4010);
export const KEYS = { grocy: "mock-grocy-key", mealie: "mock-mealie-token", gms: "mock-gms-secret" };

function gs1(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return `${body}${(10 - (sum % 10)) % 10}`;
}
// In-store "restricted circulation" EAN-13 prefixes (20–29) never collide with real products.
export const BARCODES = {
  barilla: gs1("200000000001"),
  tjPenne: gs1("200000000002"),
  milk: gs1("200000000003"),
  eggs: gs1("200000000004"),
  chicken: gs1("200000000005"),
  tomatoes: gs1("200000000006"),
  unknownOff: "3017620422003", // known to the mock Open Food Facts
  unknownNone: gs1("200000000099"), // unknown everywhere
};

// Local calendar dates, like the household (and the hub, which uses TZ).
const iso = (d) => d.toLocaleDateString("en-CA");
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

let S;
let nextGlobalId = 1000;
function seed() {
  const today = iso(new Date());
  S = {
    nextEntry: 1,
    nextLog: 1,
    nextTx: 1,
    calls: [],
    units: [
      [1, "g", "g"],
      [2, "kg", "kg"],
      [3, "mL", "mL"],
      [4, "L", "L"],
      [5, "Piece", "Pieces"],
      [6, "Pack", "Packs"],
      [7, "lb", "lb"],
      [9, "cup", "cups"],
      [10, "tbsp", "tbsp"],
    ].map(([id, name, name_plural]) => ({ id, name, name_plural, description: null })),
    conversions: [
      [null, 2, 1, 1000],
      [null, 4, 3, 1000],
      [null, 7, 1, 453.59237],
      [null, 9, 3, 236.5882365],
      [null, 10, 3, 14.78676478125],
    ].map(([product_id, from_qu_id, to_qu_id, factor], i) => ({ id: i + 1, product_id, from_qu_id, to_qu_id, factor })),
    locations: [
      { id: 1, name: "Pantry", is_freezer: 0 },
      { id: 2, name: "Fridge", is_freezer: 0 },
      { id: 3, name: "Freezer", is_freezer: 1 },
    ],
    stores: [
      { id: 1, name: "Trader Joe's" },
      { id: 2, name: "Grocery Outlet" },
      { id: 3, name: "Amazon Fresh" },
    ],
    groups: [
      { id: 1, name: "Pantry staples" },
      { id: 2, name: "Dairy" },
      { id: 3, name: "Meat" },
    ],
    products: [],
    barcodes: [],
    entries: [],
    log: [],
    foods: [],
    mealieUnits: [
      { id: "mu-g", name: "gram", abbreviation: "g" },
      { id: "mu-lb", name: "pound", abbreviation: "lb" },
      { id: "mu-cup", name: "cup", abbreviation: "c" },
      { id: "mu-tbsp", name: "tablespoon", abbreviation: "tbsp" },
      { id: "mu-piece", name: "piece", abbreviation: "" },
    ].map((u) => ({ pluralName: null, standardQuantity: null, standardUnit: null, ...u })),
    recipes: [],
    mealplans: [],
    lists: [{ id: "list-needs", name: "Low stock (synced from Grocy)", extras: { hub_role: "gms_needs" } }],
    items: [],
    timeline: [],
    productMappings: [],
    unitMappings: [
      ["mu-g", "gram", "g", 1, "g"],
      ["mu-lb", "pound", "lb", 7, "lb"],
      ["mu-cup", "cup", "c", 9, "cup"],
      ["mu-tbsp", "tablespoon", "tbsp", 10, "tbsp"],
      ["mu-piece", "piece", "", 5, "Piece"],
    ].map(([mealieUnitId, mealieUnitName, mealieUnitAbbreviation, grocyUnitId, grocyUnitName], i) => ({ id: `um${i}`, mealieUnitId, mealieUnitName, mealieUnitAbbreviation, grocyUnitId, grocyUnitName, conversionFactor: 1 })),
  };
  const P = (id, name, qu, extra = {}) =>
    S.products.push({ id, name, description: "", location_id: 1, qu_id_stock: qu, qu_id_purchase: qu, qu_id_consume: qu, qu_id_price: qu, min_stock_amount: 0, default_best_before_days: 0, parent_product_id: null, no_own_stock: 0, active: 1, product_group_id: null, shopping_location_id: null, calories: null, ...extra });
  P(10, "Pasta", 1, { no_own_stock: 1 });
  P(11, "Barilla Spaghetti 1 lb", 1, { parent_product_id: 10, default_best_before_days: 365, product_group_id: 1 });
  P(12, "Trader Joe's Penne 500 g", 1, { parent_product_id: 10, default_best_before_days: 365, product_group_id: 1 });
  P(20, "Milk", 3, { location_id: 2, default_best_before_days: 7, min_stock_amount: 946, product_group_id: 2 });
  P(30, "Eggs", 5, { location_id: 2, default_best_before_days: 21, product_group_id: 2 });
  P(40, "Chicken thighs", 1, { location_id: 3, default_best_before_days: 3, product_group_id: 3 });
  P(50, "Canned tomatoes", 1, { default_best_before_days: 730 });
  P(60, "Onion", 5, { default_best_before_days: 30 });
  P(70, "Parmesan", 1, { location_id: 2, default_best_before_days: 60, product_group_id: 2 });
  const B = (product_id, barcode, amount, qu_id) => S.barcodes.push({ id: S.barcodes.length + 1, product_id, barcode, amount, qu_id, shopping_location_id: null, note: null });
  B(11, BARCODES.barilla, 1, 7);
  B(12, BARCODES.tjPenne, 500, 1);
  B(20, BARCODES.milk, 946, 3);
  B(30, BARCODES.eggs, 12, 5);
  B(40, BARCODES.chicken, 680, 1);
  B(50, BARCODES.tomatoes, 794, 1);
  addEntry(11, 453.59237, "2027-03-01");
  addEntry(12, 500, "2026-12-01");
  addEntry(20, 946, day(5), 2);
  addEntry(30, 12, day(18), 2);
  addEntry(40, 680, day(1), 3);
  addEntry(50, 794, "2028-01-01");
  addEntry(50, 794, "2028-02-01");
  addEntry(60, 3, day(20));
  addEntry(70, 150, day(40), 2);

  const F = (id, name, extra = {}) => S.foods.push({ id, name, pluralName: null, description: null, labelId: null, aliases: [], substitutions: [], householdsWithIngredientFood: [], ...extra });
  F("food-pasta", "Pasta");
  F("food-milk", "Milk");
  F("food-egg", "Egg");
  F("food-chicken", "Chicken thighs");
  F("food-tomatoes", "Canned tomatoes");
  F("food-onion", "Onion");
  F("food-parmesan", "Parmesan");
  F("food-butter", "Butter");
  F("food-salt", "Salt");
  for (const [foodId, productId] of [["food-pasta", 10], ["food-milk", 20], ["food-egg", 30], ["food-chicken", 40], ["food-tomatoes", 50], ["food-onion", 60], ["food-parmesan", 70]]) {
    S.productMappings.push({ id: `pm-${foodId}`, mealieFoodId: foodId, mealieFoodName: S.foods.find((f) => f.id === foodId).name, grocyProductId: productId, grocyProductName: S.products.find((p) => p.id === productId).name, unitMappingId: null });
  }
  const food = (id) => S.foods.find((f) => f.id === id);
  const unit = (id) => S.mealieUnits.find((u) => u.id === id);
  const I = (foodId, quantity, unitId, ref) => ({ quantity, unit: unitId ? unit(unitId) : null, food: foodId ? food(foodId) : null, note: "", display: [quantity, unitId ? unit(unitId).name : null, foodId ? food(foodId).name : null].filter((x) => x !== null && x !== undefined).join(" "), title: null, originalText: null, referenceId: ref, substitutions: [] });
  const R = (slug, name, servings, ingredients, extra = {}) =>
    S.recipes.push({ id: `recipe-${slug}`, slug, name, description: "", recipeServings: servings, recipeYieldQuantity: 0, recipeYield: null, totalTime: "30 minutes", prepTime: null, performTime: null, rating: 4, lastMade: null, tags: [], recipeCategory: [], tools: [], recipeIngredient: ingredients, recipeInstructions: [{ text: "Cook." }], nutrition: null, ...extra });
  R("spaghetti-al-pomodoro", "Spaghetti al Pomodoro", 4, [
    I("food-pasta", 1, "mu-lb", "r1-pasta"),
    I("food-tomatoes", 794, "mu-g", "r1-tom"),
    I("food-onion", 1, null, "r1-onion"),
    I("food-parmesan", 50, "mu-g", "r1-parm"),
    I("food-butter", 2, "mu-tbsp", "r1-butter"),
    I("food-salt", null, null, "r1-salt"),
  ]);
  R("scrambled-eggs", "Scrambled Eggs", 2, [I("food-egg", 4, null, "r2-egg"), I("food-milk", 0.25, "mu-cup", "r2-milk")]);
  R("garlic-chicken", "Garlic Chicken Thighs", 4, [I("food-chicken", 680, "mu-g", "r3-chicken"), I("food-onion", 1, null, "r3-onion")]);
  S.mealplans.push({ id: 501, date: today, entryType: "dinner", title: "", text: "", recipeId: "recipe-spaghetti-al-pomodoro" });
  S.mealplans.push({ id: 502, date: day(1), entryType: "lunch", title: "", text: "", recipeId: "recipe-scrambled-eggs" });
}

function addEntry(productId, amount, bestBefore, location = 1, note = null) {
  const stock_id = `stk${S.nextEntry}`;
  S.entries.push({ id: S.nextEntry++, product_id: productId, location_id: location, shopping_location_id: null, amount, best_before_date: bestBefore, purchased_date: iso(new Date()), stock_id, price: null, open: 0, opened_date: null, note, row_created_timestamp: new Date().toISOString() });
  return stock_id;
}

const total = (pid) => Math.round(S.entries.filter((e) => e.product_id === pid).reduce((s, e) => s + e.amount, 0) * 10000) / 10000;
const unitById = (id) => S.units.find((u) => u.id === id);

// ---- HTTP plumbing --------------------------------------------------------------

function send(res, status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString();
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    return Object.fromEntries(new URLSearchParams(t));
  }
}
function applyQuery(rows, url) {
  let out = [...rows];
  for (const q of url.searchParams.getAll("query[]")) {
    const m = q.match(/^(\w+)(!=|>=|<=|=|>|<|~)(.*)$/);
    if (!m) continue;
    const [, f, op, v] = m;
    out = out.filter((r) => {
      const x = r[f];
      if (op === "=") return String(x ?? "") === v;
      if (op === "!=") return String(x ?? "") !== v;
      if (op === ">") return Number(x) > Number(v);
      if (op === "<") return Number(x) < Number(v);
      if (op === "~") return String(x ?? "").toLowerCase().includes(v.toLowerCase());
      return true;
    });
  }
  const order = url.searchParams.get("order");
  if (order) {
    const [f, dir] = order.split(":");
    out.sort((a, b) => (Number(a[f]) - Number(b[f])) * (dir === "desc" ? -1 : 1));
  }
  const limit = Number(url.searchParams.get("limit") ?? 0);
  return limit ? out.slice(0, limit) : out;
}

// ---- Grocy ----------------------------------------------------------------------------

function details(p) {
  const qu = unitById(p.qu_id_stock);
  const entries = S.entries.filter((e) => e.product_id === p.id && e.amount > 0).sort((a, b) => a.best_before_date.localeCompare(b.best_before_date));
  return {
    product: p,
    product_barcodes: S.barcodes.filter((b) => b.product_id === p.id),
    quantity_unit_stock: qu,
    default_quantity_unit_purchase: unitById(p.qu_id_purchase),
    stock_amount: total(p.id),
    stock_amount_opened: 0,
    next_due_date: entries[0]?.best_before_date ?? null,
    last_price: null,
    location: S.locations.find((l) => l.id === p.location_id) ?? null,
    has_childs: S.products.some((c) => c.parent_product_id === p.id),
  };
}

function logRow(productId, amount, type, e, tx, note = null) {
  const row = { id: S.nextLog++, product_id: productId, amount, best_before_date: e.best_before_date, purchased_date: e.purchased_date, used_date: type === "consume" ? iso(new Date()) : null, spoiled: 0, stock_id: e.stock_id, transaction_id: tx, transaction_type: type, note, undone: 0, location_id: e.location_id, row_created_timestamp: new Date().toISOString().replace("T", " ").slice(0, 19) };
  S.log.push(row);
  return row;
}

async function grocy(req, res, url, path) {
  if (req.headers["grocy-api-key"] !== KEYS.grocy) return send(res, 401, { error_message: "Unauthorized" });
  const body = req.method === "GET" ? {} : await readBody(req);
  S.calls.push({ service: "grocy", method: req.method, path, body });
  let m;
  if (path === "/api/system/info") return send(res, 200, { grocy_version: { Version: "4.7.1-mock", ReleaseDate: "2026-09-04" } });
  if ((m = path.match(/^\/api\/objects\/(\w+)$/))) {
    const entity = m[1];
    const tables = {
      products: S.products,
      quantity_units: S.units,
      locations: S.locations,
      shopping_locations: S.stores,
      product_groups: S.groups,
      product_barcodes: S.barcodes,
      quantity_unit_conversions: S.conversions,
      quantity_unit_conversions_resolved: S.conversions,
      stock_log: S.log,
      stock_current_locations: S.products.map((p) => ({ product_id: p.id, location_id: p.location_id, amount: total(p.id) })).filter((r) => r.amount > 0),
    };
    if (req.method === "GET") return tables[entity] ? send(res, 200, applyQuery(tables[entity], url)) : send(res, 400, { error_message: "Entity not found" });
    if (req.method === "POST") {
      const id = nextGlobalId++;
      if (entity === "products") S.products.push({ id, description: "", min_stock_amount: 0, default_best_before_days: 0, parent_product_id: null, no_own_stock: 0, active: 1, ...body, qu_id_consume: body.qu_id_consume ?? body.qu_id_stock, qu_id_price: body.qu_id_price ?? body.qu_id_stock });
      else if (entity === "product_barcodes") S.barcodes.push({ id, shopping_location_id: null, note: null, ...body });
      else return send(res, 400, { error_message: "not supported by mock" });
      return send(res, 200, { created_object_id: id });
    }
  }
  if ((m = path.match(/^\/api\/objects\/products\/(\d+)$/))) {
    const p = S.products.find((x) => x.id === Number(m[1]));
    return p ? send(res, 200, p) : send(res, 404, { error_message: "not found" });
  }
  if (path === "/api/stock") return send(res, 200, S.products.filter((p) => total(p.id) > 0).map((p) => ({ product_id: p.id, amount: total(p.id), amount_aggregated: total(p.id), amount_opened: 0, best_before_date: S.entries.filter((e) => e.product_id === p.id && e.amount > 0).map((e) => e.best_before_date).sort()[0] ?? null, is_aggregated_amount: 0, product: p })));
  if (path === "/api/stock/volatile") {
    const soon = Number(url.searchParams.get("due_soon_days") ?? 5);
    const today = iso(new Date());
    const limit = day(soon);
    const due = [], overdue = [], expired = [], missing = [];
    for (const p of S.products) {
      const t = total(p.id);
      const next = S.entries.filter((e) => e.product_id === p.id && e.amount > 0).map((e) => e.best_before_date).sort()[0];
      if (next && next < today) overdue.push({ product_id: p.id, amount: t, best_before_date: next, product: p });
      else if (next && next <= limit) due.push({ product_id: p.id, amount: t, best_before_date: next, product: p });
      if (!p.no_own_stock && p.min_stock_amount > 0 && t < p.min_stock_amount) missing.push({ product_id: p.id, name: p.name, amount_missing: p.min_stock_amount - t, best_before_date: null });
    }
    return send(res, 200, { due_products: due, overdue_products: overdue, expired_products: expired, missing_products: missing });
  }
  if ((m = path.match(/^\/api\/stock\/products\/by-barcode\/(.+)$/))) {
    const b = S.barcodes.find((x) => x.barcode === decodeURIComponent(m[1]));
    if (!b) return send(res, 400, { error_message: `No product with barcode ${m[1]} found` });
    return send(res, 200, details(S.products.find((p) => p.id === b.product_id)));
  }
  if ((m = path.match(/^\/api\/stock\/products\/(\d+)$/))) {
    const p = S.products.find((x) => x.id === Number(m[1]));
    return p ? send(res, 200, details(p)) : send(res, 400, { error_message: "Product does not exist" });
  }
  if ((m = path.match(/^\/api\/stock\/products\/(\d+)\/entries$/))) return send(res, 200, S.entries.filter((e) => e.product_id === Number(m[1]) && e.amount > 0));
  if ((m = path.match(/^\/api\/stock\/products\/(\d+)\/add$/))) {
    const pid = Number(m[1]);
    const tx = `tx${S.nextTx++}`;
    const sid = addEntry(pid, Number(body.amount), body.best_before_date ?? iso(new Date()), body.location_id ?? 1, body.note ?? null);
    const e = S.entries.find((x) => x.stock_id === sid);
    return send(res, 200, [logRow(pid, Number(body.amount), "purchase", e, tx, body.note ?? null)]);
  }
  if ((m = path.match(/^\/api\/stock\/products\/(\d+)\/consume$/))) {
    const pid = Number(m[1]);
    const cands = S.entries
      .filter((e) => e.product_id === pid && e.amount > 0 && (!body.stock_entry_id || e.stock_id === body.stock_entry_id))
      .sort((a, b) => a.best_before_date.localeCompare(b.best_before_date) || a.id - b.id);
    const amount = Number(body.amount);
    if (amount > cands.reduce((s, e) => s + e.amount, 0) + 1e-9) return send(res, 400, { error_message: "Amount to be consumed cannot be > current stock amount" });
    const tx = `tx${S.nextTx++}`;
    let left = amount;
    const rows = [];
    for (const e of cands) {
      if (left <= 1e-9) break;
      const take = Math.min(e.amount, left);
      e.amount = Math.round((e.amount - take) * 10000) / 10000;
      left -= take;
      rows.push(logRow(pid, -take, "consume", e, tx));
    }
    return send(res, 200, rows);
  }
  if ((m = path.match(/^\/api\/stock\/products\/(\d+)\/inventory$/))) {
    const pid = Number(m[1]);
    const diff = Number(body.new_amount) - total(pid);
    const tx = `tx${S.nextTx++}`;
    if (Math.abs(diff) < 1e-9) return send(res, 200, []);
    if (diff > 0) {
      const sid = addEntry(pid, diff, body.best_before_date ?? "2999-12-31");
      return send(res, 200, [logRow(pid, diff, "inventory-correction", S.entries.find((x) => x.stock_id === sid), tx, body.note)]);
    }
    let left = -diff;
    const rows = [];
    for (const e of S.entries.filter((x) => x.product_id === pid && x.amount > 0)) {
      if (left <= 1e-9) break;
      const take = Math.min(e.amount, left);
      e.amount -= take;
      left -= take;
      rows.push(logRow(pid, -take, "inventory-correction", e, tx));
    }
    return send(res, 200, rows);
  }
  if ((m = path.match(/^\/api\/stock\/transactions\/([^/]+)\/undo$/))) {
    const rows = S.log.filter((r) => r.transaction_id === m[1]);
    if (!rows.length || rows.every((r) => r.undone)) return send(res, 400, { error_message: "Transaction does not exist or was already undone" });
    for (const r of rows) {
      r.undone = 1;
      const e = S.entries.find((x) => x.stock_id === r.stock_id);
      if (e) e.amount = Math.round((e.amount - r.amount) * 10000) / 10000;
    }
    return send(res, 204);
  }
  if ((m = path.match(/^\/api\/stock\/transactions\/([^/]+)$/))) {
    const rows = S.log.filter((r) => r.transaction_id === m[1]);
    return rows.length ? send(res, 200, rows) : send(res, 404, { error_message: "not found" });
  }
  return send(res, 404, { error_message: `mock grocy: ${req.method} ${path} not implemented` });
}

// ---- Mealie --------------------------------------------------------------------------

const summary = (r) => {
  const { recipeIngredient: _i, recipeInstructions: _s, ...rest } = r;
  return rest;
};
const page = (items) => ({ page: 1, per_page: items.length, total: items.length, total_pages: 1, items });
const planView = (p) => ({ ...p, groupId: "g", userId: "u", householdId: "h", recipe: p.recipeId ? summary(S.recipes.find((r) => r.id === p.recipeId)) : null });
const itemView = (i) => ({ ...i, food: i.foodId ? S.foods.find((f) => f.id === i.foodId) ?? null : null, unit: null, display: i.note ?? "" });

async function mealie(req, res, url, path) {
  if (req.headers.authorization !== `Bearer ${KEYS.mealie}`) return send(res, 401, { detail: "Not authenticated" });
  const body = req.method === "GET" ? {} : await readBody(req);
  S.calls.push({ service: "mealie", method: req.method, path, body });
  let m;
  if (path === "/api/app/about") return send(res, 200, { version: "v3.28.0-mock" });
  if (path === "/api/recipes") {
    const q = (url.searchParams.get("search") ?? "").toLowerCase();
    return send(res, 200, page(S.recipes.filter((r) => r.name.toLowerCase().includes(q)).map(summary)));
  }
  if ((m = path.match(/^\/api\/recipes\/([^/]+)\/last-made$/))) {
    const r = S.recipes.find((x) => x.slug === m[1]);
    if (r) r.lastMade = body.timestamp;
    return send(res, 200, r ?? null);
  }
  if ((m = path.match(/^\/api\/recipes\/([^/]+)$/))) {
    const r = S.recipes.find((x) => x.slug === m[1] || x.id === m[1]);
    return r ? send(res, 200, r) : send(res, 404, { detail: "not found" });
  }
  if (path === "/api/recipes/timeline/events" && req.method === "POST") {
    S.timeline.push(body);
    return send(res, 201, body);
  }
  if (path === "/api/foods") {
    if (req.method === "POST") {
      const f = { id: `food-${nextGlobalId++}`, pluralName: null, description: null, labelId: null, aliases: [], substitutions: [], householdsWithIngredientFood: [], ...body };
      S.foods.push(f);
      return send(res, 201, f);
    }
    const q = (url.searchParams.get("search") ?? "").toLowerCase();
    return send(res, 200, page(S.foods.filter((f) => f.name.toLowerCase().includes(q))));
  }
  if ((m = path.match(/^\/api\/foods\/([^/]+)$/))) {
    const f = S.foods.find((x) => x.id === m[1]);
    return f ? send(res, 200, f) : send(res, 404, { detail: "not found" });
  }
  if (path === "/api/units") return send(res, 200, page(S.mealieUnits));
  if (path === "/api/households/mealplans") {
    if (req.method === "POST") {
      const p = { id: nextGlobalId++, title: "", text: "", recipeId: null, ...body };
      S.mealplans.push(p);
      return send(res, 201, planView(p));
    }
    const s = url.searchParams.get("start_date") ?? "0000";
    const e = url.searchParams.get("end_date") ?? "9999";
    return send(res, 200, page(S.mealplans.filter((p) => p.date >= s && p.date <= e).map(planView)));
  }
  if ((m = path.match(/^\/api\/households\/mealplans\/(\d+)$/))) {
    const i = S.mealplans.findIndex((x) => x.id === Number(m[1]));
    if (i < 0) return send(res, 404, { detail: "not found" });
    if (req.method === "DELETE") return send(res, 200, planView(S.mealplans.splice(i, 1)[0]));
    if (req.method === "PUT") S.mealplans[i] = { ...S.mealplans[i], date: body.date, entryType: body.entryType, title: body.title ?? "", text: body.text ?? "", recipeId: body.recipeId ?? null };
    return send(res, 200, planView(S.mealplans[i]));
  }
  if (path === "/api/households/shopping/lists") {
    if (req.method === "POST") {
      const l = { id: `list-${nextGlobalId++}`, name: body.name, extras: body.extras ?? {} };
      S.lists.push(l);
      return send(res, 201, { ...l, listItems: [] });
    }
    return send(res, 200, page(S.lists));
  }
  if ((m = path.match(/^\/api\/households\/shopping\/lists\/([^/]+)$/))) {
    const l = S.lists.find((x) => x.id === m[1]);
    return l ? send(res, 200, { ...l, listItems: S.items.filter((i) => i.shoppingListId === l.id).map(itemView) }) : send(res, 404, { detail: "not found" });
  }
  if (path === "/api/households/shopping/items" && req.method === "POST") {
    const i = { id: `item-${nextGlobalId++}`, checked: false, position: 0, quantity: 1, note: "", foodId: null, unitId: null, extras: {}, ...body };
    S.items.push(i);
    return send(res, 201, { createdItems: [itemView(i)], updatedItems: [], deletedItems: [] });
  }
  if ((m = path.match(/^\/api\/households\/shopping\/items\/([^/]+)$/))) {
    const idx = S.items.findIndex((x) => x.id === m[1]);
    if (idx < 0) return send(res, 404, { detail: "not found" });
    if (req.method === "DELETE") {
      S.items.splice(idx, 1);
      return send(res, 200, {});
    }
    if (req.method === "PUT") S.items[idx] = { ...S.items[idx], ...body, id: S.items[idx].id };
    return send(res, 200, itemView(S.items[idx]));
  }
  if (path === "/api/households/recipe-actions") return send(res, 200, page([]));
  return send(res, 404, { detail: `mock mealie: ${req.method} ${path} not implemented` });
}

// ---- Grocy-Mealie Sync and Open Food Facts --------------------------------------------

async function gms(req, res, url, path) {
  if (path === "/api/health") return send(res, 200, { status: "ok" });
  if (req.headers.authorization !== `Bearer ${KEYS.gms}`) return send(res, 401, { error: "unauthorized" });
  const body = req.method === "GET" ? {} : await readBody(req);
  S.calls.push({ service: "gms", method: req.method, path, body });
  if (path === "/api/status") return send(res, 200, { lastGrocyPoll: new Date().toISOString(), productMappings: S.productMappings.length, unitMappings: S.unitMappings.length, schedulerStatus: "active" });
  if (path === "/api/mappings/products") return send(res, 200, S.productMappings);
  if (path === "/api/mappings/units") return send(res, 200, S.unitMappings);
  if (path === "/api/mapping-wizard/products/sync" && req.method === "POST") {
    for (const e of body.mappings ?? []) {
      const food = S.foods.find((f) => f.id === e.mealieFoodId);
      const product = S.products.find((p) => p.id === e.grocyProductId);
      if (!food || !product) continue;
      product.name = food.name; // GMS renames the Grocy product to the Mealie food name
      S.productMappings = S.productMappings.filter((x) => x.mealieFoodId !== food.id);
      S.productMappings.push({ id: `pm-${food.id}`, mealieFoodId: food.id, mealieFoodName: food.name, grocyProductId: product.id, grocyProductName: product.name, unitMappingId: null });
    }
    return send(res, 200, { synced: (body.mappings ?? []).length });
  }
  return send(res, 404, { error: "not implemented" });
}

function off(req, res, url, path) {
  const m = path.match(/^\/api\/v2\/product\/([^/?]+)/);
  if (m && m[1] === BARCODES.unknownOff) {
    return send(res, 200, {
      status: 1,
      product: {
        product_name: "Nutella",
        brands: "Ferrero",
        quantity: "400 g",
        product_quantity: 400,
        product_quantity_unit: "g",
        nutriments: { "energy-kcal_100g": 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3 },
        allergens_tags: ["en:milk", "en:nuts"],
        categories_tags: ["en:spreads", "en:hazelnut-spreads"],
      },
    });
  }
  return send(res, 404, { status: 0, status_verbose: "product not found" });
}

seed();
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === "/__reset" && req.method === "POST") {
        seed();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/__state") {
        return send(res, 200, {
          totals: Object.fromEntries(S.products.map((p) => [p.id, total(p.id)])),
          calls: S.calls,
          items: S.items,
          timeline: S.timeline,
          products: S.products.map((p) => ({ id: p.id, name: p.name, parent: p.parent_product_id })),
          barcodes: S.barcodes,
          mealplans: S.mealplans,
        });
      }
      const [, svc, ...rest] = url.pathname.split("/");
      const path = `/${rest.join("/")}`;
      if (svc === "grocy") return await grocy(req, res, url, path);
      if (svc === "mealie") return await mealie(req, res, url, path);
      if (svc === "gms") return await gms(req, res, url, path);
      if (svc === "off") return off(req, res, url, path);
      return send(res, 404, { error: "unknown service" });
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock upstreams on http://127.0.0.1:${PORT}`));

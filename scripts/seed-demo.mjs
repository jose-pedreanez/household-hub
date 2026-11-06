#!/usr/bin/env node
// Optional demo data for a fresh stack: units, locations, stores, a few products with barcodes and stock
// in Grocy; units, foods, three recipes and two planned meals in Mealie; then Grocy-Mealie Sync maps them
// by name. Idempotent (matches by name). Uses the admin ports on 127.0.0.1 and the keys in .env.
//
//   node scripts/seed-demo.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const GROCY = `http://127.0.0.1:${env.GROCY_ADMIN_PORT || 9283}/api`;
const MEALIE = `http://127.0.0.1:${env.MEALIE_ADMIN_PORT || 9925}/api`;
const GMS = `http://127.0.0.1:${env.GMS_ADMIN_PORT || 3001}/api`;
const log = (m) => console.log(`• ${m}`);

async function call(base, headers, method, p, body) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { ...headers, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${base}${p} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const grocy = (m, p, b) => call(GROCY, { "GROCY-API-KEY": env.GROCY_API_KEY }, m, p, b);
const mealie = (m, p, b) => call(MEALIE, { Authorization: `Bearer ${env.MEALIE_API_TOKEN}` }, m, p, b);
const gms = (m, p, b) => call(GMS, { Authorization: `Bearer ${env.GMS_AUTH_SECRET}` }, m, p, b);

const gs1 = (body) => {
  let s = 0;
  for (let i = 0; i < body.length; i++) s += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return `${body}${(10 - (s % 10)) % 10}`;
};
// In-store EAN-13 prefixes (20–29) never collide with real products.
export const DEMO_BARCODES = {
  barilla: gs1("200000000001"),
  tjPenne: gs1("200000000002"),
  milk: gs1("200000000003"),
  eggs: gs1("200000000004"),
  chicken: gs1("200000000005"),
  tomatoes: gs1("200000000006"),
};
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};

async function ensureGrocy(entity, name, body) {
  const rows = await grocy("GET", `/objects/${entity}?query[]=${encodeURIComponent(`name=${name}`)}`);
  if (rows.length) return Number(rows[0].id);
  return Number((await grocy("POST", `/objects/${entity}`, { name, ...body })).created_object_id);
}

async function main() {
  // ---- Grocy reference data ----
  const qu = {};
  for (const [key, name, plural] of [["g", "g", "g"], ["kg", "kg", "kg"], ["ml", "mL", "mL"], ["l", "L", "L"], ["piece", "Piece", "Pieces"], ["pack", "Pack", "Packs"], ["lb", "lb", "lb"], ["oz", "oz", "oz"], ["cup", "cup", "cups"], ["tbsp", "tbsp", "tbsp"], ["tsp", "tsp", "tsp"], ["gallon", "gallon", "gallons"]]) {
    qu[key] = await ensureGrocy("quantity_units", name, { name_plural: plural });
  }
  const loc = {};
  for (const [key, name, freezer] of [["pantry", "Pantry", 0], ["fridge", "Fridge", 0], ["freezer", "Freezer", 1]]) loc[key] = await ensureGrocy("locations", name, { is_freezer: freezer });
  for (const name of ["Trader Joe's", "Grocery Outlet", "Amazon Fresh"]) await ensureGrocy("shopping_locations", name, {});
  const grp = {};
  for (const name of ["Pantry staples", "Dairy", "Meat", "Produce"]) grp[name] = await ensureGrocy("product_groups", name, {});
  log("Grocy units, locations, stores and product groups");

  // ---- Unit conversions ----
  // The demo creates exact global Grocy conversions directly. For a real household, use Grocy-Mealie Sync's
  // "Units & Conversions" page: its library also standardises Mealie units, but needs interactive choices
  // for ambiguous units such as "cup", which a script should not make on the household's behalf.
  const wanted = [["kg", "g", 1000], ["l", "ml", 1000], ["lb", "g", 453.59237], ["oz", "g", 28.349523125], ["cup", "ml", 236.5882365], ["tbsp", "ml", 14.78676478125], ["tsp", "ml", 4.92892159375], ["gallon", "ml", 3785.411784]];
  const existing = await grocy("GET", "/objects/quantity_unit_conversions");
  for (const [from, to, factor] of wanted) {
    const has = existing.some((c) => !c.product_id && Number(c.from_qu_id) === qu[from] && Number(c.to_qu_id) === qu[to]);
    if (!has) await grocy("POST", "/objects/quantity_unit_conversions", { from_qu_id: qu[from], to_qu_id: qu[to], factor });
  }
  log("Grocy global unit conversions (mass and volume)");

  // ---- Grocy products, barcodes and stock ----
  const products = {};
  const product = async (key, name, unit, extra = {}) => {
    products[key] = await ensureGrocy("products", name, {
      location_id: loc.pantry,
      qu_id_stock: qu[unit],
      qu_id_purchase: qu[unit],
      qu_id_consume: qu[unit],
      qu_id_price: qu[unit],
      ...extra,
    });
  };
  await product("pasta", "Pasta", "g", { no_own_stock: 1, product_group_id: grp["Pantry staples"] });
  await product("barilla", "Barilla Spaghetti 1 lb", "g", { parent_product_id: products.pasta, default_best_before_days: 365, product_group_id: grp["Pantry staples"] });
  await product("tjPenne", "Trader Joe's Penne 500 g", "g", { parent_product_id: products.pasta, default_best_before_days: 365, product_group_id: grp["Pantry staples"] });
  await product("milk", "Milk", "ml", { location_id: loc.fridge, default_best_before_days: 7, min_stock_amount: 946, product_group_id: grp.Dairy });
  await product("eggs", "Egg", "piece", { location_id: loc.fridge, default_best_before_days: 21, product_group_id: grp.Dairy });
  await product("chicken", "Chicken thighs", "g", { location_id: loc.freezer, default_best_before_days: 90, product_group_id: grp.Meat });
  await product("tomatoes", "Canned tomatoes", "g", { default_best_before_days: 730 });
  await product("onion", "Onion", "piece", { default_best_before_days: 30, product_group_id: grp.Produce });
  await product("parmesan", "Parmesan", "g", { location_id: loc.fridge, default_best_before_days: 60, product_group_id: grp.Dairy });

  const barcodes = await grocy("GET", "/objects/product_barcodes");
  for (const [key, code, amount, unit] of [["barilla", DEMO_BARCODES.barilla, 1, "lb"], ["tjPenne", DEMO_BARCODES.tjPenne, 500, "g"], ["milk", DEMO_BARCODES.milk, 946, "ml"], ["eggs", DEMO_BARCODES.eggs, 12, "piece"], ["chicken", DEMO_BARCODES.chicken, 680, "g"], ["tomatoes", DEMO_BARCODES.tomatoes, 794, "g"]]) {
    if (!barcodes.some((b) => b.barcode === code)) await grocy("POST", "/objects/product_barcodes", { product_id: products[key], barcode: code, amount, qu_id: qu[unit], note: "demo" });
  }
  for (const [key, amount, due, location] of [["barilla", 453.59237, day(300), loc.pantry], ["tjPenne", 500, day(200), loc.pantry], ["milk", 946, day(5), loc.fridge], ["eggs", 12, day(18), loc.fridge], ["chicken", 680, day(2), loc.freezer], ["tomatoes", 1588, day(600), loc.pantry], ["onion", 3, day(20), loc.pantry], ["parmesan", 150, day(40), loc.fridge]]) {
    const details = await grocy("GET", `/stock/products/${products[key]}`);
    if (Number(details.stock_amount ?? 0) === 0) await grocy("POST", `/stock/products/${products[key]}/add`, { amount, best_before_date: due, location_id: location, transaction_type: "purchase", note: "demo seed" });
  }
  log("Grocy products, barcodes (EAN-13 20xxxxxxxxxxx) and starting stock");

  // ---- Mealie units, foods, recipes, meal plan ----
  const munits = (await mealie("GET", "/units?perPage=-1")).items;
  const mu = {};
  for (const [key, name, abbreviation] of [["g", "gram", "g"], ["lb", "pound", "lb"], ["cup", "cup", ""], ["tbsp", "tablespoon", "tbsp"], ["piece", "piece", ""]]) {
    const found = munits.find((u) => u.name.toLowerCase() === name);
    mu[key] = found ?? (await mealie("POST", "/units", { name, abbreviation, fraction: true }));
  }
  const mfoods = (await mealie("GET", "/foods?perPage=-1")).items;
  const mf = {};
  for (const [key, name] of [["pasta", "Pasta"], ["milk", "Milk"], ["egg", "Egg"], ["chicken", "Chicken thighs"], ["tomatoes", "Canned tomatoes"], ["onion", "Onion"], ["parmesan", "Parmesan"], ["butter", "Butter"], ["salt", "Salt"]]) {
    const found = mfoods.find((f) => f.name.toLowerCase() === name.toLowerCase());
    mf[key] = found ?? (await mealie("POST", "/foods", { name }));
  }
  const ing = (food, quantity, unit, note = "") => ({ quantity, unit: unit ? { id: mu[unit].id, name: mu[unit].name } : null, food: food ? { id: mf[food].id, name: mf[food].name } : null, note, display: "", originalText: null });
  const recipes = (await mealie("GET", "/recipes?perPage=-1")).items;
  const recipe = async (name, servings, ingredients, totalTime) => {
    let r = recipes.find((x) => x.name === name);
    if (!r) {
      const slug = await mealie("POST", "/recipes", { name });
      await mealie("PATCH", `/recipes/${slug}`, { recipeServings: servings, totalTime, recipeIngredient: ingredients, recipeInstructions: [{ text: "Cook as usual." }] });
      r = await mealie("GET", `/recipes/${slug}`);
    }
    return r;
  };
  const spaghetti = await recipe("Spaghetti al Pomodoro", 4, [ing("pasta", 1, "lb"), ing("tomatoes", 794, "g"), ing("onion", 1, null), ing("parmesan", 50, "g"), ing("butter", 2, "tbsp"), ing("salt", null, null, "to taste")], "30 minutes");
  const eggs = await recipe("Scrambled Eggs", 2, [ing("egg", 4, null), ing("milk", 0.25, "cup")], "10 minutes");
  await recipe("Garlic Chicken Thighs", 4, [ing("chicken", 680, "g"), ing("onion", 1, null)], "40 minutes");
  const plans = (await mealie("GET", `/households/mealplans?start_date=${day(0)}&end_date=${day(1)}&perPage=-1`)).items;
  if (!plans.some((p) => p.recipeId === spaghetti.id)) await mealie("POST", "/households/mealplans", { date: day(0), entryType: "dinner", recipeId: spaghetti.id, title: "", text: "" });
  if (!plans.some((p) => p.recipeId === eggs.id)) await mealie("POST", "/households/mealplans", { date: day(1), entryType: "lunch", recipeId: eggs.id, title: "", text: "" });
  log("Mealie units, foods, 3 recipes, 2 planned meals");

  // ---- Grocy-Mealie Sync: name-based mapping ----
  await gms("POST", "/sync/products");
  const mappings = await gms("GET", "/mappings/products");
  const units = await gms("GET", "/mappings/units");
  const mappedFoods = new Set(mappings.map((m) => m.mealieFoodName.toLowerCase()));
  const missing = ["pasta", "milk", "egg", "chicken thighs", "canned tomatoes", "onion", "parmesan"].filter((n) => !mappedFoods.has(n));
  log(`Grocy-Mealie Sync mapped ${mappings.length} foods and ${units.length} units${missing.length ? ` (not mapped: ${missing.join(", ")})` : ""}`);
  log("Butter and Salt are intentionally left unmapped to demonstrate how the hub handles them.");
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});

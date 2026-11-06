import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GrocyClient } from "@/lib/grocy/client";
import { MealieClient } from "@/lib/mealie/client";

/**
 * Live integration tests against the real stack (Grocy, Mealie, Grocy-Mealie Sync, hub) seeded with
 * scripts/seed-demo.mjs. They verify the definition-of-done loop and the Grocy/Mealie behaviours the hub
 * depends on. When the stack is not reachable every test is SKIPPED (never reported as passed).
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const env = fs.existsSync(path.join(ROOT, ".env"))
  ? Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, ".env"), "utf8")
        .split(/\r?\n/)
        .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => [m[1], m[2]]),
    )
  : {};
const HUB = process.env.HUB_URL ?? `http://127.0.0.1:${env.HUB_LOCAL_PORT || 3000}`;
const grocy = new GrocyClient(`http://127.0.0.1:${env.GROCY_ADMIN_PORT || 9283}`, env.GROCY_API_KEY ?? "");
const mealie = new MealieClient(`http://127.0.0.1:${env.MEALIE_ADMIN_PORT || 9925}`, env.MEALIE_API_TOKEN ?? "");
const GMS = `http://127.0.0.1:${env.GMS_ADMIN_PORT || 3001}`;

const gs1 = (b: string) => {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += Number(b[b.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return `${b}${(10 - (s % 10)) % 10}`;
};
const BC = { barilla: gs1("200000000001"), milk: gs1("200000000003") };
const run = Date.now().toString(36);

async function hub<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(`${HUB}${p}`, {
    method,
    headers: { Authorization: `Bearer ${env.HUB_API_TOKEN}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as T };
}

async function productByName(name: string) {
  const p = (await grocy.listProducts([`name=${name}`]))[0];
  if (!p) throw new Error(`Seed product “${name}” missing — run scripts/seed-demo.mjs`);
  return p;
}
const stockOf = async (id: number) => (await grocy.productDetails(id)).stock_amount ?? 0;

let reachable = false;
beforeAll(async () => {
  try {
    const r = await hub<{ ok: boolean }>("GET", "/api/health?deep=1");
    reachable = r.status === 200 && r.json.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) console.warn(`\n⚠ Live stack not reachable at ${HUB} — integration tests are SKIPPED, not passed.\n`);
});

describe("live stack", () => {
  it("all services are healthy and connected", async (ctx) => {
    if (!reachable) return ctx.skip();
    const h = await hub<{ grocy: { ok: boolean; detail: string }; mealie: { ok: boolean; detail: string }; gms: { ok: boolean } }>("GET", "/api/health?deep=1");
    expect(h.json.grocy.ok && h.json.mealie.ok && h.json.gms.ok).toBe(true);
    expect(h.json.grocy.detail).toMatch(/^4\./);
    expect(h.json.mealie.detail).toMatch(/^v?3\./);
  });

  it("Grocy behaviours the hub relies on", async (ctx) => {
    if (!reachable) return ctx.skip();
    const milk = await productByName("Milk");
    const watermark = (await grocy.listStockLog([`product_id=${milk.id}`], "id:desc", 1))[0]?.id ?? 0;
    const added = await grocy.addStock(milk.id, { amount: 100, best_before_date: "2999-12-31", note: `hub:probe-${run}` });
    // add takes stock-unit amounts and returns a transaction id
    expect(added[0].transaction_id).toBeTruthy();
    expect(added[0].amount).toBe(100);
    // id> filter and note on the purchase log row (used for reconciliation)
    const rows = await grocy.listStockLog([`product_id=${milk.id}`, `id>${watermark}`, "transaction_type=purchase"], "id:asc", 50);
    expect(rows.some((r) => r.note === `hub:probe-${run}`)).toBe(true);
    // consume a specific lot by stock_entry_id with an amount greater than 1
    const consumed = await grocy.consumeStock(milk.id, { amount: 60, stock_entry_id: added[0].stock_id! });
    expect(consumed.reduce((s, r) => s + Math.abs(r.amount), 0)).toBe(60);
    expect(consumed.every((r) => r.stock_id === added[0].stock_id)).toBe(true);
    await grocy.undoTransaction(consumed[0].transaction_id);
    await grocy.undoTransaction(added[0].transaction_id);
  });

  it("scan → resolve → receive: one package in stock units, retry-safe, rescans add", async (ctx) => {
    if (!reachable) return ctx.skip();
    const barilla = await productByName("Barilla Spaghetti 1 lb");
    const before = await stockOf(barilla.id);
    const resolved = await hub<{ status: string; package: { stockPerPackage: number } }>("GET", `/api/scan/resolve?barcode=${BC.barilla}`);
    expect(resolved.json.status).toBe("known");
    expect(resolved.json.package.stockPerPackage).toBeCloseTo(453.5924, 3);

    const body = { idempotencyKey: `it-rcv-${run}-a`, productId: barilla.id, barcode: BC.barilla, packages: 1, source: "manual" };
    const a = await hub<{ transaction: { status: string; id: number } }>("POST", "/api/scan/receive", body);
    const retry = await hub<{ replayed: boolean }>("POST", "/api/scan/receive", body);
    expect(a.json.transaction.status).toBe("completed");
    expect(retry.json.replayed).toBe(true);
    expect(await stockOf(barilla.id)).toBeCloseTo(before + 453.5924, 3);

    const b = await hub<{ transaction: { status: string; id: number } }>("POST", "/api/scan/receive", { ...body, idempotencyKey: `it-rcv-${run}-b` });
    expect(b.json.transaction.status).toBe("completed");
    expect(await stockOf(barilla.id)).toBeCloseTo(before + 907.1847, 3);

    await hub("POST", `/api/scan/${b.json.transaction.id}/undo`, {});
    await hub("POST", `/api/scan/${a.json.transaction.id}/undo`, {});
    expect(await stockOf(barilla.id)).toBeCloseTo(before, 3);
  });

  it("plan a Mealie recipe, mark it cooked, Grocy is deducted exactly once, reverse restores", async (ctx) => {
    if (!reachable) return ctx.skip();
    const recipe = (await mealie.searchRecipes({ search: "Scrambled Eggs" })).items[0];
    expect(recipe).toBeTruthy();
    const today = new Date().toLocaleDateString("en-CA");
    const created = await hub<{ id: number }>("POST", "/api/meals", { date: today, entryType: "snack", recipeId: recipe.id, servings: 2 });
    const entryId = created.json.id;
    const egg = await productByName("Egg");
    const milk = await productByName("Milk");
    const [eggs0, milk0] = [await stockOf(egg.id), await stockOf(milk.id)];

    const req = { idempotencyKey: `it-cook-${run}`, recipeSlug: recipe.slug, mealplanEntryId: entryId, servings: 2, leftoverServings: 0, overrides: {}, extras: [] };
    const cooked = await hub<{ occurrence: { id: string; status: string } }>("POST", "/api/cook", req);
    expect(cooked.json.occurrence.status).toBe("completed");
    expect(await stockOf(egg.id)).toBeCloseTo(eggs0 - 4, 3);
    expect(await stockOf(milk.id)).toBeCloseTo(milk0 - 59.1471, 3);

    const again = await hub<{ replayed: boolean }>("POST", "/api/cook", req);
    expect(again.json.replayed).toBe(true);
    expect(await stockOf(egg.id)).toBeCloseTo(eggs0 - 4, 3);
    expect((await hub("POST", "/api/cook", { ...req, idempotencyKey: `it-cook-${run}-2` })).status).toBe(409);

    const recipeAfter = await mealie.getRecipe(recipe.slug);
    expect(recipeAfter?.lastMade).toBeTruthy();

    const reversed = await hub<{ occurrence: { status: string } }>("POST", `/api/cook/${cooked.json.occurrence.id}/reverse`, {});
    expect(reversed.json.occurrence.status).toBe("reversed");
    expect(await stockOf(egg.id)).toBeCloseTo(eggs0, 3);
    expect(await stockOf(milk.id)).toBeCloseTo(milk0, 3);
    await hub("DELETE", `/api/meals/${entryId}`);
  });

  it("unmapped ingredients are flagged, never guessed", async (ctx) => {
    if (!reachable) return ctx.skip();
    const recipe = (await mealie.searchRecipes({ search: "Spaghetti al Pomodoro" })).items[0];
    const preview = await hub<{ plan: { blocking: boolean; lines: Array<{ foodName: string | null; status: string }> } }>("POST", "/api/cook/preview", { recipeSlug: recipe.slug, servings: 4 });
    expect(preview.json.plan.lines.find((l) => l.foodName === "Butter")?.status).toBe("unmapped");
    expect(preview.json.plan.blocking).toBe(true);
  });

  it("Grocy stock changes update Mealie 'In possession' through Grocy-Mealie Sync", async (ctx) => {
    if (!reachable) return ctx.skip();
    const r = await fetch(`${GMS}/api/sync/grocy-to-mealie/in-possession`, { method: "POST", headers: { Authorization: `Bearer ${env.GMS_AUTH_SECRET}` } });
    expect(r.ok).toBe(true);
    const food = (await mealie.listFoods("Parmesan")).find((f) => f.name === "Parmesan");
    expect(food?.householdsWithIngredientFood.length).toBeGreaterThan(0);
  });

  it("checking off a store-list item never adds stock (even after a GMS poll)", async (ctx) => {
    if (!reachable) return ctx.skip();
    const milk = await productByName("Milk");
    await hub("POST", "/api/shopping/items", { retailerId: "trader_joes", text: "Milk" });
    const lists = await hub<{ stores: Array<{ retailerId: string; items: Array<{ id: string; text: string; checked: boolean }> }> }>("GET", "/api/shopping");
    const item = lists.json.stores.find((s) => s.retailerId === "trader_joes")!.items.find((i) => i.text.startsWith("Milk") && !i.checked)!;
    const before = await stockOf(milk.id);
    expect((await hub("PATCH", `/api/shopping/items/${item.id}`, { checked: true })).status).toBe(200);
    await fetch(`${GMS}/api/sync/mealie-to-grocy`, { method: "POST", headers: { Authorization: `Bearer ${env.GMS_AUTH_SECRET}` } });
    expect(await stockOf(milk.id)).toBeCloseTo(before, 3);
    await hub("DELETE", `/api/shopping/items/${item.id}`);
  });
});

import "server-only";
import { householdConfig, retailerConfig } from "../config";
import { mappingContext } from "../context";
import { env } from "../env";
import { AppError } from "../errors";
import { computeRequirements, type RequirementsResult } from "../meals/requirements";
import { mealsNeedingIngredients } from "../meals/service";
import type { ShoppingList, ShoppingListItem } from "../mealie/schemas";
import { buildAdapters } from "../retailers/adapters";
import { selectSources, type Need, type SourcedItem } from "../retailers/sourcing";
import type { AvailabilityResult, ShoppingItem } from "../retailers/types";
import { services } from "../services";
import { foodForProduct } from "../sync/mappings";
import { unitName } from "../units/convert";

/**
 * Store-specific shopping lists live in Mealie (one list per retailer, tagged with extras.hub_retailer).
 *
 * Single source of truth for purchases: stock is added ONLY by receiving (scan or manual receive).
 * Checking an item off a store list marks it as picked up; it never changes Grocy stock. The list that
 * Grocy-Mealie Sync watches (MEALIE_NEEDS_LIST_ID) is read-only here, because GMS books stock when a
 * row on it is checked — checking it from the hub would double-count a scanned purchase.
 */

export const HUB_SOURCES = ["plan", "low_stock", "adhoc"] as const;

export interface NeedsResult extends RequirementsResult {
  needs: Need[];
}

export async function computeNeeds(start: string, end: string): Promise<NeedsResult> {
  const { grocy, metadata } = services();
  const [planned, ctx, stock, volatile] = await Promise.all([
    mealsNeedingIngredients(start, end),
    mappingContext(),
    grocy.currentStock(),
    grocy.volatileStock(householdConfig().config.inventory.expiringSoonDays),
  ]);
  const req = computeRequirements(
    planned.map(({ meal, recipe }) => ({ entryId: meal.id, date: meal.date, recipe, servings: meal.plannedServings })),
    ctx,
    stock,
    (id) => metadata.edibleYield(id),
  );
  // Buy enough to cook the planned meals AND stay at the minimum stock: max(0, min + planned − usable).
  const needs: Need[] = [];
  for (const r of req.requirements) {
    const min = ctx.products.get(r.productId)?.min_stock_amount ?? 0;
    const amount = Math.round(Math.max(0, min + r.required - r.available) * 10_000) / 10_000;
    if (amount > 0) needs.push({ key: `food:${r.foodId}`, foodName: r.foodName, amount, unitName: r.unitName, source: r.shortfall > 0 ? "plan" : "low_stock" });
  }

  // Low stock on products the plan does not touch.
  const covered = new Set(req.requirements.map((r) => r.productId));
  for (const m of volatile.missing_products) {
    const product = ctx.products.get(m.product_id);
    if (!product || covered.has(product.id) || covered.has(product.parent_product_id ?? -1)) continue;
    const amount = m.amount_missing ?? m.amount ?? 0;
    if (!(amount > 0)) continue;
    needs.push({
      key: `low:${product.id}`,
      foodName: foodForProduct(ctx, product.id)?.mealieFoodName ?? product.name,
      amount,
      unitName: unitName(ctx.catalog, product.qu_id_stock, amount),
      source: "low_stock",
    });
  }
  return { ...req, needs };
}

function adapters() {
  const e = env();
  return buildAdapters(retailerConfig().config, {
    instacartApiKey: e.INSTACART_API_KEY,
    instacartEnv: e.INSTACART_ENV,
    publicBaseUrl: e.PUBLIC_BASE_URL,
  });
}

async function availabilityFor(items: Need[]): Promise<(retailerId: string, product: string) => AvailabilityResult | undefined> {
  const cfg = retailerConfig().config;
  const ads = adapters();
  const cache = new Map<string, AvailabilityResult>();
  const names = new Set(items.map((i) => i.foodName.toLowerCase()));
  for (const rule of cfg.products) {
    if (!names.has(rule.food.toLowerCase())) continue;
    for (const src of [rule.preferred, ...rule.backups]) {
      if (!src) continue;
      const k = `${src.retailer}::${src.product}`;
      if (cache.has(k)) continue;
      const a = ads.get(src.retailer);
      try {
        cache.set(k, a ? await a.getAvailability(`${rule.food}::${src.product}`.toLowerCase()) : { status: "unknown", reason: "no adapter", checkedAt: new Date().toISOString() });
      } catch (e) {
        // A failed lookup is "unknown", never "out of stock".
        cache.set(k, { status: "unknown", reason: `lookup failed: ${(e as Error).message}`, checkedAt: new Date().toISOString() });
      }
    }
  }
  return (retailerId, product) => cache.get(`${retailerId}::${product}`);
}

export async function retailerLists(): Promise<Map<string, ShoppingList>> {
  const { mealie } = services();
  const cfg = retailerConfig().config;
  const lists = await mealie.shoppingLists();
  const out = new Map<string, ShoppingList>();
  for (const r of cfg.retailers) {
    const found = lists.find((l) => l.extras.hub_retailer === r.id) ?? lists.find((l) => l.name === r.name);
    if (found) out.set(r.id, found);
  }
  return out;
}

async function ensureRetailerList(retailerId: string): Promise<ShoppingList> {
  const { mealie } = services();
  const existing = (await retailerLists()).get(retailerId);
  if (existing) return existing;
  const r = retailerConfig().config.retailers.find((x) => x.id === retailerId);
  if (!r) throw new AppError("bad_request", `Unknown retailer ${retailerId}`);
  return mealie.createShoppingList(r.name, { hub_retailer: r.id });
}

function isHubGenerated(i: ShoppingListItem): boolean {
  return i.extras.hub_source === "plan" || i.extras.hub_source === "low_stock";
}

function itemNote(s: SourcedItem): string {
  return [s.display, s.product, s.pendingApprovals.length ? `substitutes need approval: ${s.pendingApprovals.map((p) => p.food).join(", ")}` : null]
    .filter(Boolean)
    .join(" · ");
}

export interface GenerateResult {
  items: SourcedItem[];
  created: number;
  updated: number;
  removed: number;
  unresolved: RequirementsResult["unresolved"];
}

/** Rebuild the generated part of every store list. Idempotent: running it twice changes nothing. */
export async function generateStoreLists(start: string, end: string): Promise<GenerateResult> {
  const { mealie } = services();
  const cfg = retailerConfig().config;
  const needs = await computeNeeds(start, end);
  const sourced = selectSources(needs.needs, cfg, await availabilityFor(needs.needs));
  const ctx = await mappingContext();
  const foodIdByName = new Map(ctx.productMappings.map((m) => [m.mealieFoodName.toLowerCase(), m.mealieFoodId]));

  let created = 0;
  let updated = 0;
  let removed = 0;
  const lists = await retailerLists();
  for (const r of cfg.retailers) {
    const desired = sourced.filter((s) => s.retailerId === r.id);
    const existingList = lists.get(r.id);
    if (desired.length === 0 && !existingList) continue;
    const list = existingList ?? (await ensureRetailerList(r.id));
    const full = (await mealie.shoppingList(list.id)) ?? list;
    const generated = full.listItems.filter(isHubGenerated);
    const current = generated.filter((i) => !i.checked);

    for (const s of desired) {
      const extras = { hub_source: s.need.source, hub_key: s.key, hub_retailer: r.id, hub_need: `${s.need.amount} ${s.need.unitName}` };
      const note = itemNote(s);
      const quantity = s.packages ?? 0;
      // A checked-off item is in the cart but not scanned yet: it still covers this need.
      if (generated.some((i) => i.checked && i.extras.hub_key === s.key)) continue;
      const existing = current.find((i) => i.extras.hub_key === s.key);
      if (!existing) {
        await mealie.createShoppingItem({
          shoppingListId: list.id,
          foodId: s.key.startsWith("food:") ? s.key.slice(5) : foodIdByName.get(s.foodName.toLowerCase()) ?? null,
          quantity,
          note,
          extras,
        });
        created++;
      } else if (existing.note !== note || existing.quantity !== quantity) {
        await mealie.updateShoppingItem(existing, { quantity, note, extras });
        updated++;
      }
    }
    for (const stale of current.filter((i) => !desired.some((s) => s.key === i.extras.hub_key))) {
      await mealie.deleteShoppingItem(stale.id);
      removed++;
    }
  }
  return { items: sourced, created, updated, removed, unresolved: needs.unresolved };
}

export interface StoreListView {
  retailerId: string;
  name: string;
  adapter: string;
  listId: string | null;
  items: Array<{
    id: string;
    text: string;
    quantity: number;
    checked: boolean;
    source: string;
    need: string | null;
  }>;
}

export async function storeListViews(): Promise<{ stores: StoreListView[]; needsList: StoreListView | null }> {
  const { mealie } = services();
  const cfg = retailerConfig().config;
  const lists = await retailerLists();
  const stores: StoreListView[] = [];
  for (const r of cfg.retailers) {
    const l = lists.get(r.id);
    const full = l ? await mealie.shoppingList(l.id) : null;
    stores.push({ retailerId: r.id, name: r.name, adapter: r.adapter, listId: l?.id ?? null, items: (full?.listItems ?? []).map(viewItem).sort(byChecked) });
  }
  let needsList: StoreListView | null = null;
  const needsId = env().MEALIE_NEEDS_LIST_ID;
  if (needsId) {
    const n = await mealie.shoppingList(needsId).catch(() => null);
    if (n) needsList = { retailerId: "needs", name: n.name || "Low stock (Grocy-Mealie Sync)", adapter: "gms", listId: n.id, items: n.listItems.map(viewItem).sort(byChecked) };
  }
  return { stores, needsList };
}

function viewItem(i: ShoppingListItem): StoreListView["items"][number] {
  const food = i.food?.name ?? "";
  const text = [i.quantity > 0 && !i.extras.hub_source ? String(i.quantity) : null, food, i.note].filter(Boolean).join(" ").trim() || i.display;
  return {
    id: i.id,
    text: i.extras.hub_source && food ? `${food}${i.note ? ` — ${i.note}` : ""}` : text,
    quantity: i.quantity,
    checked: i.checked,
    source: String(i.extras.hub_source ?? "mealie"),
    need: typeof i.extras.hub_need === "string" ? i.extras.hub_need : null,
  };
}

function byChecked(a: { checked: boolean; text: string }, b: { checked: boolean; text: string }) {
  return Number(a.checked) - Number(b.checked) || a.text.localeCompare(b.text);
}

export async function addAdhocItem(retailerId: string, text: string, quantity?: number): Promise<void> {
  const { mealie } = services();
  const list = await ensureRetailerList(retailerId);
  const ctx = await mappingContext();
  const match = ctx.productMappings.find((m) => m.mealieFoodName.toLowerCase() === text.trim().toLowerCase());
  await mealie.createShoppingItem({
    shoppingListId: list.id,
    foodId: match?.mealieFoodId ?? null,
    note: match ? "" : text.trim(),
    quantity: quantity ?? (match ? 1 : 0),
    extras: { hub_source: "adhoc", hub_retailer: retailerId },
  });
}

/** Mark an item picked up (or not). Never touches Grocy stock. */
export async function setItemChecked(itemId: string, checked: boolean): Promise<void> {
  const { mealie } = services();
  const item = await mealie.getShoppingItem(itemId);
  if (!item) throw new AppError("not_found", "Shopping item not found");
  const needsId = env().MEALIE_NEEDS_LIST_ID;
  if (needsId && item.shoppingListId === needsId) {
    throw new AppError(
      "conflict",
      "Items on the synced low-stock list are completed by scanning the purchase, not by checking them off (that would add the stock twice).",
    );
  }
  if (item.checked === checked) return;
  await mealie.updateShoppingItem(item, { checked });
}

export async function removeItem(itemId: string): Promise<void> {
  const { mealie } = services();
  const item = await mealie.getShoppingItem(itemId);
  if (!item) return;
  if (env().MEALIE_NEEDS_LIST_ID && item.shoppingListId === env().MEALIE_NEEDS_LIST_ID) {
    throw new AppError("conflict", "The synced low-stock list is managed by Grocy-Mealie Sync.");
  }
  await mealie.deleteShoppingItem(itemId);
}

export async function exportStoreList(retailerId: string): Promise<{ title: string; items: ShoppingItem[] }> {
  const view = (await storeListViews()).stores.find((s) => s.retailerId === retailerId);
  if (!view) throw new AppError("not_found", "Unknown store");
  return {
    title: `${view.name} — shopping list`,
    items: view.items
      .filter((i) => !i.checked)
      .map((i) => ({ name: i.text, quantity: i.quantity || 1, unit: null, display: "", note: null, upc: null })),
  };
}

export async function handoff(retailerId: string) {
  const adapter = adapters().get(retailerId);
  if (!adapter) throw new AppError("not_found", "Unknown store");
  const { title, items } = await exportStoreList(retailerId);
  if (items.length === 0) throw new AppError("unprocessable", "Nothing left to buy on this list");
  return adapter.createShoppingList(items, title);
}

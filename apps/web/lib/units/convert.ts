import type { QuantityUnit, ResolvedConversion } from "../grocy/schemas";
import type { MealieUnit } from "../mealie/schemas";
import type { UnitMapping } from "../sync/gms-client";
import { builtinFactor, isCountUnitName } from "./builtin";

/**
 * Deterministic unit conversion. AI never does arithmetic or unit conversion in this system.
 *
 * Source of truth, in priority order:
 *   1. identity (same Grocy unit)
 *   2. Grocy conversions — product-specific first, then global (the `quantity_unit_conversions_resolved` view)
 *   3. exact built-in physical constants for same-dimension units (mass↔mass, volume↔volume)
 * Anything else (e.g. cups of flour → grams without a product density) is reported as unconvertible.
 */

export interface UnitCatalog {
  units: Map<number, QuantityUnit>;
  conversions: ResolvedConversion[];
}

export interface Conversion {
  amount: number;
  factor: number;
  source: "identity" | "grocy" | "builtin";
}

export function buildCatalog(units: QuantityUnit[], conversions: ResolvedConversion[]): UnitCatalog {
  return { units: new Map(units.map((u) => [u.id, u])), conversions };
}

export function unitName(catalog: UnitCatalog, quId: number | null | undefined, amount = 1): string {
  if (quId == null) return "";
  const u = catalog.units.get(quId);
  if (!u) return `unit #${quId}`;
  return amount === 1 || !u.name_plural ? u.name : u.name_plural;
}

/** Factor such that 1 `from` = factor `to` for this product, or null. */
export function grocyFactor(
  catalog: UnitCatalog,
  productId: number | null,
  fromQu: number,
  toQu: number,
): { factor: number; source: Conversion["source"] } | null {
  if (fromQu === toQu) return { factor: 1, source: "identity" };

  // Product-specific edges take precedence over global ones for the same unit pair.
  const edges = new Map<number, Map<number, number>>();
  const addEdge = (a: number, b: number, f: number, override: boolean) => {
    if (!(f > 0) || !Number.isFinite(f)) return;
    const m = edges.get(a) ?? new Map<number, number>();
    if (override || !m.has(b)) m.set(b, f);
    edges.set(a, m);
  };
  for (const c of catalog.conversions) {
    if (c.product_id == null) {
      addEdge(c.from_qu_id, c.to_qu_id, c.factor, false);
      addEdge(c.to_qu_id, c.from_qu_id, 1 / c.factor, false);
    }
  }
  for (const c of catalog.conversions) {
    if (productId != null && c.product_id === productId) {
      addEdge(c.from_qu_id, c.to_qu_id, c.factor, true);
      addEdge(c.to_qu_id, c.from_qu_id, 1 / c.factor, true);
    }
  }

  // Breadth-first search: the shortest chain wins, and ties resolve by unit id for determinism.
  const queue: Array<{ qu: number; factor: number }> = [{ qu: fromQu, factor: 1 }];
  const seen = new Set<number>([fromQu]);
  while (queue.length > 0) {
    const { qu, factor } = queue.shift()!;
    const next = [...(edges.get(qu) ?? new Map<number, number>()).entries()].sort(([a], [b]) => a - b);
    for (const [to, f] of next) {
      if (seen.has(to)) continue;
      const total = factor * f;
      if (to === toQu) return { factor: total, source: "grocy" };
      seen.add(to);
      queue.push({ qu: to, factor: total });
    }
  }

  const fromName = catalog.units.get(fromQu)?.name;
  const toName = catalog.units.get(toQu)?.name;
  const b = builtinFactor(fromName, toName);
  if (b !== null) return { factor: b, source: "builtin" };
  return null;
}

export function convertGrocy(
  catalog: UnitCatalog,
  productId: number | null,
  amount: number,
  fromQu: number,
  toQu: number,
): Conversion | null {
  const f = grocyFactor(catalog, productId, fromQu, toQu);
  if (!f) return null;
  return { amount: roundAmount(amount * f.factor), factor: f.factor, source: f.source };
}

export type MealieUnitResolution =
  | { ok: true; quId: number; factor: number; via: "mapping" | "count" | "name" }
  | { ok: false; reason: string };

/**
 * Map a Mealie recipe unit onto a Grocy quantity unit.
 *
 * - Mapped units use the GMS unit mapping (and its conversion factor).
 * - A unitless line ("2 eggs") counts in the product's stock unit only when that unit counts pieces.
 * - Otherwise a Grocy unit with the same name is accepted (exact, case-insensitive).
 */
export function resolveMealieUnit(
  mealieUnit: Pick<MealieUnit, "id" | "name" | "abbreviation"> | null,
  unitMappings: UnitMapping[],
  catalog: UnitCatalog,
  stockQuId: number,
): MealieUnitResolution {
  if (!mealieUnit) {
    const stockName = catalog.units.get(stockQuId)?.name;
    if (isCountUnitName(stockName)) return { ok: true, quId: stockQuId, factor: 1, via: "count" };
    return {
      ok: false,
      reason: `the recipe line has no unit and the stock unit "${stockName ?? stockQuId}" does not count pieces`,
    };
  }
  const mapping = unitMappings.find((m) => m.mealieUnitId === mealieUnit.id);
  if (mapping) return { ok: true, quId: mapping.grocyUnitId, factor: mapping.conversionFactor || 1, via: "mapping" };

  const wanted = [mealieUnit.name, mealieUnit.abbreviation].filter(Boolean).map((s) => s!.trim().toLowerCase());
  for (const u of [...catalog.units.values()].sort((a, b) => a.id - b.id)) {
    const names = [u.name, u.name_plural].filter(Boolean).map((s) => s!.trim().toLowerCase());
    if (names.some((n) => wanted.includes(n))) return { ok: true, quId: u.id, factor: 1, via: "name" };
  }
  return { ok: false, reason: `Mealie unit "${mealieUnit.name}" has no Grocy unit mapping` };
}

/** Grocy stores up to 4 decimals for amounts by default; avoid float drift such as 0.30000000000000004. */
export function roundAmount(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Apply an edible yield (usable fraction of the stocked amount): usable → amount to take from stock. */
export function stockNeededForUsable(usable: number, edibleYield: number | null | undefined): number {
  const y = edibleYield && edibleYield > 0 && edibleYield <= 1 ? edibleYield : 1;
  return roundAmount(usable / y);
}

export function usableFromStock(stock: number, edibleYield: number | null | undefined): number {
  const y = edibleYield && edibleYield > 0 && edibleYield <= 1 ? edibleYield : 1;
  return roundAmount(stock * y);
}

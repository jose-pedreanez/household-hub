import { isNeverExpires } from "../grocy/client";
import type { StockEntry } from "../grocy/schemas";
import { roundAmount } from "../units/convert";

/**
 * Deterministic stock-lot selection for consumption.
 *
 * Every lot of every eligible product is ordered by one global rule, so the same stock and the
 * same request always produce the same allocation:
 *   1. earliest due date first (lots that never expire come last),
 *   2. opened lots before sealed ones,
 *   3. oldest purchase first,
 *   4. lowest Grocy stock-entry id (stable tie-break).
 * Lots are drawn greedily in that order until the need is covered.
 */

export interface CandidateProduct {
  productId: number;
  productName: string;
  stockQuId: number;
  stockUnitName: string;
  /** 1 stock unit of this product = `toTarget` target units (target = the unit the need is expressed in). */
  toTarget: number;
  /** Usable fraction of the stocked amount (edible yield). 1 when unknown. */
  edibleYield: number;
}

export interface Allocation {
  productId: number;
  productName: string;
  stockId: string;
  entryId: number;
  /** Amount to consume, in the product's stock unit. */
  amountStock: number;
  stockQuId: number;
  stockUnitName: string;
  /** Usable amount this covers, in target units. */
  amountTarget: number;
  bestBeforeDate: string | null;
  opened: boolean;
  locationId: number | null;
}

export interface LotSelection {
  allocations: Allocation[];
  /** Target units that could not be covered by available stock. */
  shortfall: number;
  /** Usable amount available across all candidates, in target units. */
  available: number;
}

export function sortLots(entries: StockEntry[]): StockEntry[] {
  const due = (e: StockEntry) => (isNeverExpires(e.best_before_date) ? "9999-12-31" : e.best_before_date!);
  return [...entries].sort(
    (a, b) =>
      cmp(due(a), due(b)) ||
      Number(b.open) - Number(a.open) ||
      cmp(a.purchased_date ?? "", b.purchased_date ?? "") ||
      a.id - b.id,
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function selectLots(need: number, candidates: CandidateProduct[], entries: StockEntry[]): LotSelection {
  const byProduct = new Map(candidates.map((c) => [c.productId, c]));
  const usable = sortLots(entries.filter((e) => byProduct.has(e.product_id) && e.amount > 0));

  let available = 0;
  for (const e of usable) {
    const c = byProduct.get(e.product_id)!;
    available += e.amount * c.toTarget * c.edibleYield;
  }

  const allocations: Allocation[] = [];
  let remaining = roundAmount(need);
  for (const e of usable) {
    if (remaining <= 0) break;
    const c = byProduct.get(e.product_id)!;
    const perStockUnit = c.toTarget * c.edibleYield;
    if (!(perStockUnit > 0)) continue;
    const lotTarget = e.amount * perStockUnit;
    const takeTarget = Math.min(remaining, lotTarget);
    // Never take more than the lot holds, even after rounding.
    const takeStock = Math.min(e.amount, roundAmount(takeTarget / perStockUnit));
    if (takeStock <= 0) continue;
    allocations.push({
      productId: c.productId,
      productName: c.productName,
      stockId: e.stock_id,
      entryId: e.id,
      amountStock: takeStock,
      stockQuId: c.stockQuId,
      stockUnitName: c.stockUnitName,
      amountTarget: roundAmount(takeTarget),
      bestBeforeDate: isNeverExpires(e.best_before_date) ? null : e.best_before_date,
      opened: e.open,
      locationId: e.location_id,
    });
    remaining = roundAmount(remaining - takeTarget);
  }

  return { allocations, shortfall: Math.max(0, remaining), available: roundAmount(available) };
}

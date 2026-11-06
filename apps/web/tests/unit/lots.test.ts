import { describe, expect, it } from "vitest";
import type { StockEntry } from "@/lib/grocy/schemas";
import { selectLots, sortLots, type CandidateProduct } from "@/lib/inventory/lots";

const entry = (id: number, productId: number, amount: number, due: string, o: Partial<StockEntry> = {}): StockEntry =>
  ({ id, product_id: productId, location_id: 1, amount, best_before_date: due, purchased_date: "2026-10-01", stock_id: `s${id}`, open: false, opened_date: null, note: null, price: null, ...o }) as StockEntry;

const cand = (productId: number, toTarget = 1, edibleYield = 1): CandidateProduct => ({
  productId,
  productName: `P${productId}`,
  stockQuId: 1,
  stockUnitName: "g",
  toTarget,
  edibleYield,
});

describe("deterministic lot selection", () => {
  it("orders by due date, opened first on ties, never-expiring last", () => {
    const sorted = sortLots([
      entry(1, 1, 100, "2999-12-31"),
      entry(2, 1, 100, "2026-10-25"),
      entry(3, 1, 100, "2026-10-23"),
      entry(4, 1, 100, "2026-10-25", { open: true }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual([3, 4, 2, 1]);
  });

  it("draws the earliest-expiring lots across all compatible products", () => {
    const r = selectLots(600, [cand(11), cand(12)], [entry(1, 11, 453, "2027-01-01"), entry(2, 12, 500, "2026-11-01"), entry(3, 12, 500, "2027-06-01")]);
    expect(r.allocations.map((a) => [a.entryId, a.amountStock])).toEqual([
      [2, 500],
      [1, 100],
    ]);
    expect(r.shortfall).toBe(0);
    expect(r.available).toBe(1453);
  });

  it("converts each candidate's stock unit to the target unit", () => {
    // product 30 stocked in kg (1 kg = 1000 g target units)
    const r = selectLots(1500, [cand(30, 1000)], [entry(1, 30, 1, "2026-11-01"), entry(2, 30, 2, "2026-12-01")]);
    expect(r.allocations.map((a) => a.amountStock)).toEqual([1, 0.5]);
  });

  it("accounts for edible yield: 400 g usable needs 500 g at 80 % yield", () => {
    const r = selectLots(400, [cand(40, 1, 0.8)], [entry(1, 40, 1000, "2026-10-23")]);
    expect(r.allocations[0].amountStock).toBe(500);
  });

  it("reports the shortfall when stock runs out", () => {
    const r = selectLots(800, [cand(11)], [entry(1, 11, 300, "2026-11-01")]);
    expect(r.allocations[0].amountStock).toBe(300);
    expect(r.shortfall).toBe(500);
  });

  it("ignores products that are not candidates and empty lots", () => {
    const r = selectLots(100, [cand(11)], [entry(1, 99, 500, "2026-10-22"), entry(2, 11, 0, "2026-10-22"), entry(3, 11, 200, "2026-12-01")]);
    expect(r.allocations.map((a) => a.entryId)).toEqual([3]);
  });
});

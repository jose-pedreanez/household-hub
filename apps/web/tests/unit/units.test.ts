import { describe, expect, it } from "vitest";
import { builtinFactor, canonicalUnit } from "@/lib/units/builtin";
import { convertGrocy, grocyFactor, resolveMealieUnit, stockNeededForUsable, usableFromStock } from "@/lib/units/convert";
import { makeContext, makeGrocy, MU, P, U, UNIT_MAPPINGS } from "../support/kitchen";

describe("unit conversion", () => {
  const ctx = makeContext(makeGrocy());

  it("identity", () => {
    expect(convertGrocy(ctx.catalog, P.milk, 946, U.ml, U.ml)).toEqual({ amount: 946, factor: 1, source: "identity" });
  });

  it("uses Grocy global conversions in both directions", () => {
    expect(convertGrocy(ctx.catalog, null, 2, U.l, U.ml)?.amount).toBe(2000);
    expect(convertGrocy(ctx.catalog, null, 500, U.ml, U.l)?.amount).toBe(0.5);
  });

  it("prefers product-specific conversions (density) over anything else", () => {
    expect(convertGrocy(ctx.catalog, P.flour, 2, U.cup, U.g)).toMatchObject({ amount: 240, source: "grocy" });
  });

  it("never converts volume to mass without a product conversion", () => {
    expect(convertGrocy(ctx.catalog, P.milk, 1, U.cup, U.g)).toBeNull();
    expect(builtinFactor("cup", "g")).toBeNull();
  });

  it("falls back to exact physical constants for same-dimension units", () => {
    const c = convertGrocy(ctx.catalog, P.barilla, 1, U.lb, U.g);
    expect(c).toMatchObject({ amount: 453.5924, source: "builtin" });
  });

  it("product conversion for packs: 1 pack of yogurt = 6 pieces", () => {
    expect(convertGrocy(ctx.catalog, P.yogurt, 2, U.pack, U.piece)?.amount).toBe(12);
    expect(grocyFactor(ctx.catalog, P.eggs, U.pack, U.piece)).toBeNull();
  });

  it("canonicalises unit names", () => {
    expect(canonicalUnit("Tablespoons")).toBe("tbsp");
    expect(canonicalUnit("fl oz")).toBe("floz");
    expect(canonicalUnit("pinch")).toBeNull();
  });

  it("maps Mealie units through GMS unit mappings", () => {
    expect(resolveMealieUnit({ id: MU.cup, name: "cup", abbreviation: "c" }, UNIT_MAPPINGS, ctx.catalog, U.ml)).toMatchObject({ ok: true, quId: U.cup });
  });

  it("reads a unitless line as pieces only when the stock unit counts pieces", () => {
    expect(resolveMealieUnit(null, UNIT_MAPPINGS, ctx.catalog, U.piece)).toMatchObject({ ok: true, quId: U.piece, via: "count" });
    expect(resolveMealieUnit(null, UNIT_MAPPINGS, ctx.catalog, U.g).ok).toBe(false);
  });

  it("falls back to a same-named Grocy unit, else reports it", () => {
    expect(resolveMealieUnit({ id: "unmapped", name: "kg", abbreviation: null }, [], ctx.catalog, U.g)).toMatchObject({ ok: true, quId: U.kg, via: "name" });
    expect(resolveMealieUnit({ id: "x", name: "pinch", abbreviation: null }, [], ctx.catalog, U.g).ok).toBe(false);
  });

  it("applies edible yield", () => {
    expect(stockNeededForUsable(400, 0.8)).toBe(500);
    expect(usableFromStock(500, 0.8)).toBe(400);
    expect(stockNeededForUsable(400, null)).toBe(400);
  });
});

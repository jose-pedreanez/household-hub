import { beforeEach, describe, expect, it } from "vitest";
import { buildCookingPlan, ingredientKey, productsToLoad, type PlanInput } from "@/lib/cooking/plan";
import type { FakeGrocy } from "../support/fake-grocy";
import { F, ing, makeContext, makeGrocy, MU, P, recipe } from "../support/kitchen";

let g: FakeGrocy;
beforeEach(() => {
  g = makeGrocy();
});

const pasta = { id: F.pasta, name: "Pasta" };
const milk = { id: F.milk, name: "Milk" };
const egg = { id: F.egg, name: "Egg" };
const chicken = { id: F.chicken, name: "Chicken thighs" };
const flour = { id: F.flour, name: "Flour" };
const gram = { id: MU.gram, name: "gram" };
const cup = { id: MU.cup, name: "cup" };
const pound = { id: MU.pound, name: "pound" };

function plan(r: ReturnType<typeof recipe>, servings: number, extra: Partial<PlanInput> = {}) {
  const ctx = extra.ctx ?? makeContext(g);
  const entries = productsToLoad(r, ctx, extra.overrides, extra.extras).flatMap((id) => g.entries.filter((e) => e.product_id === id));
  return buildCookingPlan({ recipe: r, servings, ctx, entries, edibleYield: (id) => (id === P.chicken ? 0.8 : null), ...extra });
}

describe("cooking plan", () => {
  it("normal recipe: scales and allocates exact stock amounts", () => {
    g.stock(P.milk, 946, "2026-10-25");
    g.stock(P.eggs, 12, "2026-11-01");
    const r = recipe("Pancakes", 4, [ing(milk, 1, cup), ing(egg, 2, null)]);
    const p = plan(r, 4);
    expect(p.blocking).toBe(false);
    expect(p.lines[0].allocations[0]).toMatchObject({ productId: P.milk, amountStock: 236.5882 });
    expect(p.lines[1].allocations[0]).toMatchObject({ productId: P.eggs, amountStock: 2 });
  });

  it("variable servings scale every quantity", () => {
    g.stock(P.eggs, 12, "2026-11-01");
    const p = plan(recipe("Omelette", 2, [ing(egg, 3, null)]), 5);
    expect(p.scale).toBe(2.5);
    expect(p.lines[0].target?.amount).toBe(7.5);
  });

  it("one ingredient, several products: consumes across the family, earliest due first", () => {
    g.stock(P.barilla, 453.5924, "2027-03-01");
    g.stock(P.tjPasta, 500, "2026-12-01");
    const p = plan(recipe("Spaghetti", 4, [ing(pasta, 1.5, pound)]), 4);
    const line = p.lines[0];
    expect(line.target).toMatchObject({ productId: P.pasta, amount: 680.3886 });
    expect(line.allocations.map((a) => [a.productId, a.amountStock])).toEqual([
      [P.tjPasta, 500],
      [P.barilla, 180.3886],
    ]);
    expect(line.available).toBe(953.5924);
  });

  it("missing ingredient mapping blocks with a clear reason", () => {
    const p = plan(recipe("Mystery", 2, [ing({ id: "food-saffron", name: "Saffron" }, 1, gram)]), 2);
    expect(p.blocking).toBe(true);
    expect(p.lines[0].status).toBe("unmapped");
  });

  it("GMS unreachable is not the same as unmapped", () => {
    const p = plan(recipe("Spaghetti", 4, [ing(pasta, 1, pound)]), 4, { ctx: makeContext(g, { mappings: [], mappingsAvailable: false }) });
    expect(p.lines[0].status).toBe("mapping_unavailable");
  });

  it("volume of a mass-stocked food without density is unconvertible; with density it works", () => {
    g.stock(P.flour, 2000, "2999-12-31");
    g.stock(P.chicken, 500, "2026-10-23");
    const flourPlan = plan(recipe("Bread", 1, [ing(flour, 2, cup)]), 1);
    expect(flourPlan.lines[0].allocations[0].amountStock).toBe(240);
    const chickenPlan = plan(recipe("Soup", 1, [ing(chicken, 1, cup)]), 1);
    expect(chickenPlan.lines[0].status).toBe("unconvertible");
  });

  it("partial shortage blocks until the shortfall is accepted", () => {
    g.stock(P.milk, 100, "2026-10-25");
    const r = recipe("Latte", 1, [ing(milk, 1, cup)]);
    const p = plan(r, 1);
    expect(p.lines[0]).toMatchObject({ status: "short", blocking: true, shortfall: 136.5882 });
    const accepted = plan(r, 1, { overrides: { [ingredientKey(r.recipeIngredient[0], 0)]: { acceptShortfall: true } } });
    expect(accepted.blocking).toBe(false);
    expect(accepted.lines[0].allocations[0].amountStock).toBe(100);
  });

  it("partial usage: an explicit amount replaces the recipe quantity", () => {
    g.stock(P.milk, 946, "2026-10-25");
    const r = recipe("Latte", 1, [ing(milk, 1, cup)]);
    const p = plan(r, 1, { overrides: { [ingredientKey(r.recipeIngredient[0], 0)]: { amount: 150 } } });
    expect(p.lines[0].allocations[0].amountStock).toBe(150);
  });

  it("skipped, free-text and to-taste lines consume nothing", () => {
    g.stock(P.eggs, 12, "2026-11-01");
    const r = recipe("Eggs", 1, [ing(egg, 2, null), ing(null, 1, null, { note: "water" }), ing({ id: F.salt, name: "Salt" }, null, null)]);
    const p = plan(r, 1, { overrides: { [ingredientKey(r.recipeIngredient[0], 0)]: { skip: true } } });
    expect(p.lines.map((l) => l.status)).toEqual(["skipped", "not_tracked", "no_quantity"]);
    expect(p.lines.flatMap((l) => l.allocations)).toHaveLength(0);
    expect(p.blocking).toBe(false);
  });

  it("substitutions: only Mealie-defined ones, and only when chosen", () => {
    g.stock(P.oatMilk, 1000, "2026-11-10");
    const milkWithSub = { ...milk, substitutions: [{ substituteFoodId: F.oatMilk, substituteFood: { id: F.oatMilk, name: "Oat milk" }, note: null }] };
    const r = recipe("Latte", 1, [ing(milkWithSub, 1, cup)]);
    const key = ingredientKey(r.recipeIngredient[0], 0);
    const offered = plan(r, 1);
    expect(offered.lines[0].status).toBe("short");
    expect(offered.lines[0].substitutions[0]).toMatchObject({ foodId: F.oatMilk, available: 1000 });
    const used = plan(r, 1, { overrides: { [key]: { substituteFoodId: F.oatMilk } } });
    expect(used.lines[0]).toMatchObject({ status: "ok", substitutedFrom: "Milk" });
    expect(used.lines[0].allocations[0].productId).toBe(P.oatMilk);
    const bogus = plan(r, 1, { overrides: { [key]: { substituteFoodId: F.flour } } });
    expect(bogus.lines[0].blocking).toBe(true);
  });

  it("two lines needing the same product never over-commit one lot", () => {
    g.stock(P.eggs, 3, "2026-11-01");
    const p = plan(recipe("Cake", 1, [ing(egg, 2, null, { referenceId: "a" }), ing(egg, 2, null, { referenceId: "b" })]), 1);
    expect(p.lines[0].allocations[0].amountStock).toBe(2);
    expect(p.lines[1]).toMatchObject({ status: "short", shortfall: 1 });
  });

  it("recipe modifications: extra products are planned like ingredients", () => {
    g.stock(P.chicken, 1000, "2026-10-23");
    const p = plan(recipe("Salad", 2, []), 2, { extras: [{ productId: P.chicken, amount: 200, note: "added chicken" }] });
    expect(p.lines[0]).toMatchObject({ kind: "extra", status: "ok" });
    expect(p.lines[0].allocations[0].amountStock).toBe(200);
  });

  it("edible yield increases the stock needed", () => {
    g.stock(P.chicken, 1000, "2026-10-23");
    const p = plan(recipe("Curry", 2, [ing(chicken, 400, gram)]), 2);
    expect(p.lines[0].allocations[0].amountStock).toBe(500);
  });
});

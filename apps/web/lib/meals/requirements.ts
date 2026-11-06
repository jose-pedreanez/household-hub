import type { CurrentStock } from "../grocy/schemas";
import type { MealieRecipe } from "../mealie/schemas";
import { mappedProductForFood, stockCandidates, type MappingContext } from "../sync/mappings";
import { grocyFactor, resolveMealieUnit, roundAmount, unitName } from "../units/convert";

/**
 * Ingredient requirements for planned meals minus usable stock, computed deterministically.
 * Leftover meals and meals already cooked need nothing; unmapped ingredients are listed, not guessed.
 */

export interface PlannedRecipe {
  entryId: number;
  date: string;
  recipe: MealieRecipe;
  servings: number;
}

export interface Requirement {
  foodId: string;
  foodName: string;
  productId: number;
  productName: string;
  quId: number;
  unitName: string;
  required: number;
  available: number;
  shortfall: number;
  meals: Array<{ entryId: number; date: string; recipeName: string; amount: number }>;
}

export interface UnresolvedIngredient {
  foodId: string | null;
  foodName: string | null;
  display: string;
  reason: "unmapped" | "unconvertible" | "not_tracked";
  detail: string;
  meals: Array<{ entryId: number; date: string; recipeName: string }>;
}

export interface RequirementsResult {
  requirements: Requirement[];
  unresolved: UnresolvedIngredient[];
}

export function computeRequirements(
  planned: PlannedRecipe[],
  ctx: MappingContext,
  stock: CurrentStock[],
  edibleYield: (productId: number) => number | null,
): RequirementsResult {
  const byProduct = new Map<number, Requirement>();
  const unresolved = new Map<string, UnresolvedIngredient>();
  const stockByProduct = new Map(stock.map((s) => [s.product_id, s.amount]));

  const addUnresolved = (key: string, u: Omit<UnresolvedIngredient, "meals">, meal: UnresolvedIngredient["meals"][number]) => {
    const existing = unresolved.get(key) ?? { ...u, meals: [] };
    if (!existing.meals.some((m) => m.entryId === meal.entryId)) existing.meals.push(meal);
    unresolved.set(key, existing);
  };

  for (const p of [...planned].sort((a, b) => a.date.localeCompare(b.date) || a.entryId - b.entryId)) {
    const base = p.recipe.recipeServings > 0 ? p.recipe.recipeServings : p.recipe.recipeYieldQuantity > 0 ? p.recipe.recipeYieldQuantity : 0;
    const scale = base > 0 ? p.servings / base : 1;
    const meal = { entryId: p.entryId, date: p.date, recipeName: p.recipe.name };

    for (const ing of p.recipe.recipeIngredient) {
      if (!ing.food) continue; // free-text line: not an inventory item
      if (!(ing.quantity && ing.quantity > 0)) continue; // "to taste"
      const product = mappedProductForFood(ctx, ing.food.id);
      if (!product) {
        addUnresolved(`food:${ing.food.id}`, { foodId: ing.food.id, foodName: ing.food.name, display: ing.display, reason: "unmapped", detail: "No Grocy product is mapped to this Mealie food." }, meal);
        continue;
      }
      const unit = resolveMealieUnit(ing.unit, ctx.unitMappings, ctx.catalog, product.qu_id_stock);
      const f = unit.ok ? grocyFactor(ctx.catalog, product.id, unit.quId, product.qu_id_stock) : null;
      if (!unit.ok || !f) {
        addUnresolved(
          `conv:${ing.food.id}:${ing.unit?.id ?? "none"}`,
          {
            foodId: ing.food.id,
            foodName: ing.food.name,
            display: ing.display,
            reason: "unconvertible",
            detail: unit.ok ? `No conversion from ${unitName(ctx.catalog, unit.quId)} to ${unitName(ctx.catalog, product.qu_id_stock)}.` : unit.reason,
          },
          meal,
        );
        continue;
      }
      const amount = roundAmount(ing.quantity * scale * unit.factor * f.factor);
      const req = byProduct.get(product.id) ?? {
        foodId: ing.food.id,
        foodName: ing.food.name,
        productId: product.id,
        productName: product.name,
        quId: product.qu_id_stock,
        unitName: unitName(ctx.catalog, product.qu_id_stock, 2),
        required: 0,
        available: 0,
        shortfall: 0,
        meals: [],
      };
      req.required = roundAmount(req.required + amount);
      req.meals.push({ ...meal, amount });
      byProduct.set(product.id, req);
    }
  }

  for (const req of byProduct.values()) {
    let available = 0;
    for (const c of stockCandidates(ctx, req.productId)) {
      const f = grocyFactor(ctx.catalog, c.id, c.qu_id_stock, req.quId) ?? grocyFactor(ctx.catalog, req.productId, c.qu_id_stock, req.quId);
      if (!f) continue;
      available += (stockByProduct.get(c.id) ?? 0) * f.factor * (edibleYield(c.id) ?? 1);
    }
    req.available = roundAmount(available);
    req.shortfall = roundAmount(Math.max(0, req.required - req.available));
  }

  return {
    requirements: [...byProduct.values()].sort((a, b) => b.shortfall - a.shortfall || a.foodName.localeCompare(b.foodName)),
    unresolved: [...unresolved.values()].sort((a, b) => (a.foodName ?? "").localeCompare(b.foodName ?? "")),
  };
}

/** Usable amount of a mapped product family, in the mapped product's stock unit. */
export function familyAvailability(
  ctx: MappingContext,
  productId: number,
  stock: CurrentStock[],
  edibleYield: (productId: number) => number | null,
): { amount: number; unitName: string; members: Array<{ productId: number; name: string; amount: number; unitName: string; usable: number }> } {
  const root = ctx.products.get(productId);
  if (!root) return { amount: 0, unitName: "", members: [] };
  const stockByProduct = new Map(stock.map((s) => [s.product_id, s.amount]));
  const members = [];
  let total = 0;
  for (const c of stockCandidates(ctx, productId)) {
    const amount = stockByProduct.get(c.id) ?? 0;
    const f = grocyFactor(ctx.catalog, c.id, c.qu_id_stock, root.qu_id_stock) ?? grocyFactor(ctx.catalog, productId, c.qu_id_stock, root.qu_id_stock);
    const usable = f ? roundAmount(amount * f.factor * (edibleYield(c.id) ?? 1)) : 0;
    total += usable;
    members.push({ productId: c.id, name: c.name, amount, unitName: unitName(ctx.catalog, c.qu_id_stock, amount), usable });
  }
  return { amount: roundAmount(total), unitName: unitName(ctx.catalog, root.qu_id_stock, 2), members };
}

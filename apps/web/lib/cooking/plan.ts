import { z } from "zod";
import type { StockEntry } from "../grocy/schemas";
import type { MealieIngredient, MealieRecipe } from "../mealie/schemas";
import { selectLots, type Allocation, type CandidateProduct } from "../inventory/lots";
import { mappedProductForFood, stockCandidates, type MappingContext } from "../sync/mappings";
import { grocyFactor, resolveMealieUnit, roundAmount, unitName } from "../units/convert";

/**
 * Builds the consumption plan for "we cooked this": which Grocy stock lots to consume, in which
 * amounts, for a recipe at a given number of servings. Pure: all data is passed in.
 *
 * Statuses that block execution until the household decides:
 *   unmapped / mapping_unavailable / unconvertible — we cannot tell what or how much to consume;
 *   short — not enough stock (accept the shortfall to consume what is there).
 * Informational, never consumed: not_tracked (no food, e.g. "water"), no_quantity ("salt to taste").
 */

export const lineOverrideSchema = z.object({
  skip: z.boolean().optional(),
  /** Amount to consume in the line's target unit (the mapped product's stock unit). Partial usage. */
  amount: z.number().positive().optional(),
  /** Consume from this Grocy product instead of the mapped family (explicit household approval). */
  productId: z.number().int().positive().optional(),
  /** Use a substitute food (must be a Mealie-defined substitution for this ingredient). */
  substituteFoodId: z.string().optional(),
  /** Consume whatever stock exists and record the rest as missing. */
  acceptShortfall: z.boolean().optional(),
});
export type LineOverride = z.infer<typeof lineOverrideSchema>;

export const extraLineSchema = z.object({
  productId: z.number().int().positive(),
  /** Amount in the product's stock unit. */
  amount: z.number().positive(),
  note: z.string().max(200).optional(),
});
export type ExtraLine = z.infer<typeof extraLineSchema>;

export type PlanLineStatus =
  | "ok"
  | "short"
  | "unmapped"
  | "mapping_unavailable"
  | "unconvertible"
  | "skipped"
  | "not_tracked"
  | "no_quantity";

export interface SubstitutionOption {
  foodId: string;
  foodName: string;
  note: string | null;
  mappedProductId: number | null;
  available: number | null;
  unitName: string | null;
}

export interface PlanLine {
  key: string;
  kind: "recipe" | "extra";
  display: string;
  foodId: string | null;
  foodName: string | null;
  /** Scaled recipe quantity in recipe units, for display. */
  recipeQuantity: number | null;
  recipeUnit: string | null;
  status: PlanLineStatus;
  blocking: boolean;
  target: { productId: number; productName: string; quId: number; unitName: string; amount: number } | null;
  available: number | null;
  shortfall: number;
  allocations: Allocation[];
  substitutions: SubstitutionOption[];
  substitutedFrom: string | null;
  issues: string[];
}

export interface CookingPlan {
  recipe: { id: string; slug: string; name: string; baseServings: number };
  servings: number;
  scale: number;
  lines: PlanLine[];
  blocking: boolean;
  warnings: string[];
}

export interface PlanInput {
  recipe: MealieRecipe;
  servings: number;
  ctx: MappingContext;
  entries: StockEntry[];
  edibleYield: (productId: number) => number | null;
  overrides?: Record<string, LineOverride>;
  extras?: ExtraLine[];
}

export function ingredientKey(ing: MealieIngredient, index: number): string {
  return ing.referenceId ? `ref:${ing.referenceId}` : `idx:${index}`;
}

/** Product ids whose stock entries the planner may need (fetch these before planning). */
export function productsToLoad(recipe: MealieRecipe, ctx: MappingContext, overrides: Record<string, LineOverride> = {}, extras: ExtraLine[] = []): number[] {
  const ids = new Set<number>();
  recipe.recipeIngredient.forEach((ing, i) => {
    const o = overrides[ingredientKey(ing, i)];
    if (o?.productId) ids.add(o.productId);
    const foods = [ing.food?.id, o?.substituteFoodId, ...substitutionFoodIds(ing)].filter((x): x is string => !!x);
    for (const f of foods) {
      const p = mappedProductForFood(ctx, f);
      if (p) for (const c of stockCandidates(ctx, p.id)) ids.add(c.id);
    }
  });
  for (const x of extras) ids.add(x.productId);
  return [...ids].sort((a, b) => a - b);
}

function substitutionFoodIds(ing: MealieIngredient): string[] {
  const fromRecipe = ing.substitutions.map((s) => s.substituteFoodId);
  const fromFood = ing.food?.substitutions.map((s) => s.substituteFoodId) ?? [];
  return [...fromRecipe, ...fromFood].filter((x): x is string => !!x);
}

export function buildCookingPlan(input: PlanInput): CookingPlan {
  const { recipe } = input;
  const overrides = input.overrides ?? {};
  const baseServings = recipe.recipeServings > 0 ? recipe.recipeServings : recipe.recipeYieldQuantity > 0 ? recipe.recipeYieldQuantity : 0;
  const warnings: string[] = [];
  if (baseServings <= 0) {
    warnings.push("The recipe has no serving count in Mealie; quantities are used as written (scale 1).");
  }
  const scale = baseServings > 0 ? input.servings / baseServings : 1;

  // Lines draw from one shared pool so two lines needing the same product never over-commit a lot.
  const pool: StockEntry[] = input.entries.map((e) => ({ ...e }));
  const planned = { ...input, entries: pool };
  const lines: PlanLine[] = [];
  recipe.recipeIngredient.forEach((ing, i) => {
    const line = planIngredient(ing, ingredientKey(ing, i), scale, overrides[ingredientKey(ing, i)] ?? {}, planned);
    takeFromPool(pool, line);
    lines.push(line);
  });
  (input.extras ?? []).forEach((x, i) => {
    const line = planExtra(x, `extra:${i}`, planned);
    takeFromPool(pool, line);
    lines.push(line);
  });

  return {
    recipe: { id: recipe.id, slug: recipe.slug, name: recipe.name, baseServings },
    servings: input.servings,
    scale: roundAmount(scale),
    lines,
    blocking: lines.some((l) => l.blocking),
    warnings,
  };
}

function takeFromPool(pool: StockEntry[], line: PlanLine): void {
  for (const a of line.allocations) {
    const e = pool.find((x) => x.stock_id === a.stockId && x.product_id === a.productId);
    if (e) e.amount = roundAmount(Math.max(0, e.amount - a.amountStock));
  }
}

function emptyLine(key: string, ing: MealieIngredient, scale: number): PlanLine {
  return {
    key,
    kind: "recipe",
    display: ing.display || ing.originalText || ing.note || ing.food?.name || "(ingredient)",
    foodId: ing.food?.id ?? null,
    foodName: ing.food?.name ?? null,
    recipeQuantity: ing.quantity ? roundAmount(ing.quantity * scale) : null,
    recipeUnit: ing.unit?.name ?? null,
    status: "ok",
    blocking: false,
    target: null,
    available: null,
    shortfall: 0,
    allocations: [],
    substitutions: [],
    substitutedFrom: null,
    issues: [],
  };
}

function planIngredient(ing: MealieIngredient, key: string, scale: number, o: LineOverride, input: PlanInput): PlanLine {
  const { ctx } = input;
  const line = emptyLine(key, ing, scale);

  if (o.skip) return { ...line, status: "skipped" };
  if (!ing.food) {
    return { ...line, status: "not_tracked", issues: ["No Mealie food on this line, so it is not tracked in inventory."] };
  }
  if (!(ing.quantity && ing.quantity > 0) && !o.amount) {
    return { ...line, status: "no_quantity", issues: ["No quantity (e.g. “to taste”); nothing is consumed unless you enter an amount."] };
  }

  line.substitutions = substitutionOptions(ing, input);

  let foodId = ing.food.id;
  if (o.substituteFoodId) {
    const allowed = line.substitutions.some((s) => s.foodId === o.substituteFoodId);
    if (!allowed) {
      return block(line, "unmapped", `“${o.substituteFoodId}” is not a Mealie-defined substitution for ${ing.food.name}.`);
    }
    foodId = o.substituteFoodId;
    line.substitutedFrom = ing.food.name;
    line.foodId = foodId;
    line.foodName = line.substitutions.find((s) => s.foodId === foodId)?.foodName ?? foodId;
  }

  const mapped = o.productId ? ctx.products.get(o.productId) ?? null : mappedProductForFood(ctx, foodId);
  if (!mapped) {
    if (o.productId) return block(line, "unmapped", `Grocy product #${o.productId} does not exist.`);
    if (!ctx.mappingsAvailable) {
      return block(line, "mapping_unavailable", "Grocy-Mealie Sync is unreachable, so ingredient mappings are unknown.");
    }
    return block(line, "unmapped", `Mealie food “${line.foodName}” is not mapped to a Grocy product.`);
  }

  const targetQu = mapped.qu_id_stock;
  let need: number;
  if (o.amount) {
    need = o.amount;
  } else {
    const unit = resolveMealieUnit(ing.unit, ctx.unitMappings, ctx.catalog, targetQu);
    if (!unit.ok) return block(line, "unconvertible", `Cannot convert: ${unit.reason}.`);
    const toStock = grocyFactor(ctx.catalog, mapped.id, unit.quId, targetQu);
    if (!toStock) {
      return block(
        line,
        "unconvertible",
        `No conversion from ${unitName(ctx.catalog, unit.quId)} to ${unitName(ctx.catalog, targetQu)} for ${mapped.name}. Add a product conversion in Grocy or enter the amount.`,
      );
    }
    need = roundAmount(ing.quantity! * scale * unit.factor * toStock.factor);
    if (toStock.source === "builtin") {
      line.issues.push(`Converted ${unitName(ctx.catalog, unit.quId)} → ${unitName(ctx.catalog, targetQu)} with a standard factor (no Grocy conversion defined).`);
    }
  }

  const family = o.productId ? [mapped] : stockCandidates(ctx, mapped.id);
  const candidates: CandidateProduct[] = [];
  for (const p of family) {
    const f = grocyFactor(ctx.catalog, p.id, p.qu_id_stock, targetQu) ?? grocyFactor(ctx.catalog, mapped.id, p.qu_id_stock, targetQu);
    if (!f) {
      line.issues.push(`${p.name} is stocked in ${unitName(ctx.catalog, p.qu_id_stock)}, which cannot be converted to ${unitName(ctx.catalog, targetQu)}; it is not used.`);
      continue;
    }
    candidates.push({
      productId: p.id,
      productName: p.name,
      stockQuId: p.qu_id_stock,
      stockUnitName: unitName(ctx.catalog, p.qu_id_stock, 2),
      toTarget: f.factor,
      edibleYield: input.edibleYield(p.id) ?? 1,
    });
  }

  const selection = withUnitNames(ctx, selectLots(need, candidates, input.entries));
  line.target = { productId: mapped.id, productName: mapped.name, quId: targetQu, unitName: unitName(ctx.catalog, targetQu, need), amount: need };
  line.available = selection.available;
  line.allocations = selection.allocations;
  line.shortfall = selection.shortfall;
  if (o.productId && !stockCandidates(ctx, mappedProductForFood(ctx, foodId)?.id ?? -1).some((p) => p.id === o.productId)) {
    line.issues.push(`Using ${mapped.name} by household choice (not part of the mapped products for ${line.foodName}).`);
  }

  if (selection.shortfall > 0) {
    line.status = "short";
    line.blocking = !o.acceptShortfall;
    line.issues.push(
      `Short by ${fmt(selection.shortfall)} ${line.target.unitName} (have ${fmt(selection.available)}).` +
        (o.acceptShortfall ? " The available stock will be consumed and the rest recorded as missing." : ""),
    );
  }
  return line;
}

function planExtra(x: ExtraLine, key: string, input: PlanInput): PlanLine {
  const { ctx } = input;
  const p = ctx.products.get(x.productId);
  const base: PlanLine = {
    key,
    kind: "extra",
    display: x.note ? `Added: ${x.note}` : "Added ingredient",
    foodId: null,
    foodName: null,
    recipeQuantity: null,
    recipeUnit: null,
    status: "ok",
    blocking: false,
    target: null,
    available: null,
    shortfall: 0,
    allocations: [],
    substitutions: [],
    substitutedFrom: null,
    issues: [],
  };
  if (!p) return block(base, "unmapped", `Grocy product #${x.productId} does not exist.`);
  const candidate: CandidateProduct = {
    productId: p.id,
    productName: p.name,
    stockQuId: p.qu_id_stock,
    stockUnitName: unitName(ctx.catalog, p.qu_id_stock, 2),
    toTarget: 1,
    edibleYield: 1,
  };
  const sel = withUnitNames(ctx, selectLots(x.amount, [candidate], input.entries));
  const line: PlanLine = {
    ...base,
    display: x.note ? `Added: ${x.note} (${p.name})` : `Added: ${p.name}`,
    target: { productId: p.id, productName: p.name, quId: p.qu_id_stock, unitName: unitName(ctx.catalog, p.qu_id_stock, x.amount), amount: x.amount },
    available: sel.available,
    allocations: sel.allocations,
    shortfall: sel.shortfall,
  };
  if (sel.shortfall > 0) return { ...line, status: "short", blocking: true, issues: [`Only ${fmt(sel.available)} in stock.`] };
  return line;
}

/** Singular or plural unit name to match each allocated amount ("1 Piece", "2 Pieces"). */
function withUnitNames<T extends { allocations: Allocation[] }>(ctx: MappingContext, sel: T): T {
  return { ...sel, allocations: sel.allocations.map((a) => ({ ...a, stockUnitName: unitName(ctx.catalog, a.stockQuId, a.amountStock) })) };
}

function substitutionOptions(ing: MealieIngredient, input: PlanInput): SubstitutionOption[] {
  const { ctx } = input;
  const seen = new Set<string>();
  const out: SubstitutionOption[] = [];
  for (const s of [...ing.substitutions, ...(ing.food?.substitutions ?? [])]) {
    const id = s.substituteFoodId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = mappedProductForFood(ctx, id);
    let available: number | null = null;
    if (p) {
      available = 0;
      for (const c of stockCandidates(ctx, p.id)) {
        const f = grocyFactor(ctx.catalog, c.id, c.qu_id_stock, p.qu_id_stock);
        if (!f) continue;
        for (const e of input.entries) if (e.product_id === c.id) available += e.amount * f.factor;
      }
      available = roundAmount(available);
    }
    out.push({
      foodId: id,
      foodName: s.substituteFood?.name ?? id,
      note: s.note,
      mappedProductId: p?.id ?? null,
      available,
      unitName: p ? unitName(ctx.catalog, p.qu_id_stock, 2) : null,
    });
  }
  return out;
}

function block(line: PlanLine, status: PlanLineStatus, issue: string): PlanLine {
  return { ...line, status, blocking: true, issues: [...line.issues, issue] };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

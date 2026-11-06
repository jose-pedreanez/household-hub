import "server-only";
import { z } from "zod";
import { mappingContext, recipe as loadRecipe } from "../context";
import { AppError } from "../errors";
import { hashRequest } from "../idempotency";
import { services } from "../services";
import type { CookingDeps } from "./execute";
import { CookingJournal } from "./journal";
import { buildCookingPlan, extraLineSchema, lineOverrideSchema, productsToLoad, type CookingPlan } from "./plan";

export const cookRequestSchema = z.object({
  recipeSlug: z.string().min(1),
  mealplanEntryId: z.number().int().positive().nullable().default(null),
  servings: z.number().positive().max(50),
  leftoverServings: z.number().min(0).max(50).default(0),
  overrides: z.record(z.string(), lineOverrideSchema).default({}),
  extras: z.array(extraLineSchema).max(20).default([]),
});
export type CookRequest = z.infer<typeof cookRequestSchema>;

export const cookExecuteSchema = cookRequestSchema.extend({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});

export async function previewCooking(req: CookRequest): Promise<CookingPlan> {
  const { grocy, metadata } = services();
  const recipe = await loadRecipe(req.recipeSlug, true);
  if (!recipe) throw new AppError("not_found", `Recipe “${req.recipeSlug}” not found in Mealie`);
  const ctx = await mappingContext(5_000);
  const ids = productsToLoad(recipe, ctx, req.overrides, req.extras);
  const entries = (await Promise.all(ids.map((id) => grocy.stockEntries(id)))).flat();
  return buildCookingPlan({
    recipe,
    servings: req.servings,
    ctx,
    entries,
    edibleYield: (id) => metadata.edibleYield(id),
    overrides: req.overrides,
    extras: req.extras,
  });
}

/** Hash of the household's intent; the plan itself is recomputed from live stock. */
export function cookRequestHash(req: CookRequest): string {
  return hashRequest(req);
}

export function cookingDeps(): CookingDeps {
  const { db, grocy, mealie } = services();
  return { journal: new CookingJournal(db), grocy, mealie };
}

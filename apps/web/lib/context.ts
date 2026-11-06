import "server-only";
import type { MealieRecipe } from "./mealie/schemas";
import { services } from "./services";
import { loadMappingContext, type MappingContext } from "./sync/mappings";

/**
 * Short-lived caches so one page view or one cooking flow does not refetch every Grocy product,
 * unit and conversion several times. Writes that change products or mappings call `invalidate()`.
 */

const g = globalThis as unknown as {
  __hubCtx?: { ctx: Promise<MappingContext>; at: number };
  __hubRecipes?: Map<string, { recipe: MealieRecipe; at: number }>;
};

const CTX_TTL_MS = 20_000;
const RECIPE_TTL_MS = 5 * 60_000;

export function mappingContext(maxAgeMs = CTX_TTL_MS): Promise<MappingContext> {
  const cached = g.__hubCtx;
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.ctx;
  const { grocy, gms } = services();
  const ctx = loadMappingContext(grocy, gms);
  g.__hubCtx = { ctx, at: Date.now() };
  ctx.catch(() => {
    if (g.__hubCtx?.ctx === ctx) g.__hubCtx = undefined;
  });
  return ctx;
}

export function invalidate(): void {
  g.__hubCtx = undefined;
}

export async function recipe(slugOrId: string, fresh = false): Promise<MealieRecipe | null> {
  g.__hubRecipes ??= new Map();
  const hit = g.__hubRecipes.get(slugOrId);
  if (!fresh && hit && Date.now() - hit.at < RECIPE_TTL_MS) return hit.recipe;
  const r = await services().mealie.getRecipe(slugOrId);
  if (r) {
    g.__hubRecipes.set(r.slug, { recipe: r, at: Date.now() });
    g.__hubRecipes.set(r.id, { recipe: r, at: Date.now() });
  }
  return r;
}

export function forgetRecipe(slugOrId: string): void {
  g.__hubRecipes?.delete(slugOrId);
}

import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { today } from "../api";
import { householdConfig } from "../config";
import { mappingContext, recipe as loadRecipe } from "../context";
import { nowIso } from "../db";
import { AppError } from "../errors";
import { isNeverExpires } from "../grocy/client";
import { hashRequest } from "../idempotency";
import { PlanAnnotations } from "../meals/annotations";
import { addDays, listMeals } from "../meals/service";
import { PLAN_ENTRY_TYPES, type MealieRecipe, type PlanEntryType } from "../mealie/schemas";
import { services } from "../services";
import { foodForProduct } from "../sync/mappings";
import { planHeuristically, parseMinutes, type RecipeInfo } from "./heuristic";
import { aiProvider } from "./index";
import { type PlanSlot, type ValidatedMeal } from "./schemas";
import { suggestWithProvider } from "./suggest";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const planRequestSchema = z.object({
  start: isoDate,
  days: z.number().int().min(1).max(14).default(7),
  slots: z.array(z.enum(PLAN_ENTRY_TYPES)).min(1).optional(),
  servings: z.number().positive().max(24).optional(),
  note: z.string().max(300).optional(),
  useAi: z.boolean().default(true),
});
export type PlanRequest = z.infer<typeof planRequestSchema>;

export interface PlannedSuggestion extends ValidatedMeal {
  source: "ai" | "heuristic";
  proposalId: string | null;
}

export interface PlanResult {
  runId: string;
  source: "ai" | "heuristic" | "mixed";
  provider: string;
  model: string | null;
  cached: boolean;
  meals: PlannedSuggestion[];
  unfilled: PlanSlot[];
  issues: string[];
  notes: string;
}

const CACHE_MS = 15 * 60_000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function recipeCatalog(): Promise<{ infos: RecipeInfo[]; recipes: MealieRecipe[] }> {
  const { mealie } = services();
  const summaries = await mealie.allRecipeSummaries();
  const full = (await mapLimit(summaries.slice(0, 300), 6, (s) => loadRecipe(s.slug).catch(() => null))).filter(
    (r): r is MealieRecipe => r !== null,
  );
  const infos = full.map((r) => {
    const foods = r.recipeIngredient.filter((i) => i.food);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      foodIds: [...new Set(foods.map((i) => i.food!.id))],
      foodNames: [...new Set(foods.map((i) => i.food!.name))],
      totalMinutes: parseMinutes(r.totalTime) ?? ((parseMinutes(r.prepTime) ?? 0) + (parseMinutes(r.performTime) ?? 0) || null),
      rating: r.rating,
      tags: r.tags.map((t) => t.name),
    };
  });
  return { infos, recipes: full };
}

/** Inventory facts shared by the planner, the assistant and the heuristic. All from Grocy. */
export async function inventoryFacts() {
  const { grocy } = services();
  const cfg = householdConfig().config;
  const [ctx, stock, volatile] = await Promise.all([mappingContext(), grocy.currentStock(), grocy.volatileStock(cfg.inventory.expiringSoonDays)]);
  const inStockFoodIds = new Set<string>();
  const inventory: Array<{ name: string; food: string | null; amount: number; unit: string; due: string | null }> = [];
  for (const s of stock) {
    if (s.amount <= 0) continue;
    const food = foodForProduct(ctx, s.product_id);
    if (food) inStockFoodIds.add(food.mealieFoodId);
    const unit = ctx.catalog.units.get(s.product.qu_id_stock);
    inventory.push({
      name: s.product.name,
      food: food?.mealieFoodName ?? null,
      amount: s.amount,
      unit: (s.amount === 1 ? unit?.name : unit?.name_plural ?? unit?.name) ?? "",
      due: isNeverExpires(s.best_before_date) ? null : s.best_before_date,
    });
  }
  const expiringFoodIds = new Map<string, string>();
  const expiring: Array<{ name: string; food: string | null; due: string }> = [];
  for (const v of [...volatile.overdue_products, ...volatile.due_products]) {
    const p = ctx.products.get(v.product_id);
    if (!p || !v.best_before_date) continue;
    const food = foodForProduct(ctx, p.id);
    if (food && !expiringFoodIds.has(food.mealieFoodId)) expiringFoodIds.set(food.mealieFoodId, v.best_before_date);
    if (!expiring.some((e) => e.name === p.name)) expiring.push({ name: p.name, food: food?.mealieFoodName ?? null, due: v.best_before_date });
  }
  return { inventory, inStockFoodIds, expiring, expiringFoodIds, ctx };
}

const SYSTEM = `You plan meals for a household. You receive their current inventory, items expiring soon, their recipe catalog, recent meals and preferences, and a list of empty meal slots.

Fill each requested slot with one meal:
- Prefer an existing recipe from the catalog, referenced by its exact "id". Propose a new recipe (recipeId null, newRecipe filled in) only when no catalog recipe fits well, and at most one or two per plan.
- Favour practical, varied meals that use ingredients already on hand, especially items expiring soon, to reduce waste. Avoid repeating recent meals.
- Respect the stated time limits, equipment, dislikes and any dietary restrictions. Do not add restrictions that are not listed.
- usesExpiring may only contain names from the expiring list.
- Never state inventory quantities and never invent nutrition values; the household's software computes those.
- Keep each reason to one short sentence.`;

export async function generatePlan(req: PlanRequest): Promise<PlanResult> {
  const { db } = services();
  const cfg = householdConfig().config;
  const slotsWanted = req.slots ?? cfg.meals.plannerSlots;
  const end = addDays(req.start, req.days - 1);
  const existing = await listMeals(req.start, end);
  const filled = new Set(existing.map((m) => `${m.date}|${m.entryType}`));
  const slots: PlanSlot[] = [];
  for (let i = 0; i < req.days; i++) {
    const date = addDays(req.start, i);
    for (const entryType of slotsWanted) if (!filled.has(`${date}|${entryType}`)) slots.push({ date, entryType });
  }
  if (slots.length === 0) throw new AppError("unprocessable", "Every requested slot in that range is already planned.");

  const [{ infos, recipes }, facts, recentMeals] = await Promise.all([
    recipeCatalog(),
    inventoryFacts(),
    listMeals(addDays(req.start, -21), addDays(req.start, -1)).catch(() => []),
  ]);
  const status = aiProvider();
  const useAi = req.useAi && status.provider !== null;

  const recent = new Map<string, string>();
  for (const r of recipes) if (r.lastMade) recent.set(r.id, r.lastMade.slice(0, 10));
  for (const m of [...recentMeals, ...existing]) if (m.recipe) recent.set(m.recipe.id, m.date);
  const favorites = new Set(recipes.filter((r) => (r.rating ?? 0) >= 4 || r.tags.some((t) => t.name.toLowerCase() === cfg.meals.favoritesTag.toLowerCase())).map((r) => r.id));

  const fingerprint = hashRequest({
    req,
    slots,
    provider: useAi ? `${status.provider!.name}:${status.provider!.model}` : "heuristic",
    inv: facts.inventory.map((i) => [i.name, i.amount, i.due]),
    recipes: infos.map((r) => r.id).sort(),
  });
  const cachedRun = db
    .prepare("SELECT id, result_json FROM ai_plan_runs WHERE request_hash = ? AND status = 'ok' AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .get(fingerprint, new Date(Date.now() - CACHE_MS).toISOString()) as { id: string; result_json: string } | undefined;
  if (cachedRun) return { ...(JSON.parse(cachedRun.result_json) as PlanResult), cached: true };

  const issues: string[] = [];
  let notes = "";
  let aiMeals: ValidatedMeal[] = [];
  let raw: string | null = null;
  let runStatus: "ok" | "invalid" | "error" = "ok";

  if (req.useAi && !status.provider && status.configured !== "none") issues.push(`AI provider not usable (${status.problem}); used the built-in planner.`);
  if (useAi) {
    const provider = status.provider!;
    const weekend = (d: string) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
    const context = {
      today: today(),
      slots: slots.map((s) => ({ ...s, maxMinutes: weekend(s.date) ? cfg.meals.maxCookingMinutes.weekend : cfg.meals.maxCookingMinutes.weeknight })),
      defaultServings: req.servings ?? cfg.household.defaultServings,
      householdNote: req.note ?? null,
      inventory: facts.inventory.slice(0, 200).map((i) => ({ name: i.name, food: i.food, due: i.due })),
      expiring: facts.expiring,
      recipes: infos.map((r) => ({ id: r.id, name: r.name, foods: r.foodNames, minutes: r.totalMinutes, rating: r.rating, tags: r.tags, favorite: favorites.has(r.id) })),
      recentMeals: [...recentMeals].map((m) => ({ date: m.date, recipe: m.recipe?.name ?? m.title })).slice(-30),
      preferences: cfg.meals.preferences,
      dietaryRestrictions: cfg.meals.dietaryRestrictions,
      equipment: cfg.meals.equipment,
      avoidRepeatDays: cfg.meals.avoidRepeatDays,
    };
    const out = await suggestWithProvider(provider, {
      system: SYSTEM,
      context,
      slots,
      recipes: infos,
      expiringNames: facts.expiring.map((e) => e.name),
      knownFoods: [...facts.ctx.productMappings.map((m) => m.mealieFoodName), ...infos.flatMap((r) => r.foodNames)],
    });
    aiMeals = out.meals;
    issues.push(...out.issues);
    notes = out.notes;
    raw = out.raw;
    runStatus = out.status;
  }

  // Deterministic planner for every slot the AI did not (validly) fill.
  const aiKeys = new Set(aiMeals.map((m) => `${m.date}|${m.entryType}`));
  const gaps = slots.filter((s) => !aiKeys.has(`${s.date}|${s.entryType}`));
  for (const m of aiMeals) if (m.recipeId) recent.set(m.recipeId, m.date);
  const heuristic = planHeuristically({
    slots: gaps,
    recipes: infos,
    inStockFoodIds: facts.inStockFoodIds,
    expiringFoodIds: facts.expiringFoodIds,
    recent,
    favorites,
    maxMinutes: (d) => ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()) ? cfg.meals.maxCookingMinutes.weekend : cfg.meals.maxCookingMinutes.weeknight),
    avoidRepeatDays: cfg.meals.avoidRepeatDays,
    dislikes: cfg.meals.preferences.dislikes,
  });
  const foodName = new Map(infos.flatMap((r) => r.foodIds.map((id, i) => [id, r.foodNames[i]] as const)));
  const servings = req.servings ?? cfg.household.defaultServings;

  const runId = randomUUID();
  const meals: PlannedSuggestion[] = [];
  for (const m of aiMeals) {
    let proposalId: string | null = null;
    if (m.newRecipe) {
      proposalId = randomUUID();
      db.prepare("INSERT INTO recipe_proposals(id, source_run_id, name, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(
        proposalId,
        runId,
        m.newRecipe.name,
        JSON.stringify(m.newRecipe),
        nowIso(),
      );
    }
    meals.push({ ...m, source: "ai", proposalId });
  }
  for (const h of heuristic) {
    meals.push({
      date: h.date,
      entryType: h.entryType,
      recipeId: h.recipeId,
      recipeSlug: h.recipeSlug,
      recipeName: h.recipeName,
      newRecipe: null,
      servings,
      usesExpiring: h.usesExpiringFoodIds.map((id) => foodName.get(id) ?? id),
      reason: h.reasons.join("; ") || "fits what you have",
      source: "heuristic",
      proposalId: null,
    });
  }
  meals.sort((a, b) => a.date.localeCompare(b.date) || PLAN_ENTRY_TYPES.indexOf(a.entryType) - PLAN_ENTRY_TYPES.indexOf(b.entryType));
  const covered = new Set(meals.map((m) => `${m.date}|${m.entryType}`));
  const unfilled = slots.filter((s) => !covered.has(`${s.date}|${s.entryType}`));
  if (unfilled.length > 0) issues.push(`${unfilled.length} slot(s) left empty: not enough suitable recipes in Mealie.`);

  const result: PlanResult = {
    runId,
    source: aiMeals.length > 0 && heuristic.length > 0 ? "mixed" : aiMeals.length > 0 ? "ai" : "heuristic",
    provider: useAi ? status.provider!.name : "heuristic",
    model: useAi ? status.provider!.model : null,
    cached: false,
    meals,
    unfilled,
    issues,
    notes,
  };
  db.prepare(
    "INSERT INTO ai_plan_runs(id, request_hash, provider, model, status, raw_output, result_json, issues_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, fingerprint, result.provider, result.model, runStatus, raw, JSON.stringify(result), JSON.stringify(issues), nowIso());
  return result;
}

export const applyPlanSchema = z.object({
  runId: z.string().uuid(),
  /** Indexes into the run's meals that the household accepted. */
  accept: z.array(z.number().int().min(0)).min(1),
});

/** Write accepted suggestions into Mealie (the meal-plan authority). Skips slots filled meanwhile. */
export async function applyPlan(runId: string, accept: number[]) {
  const { db, mealie } = services();
  const row = db.prepare("SELECT result_json FROM ai_plan_runs WHERE id = ?").get(runId) as { result_json: string } | undefined;
  if (!row) throw new AppError("not_found", "Plan run not found");
  const result = JSON.parse(row.result_json) as PlanResult;
  const annotations = new PlanAnnotations(db);
  const created: Array<{ entryId: number; date: string; entryType: PlanEntryType; recipeName: string }> = [];
  const skipped: string[] = [];
  const dates = result.meals.map((m) => m.date).sort();
  const existing = dates.length ? await listMeals(dates[0], dates[dates.length - 1]) : [];

  for (const i of [...new Set(accept)].sort((a, b) => a - b)) {
    const m = result.meals[i];
    if (!m) continue;
    let recipeId = m.recipeId;
    if (!recipeId && m.proposalId) {
      const p = db.prepare("SELECT status, mealie_slug FROM recipe_proposals WHERE id = ?").get(m.proposalId) as { status: string; mealie_slug: string | null } | undefined;
      if (p?.status !== "approved" || !p.mealie_slug) {
        skipped.push(`${m.date} ${m.entryType}: approve the new recipe “${m.recipeName}” first.`);
        continue;
      }
      recipeId = (await loadRecipe(p.mealie_slug))?.id ?? null;
    }
    if (!recipeId) continue;
    if (existing.some((e) => e.date === m.date && e.entryType === m.entryType)) {
      skipped.push(`${m.date} ${m.entryType}: already planned.`);
      continue;
    }
    const entry = await mealie.createMealPlan({ date: m.date, entryType: m.entryType, recipeId });
    annotations.set(entry.id, { plannedServings: m.servings });
    existing.push({ id: entry.id, date: m.date, entryType: m.entryType } as (typeof existing)[number]);
    created.push({ entryId: entry.id, date: m.date, entryType: m.entryType, recipeName: m.recipeName });
  }
  return { created, skipped };
}

/** Create a reviewed AI recipe proposal in Mealie. Unknown ingredients become plain text lines. */
export async function approveProposal(id: string) {
  const { db, mealie } = services();
  const p = db.prepare("SELECT * FROM recipe_proposals WHERE id = ?").get(id) as { status: string; payload_json: string; mealie_slug: string | null; name: string } | undefined;
  if (!p) throw new AppError("not_found", "Proposal not found");
  if (p.status === "approved") return { slug: p.mealie_slug };
  if (p.status === "rejected") throw new AppError("conflict", "Proposal was rejected");
  const r = JSON.parse(p.payload_json) as ValidatedMeal["newRecipe"] & object;
  const foods = await mealie.listFoods();
  const byName = new Map(foods.map((f) => [f.name.toLowerCase(), f]));
  const ingredients = r.ingredients.map((i) => {
    const food = byName.get(i.food.toLowerCase());
    const text = [i.quantity, i.unit, i.food, i.note].filter((x) => x !== null && x !== "").join(" ");
    return food
      ? { quantity: i.quantity ?? 0, food: { id: food.id, name: food.name }, note: [i.unit, i.note].filter(Boolean).join(" "), originalText: text }
      : { quantity: 0, note: text, originalText: text };
  });
  const slug = await mealie.createRecipe(r.name, {
    description: r.description,
    recipeServings: r.servings,
    totalTime: r.totalTimeMinutes ? `${r.totalTimeMinutes} minutes` : null,
    recipeIngredient: ingredients,
    recipeInstructions: r.steps.map((text) => ({ text })),
  });
  db.prepare("UPDATE recipe_proposals SET status = 'approved', mealie_slug = ?, decided_at = ? WHERE id = ?").run(slug, nowIso(), id);
  return { slug };
}

export function rejectProposal(id: string): void {
  services().db.prepare("UPDATE recipe_proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), id);
}

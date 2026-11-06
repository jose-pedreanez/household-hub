import "server-only";
import { householdConfig } from "../config";
import { recipe as loadRecipe } from "../context";
import { CookingJournal } from "../cooking/journal";
import type { MealPlanEntry, MealieRecipe, PlanEntryType } from "../mealie/schemas";
import { services } from "../services";
import { PlanAnnotations } from "./annotations";

export interface PlannedMeal {
  id: number;
  date: string;
  entryType: PlanEntryType;
  title: string;
  text: string;
  recipe: {
    id: string;
    slug: string;
    name: string;
    servings: number;
    totalTime: string | null;
    rating: number | null;
  } | null;
  plannedServings: number;
  leftoverOf: string | null;
  cooked: { occurrenceId: string; status: string; servings: number } | null;
}

export function defaultServings(r: { recipeServings: number } | null): number {
  const fallback = householdConfig().config.household.defaultServings;
  return r && r.recipeServings > 0 ? r.recipeServings : fallback;
}

export async function listMeals(start: string, end: string): Promise<PlannedMeal[]> {
  const { mealie, db } = services();
  const entries = await mealie.mealPlans(start, end);
  const annotations = new PlanAnnotations(db).getMany(entries.map((e) => e.id));
  const cooked = new CookingJournal(db).forMealplanEntries(entries.map((e) => e.id));
  return entries
    .map((e) => toPlannedMeal(e, annotations.get(e.id), cooked.get(e.id)))
    .sort((a, b) => a.date.localeCompare(b.date) || slotOrder(a.entryType) - slotOrder(b.entryType) || a.id - b.id);
}

const ORDER: PlanEntryType[] = ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert"];
export function slotOrder(t: PlanEntryType): number {
  return ORDER.indexOf(t);
}

function toPlannedMeal(
  e: MealPlanEntry,
  a: { plannedServings: number | null; leftoverOfOccurrenceId: string | null } | undefined,
  c: { id: string; status: string; servings: number } | undefined,
): PlannedMeal {
  return {
    id: e.id,
    date: e.date,
    entryType: e.entryType,
    title: e.title,
    text: e.text,
    recipe: e.recipe
      ? {
          id: e.recipe.id,
          slug: e.recipe.slug,
          name: e.recipe.name,
          servings: e.recipe.recipeServings,
          totalTime: e.recipe.totalTime,
          rating: e.recipe.rating,
        }
      : null,
    plannedServings: a?.plannedServings ?? defaultServings(e.recipe ? { recipeServings: e.recipe.recipeServings } : null),
    leftoverOf: a?.leftoverOfOccurrenceId ?? null,
    cooked: c ? { occurrenceId: c.id, status: c.status, servings: c.servings } : null,
  };
}

/** Meals that still need ingredients: have a recipe, are not leftovers and are not cooked yet. */
export async function mealsNeedingIngredients(start: string, end: string): Promise<Array<{ meal: PlannedMeal; recipe: MealieRecipe }>> {
  const meals = (await listMeals(start, end)).filter((m) => m.recipe && !m.leftoverOf && !m.cooked);
  const out: Array<{ meal: PlannedMeal; recipe: MealieRecipe }> = [];
  for (const m of meals) {
    const r = await loadRecipe(m.recipe!.slug);
    if (r) out.push({ meal: m, recipe: r });
  }
  return out;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `iso`. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

import { z } from "zod";
import { PLAN_ENTRY_TYPES, type PlanEntryType } from "../mealie/schemas";

/**
 * What the AI may return for a meal plan. It references recipes by id or proposes new ones; it never
 * returns inventory quantities or nutrition, which are computed deterministically elsewhere.
 * Fields use `nullable` instead of `optional` so both providers' strict schema modes accept them.
 */
export const aiNewRecipeSchema = z.object({
  name: z.string().describe("Name of the proposed new recipe"),
  description: z.string().describe("One or two sentences"),
  servings: z.number().describe("Servings the recipe makes"),
  totalTimeMinutes: z.number().nullable().describe("Total time in minutes, or null if unknown"),
  ingredients: z
    .array(
      z.object({
        food: z.string().describe("Ingredient name, preferably one from the provided food list"),
        quantity: z.number().nullable(),
        unit: z.string().nullable(),
        note: z.string().nullable(),
      }),
    )
    .describe("Recipe ingredients (recipe content for household review, not inventory)"),
  steps: z.array(z.string()),
});

export const aiMealSchema = z.object({
  date: z.string().describe("YYYY-MM-DD, within the requested range"),
  slot: z.enum(PLAN_ENTRY_TYPES).describe("Meal slot"),
  recipeId: z.string().nullable().describe("id of an existing recipe from the catalog, or null when proposing a new recipe"),
  newRecipe: aiNewRecipeSchema.nullable().describe("Only when recipeId is null"),
  servings: z.number().describe("Servings to cook"),
  usesExpiring: z.array(z.string()).describe("Names of items from the expiring list that this meal uses; empty if none"),
  reason: z.string().describe("Short reason for the household"),
});

export const aiPlanSchema = z.object({
  meals: z.array(aiMealSchema),
  notes: z.string().describe("Optional short note for the household; empty string if none"),
});
export type AiPlan = z.infer<typeof aiPlanSchema>;
export type AiNewRecipe = z.infer<typeof aiNewRecipeSchema>;

export interface PlanSlot {
  date: string;
  entryType: PlanEntryType;
}

export interface ValidatedMeal {
  date: string;
  entryType: PlanEntryType;
  recipeId: string | null;
  recipeSlug: string | null;
  recipeName: string;
  newRecipe: (AiNewRecipe & { unknownFoods: string[] }) | null;
  servings: number;
  usesExpiring: string[];
  reason: string;
}

export interface ValidationOutcome {
  meals: ValidatedMeal[];
  issues: string[];
  notes: string;
}

/** Second, stricter pass over AI output: every reference is checked against real data. */
export function validateAiPlan(
  plan: AiPlan,
  opts: {
    slots: PlanSlot[];
    recipes: Array<{ id: string; slug: string; name: string }>;
    expiringNames: string[];
    knownFoods: string[];
  },
): ValidationOutcome {
  const issues: string[] = [];
  const meals: ValidatedMeal[] = [];
  const slotKeys = new Set(opts.slots.map((s) => `${s.date}|${s.entryType}`));
  const recipes = new Map(opts.recipes.map((r) => [r.id, r]));
  const expiring = new Map(opts.expiringNames.map((n) => [n.toLowerCase(), n]));
  const foods = new Set(opts.knownFoods.map((f) => f.toLowerCase()));
  const used = new Set<string>();

  for (const m of plan.meals) {
    const key = `${m.date}|${m.slot}`;
    if (!slotKeys.has(key)) {
      issues.push(`Ignored a meal for ${m.date} ${m.slot}: that slot was not requested or is already planned.`);
      continue;
    }
    if (used.has(key)) {
      issues.push(`Ignored a second meal for ${m.date} ${m.slot}.`);
      continue;
    }
    let recipe: { id: string; slug: string; name: string } | null = null;
    if (m.recipeId) {
      recipe = recipes.get(m.recipeId) ?? null;
      if (!recipe) {
        issues.push(`Ignored a meal for ${m.date} ${m.slot}: recipe id ${m.recipeId} does not exist in Mealie.`);
        continue;
      }
    } else if (!m.newRecipe) {
      issues.push(`Ignored a meal for ${m.date} ${m.slot}: it named neither a recipe nor a new recipe.`);
      continue;
    }
    let servings = m.servings;
    if (!(servings > 0 && servings <= 24)) {
      issues.push(`Servings ${servings} for ${m.date} ${m.slot} is out of range; using 2.`);
      servings = 2;
    }
    const usesExpiring: string[] = [];
    for (const name of m.usesExpiring) {
      const real = expiring.get(name.toLowerCase());
      if (real) usesExpiring.push(real);
      else issues.push(`“${name}” is not in the expiring inventory list; removed from ${m.date} ${m.slot}.`);
    }
    const newRecipe = !recipe && m.newRecipe
      ? { ...m.newRecipe, unknownFoods: m.newRecipe.ingredients.map((i) => i.food).filter((f) => !foods.has(f.toLowerCase())) }
      : null;
    if (newRecipe && newRecipe.unknownFoods.length > 0) {
      issues.push(`Proposed recipe “${newRecipe.name}” uses ingredients not in Mealie: ${newRecipe.unknownFoods.join(", ")}. They will be added as text lines.`);
    }
    used.add(key);
    meals.push({
      date: m.date,
      entryType: m.slot,
      recipeId: recipe?.id ?? null,
      recipeSlug: recipe?.slug ?? null,
      recipeName: recipe?.name ?? newRecipe!.name,
      newRecipe,
      servings: Math.round(servings * 2) / 2,
      usesExpiring,
      reason: m.reason.slice(0, 300),
    });
  }
  return { meals, issues, notes: plan.notes.slice(0, 500) };
}

import { z } from "zod";

const nstr = z.string().nullable().optional().transform((v) => v ?? null);
const nnum = z.number().nullable().optional().transform((v) => v ?? null);

export const mealieUnitSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    pluralName: nstr,
    abbreviation: nstr,
    standardQuantity: nnum,
    standardUnit: nstr,
  })
  .loose();
export type MealieUnit = z.infer<typeof mealieUnitSchema>;

const foodSummary = z.object({ id: z.string(), name: z.string() }).loose();

export const mealieSubstitutionSchema = z
  .object({ substituteFoodId: nstr, substituteFood: foodSummary.nullable().optional(), note: nstr })
  .loose();
export type MealieSubstitution = z.infer<typeof mealieSubstitutionSchema>;

export const mealieFoodSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    pluralName: nstr,
    description: nstr,
    labelId: nstr,
    aliases: z.array(z.object({ name: z.string() }).loose()).optional().default([]),
    substitutions: z.array(mealieSubstitutionSchema).optional().default([]),
    householdsWithIngredientFood: z.array(z.string()).optional().default([]),
  })
  .loose();
export type MealieFood = z.infer<typeof mealieFoodSchema>;

export const mealieIngredientSchema = z
  .object({
    quantity: nnum,
    unit: mealieUnitSchema.nullable().optional().transform((v) => v ?? null),
    food: mealieFoodSchema.nullable().optional().transform((v) => v ?? null),
    note: nstr,
    display: z.string().optional().default(""),
    title: nstr,
    originalText: nstr,
    referenceId: z.string().optional(),
    substitutions: z.array(mealieSubstitutionSchema).optional().default([]),
  })
  .loose();
export type MealieIngredient = z.infer<typeof mealieIngredientSchema>;

const tagLike = z.object({ id: z.string().optional(), name: z.string(), slug: z.string().optional() }).loose();

export const mealieRecipeSummarySchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string().nullable().transform((v) => v ?? "(untitled)"),
    description: nstr,
    recipeServings: z.number().optional().default(0),
    recipeYieldQuantity: z.number().optional().default(0),
    recipeYield: nstr,
    totalTime: nstr,
    prepTime: nstr,
    performTime: nstr,
    rating: nnum,
    lastMade: nstr,
    tags: z.array(tagLike).nullable().optional().transform((v) => v ?? []),
    recipeCategory: z.array(tagLike).nullable().optional().transform((v) => v ?? []),
    tools: z.array(tagLike).optional().default([]),
    image: z.unknown().optional(),
  })
  .loose();
export type MealieRecipeSummary = z.infer<typeof mealieRecipeSummarySchema>;

export const mealieNutritionSchema = z
  .object({
    calories: nstr,
    proteinContent: nstr,
    carbohydrateContent: nstr,
    fatContent: nstr,
    fiberContent: nstr,
    sodiumContent: nstr,
    sugarContent: nstr,
  })
  .loose();

export const mealieRecipeSchema = mealieRecipeSummarySchema
  .extend({
    recipeIngredient: z.array(mealieIngredientSchema).default([]),
    recipeInstructions: z.array(z.object({ text: z.string().optional().default("") }).loose()).nullable().optional(),
    nutrition: mealieNutritionSchema.nullable().optional(),
  })
  .loose();
export type MealieRecipe = z.infer<typeof mealieRecipeSchema>;

export const PLAN_ENTRY_TYPES = ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert"] as const;
export type PlanEntryType = (typeof PLAN_ENTRY_TYPES)[number];

export const mealPlanEntrySchema = z
  .object({
    id: z.number().int(),
    date: z.string(),
    entryType: z.enum(PLAN_ENTRY_TYPES),
    title: z.string().optional().default(""),
    text: z.string().optional().default(""),
    recipeId: nstr,
    recipe: mealieRecipeSummarySchema.nullable().optional().transform((v) => v ?? null),
  })
  .loose();
export type MealPlanEntry = z.infer<typeof mealPlanEntrySchema>;

export const shoppingListItemSchema = z
  .object({
    id: z.string(),
    shoppingListId: z.string(),
    checked: z.boolean().default(false),
    position: z.number().optional().default(0),
    quantity: z.number().optional().default(0),
    note: nstr,
    display: z.string().optional().default(""),
    foodId: nstr,
    unitId: nstr,
    food: mealieFoodSchema.nullable().optional().transform((v) => v ?? null),
    unit: mealieUnitSchema.nullable().optional().transform((v) => v ?? null),
    extras: z.record(z.string(), z.unknown()).nullable().optional().transform((v) => v ?? {}),
    updatedAt: nstr,
  })
  .loose();
export type ShoppingListItem = z.infer<typeof shoppingListItemSchema>;

export const shoppingListSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().transform((v) => v ?? ""),
    extras: z.record(z.string(), z.unknown()).nullable().optional().transform((v) => v ?? {}),
    listItems: z.array(shoppingListItemSchema).optional().default([]),
  })
  .loose();
export type ShoppingList = z.infer<typeof shoppingListSchema>;

export const recipeActionSchema = z
  .object({ id: z.string(), actionType: z.enum(["link", "post"]), title: z.string(), url: z.string() })
  .loose();

export function paginated<T extends z.ZodType>(item: T) {
  return z
    .object({
      page: z.number().optional(),
      per_page: z.number().optional(),
      total: z.number().optional(),
      total_pages: z.number().optional(),
      items: z.array(item),
    })
    .loose();
}

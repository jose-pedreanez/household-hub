import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { CookingJournal } from "@/lib/cooking/journal";
import { AppError } from "@/lib/errors";
import { PlanAnnotations } from "@/lib/meals/annotations";
import { PLAN_ENTRY_TYPES } from "@/lib/mealie/schemas";
import { services } from "@/lib/services";

const patchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  entryType: z.enum(PLAN_ENTRY_TYPES).optional(),
  recipeId: z.string().nullable().optional(),
  title: z.string().max(120).optional(),
  servings: z.number().positive().max(50).optional(),
});

async function entryId(params: Promise<{ id: string }>): Promise<number> {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) throw new AppError("bad_request", "Invalid meal id");
  return id;
}

/** Move, swap or resize a planned meal. */
export const PATCH = route<{ id: string }>(async (req, { params, actor }) => {
  const id = await entryId(params);
  const input = await body(req, patchSchema);
  const { mealie, db } = services();
  const entry = await mealie.getMealPlan(id);
  if (!entry) throw new AppError("not_found", "Meal not found");
  const cooked = new CookingJournal(db).activeForMealplan(id);
  if (cooked && (input.recipeId !== undefined || input.servings !== undefined)) {
    throw new AppError("conflict", "This meal is already marked cooked; reverse the cooking first to change the recipe or servings.");
  }
  if (input.date || input.entryType || input.recipeId !== undefined || input.title !== undefined) {
    await mealie.updateMealPlan({
      ...entry,
      ...(input.date ? { date: input.date } : {}),
      ...(input.entryType ? { entryType: input.entryType } : {}),
      ...(input.recipeId !== undefined ? { recipeId: input.recipeId } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  }
  if (input.servings !== undefined) new PlanAnnotations(db).set(id, { plannedServings: input.servings });
  audit(actor, "meal.update", { id, ...input });
  return { id };
});

export const DELETE = route<{ id: string }>(async (_req, { params, actor }) => {
  const id = await entryId(params);
  const { mealie, db } = services();
  if (new CookingJournal(db).activeForMealplan(id)) {
    throw new AppError("conflict", "This meal is marked cooked; reverse the cooking before removing it from the plan.");
  }
  await mealie.deleteMealPlan(id);
  new PlanAnnotations(db).delete(id);
  audit(actor, "meal.delete", { id });
  return { id };
});

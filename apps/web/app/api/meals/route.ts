import { z } from "zod";
import { audit, body, query, route, today } from "@/lib/api";
import { PlanAnnotations } from "@/lib/meals/annotations";
import { addDays, listMeals, weekStart } from "@/lib/meals/service";
import { PLAN_ENTRY_TYPES } from "@/lib/mealie/schemas";
import { services } from "@/lib/services";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(async (req) => {
  const q = query(req, z.object({ start: date.optional(), end: date.optional() }));
  const start = q.start ?? weekStart(today());
  const end = q.end ?? addDays(start, 6);
  return { start, end, today: today(), meals: await listMeals(start, end) };
});

const createSchema = z.object({
  date,
  entryType: z.enum(PLAN_ENTRY_TYPES),
  recipeId: z.string().nullable().default(null),
  title: z.string().max(120).optional(),
  servings: z.number().positive().max(50).optional(),
});

/** Add a meal to the Mealie plan (the meal-plan authority). Adding never touches stock. */
export const POST = route(async (req, { actor }) => {
  const input = await body(req, createSchema);
  const { mealie, db } = services();
  const entry = await mealie.createMealPlan({ date: input.date, entryType: input.entryType, recipeId: input.recipeId, title: input.title ?? "" });
  if (input.servings) new PlanAnnotations(db).set(entry.id, { plannedServings: input.servings });
  audit(actor, "meal.create", { entryId: entry.id, ...input });
  return { id: entry.id };
});

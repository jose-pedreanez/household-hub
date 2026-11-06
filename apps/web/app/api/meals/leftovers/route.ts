import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { CookingJournal } from "@/lib/cooking/journal";
import { AppError } from "@/lib/errors";
import { PlanAnnotations } from "@/lib/meals/annotations";
import { PLAN_ENTRY_TYPES } from "@/lib/mealie/schemas";
import { services } from "@/lib/services";

const schema = z.object({
  occurrenceId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entryType: z.enum(PLAN_ENTRY_TYPES),
  servings: z.number().positive().max(50),
});

/**
 * Plan a leftovers meal from an earlier cooking. Its ingredients were consumed when the original meal
 * was cooked, so this entry never deducts stock again.
 */
export const POST = route(async (req, { actor }) => {
  const input = await body(req, schema);
  const { db, mealie } = services();
  const occ = new CookingJournal(db).get(input.occurrenceId);
  if (!occ || occ.status === "reversed") throw new AppError("not_found", "Cooking record not found");
  const entry = await mealie.createMealPlan({
    date: input.date,
    entryType: input.entryType,
    recipeId: occ.recipeId,
    title: `Leftovers: ${occ.recipeName}`,
    text: "Leftovers (Household Hub) — already deducted from inventory when cooked.",
  });
  new PlanAnnotations(db).set(entry.id, { plannedServings: input.servings, leftoverOfOccurrenceId: occ.id });
  audit(actor, "meal.leftovers", { entryId: entry.id, occurrenceId: occ.id });
  return { id: entry.id };
});

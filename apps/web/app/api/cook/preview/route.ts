import { body, route } from "@/lib/api";
import { CookingJournal } from "@/lib/cooking/journal";
import { cookRequestSchema, previewCooking } from "@/lib/cooking/service";
import { services } from "@/lib/services";

/** What marking this meal cooked would consume. Read-only. */
export const POST = route(async (req) => {
  const input = await body(req, cookRequestSchema);
  const plan = await previewCooking(input);
  const alreadyCooked = input.mealplanEntryId ? new CookingJournal(services().db).activeForMealplan(input.mealplanEntryId) : null;
  return { plan, alreadyCooked: alreadyCooked ? { occurrenceId: alreadyCooked.id, status: alreadyCooked.status } : null };
});

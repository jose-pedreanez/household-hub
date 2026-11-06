import { audit, route } from "@/lib/api";
import { invalidate } from "@/lib/context";
import { reverseCooking } from "@/lib/cooking/execute";
import { cookingDeps } from "@/lib/cooking/service";

/** Undo every consume of this cooking in Grocy. Idempotent. */
export const POST = route<{ id: string }>(async (_req, { params, actor }) => {
  const id = (await params).id;
  const result = await reverseCooking(cookingDeps(), id);
  invalidate();
  audit(actor, "cook.reverse", { occurrenceId: id, status: result.occurrence.status });
  return result;
});

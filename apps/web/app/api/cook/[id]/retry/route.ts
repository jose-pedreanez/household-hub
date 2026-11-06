import { audit, route } from "@/lib/api";
import { invalidate } from "@/lib/context";
import { resumeCooking } from "@/lib/cooking/execute";
import { cookingDeps } from "@/lib/cooking/service";

/** Reconcile unconfirmed lines and resubmit failed ones. Never re-consumes a consumed line. */
export const POST = route<{ id: string }>(async (_req, { params, actor }) => {
  const id = (await params).id;
  const result = await resumeCooking(cookingDeps(), id);
  invalidate();
  audit(actor, "cook.retry", { occurrenceId: id, status: result.occurrence.status, summary: result.summary });
  return result;
});

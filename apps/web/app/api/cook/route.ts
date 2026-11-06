import { NextResponse } from "next/server";
import { audit, body, route } from "@/lib/api";
import { invalidate } from "@/lib/context";
import { startCooking } from "@/lib/cooking/execute";
import { CookingJournal } from "@/lib/cooking/journal";
import { cookExecuteSchema, cookRequestHash, cookingDeps, previewCooking } from "@/lib/cooking/service";
import { services } from "@/lib/services";

export const GET = route(async () => ({ occurrences: new CookingJournal(services().db).recent(30) }));

/**
 * "We cooked this": consume the ingredients from Grocy. Exactly once per idempotency key, and once per
 * meal-plan entry until reversed. The plan is rebuilt from live stock at execution time.
 */
export const POST = route(async (req, { actor }) => {
  const input = await body(req, cookExecuteSchema);
  const { idempotencyKey, ...request } = input;
  const deps = cookingDeps();
  const known = deps.journal.byKey(idempotencyKey);
  // A retry of a known request resumes it without rebuilding the plan.
  const plan = known ? known.plan : await previewCooking(request);
  const view = await startCooking(deps, {
    idempotencyKey,
    requestHash: cookRequestHash(request),
    mealplanEntryId: request.mealplanEntryId,
    servings: request.servings,
    leftoverServings: request.leftoverServings,
    plan,
  });
  invalidate();
  if (!view.replayed) {
    audit(actor, "cook.execute", { occurrenceId: view.occurrence.id, status: view.occurrence.status, summary: view.summary });
  }
  const status = view.occurrence.status === "completed" ? 200 : view.occurrence.status === "partial" || view.occurrence.status === "executing" ? 202 : 502;
  return NextResponse.json(view, { status });
});

import { audit, body, route } from "@/lib/api";
import { applyPlan, applyPlanSchema } from "@/lib/ai/planner";

export const POST = route(async (req, { actor }) => {
  const input = await body(req, applyPlanSchema);
  const result = await applyPlan(input.runId, input.accept);
  audit(actor, "plan.apply", { runId: input.runId, created: result.created.length, skipped: result.skipped.length });
  return result;
});

import { audit, body, route } from "@/lib/api";
import { generatePlan, planRequestSchema } from "@/lib/ai/planner";

/** Suggest meals for empty slots (AI when configured, deterministic otherwise). Nothing is saved yet. */
export const POST = route(async (req, { actor }) => {
  const input = await body(req, planRequestSchema);
  const result = await generatePlan(input);
  audit(actor, "plan.generate", { runId: result.runId, source: result.source, cached: result.cached, meals: result.meals.length });
  return result;
});

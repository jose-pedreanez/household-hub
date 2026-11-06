import { errorMessage } from "../errors";
import type { AiProvider } from "./provider";
import { aiPlanSchema, validateAiPlan, type PlanSlot, type ValidatedMeal } from "./schemas";

export interface SuggestOutcome {
  meals: ValidatedMeal[];
  issues: string[];
  notes: string;
  raw: string | null;
  status: "ok" | "invalid" | "error";
}

/**
 * One AI planning call plus deterministic validation. Any failure (provider down, refusal, output that
 * does not match the schema) yields no meals and an explanatory issue; callers then use the built-in planner.
 */
export async function suggestWithProvider(
  provider: AiProvider,
  opts: {
    system: string;
    context: unknown;
    slots: PlanSlot[];
    recipes: Array<{ id: string; slug: string; name: string }>;
    expiringNames: string[];
    knownFoods: string[];
  },
): Promise<SuggestOutcome> {
  try {
    const out = await provider.structured({
      system: opts.system,
      prompt: `Plan these meals. Household data (JSON):\n${JSON.stringify(opts.context)}`,
      schema: aiPlanSchema,
      schemaName: "meal_plan",
    });
    if (out.refusal) {
      return { meals: [], issues: [`The AI declined to plan (${out.refusal}); used the built-in planner.`], notes: "", raw: out.raw, status: "invalid" };
    }
    const parsed = out.data ? aiPlanSchema.safeParse(out.data) : null;
    if (!parsed?.success) {
      return { meals: [], issues: ["The AI returned output that did not match the plan format; used the built-in planner."], notes: "", raw: out.raw, status: "invalid" };
    }
    const v = validateAiPlan(parsed.data, opts);
    return { meals: v.meals, issues: v.issues, notes: v.notes, raw: out.raw, status: "ok" };
  } catch (e) {
    return { meals: [], issues: [`AI provider unavailable (${errorMessage(e)}); used the built-in planner.`], notes: "", raw: null, status: "error" };
  }
}

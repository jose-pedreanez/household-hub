import { audit, route, today } from "@/lib/api";
import { generatePlan } from "@/lib/ai/planner";
import { notify } from "@/lib/alerts";
import { AppError } from "@/lib/errors";
import { addDays, weekStart } from "@/lib/meals/service";
import { services } from "@/lib/services";

/**
 * Weekly planning for n8n: draft suggestions for next week's empty slots and notify the household.
 * The draft is NOT written to Mealie; someone reviews and saves it on /meals.
 */
export const POST = route(async (_req, { actor }) => {
  const start = addDays(weekStart(today()), 7);
  try {
    const plan = await generatePlan({ start, days: 7, useAi: true });
    const title = `Draft meal plan for the week of ${start} (${plan.meals.length} meals)`;
    const body = plan.meals.map((m) => `${m.date} ${m.entryType}: ${m.recipeName}`).join("\n") + (plan.issues.length ? `\n\nNotes: ${plan.issues.join(" ")}` : "");
    if (!plan.cached) notify(services().db, { kind: "meal_plan", title, body, link: `/meals?start=${start}&run=${plan.runId}` });
    audit(actor, "automation.meal_plan", { runId: plan.runId, source: plan.source, meals: plan.meals.length });
    return { runId: plan.runId, start, source: plan.source, meals: plan.meals.length, issues: plan.issues, message: `${title}\n${body}` };
  } catch (e) {
    if (e instanceof AppError && e.code === "unprocessable") return { start, skipped: true, message: "" };
    throw e;
  }
});

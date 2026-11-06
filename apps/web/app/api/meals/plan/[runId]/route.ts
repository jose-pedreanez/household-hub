import { route } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { services } from "@/lib/services";

/** A stored planning run (e.g. the weekly draft n8n generated), for review on /meals. */
export const GET = route<{ runId: string }>(async (_req, { params }) => {
  const { runId } = await params;
  const row = services().db.prepare("SELECT result_json FROM ai_plan_runs WHERE id = ?").get(runId) as { result_json: string | null } | undefined;
  if (!row?.result_json) throw new AppError("not_found", "Plan run not found");
  return JSON.parse(row.result_json);
});

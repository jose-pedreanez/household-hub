import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { decideAction } from "@/lib/ai/assistant";

/** The household confirms or rejects an action the assistant proposed. */
export const POST = route<{ id: string }>(async (req, { params, actor }) => {
  const { id } = await params;
  const { approve } = await body(req, z.object({ approve: z.boolean() }));
  const result = await decideAction(id, approve);
  audit(actor, "assistant.action", { id, approve, status: result.status });
  return result;
});

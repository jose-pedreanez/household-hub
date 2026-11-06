import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { askAssistant } from "@/lib/ai/assistant";

const schema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) }))
    .min(1)
    .max(20)
    .refine((m) => m[m.length - 1].role === "user", "The last message must be from the user"),
});

export const POST = route(async (req, { actor }) => {
  const { messages } = await body(req, schema);
  const result = await askAssistant(messages);
  audit(actor, "assistant.ask", { mode: result.mode, tools: result.toolCalls.map((t) => t.name), actions: result.actions.length });
  return result;
});

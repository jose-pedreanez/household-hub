import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { addAdhocItem } from "@/lib/shopping/service";

export const POST = route(async (req, { actor }) => {
  const input = await body(req, z.object({ retailerId: z.string().regex(/^[a-z0-9_]+$/), text: z.string().trim().min(1).max(120), quantity: z.number().positive().max(999).optional() }));
  await addAdhocItem(input.retailerId, input.text, input.quantity);
  audit(actor, "shopping.add", input);
  return { ok: true };
});

import { z } from "zod";
import { audit, body, route, today } from "@/lib/api";
import { addDays } from "@/lib/meals/service";
import { generateStoreLists } from "@/lib/shopping/service";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Rebuild the generated part of each store list from planned meals and low stock. Idempotent. */
export const POST = route(async (req, { actor }) => {
  const input = await body(req, z.object({ start: date.optional(), end: date.optional() }));
  const start = input.start ?? today();
  const end = input.end ?? addDays(start, 6);
  const result = await generateStoreLists(start, end);
  audit(actor, "shopping.generate", { start, end, created: result.created, updated: result.updated, removed: result.removed });
  return { start, end, ...result };
});

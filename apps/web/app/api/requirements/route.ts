import { z } from "zod";
import { query, route, today } from "@/lib/api";
import { addDays } from "@/lib/meals/service";
import { computeNeeds } from "@/lib/shopping/service";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Ingredient requirements of planned (uncooked, non-leftover) meals minus usable stock. */
export const GET = route(async (req) => {
  const q = query(req, z.object({ start: date.optional(), end: date.optional() }));
  const start = q.start ?? today();
  const end = q.end ?? addDays(start, 6);
  return { start, end, ...(await computeNeeds(start, end)) };
});

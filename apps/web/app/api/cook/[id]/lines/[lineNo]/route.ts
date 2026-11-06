import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { invalidate } from "@/lib/context";
import { correctLine, skipLine } from "@/lib/cooking/execute";
import { cookingDeps } from "@/lib/cooking/service";
import { AppError } from "@/lib/errors";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("correct"), amount: z.number().min(0) }),
  z.object({ action: z.literal("skip") }),
]);

/** Correct the amount a consumed line used, or give up on a line that cannot be consumed. */
export const POST = route<{ id: string; lineNo: string }>(async (req, { params, actor }) => {
  const p = await params;
  const lineNo = Number(p.lineNo);
  if (!Number.isInteger(lineNo) || lineNo < 1) throw new AppError("bad_request", "Invalid line");
  const input = await body(req, schema);
  const deps = cookingDeps();
  const result = input.action === "correct" ? await correctLine(deps, p.id, lineNo, input.amount) : await skipLine(deps, p.id, lineNo);
  invalidate();
  audit(actor, `cook.line.${input.action}`, { occurrenceId: p.id, lineNo, ...(input.action === "correct" ? { amount: input.amount } : {}) });
  return result;
});

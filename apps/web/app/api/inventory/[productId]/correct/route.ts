import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { invalidate } from "@/lib/context";
import { AppError } from "@/lib/errors";
import { withIdempotency } from "@/lib/idempotency";
import { services } from "@/lib/services";

const schema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  /** The amount actually on hand, in the product's stock unit. */
  newAmount: z.number().min(0),
  bestBeforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  locationId: z.number().int().positive().optional(),
});

/** Stock correction (physical count). Grocy books the difference as an inventory correction. */
export const POST = route<{ productId: string }>(async (req, { params, actor }) => {
  const productId = Number((await params).productId);
  if (!Number.isInteger(productId) || productId < 1) throw new AppError("bad_request", "Invalid product id");
  const input = await body(req, schema);
  const { db, grocy } = services();
  const { result, replayed } = await withIdempotency(db, { key: input.idempotencyKey, scope: "inventory_correct", payload: { productId, ...input, idempotencyKey: undefined } }, async () => {
    const rows = await grocy.inventoryProduct(productId, {
      new_amount: input.newAmount,
      ...(input.bestBeforeDate ? { best_before_date: input.bestBeforeDate } : {}),
      ...(input.locationId ? { location_id: input.locationId } : {}),
      note: `hub:${input.idempotencyKey}`,
    });
    return { transactionId: rows[0]?.transaction_id ?? null, changed: rows.length > 0 };
  });
  invalidate();
  audit(actor, "inventory.correct", { productId, newAmount: input.newAmount, ...result });
  return { ...result, replayed };
});

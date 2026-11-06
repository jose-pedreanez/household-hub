import { audit, body, route } from "@/lib/api";
import { registerProduct, registerRequestSchema } from "@/lib/barcode/register";
import { invalidate, mappingContext } from "@/lib/context";
import { withIdempotency } from "@/lib/idempotency";
import { services } from "@/lib/services";

export const POST = route(async (req, { actor }) => {
  const input = await body(req, registerRequestSchema);
  const { db, grocy, mealie, gms, metadata } = services();
  const { result, replayed } = await withIdempotency(
    db,
    { key: input.idempotencyKey, scope: "register", payload: { ...input, idempotencyKey: undefined } },
    () => registerProduct({ grocy, mealie, gms, metadata, ctx: () => mappingContext(0) }, input),
  );
  invalidate();
  if (!replayed) audit(actor, "product.register", { productId: result.productId, barcode: result.barcode, mapping: result.mapping });
  return { ...result, replayed };
});

import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { services } from "@/lib/services";

/** Edible yield: the usable fraction of the stocked amount (e.g. 0.65 for a whole chicken). */
export const PUT = route<{ productId: string }>(async (req, { params, actor }) => {
  const productId = Number((await params).productId);
  if (!Number.isInteger(productId) || productId < 1) throw new AppError("bad_request", "Invalid product id");
  const { edibleYield, note } = await body(req, z.object({ edibleYield: z.number().gt(0).max(1).nullable(), note: z.string().max(200).optional() }));
  services().metadata.setEdibleYield(productId, edibleYield, note);
  audit(actor, "product.yield", { productId, edibleYield });
  return { productId, edibleYield };
});

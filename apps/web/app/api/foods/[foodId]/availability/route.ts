import { route } from "@/lib/api";
import { mappingContext } from "@/lib/context";
import { familyAvailability } from "@/lib/meals/requirements";
import { services } from "@/lib/services";
import { mappedProductForFood } from "@/lib/sync/mappings";

/** How much usable stock of a Mealie ingredient exists across every compatible Grocy product. */
export const GET = route<{ foodId: string }>(async (_req, { params }) => {
  const { foodId } = await params;
  const ctx = await mappingContext();
  const product = mappedProductForFood(ctx, foodId);
  if (!product) return { foodId, mapped: false, mappingsAvailable: ctx.mappingsAvailable, availability: null };
  const { grocy, metadata } = services();
  const stock = await grocy.currentStock();
  return {
    foodId,
    mapped: true,
    product: { id: product.id, name: product.name },
    availability: familyAvailability(ctx, product.id, stock, (id) => metadata.edibleYield(id)),
  };
});

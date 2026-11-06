import { audit, route } from "@/lib/api";
import { handoff } from "@/lib/shopping/service";

/**
 * Hand the list to the retailer: a shareable text list (manual stores) or an Instacart shopping-list
 * link when configured. Nothing is added to a cart and nothing is purchased.
 */
export const POST = route<{ retailerId: string }>(async (_req, { params, actor }) => {
  const { retailerId } = await params;
  const result = await handoff(retailerId);
  audit(actor, "shopping.handoff", { retailerId, kind: result.kind });
  return result;
});

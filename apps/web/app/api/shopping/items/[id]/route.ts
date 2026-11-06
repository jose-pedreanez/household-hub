import { z } from "zod";
import { audit, body, route } from "@/lib/api";
import { removeItem, setItemChecked } from "@/lib/shopping/service";

/** Check an item off (picked up). This never adds stock — receiving happens by scanning. */
export const PATCH = route<{ id: string }>(async (req, { params, actor }) => {
  const { id } = await params;
  const { checked } = await body(req, z.object({ checked: z.boolean() }));
  await setItemChecked(id, checked);
  audit(actor, "shopping.check", { id, checked });
  return { id, checked };
});

export const DELETE = route<{ id: string }>(async (_req, { params, actor }) => {
  const { id } = await params;
  await removeItem(id);
  audit(actor, "shopping.remove", { id });
  return { id };
});

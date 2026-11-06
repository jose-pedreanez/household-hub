import { z } from "zod";
import { query, route } from "@/lib/api";
import { mappingContext } from "@/lib/context";
import { rank, tokens } from "@/lib/match";
import { services } from "@/lib/services";
import { foodForProduct } from "@/lib/sync/mappings";
import { unitName } from "@/lib/units/convert";

/** Search Grocy products and Mealie foods (for linking, receiving without a barcode, extras). */
export const GET = route(async (req) => {
  const { q } = query(req, z.object({ q: z.string().min(1).max(80) }));
  const ctx = await mappingContext();
  const foods = await services().mealie.listFoods(q).catch(() => []);
  const t = tokens(q);
  const needle = q.toLowerCase();
  const products = [...ctx.products.values()]
    .filter((p) => p.name.toLowerCase().includes(needle))
    .concat(rank(t, [...ctx.products.values()], (p) => tokens(p.name), 10).map((s) => s.item))
    .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i)
    .slice(0, 15)
    .map((p) => ({
      id: p.id,
      name: p.name,
      stockUnit: unitName(ctx.catalog, p.qu_id_stock, 2),
      stockQuId: p.qu_id_stock,
      generic: !!p.no_own_stock || (ctx.childrenOf.get(p.id)?.length ?? 0) > 0,
      mealieFoodName: foodForProduct(ctx, p.id)?.mealieFoodName ?? null,
    }));
  return {
    products,
    foods: foods.slice(0, 15).map((f) => ({
      id: f.id,
      name: f.name,
      mappedProductId: ctx.productMappings.find((m) => m.mealieFoodId === f.id)?.grocyProductId ?? null,
    })),
  };
});

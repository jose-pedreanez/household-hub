import { z } from "zod";
import { isNeverExpires, type GrocyClient } from "../grocy/client";
import type { CurrentStock, GrocyLocation, VolatileStock } from "../grocy/schemas";
import { foodForProduct, rootProduct, type MappingContext } from "../sync/mappings";
import { roundAmount, unitName } from "../units/convert";

export type DueStatus = "expired" | "overdue" | "due_soon" | "ok" | "no_date";

export interface InventoryItem {
  productId: number;
  name: string;
  parentName: string | null;
  mealieFoodName: string | null;
  amount: number;
  opened: number;
  unit: string;
  locations: Array<{ id: number; name: string; amount: number }>;
  nextDue: string | null;
  dueStatus: DueStatus;
  minStock: number;
  belowMin: boolean;
}

const currentLocationSchema = z
  .object({
    product_id: z.preprocess(Number, z.number()),
    location_id: z.preprocess(Number, z.number()),
    amount: z.preprocess((v) => (v == null ? 0 : Number(v)), z.number()).optional(),
  })
  .loose();

/** Per-product, per-location amounts (Grocy's `stock_current_locations` view). */
export async function stockLocations(grocy: GrocyClient): Promise<Array<z.infer<typeof currentLocationSchema>>> {
  return grocy.listObjectsLoose("stock_current_locations", currentLocationSchema);
}

export function dueStatusFor(due: string | null, today: string, soonDays: number): DueStatus {
  if (!due || isNeverExpires(due)) return "no_date";
  if (due < today) return "overdue";
  const soon = new Date(`${today}T12:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + soonDays);
  return due <= soon.toISOString().slice(0, 10) ? "due_soon" : "ok";
}

export function buildInventory(
  stock: CurrentStock[],
  locations: Array<{ product_id: number; location_id: number; amount?: number }>,
  allLocations: GrocyLocation[],
  volatile: VolatileStock,
  ctx: MappingContext,
  today: string,
  soonDays: number,
): InventoryItem[] {
  const locName = new Map(allLocations.map((l) => [l.id, l.name]));
  const expired = new Set(volatile.expired_products.map((p) => p.product_id));
  const missing = new Set(volatile.missing_products.map((p) => p.product_id));
  return stock
    .filter((s) => s.amount > 0)
    .map((s) => {
      const root = rootProduct(ctx, s.product_id);
      const due = isNeverExpires(s.best_before_date) ? null : s.best_before_date;
      let status = dueStatusFor(due, today, soonDays);
      if (expired.has(s.product_id)) status = "expired";
      return {
        productId: s.product_id,
        name: s.product.name,
        parentName: root && root.id !== s.product_id ? root.name : null,
        mealieFoodName: foodForProduct(ctx, s.product_id)?.mealieFoodName ?? null,
        amount: roundAmount(s.amount),
        opened: roundAmount(s.amount_opened ?? 0),
        unit: unitName(ctx.catalog, s.product.qu_id_stock, s.amount),
        locations: locations
          .filter((l) => l.product_id === s.product_id)
          .map((l) => ({ id: l.location_id, name: locName.get(l.location_id) ?? `#${l.location_id}`, amount: roundAmount(l.amount ?? 0) })),
        nextDue: due,
        dueStatus: status,
        minStock: s.product.min_stock_amount ?? 0,
        belowMin: missing.has(s.product_id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

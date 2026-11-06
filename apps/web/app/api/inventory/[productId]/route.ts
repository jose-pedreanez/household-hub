import { AppError } from "@/lib/errors";
import { route } from "@/lib/api";
import { mappingContext } from "@/lib/context";
import { isNeverExpires } from "@/lib/grocy/client";
import { familyAvailability } from "@/lib/meals/requirements";
import { services } from "@/lib/services";
import { foodForProduct, rootProduct } from "@/lib/sync/mappings";
import { unitName } from "@/lib/units/convert";

export const GET = route<{ productId: string }>(async (_req, { params }) => {
  const id = Number((await params).productId);
  if (!Number.isInteger(id) || id < 1) throw new AppError("bad_request", "Invalid product id");
  const { grocy, metadata } = services();
  const [details, entries, log, ctx, stock, locations] = await Promise.all([
    grocy.productDetails(id),
    grocy.stockEntries(id),
    grocy.listStockLog([`product_id=${id}`], "id:desc", 50),
    mappingContext(),
    grocy.currentStock(),
    grocy.listLocations(),
  ]);
  const root = rootProduct(ctx, id);
  const food = foodForProduct(ctx, id);
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const meta = metadata.forProduct(id)[0] ?? null;
  return {
    product: {
      id,
      name: details.product.name,
      description: details.product.description,
      stockUnit: unitName(ctx.catalog, details.product.qu_id_stock, 2),
      stockAmount: details.stock_amount ?? 0,
      opened: details.stock_amount_opened ?? 0,
      minStock: details.product.min_stock_amount ?? 0,
      defaultBestBeforeDays: details.product.default_best_before_days ?? 0,
      lastPrice: details.last_price ?? null,
      barcodes: details.product_barcodes.map((b) => ({
        barcode: b.barcode,
        amount: b.amount ?? null,
        unit: b.qu_id ? unitName(ctx.catalog, b.qu_id, b.amount ?? 1) : null,
      })),
    },
    family: {
      root: root && root.id !== id ? { id: root.id, name: root.name } : null,
      mealieFood: food ? { id: food.mealieFoodId, name: food.mealieFoodName } : null,
      availability: familyAvailability(ctx, root?.id ?? id, stock, (pid) => metadata.edibleYield(pid)),
    },
    entries: entries.map((e) => ({
      id: e.id,
      stockId: e.stock_id,
      amount: e.amount,
      bestBefore: isNeverExpires(e.best_before_date) ? null : e.best_before_date,
      purchased: e.purchased_date,
      opened: e.open,
      location: e.location_id ? locName.get(e.location_id) ?? null : null,
      note: e.note,
    })),
    history: log.map((l) => ({
      id: l.id,
      type: l.transaction_type,
      amount: l.amount,
      at: l.row_created_timestamp,
      undone: !!l.undone,
      transactionId: l.transaction_id,
      note: l.note,
    })),
    edibleYield: metadata.edibleYield(id),
    metadata: meta ? { source: meta.source, verification: meta.verification, data: meta.data } : null,
  };
});

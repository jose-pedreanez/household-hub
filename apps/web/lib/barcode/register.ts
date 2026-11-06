import { z } from "zod";
import { AppError, errorMessage } from "../errors";
import type { GrocyClient } from "../grocy/client";
import type { MealieClient } from "../mealie/client";
import type { MetadataStore } from "../nutrition/metadata-store";
import { caloriesPerStockUnit, type ProductMetadata } from "../nutrition/off";
import type { GmsClient } from "../sync/gms-client";
import { mappedProductForFood, type MappingContext } from "../sync/mappings";
import { unitName } from "../units/convert";
import { barcodeVariants, cleanBarcode } from "./normalize";

/**
 * First-time registration of a scanned product.
 *
 * Model (Grocy-native): the brand product ("Barilla Spaghetti 1 lb") is a sub-product of a generic
 * product ("Pasta") that Grocy-Mealie Sync maps to the Mealie food. The barcode stores the package
 * size in the product's stock unit, so later scans need no registration and book the right amount.
 */

export const registerRequestSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  barcode: z.string().min(4).max(64),
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().max(80).optional(),
  stockQuId: z.number().int().positive(),
  packageAmount: z.number().positive(),
  packageQuId: z.number().int().positive(),
  productGroupId: z.number().int().positive().optional(),
  locationId: z.number().int().positive(),
  shoppingLocationId: z.number().int().positive().optional(),
  /** -1 = never expires, 0 = ask each time, >0 = days. */
  defaultBestBeforeDays: z.number().int().min(-1).max(3650).default(0),
  minStockAmount: z.number().nonnegative().default(0),
  link: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("parent"), parentProductId: z.number().int().positive() }),
    z.object({ kind: z.literal("food"), mealieFoodId: z.string().min(1) }),
    z.object({ kind: z.literal("new_food"), foodName: z.string().trim().min(1).max(80) }),
  ]),
  /** Store the Open Food Facts data shown to the user, marked as household-confirmed. */
  confirmMetadata: z.boolean().default(true),
  edibleYield: z.number().gt(0).max(1).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export interface RegisterResult {
  productId: number;
  productName: string;
  barcode: string;
  parent: { id: number; name: string; created: boolean } | null;
  mealieFood: { id: string; name: string; created: boolean } | null;
  mapping: "existing" | "created" | "failed" | "none";
  warnings: string[];
}

export interface RegisterDeps {
  grocy: Pick<GrocyClient, "productByBarcode" | "listProducts" | "createObject" | "getProduct" | "listBarcodes">;
  mealie: Pick<MealieClient, "getFood" | "createFood" | "listFoods">;
  gms: Pick<GmsClient, "upsertProductMapping">;
  metadata: MetadataStore;
  ctx: () => Promise<MappingContext>;
}

export function displayName(name: string, brand?: string): string {
  if (!brand) return name;
  return name.toLowerCase().includes(brand.toLowerCase()) ? name : `${brand} ${name}`;
}

export async function registerProduct(deps: RegisterDeps, req: RegisterRequest): Promise<RegisterResult> {
  const barcode = cleanBarcode(req.barcode);
  if (!barcode) throw new AppError("bad_request", "Invalid barcode");
  for (const v of barcodeVariants(barcode)) {
    const existing = await deps.grocy.productByBarcode(v);
    if (existing) {
      throw new AppError("conflict", `Barcode ${v} is already registered to “${existing.product.name}”.`, {
        productId: existing.product.id,
      });
    }
  }

  const ctx = await deps.ctx();
  if (!ctx.catalog.units.has(req.stockQuId) || !ctx.catalog.units.has(req.packageQuId)) {
    throw new AppError("bad_request", "Unknown quantity unit");
  }
  const warnings: string[] = [];
  const name = displayName(req.name, req.brand);

  // 1. Resolve (or create) the generic parent product and its Mealie food mapping.
  let parent: RegisterResult["parent"] = null;
  let mealieFood: RegisterResult["mealieFood"] = null;
  let mapping: RegisterResult["mapping"] = "none";

  if (req.link.kind === "parent") {
    const p = ctx.products.get(req.link.parentProductId);
    if (!p) throw new AppError("bad_request", "Parent product not found");
    parent = { id: p.id, name: p.name, created: false };
    const m = ctx.productMappings.find((x) => x.grocyProductId === p.id);
    if (m) {
      mealieFood = { id: m.mealieFoodId, name: m.mealieFoodName, created: false };
      mapping = "existing";
    }
  } else if (req.link.kind === "food" || req.link.kind === "new_food") {
    let food: { id: string; name: string } | null = null;
    let foodCreated = false;
    if (req.link.kind === "food") {
      const f = await deps.mealie.getFood(req.link.mealieFoodId);
      if (!f) throw new AppError("bad_request", "Mealie food not found");
      food = { id: f.id, name: f.name };
    } else {
      const wanted = req.link.foodName.toLowerCase();
      const existing = (await deps.mealie.listFoods(req.link.foodName)).find((f) => f.name.toLowerCase() === wanted);
      if (existing) food = { id: existing.id, name: existing.name };
      else {
        const f = await deps.mealie.createFood(req.link.foodName);
        food = { id: f.id, name: f.name };
        foodCreated = true;
      }
    }
    mealieFood = { ...food, created: foodCreated };

    const mapped = mappedProductForFood(ctx, food.id);
    if (mapped) {
      parent = { id: mapped.id, name: mapped.name, created: false };
      mapping = "existing";
      if (mapped.qu_id_stock !== req.stockQuId) {
        warnings.push(
          `${mapped.name} is stocked in ${unitName(ctx.catalog, mapped.qu_id_stock)}, this product in ${unitName(ctx.catalog, req.stockQuId)}; ` +
            "recipes can use it only if a conversion between the two exists.",
        );
      }
    } else {
      // Reuse a same-named generic product if one exists, otherwise create it.
      const sameName = [...ctx.products.values()].find((p) => p.name.toLowerCase() === food!.name.toLowerCase());
      let parentId: number;
      let created = false;
      if (sameName) {
        parentId = sameName.id;
      } else {
        parentId = await deps.grocy.createObject("products", {
          name: food.name,
          description: "Generic ingredient (created by Household Hub). Brand products are its sub-products.",
          location_id: req.locationId,
          qu_id_stock: req.stockQuId,
          qu_id_purchase: req.stockQuId,
          qu_id_consume: req.stockQuId,
          qu_id_price: req.stockQuId,
          no_own_stock: 1,
          min_stock_amount: 0,
          default_best_before_days: 0,
        });
        created = true;
      }
      parent = { id: parentId, name: sameName?.name ?? food.name, created };
      try {
        await deps.gms.upsertProductMapping({ mealieFoodId: food.id, grocyProductId: parentId, grocyUnitId: req.stockQuId });
        mapping = "created";
      } catch (e) {
        mapping = "failed";
        warnings.push(`Could not create the Grocy-Mealie mapping (${errorMessage(e)}); map ${food.name} in Grocy-Mealie Sync.`);
      }
    }
  }

  // 2. Create the brand product (or reuse an identical one left behind by an interrupted attempt).
  const orphan = (await deps.grocy.listProducts([`name=${name}`])).find((p) => p.parent_product_id === (parent?.id ?? null));
  let productId: number;
  if (orphan && (await deps.grocy.listBarcodes([`product_id=${orphan.id}`])).length === 0) {
    productId = orphan.id;
    warnings.push("Reused a product created by an earlier, interrupted registration.");
  } else {
    const meta = req.confirmMetadata ? deps.metadata.get(barcode, "openfoodfacts")?.data ?? null : null;
    const calories = meta ? caloriesPerStockUnit(meta, ctx.catalog.units.get(req.stockQuId)!.name) : null;
    const body: Record<string, unknown> = {
      name,
      description: req.brand ? `Brand: ${req.brand}` : "",
      location_id: req.locationId,
      qu_id_stock: req.stockQuId,
      qu_id_purchase: req.packageQuId,
      qu_id_consume: req.stockQuId,
      qu_id_price: req.stockQuId,
      min_stock_amount: req.minStockAmount,
      default_best_before_days: req.defaultBestBeforeDays,
    };
    if (parent) body.parent_product_id = parent.id;
    if (req.productGroupId) body.product_group_id = req.productGroupId;
    if (req.shoppingLocationId) body.shopping_location_id = req.shoppingLocationId;
    if (calories !== null) body.calories = calories;
    productId = await deps.grocy.createObject("products", body);
  }

  // 3. Barcode with its package size: future scans book exactly this amount.
  await deps.grocy.createObject("product_barcodes", {
    product_id: productId,
    barcode,
    qu_id: req.packageQuId,
    amount: req.packageAmount,
    ...(req.shoppingLocationId ? { shopping_location_id: req.shoppingLocationId } : {}),
    note: "Registered via Household Hub",
  });

  // 4. Local metadata (nutrition basis, ingredients, provenance) and edible yield.
  if (req.confirmMetadata) {
    const stored = deps.metadata.get(barcode, "openfoodfacts");
    if (stored) {
      deps.metadata.save(stored.data, { grocyProductId: productId, verification: "user_confirmed" });
    }
  }
  if (req.edibleYield) deps.metadata.setEdibleYield(productId, req.edibleYield);

  return { productId, productName: name, barcode, parent, mealieFood, mapping, warnings };
}

export type { ProductMetadata };

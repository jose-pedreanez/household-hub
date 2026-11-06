import type { GrocyClient } from "../grocy/client";
import type { GrocyProduct } from "../grocy/schemas";
import type { MealieClient } from "../mealie/client";
import { isAmbiguous, rank, tokens } from "../match";
import type { MetadataStore } from "../nutrition/metadata-store";
import type { OffLookup, OpenFoodFactsClient, ProductMetadata } from "../nutrition/off";
import { foodForProduct, rootProduct, type MappingContext } from "../sync/mappings";
import { unitName } from "../units/convert";
import { barcodeVariants, cleanBarcode, detectFormat } from "./normalize";
import { defaultDueDate, packageDefinition, type PackageDefinition } from "./receive";
import { AppError, errorMessage } from "../errors";

/**
 * Barcode → product resolution, shared by the camera and the keyboard-wedge scanner:
 *   1. Grocy barcode (all UPC-A/EAN-13 variants)  → known product with its package definition.
 *   2. Otherwise Open Food Facts (cached locally)  → name, brand, package size, nutrition.
 *   3. Suggestions: existing Grocy products and Mealie foods, ranked, flagged when ambiguous.
 * Nothing is linked automatically; the household confirms on the registration screen.
 */

export interface KnownBarcode {
  status: "known";
  barcode: string;
  format: string;
  product: { id: number; name: string; stockUnit: string; locationId: number | null; noOwnStock: boolean };
  package: PackageDefinition | null;
  packageError: string | null;
  stock: { amount: number; opened: number; unit: string };
  family: { parentId: number | null; parentName: string | null; mealieFoodId: string | null; mealieFoodName: string | null };
  defaults: { locationId: number | null; shoppingLocationId: number | null; dueDate: string; dueDateAssumed: string };
  lastPrice: number | null;
  metadata: ProductMetadata | null;
}

export interface UnknownBarcode {
  status: "unknown";
  barcode: string;
  format: string;
  off: OffLookup;
  suggestions: {
    products: Array<{ id: number; name: string; score: number; generic: boolean; mealieFoodName: string | null }>;
    foods: Array<{ id: string; name: string; score: number; mappedProductId: number | null }>;
    ambiguous: boolean;
  };
}

export type ResolveResult = KnownBarcode | UnknownBarcode;

export interface ResolveDeps {
  grocy: Pick<GrocyClient, "productByBarcode" | "listProducts">;
  mealie: Pick<MealieClient, "listFoods">;
  off: Pick<OpenFoodFactsClient, "lookup">;
  metadata: MetadataStore;
  ctx: () => Promise<MappingContext>;
  today: () => string;
  /** Re-fetch Open Food Facts data older than this (ms). */
  offMaxAgeMs?: number;
}

export async function resolveBarcode(deps: ResolveDeps, raw: string): Promise<ResolveResult> {
  const barcode = cleanBarcode(raw);
  if (!barcode) throw new AppError("bad_request", "That does not look like a barcode");
  const format = detectFormat(barcode);

  for (const variant of barcodeVariants(barcode)) {
    const details = await deps.grocy.productByBarcode(variant);
    if (!details) continue;
    const ctx = await deps.ctx();
    const product = details.product;
    const row = details.product_barcodes.find((b) => b.barcode === variant) ?? null;
    let pkg: PackageDefinition | null = null;
    let packageError: string | null = null;
    try {
      pkg = packageDefinition(product, row, ctx.catalog);
    } catch (e) {
      packageError = errorMessage(e);
    }
    const root = rootProduct(ctx, product.id);
    const food = foodForProduct(ctx, product.id);
    const due = defaultDueDate(product, deps.today());
    const stored = deps.metadata.get(variant) ?? deps.metadata.get(barcode);
    return {
      status: "known",
      barcode: variant,
      format,
      product: {
        id: product.id,
        name: product.name,
        stockUnit: unitName(ctx.catalog, product.qu_id_stock, 2),
        locationId: product.location_id,
        noOwnStock: !!product.no_own_stock,
      },
      package: pkg,
      packageError,
      stock: {
        amount: details.stock_amount ?? 0,
        opened: details.stock_amount_opened ?? 0,
        unit: details.quantity_unit_stock.name_plural ?? details.quantity_unit_stock.name,
      },
      family: {
        parentId: root && root.id !== product.id ? root.id : null,
        parentName: root && root.id !== product.id ? root.name : null,
        mealieFoodId: food?.mealieFoodId ?? null,
        mealieFoodName: food?.mealieFoodName ?? null,
      },
      defaults: {
        locationId: product.location_id,
        shoppingLocationId: row?.shopping_location_id ?? product.shopping_location_id ?? null,
        dueDate: due.value,
        dueDateAssumed: due.assumed,
      },
      lastPrice: details.last_price ?? null,
      metadata: stored?.data ?? null,
    };
  }

  const off = await lookupOff(deps, barcode);
  const [products, foods, ctx] = await Promise.all([
    deps.grocy.listProducts(),
    deps.mealie.listFoods().catch(() => []),
    deps.ctx(),
  ]);
  const meta = off.status === "found" ? off.metadata : null;
  const query = queryTokens(meta);
  const rankedProducts = rank(query, products.filter((p) => p.active !== false), (p) => tokens(p.name), 6);
  const rankedFoods = rank(query, foods, (f) => [...tokens(f.name), ...f.aliases.flatMap((a) => tokens(a.name))], 6);

  return {
    status: "unknown",
    barcode,
    format,
    off,
    suggestions: {
      products: rankedProducts.map(({ item, score }) => ({
        id: item.id,
        name: item.name,
        score,
        generic: isGeneric(ctx, item),
        mealieFoodName: foodForProduct(ctx, item.id)?.mealieFoodName ?? null,
      })),
      foods: rankedFoods.map(({ item, score }) => ({
        id: item.id,
        name: item.name,
        score,
        mappedProductId: ctx.productMappings.find((m) => m.mealieFoodId === item.id)?.grocyProductId ?? null,
      })),
      ambiguous: rankedFoods.length > 0 ? isAmbiguous(rankedFoods) : isAmbiguous(rankedProducts),
    },
  };
}

function isGeneric(ctx: MappingContext, p: GrocyProduct): boolean {
  return !!p.no_own_stock || (ctx.childrenOf.get(p.id)?.length ?? 0) > 0;
}

/** Name tokens plus the most specific OFF category (e.g. "en:spaghetti" → "spaghetti"). */
function queryTokens(meta: ProductMetadata | null): string[] {
  if (!meta) return [];
  const brand = new Set(tokens(meta.brand));
  const name = tokens(meta.name).filter((t) => !brand.has(t));
  const specific = meta.categories.slice(-2).flatMap((c) => tokens(c.replace(/-/g, " ")));
  return [...new Set([...name, ...specific])];
}

async function lookupOff(deps: ResolveDeps, barcode: string): Promise<OffLookup> {
  const cached = deps.metadata.get(barcode, "openfoodfacts");
  const maxAge = deps.offMaxAgeMs ?? 30 * 24 * 3600_000;
  if (cached && cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < maxAge) {
    return { status: "found", metadata: cached.data };
  }
  const result = await deps.off.lookup(barcode);
  if (result.status === "found") deps.metadata.save(result.metadata, { fetched: true });
  if (result.status === "error" && cached) {
    // Serve stale data rather than nothing, but say so.
    return { status: "found", metadata: cached.data };
  }
  return result;
}

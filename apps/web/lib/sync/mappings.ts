import type { GrocyClient } from "../grocy/client";
import type { GrocyProduct } from "../grocy/schemas";
import { buildCatalog, type UnitCatalog } from "../units/convert";
import type { GmsClient, ProductMapping, UnitMapping } from "./gms-client";

/**
 * A consistent snapshot of everything needed to translate between Mealie ingredients and Grocy stock:
 * GMS mappings, Grocy products (with parent/sub-product structure), units and conversions.
 */
export interface MappingContext {
  products: Map<number, GrocyProduct>;
  childrenOf: Map<number, number[]>;
  productMappings: ProductMapping[];
  unitMappings: UnitMapping[];
  catalog: UnitCatalog;
  /** False when GMS could not be reached: mappings are then empty and must not be treated as "unmapped". */
  mappingsAvailable: boolean;
  loadedAt: number;
}

export async function loadMappingContext(grocy: GrocyClient, gms: GmsClient): Promise<MappingContext> {
  const [products, units, conversions, mappings] = await Promise.all([
    grocy.listProducts(),
    grocy.listQuantityUnits(),
    grocy.listResolvedConversions(),
    Promise.all([gms.productMappings(), gms.unitMappings()]).then(
      ([p, u]) => ({ p, u, ok: true }),
      () => ({ p: [] as ProductMapping[], u: [] as UnitMapping[], ok: false }),
    ),
  ]);
  return buildMappingContext(products, units, conversions, mappings.p, mappings.u, mappings.ok);
}

export function buildMappingContext(
  products: GrocyProduct[],
  units: Parameters<typeof buildCatalog>[0],
  conversions: Parameters<typeof buildCatalog>[1],
  productMappings: ProductMapping[],
  unitMappings: UnitMapping[],
  mappingsAvailable = true,
): MappingContext {
  const byId = new Map(products.filter((p) => p.active !== false).map((p) => [p.id, p]));
  const childrenOf = new Map<number, number[]>();
  for (const p of byId.values()) {
    if (p.parent_product_id != null && byId.has(p.parent_product_id)) {
      const list = childrenOf.get(p.parent_product_id) ?? [];
      list.push(p.id);
      childrenOf.set(p.parent_product_id, list);
    }
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a - b);
  return {
    products: byId,
    childrenOf,
    productMappings,
    unitMappings,
    catalog: buildCatalog(units, conversions),
    mappingsAvailable,
    loadedAt: Date.now(),
  };
}

/** Grocy product mapped to a Mealie food (usually a generic parent product), if any. */
export function mappedProductForFood(ctx: MappingContext, foodId: string): GrocyProduct | null {
  const m = ctx.productMappings.find((x) => x.mealieFoodId === foodId);
  return m ? ctx.products.get(m.grocyProductId) ?? null : null;
}

/** Mealie food for a Grocy product, following the parent chain (brand product → generic parent → food). */
export function foodForProduct(ctx: MappingContext, productId: number): ProductMapping | null {
  let current: number | null | undefined = productId;
  const seen = new Set<number>();
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const m = ctx.productMappings.find((x) => x.grocyProductId === current);
    if (m) return m;
    current = ctx.products.get(current)?.parent_product_id ?? null;
  }
  return null;
}

/**
 * Products whose stock can satisfy a mapped product: the product itself (unless it never has own stock)
 * plus all of its sub-products, recursively. Deterministic order: the product, then children by id.
 */
export function stockCandidates(ctx: MappingContext, productId: number): GrocyProduct[] {
  const out: GrocyProduct[] = [];
  const visit = (id: number, depth: number) => {
    const p = ctx.products.get(id);
    if (!p || depth > 5 || out.some((x) => x.id === id)) return;
    if (!p.no_own_stock) out.push(p);
    for (const child of ctx.childrenOf.get(id) ?? []) visit(child, depth + 1);
  };
  visit(productId, 0);
  return out;
}

/** The generic product at the top of a product's parent chain. */
export function rootProduct(ctx: MappingContext, productId: number): GrocyProduct | null {
  let p = ctx.products.get(productId) ?? null;
  const seen = new Set<number>();
  while (p && p.parent_product_id != null && !seen.has(p.id)) {
    seen.add(p.id);
    const parent = ctx.products.get(p.parent_product_id);
    if (!parent) break;
    p = parent;
  }
  return p;
}

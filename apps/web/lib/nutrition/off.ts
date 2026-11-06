import { z } from "zod";
import { requestJson, type FetchLike } from "../http";
import { UpstreamError } from "../errors";
import { builtinFactor, canonicalUnit, unitDimension } from "../units/builtin";

/**
 * Open Food Facts product lookup and normalisation.
 *
 * Rules: missing values stay null (never estimated), the basis of nutrition values is preserved
 * (per 100 g, per 100 mL or per serving), and the data is labelled as unverified crowd-sourced data
 * until a household member confirms it. A failed lookup is reported as an error, not as "unknown".
 */

export const METADATA_SCHEMA_VERSION = 1;

const OFF_FIELDS = [
  "code",
  "product_name",
  "product_name_en",
  "generic_name",
  "brands",
  "quantity",
  "product_quantity",
  "product_quantity_unit",
  "serving_size",
  "serving_quantity",
  "serving_quantity_unit",
  "nutriments",
  "nutrition_data_per",
  "ingredients_text",
  "ingredients_text_en",
  "allergens_tags",
  "traces_tags",
  "categories_tags",
  "states_tags",
  "image_front_small_url",
].join(",");

const nutrientKeys = {
  energyKcal: "energy-kcal",
  energyKj: "energy-kj",
  protein: "proteins",
  carbohydrates: "carbohydrates",
  sugars: "sugars",
  fat: "fat",
  saturatedFat: "saturated-fat",
  fiber: "fiber",
  sodium: "sodium",
  salt: "salt",
} as const;

export type NutrientName = keyof typeof nutrientKeys;
export type NutrientValues = Record<NutrientName, number | null>;

export const nutritionSchema = z.object({
  basis: z.enum(["per_100g", "per_100ml"]).nullable(),
  basisSource: z.enum(["off_field", "inferred_from_package", "unknown"]),
  per100: z.record(z.string(), z.number().nullable()),
  perServing: z.record(z.string(), z.number().nullable()),
  servingSize: z.string().nullable(),
  servingQuantity: z.number().nullable(),
  servingQuantityUnit: z.string().nullable(),
  /** Sodium and salt are reported by OFF in grams; we keep grams. Energy in kcal / kJ. */
  units: z.object({ energy: z.literal("kcal|kJ"), mass: z.literal("g") }),
});

export const productMetadataSchema = z.object({
  schemaVersion: z.literal(METADATA_SCHEMA_VERSION),
  barcode: z.string(),
  source: z.enum(["openfoodfacts", "manual"]),
  sourceUrl: z.string().nullable(),
  name: z.string().nullable(),
  brand: z.string().nullable(),
  quantityText: z.string().nullable(),
  packageAmount: z.number().nullable(),
  packageUnit: z.string().nullable(),
  packageCount: z.number().nullable(),
  nutrition: nutritionSchema.nullable(),
  ingredientsText: z.string().nullable(),
  allergens: z.array(z.string()),
  traces: z.array(z.string()),
  categories: z.array(z.string()),
  imageUrl: z.string().nullable(),
  completeness: z.array(z.string()),
});
export type ProductMetadata = z.infer<typeof productMetadataSchema>;

const offResponseSchema = z
  .object({
    status: z.union([z.number(), z.string()]).optional(),
    product: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export type OffLookup =
  | { status: "found"; metadata: ProductMetadata }
  | { status: "not_found" }
  | { status: "error"; message: string };

export class OpenFoodFactsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async lookup(barcode: string): Promise<OffLookup> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/v2/product/${encodeURIComponent(barcode)}?fields=${OFF_FIELDS}`;
    try {
      const raw = await requestJson("Open Food Facts", url, {
        headers: { "User-Agent": this.userAgent },
        timeoutMs: 8000,
        allow404: true,
      }, this.fetchImpl);
      if (raw === null) return { status: "not_found" };
      const parsed = offResponseSchema.safeParse(raw);
      if (!parsed.success) return { status: "error", message: "Unexpected Open Food Facts response" };
      const ok = Number(parsed.data.status) === 1 && parsed.data.product;
      if (!ok) return { status: "not_found" };
      return { status: "found", metadata: normalizeOffProduct(barcode, parsed.data.product!) };
    } catch (e) {
      const message = e instanceof UpstreamError ? e.message : "Open Food Facts lookup failed";
      return { status: "error", message };
    }
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function tags(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

export function normalizeOffProduct(barcode: string, p: Record<string, unknown>): ProductMetadata {
  const pkg = parsePackage(p);
  const nutriments = (p.nutriments && typeof p.nutriments === "object" ? p.nutriments : {}) as Record<string, unknown>;

  const per100 = {} as NutrientValues;
  const perServing = {} as NutrientValues;
  let any = false;
  for (const [name, key] of Object.entries(nutrientKeys) as [NutrientName, string][]) {
    per100[name] = numOrNull(nutriments[`${key}_100g`]);
    perServing[name] = numOrNull(nutriments[`${key}_serving`]);
    if (per100[name] !== null || perServing[name] !== null) any = true;
  }

  // OFF stores per-100 values under "_100g" keys for liquids too; the package unit tells which basis applies.
  let basis: "per_100g" | "per_100ml" | null = null;
  let basisSource: "off_field" | "inferred_from_package" | "unknown" = "unknown";
  const qtyUnit = str(p.product_quantity_unit)?.toLowerCase();
  if (qtyUnit === "g" || qtyUnit === "ml") {
    basis = qtyUnit === "g" ? "per_100g" : "per_100ml";
    basisSource = "off_field";
  } else if (pkg.unit) {
    const dim = unitDimension(pkg.unit);
    if (dim) {
      basis = dim === "mass" ? "per_100g" : "per_100ml";
      basisSource = "inferred_from_package";
    }
  }

  const name = str(p.product_name_en) ?? str(p.product_name) ?? str(p.generic_name);
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    barcode,
    source: "openfoodfacts",
    sourceUrl: `https://world.openfoodfacts.org/product/${encodeURIComponent(barcode)}`,
    name,
    brand: str(p.brands)?.split(",")[0]?.trim() ?? null,
    quantityText: str(p.quantity),
    packageAmount: pkg.amount,
    packageUnit: pkg.unit,
    packageCount: pkg.count,
    nutrition: any
      ? {
          basis,
          basisSource,
          per100,
          perServing,
          servingSize: str(p.serving_size),
          servingQuantity: numOrNull(p.serving_quantity),
          servingQuantityUnit: str(p.serving_quantity_unit),
          units: { energy: "kcal|kJ", mass: "g" },
        }
      : null,
    ingredientsText: str(p.ingredients_text_en) ?? str(p.ingredients_text),
    allergens: tags(p.allergens_tags).map(stripLang),
    traces: tags(p.traces_tags).map(stripLang),
    categories: tags(p.categories_tags).map(stripLang),
    imageUrl: str(p.image_front_small_url),
    completeness: tags(p.states_tags).filter((t) => /completed|to-be-completed/.test(t)).map(stripLang),
  };
}

function stripLang(tag: string): string {
  return tag.replace(/^[a-z]{2}:/, "");
}

/**
 * Package size from OFF. Prefers the structured fields; falls back to parsing "quantity" text such as
 * "16 oz (454 g)", "1 gal", "6 x 150 g" or "12 eggs". Returns nulls rather than guessing.
 */
export function parsePackage(p: Record<string, unknown>): { amount: number | null; unit: string | null; count: number | null } {
  const q = numOrNull(p.product_quantity);
  const qu = str(p.product_quantity_unit);
  const text = str(p.quantity);
  const multi = text?.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z. ]+)/);
  if (q !== null && q > 0 && qu && canonicalUnit(qu)) {
    return { amount: q, unit: canonicalUnit(qu), count: multi ? Number(multi[1]) : null };
  }
  if (!text) return { amount: null, unit: null, count: null };

  if (multi) {
    const n = Number(multi[1]);
    const each = Number(multi[2].replace(",", "."));
    const unit = canonicalUnit(multi[3]);
    if (unit && n > 0 && each > 0) return { amount: round(n * each), unit, count: n };
  }
  // Prefer a metric figure in parentheses: "16 oz (454 g)".
  const metric = text.match(/\((\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|cl)\)/i);
  if (metric) return { amount: Number(metric[1].replace(",", ".")), unit: canonicalUnit(metric[2]), count: null };
  const simple = text.match(/^(\d+(?:[.,]\d+)?)\s*([a-zA-Z. ]+?)\s*$/);
  if (simple) {
    const amount = Number(simple[1].replace(",", "."));
    const unit = canonicalUnit(simple[2]);
    if (unit && amount > 0) return { amount, unit, count: null };
    const word = simple[2].trim().toLowerCase();
    if (amount > 0 && /^(eggs?|pieces?|pcs?|count|ct|units?)$/.test(word)) return { amount, unit: "piece", count: amount };
  }
  return { amount: null, unit: null, count: null };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Energy per Grocy stock unit, for Grocy's native `calories` field — only when exact:
 * per-100 g data with a mass stock unit, or per-100 mL data with a volume stock unit.
 */
export function caloriesPerStockUnit(meta: ProductMetadata, stockUnitName: string): number | null {
  const n = meta.nutrition;
  const kcal = n?.per100.energyKcal ?? null;
  if (!n || kcal === null || !n.basis) return null;
  const base = n.basis === "per_100g" ? "g" : "ml";
  const factor = builtinFactor(stockUnitName, base); // 1 stock unit = factor base units
  if (factor === null) return null;
  return Math.round(((kcal / 100) * factor) * 100) / 100;
}

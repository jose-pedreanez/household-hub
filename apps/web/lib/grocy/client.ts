import { z } from "zod";
import { UpstreamError } from "../errors";
import { requestJson, type FetchLike, type RequestOptions } from "../http";
import {
  createdObjectSchema,
  currentStockSchema,
  grocyProductSchema,
  locationSchema,
  productBarcodeSchema,
  productDetailsSchema,
  productGroupSchema,
  quantityUnitConversionSchema,
  quantityUnitSchema,
  resolvedConversionSchema,
  shoppingLocationSchema,
  stockEntrySchema,
  stockLogEntrySchema,
  systemInfoSchema,
  volatileStockSchema,
  type GrocyProduct,
  type ProductDetails,
  type StockLogEntry,
} from "./schemas";

export interface AddStockBody {
  amount: number;
  best_before_date?: string;
  transaction_type?: "purchase" | "inventory-correction";
  price?: number;
  location_id?: number;
  shopping_location_id?: number;
  note?: string;
}

export interface ConsumeStockBody {
  amount: number;
  transaction_type?: "consume";
  spoiled?: boolean;
  stock_entry_id?: string;
  location_id?: number;
  exact_amount?: boolean;
  allow_subproduct_substitution?: boolean;
}

/** Grocy's generic-entity filter: `field=value`, `field<value`, `field~value` (LIKE)… */
export type GrocyQuery = string[];

const GROCY_NEVER_EXPIRES = "2999-12-31";

/** Thin, validated wrapper around the Grocy 4.x REST API (server-side only). */
export class GrocyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  static readonly NEVER_EXPIRES = GROCY_NEVER_EXPIRES;

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/api${path}`;
  }

  private async call<T>(path: string, opts: RequestOptions = {}): Promise<T | null> {
    return requestJson<T>(
      "Grocy",
      this.url(path),
      { ...opts, headers: { "GROCY-API-KEY": this.apiKey, ...opts.headers } },
      this.fetchImpl,
    );
  }

  private async get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    return parse(schema, await this.call(path), path);
  }

  // ---- System ---------------------------------------------------------------

  async systemInfo() {
    return this.get("/system/info", systemInfoSchema);
  }

  // ---- Generic entities -----------------------------------------------------

  private objectsPath(entity: string, query?: GrocyQuery, order?: string, limit?: number): string {
    const params = new URLSearchParams();
    for (const q of query ?? []) params.append("query[]", q);
    if (order) params.set("order", order);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return `/objects/${entity}${qs ? `?${qs}` : ""}`;
  }

  async listProducts(query?: GrocyQuery) {
    return this.get(this.objectsPath("products", query), z.array(grocyProductSchema));
  }
  async getProduct(id: number): Promise<GrocyProduct | null> {
    const raw = await this.call(`/objects/products/${id}`, { allow404: true });
    return raw === null ? null : parse(grocyProductSchema, raw, `products/${id}`);
  }
  async listQuantityUnits() {
    return this.get(this.objectsPath("quantity_units"), z.array(quantityUnitSchema));
  }
  async listLocations() {
    return this.get(this.objectsPath("locations"), z.array(locationSchema));
  }
  async listShoppingLocations() {
    return this.get(this.objectsPath("shopping_locations"), z.array(shoppingLocationSchema));
  }
  async listProductGroups() {
    return this.get(this.objectsPath("product_groups"), z.array(productGroupSchema));
  }
  async listBarcodes(query?: GrocyQuery) {
    return this.get(this.objectsPath("product_barcodes", query), z.array(productBarcodeSchema));
  }
  async listConversions(query?: GrocyQuery) {
    return this.get(this.objectsPath("quantity_unit_conversions", query), z.array(quantityUnitConversionSchema));
  }
  /** All resolved conversions (global and product-specific, including derived chains). */
  async listResolvedConversions(query?: GrocyQuery) {
    return this.get(this.objectsPath("quantity_unit_conversions_resolved", query), z.array(resolvedConversionSchema));
  }
  async listStockLog(query?: GrocyQuery, order = "id:desc", limit = 200) {
    return this.get(this.objectsPath("stock_log", query, order, limit), z.array(stockLogEntrySchema));
  }

  /** Any listable entity or view, validated with a caller-supplied row schema. */
  async listObjectsLoose<S extends z.ZodType>(entity: string, row: S, query?: GrocyQuery): Promise<Array<z.infer<S>>> {
    return this.get(this.objectsPath(entity, query), z.array(row));
  }

  async createObject(entity: string, body: Record<string, unknown>): Promise<number> {
    const raw = await this.call(`/objects/${entity}`, { method: "POST", body });
    return parse(createdObjectSchema, raw, `create ${entity}`).created_object_id;
  }
  async updateObject(entity: string, id: number, body: Record<string, unknown>): Promise<void> {
    await this.call(`/objects/${entity}/${id}`, { method: "PUT", body });
  }
  async deleteObject(entity: string, id: number): Promise<void> {
    await this.call(`/objects/${entity}/${id}`, { method: "DELETE" });
  }

  // ---- Stock ------------------------------------------------------------------

  async currentStock() {
    return this.get("/stock", z.array(currentStockSchema));
  }

  async volatileStock(dueSoonDays = 5) {
    return this.get(`/stock/volatile?due_soon_days=${dueSoonDays}`, volatileStockSchema);
  }

  async productDetails(productId: number): Promise<ProductDetails> {
    return this.get(`/stock/products/${productId}`, productDetailsSchema);
  }

  /** Product for a barcode, or null when Grocy does not know the barcode. */
  async productByBarcode(barcode: string): Promise<ProductDetails | null> {
    try {
      return await this.get(`/stock/products/by-barcode/${encodeURIComponent(barcode)}`, productDetailsSchema);
    } catch (e) {
      // Grocy answers 400 ("No product with barcode … found") for unknown barcodes.
      if (e instanceof UpstreamError && (e.httpStatus === 400 || e.httpStatus === 404)) return null;
      throw e;
    }
  }

  async stockEntries(productId: number, includeSubProducts = false) {
    const qs = includeSubProducts ? "?include_sub_products=true" : "";
    return this.get(`/stock/products/${productId}/entries${qs}`, z.array(stockEntrySchema));
  }

  /** Add stock. `amount` is always in the product's stock quantity unit. */
  async addStock(productId: number, body: AddStockBody): Promise<StockLogEntry[]> {
    const raw = await this.call(`/stock/products/${productId}/add`, {
      method: "POST",
      body: { transaction_type: "purchase", ...body },
      timeoutMs: 20_000,
    });
    return parse(z.array(stockLogEntrySchema), raw, "add stock", true);
  }

  /** Consume stock. `amount` is always in the product's stock quantity unit. */
  async consumeStock(productId: number, body: ConsumeStockBody): Promise<StockLogEntry[]> {
    const raw = await this.call(`/stock/products/${productId}/consume`, {
      method: "POST",
      body: { transaction_type: "consume", spoiled: false, ...body },
      timeoutMs: 20_000,
    });
    return parse(z.array(stockLogEntrySchema), raw, "consume stock", true);
  }

  /** Set the absolute stock amount (Grocy books the difference as an inventory correction). */
  async inventoryProduct(
    productId: number,
    body: { new_amount: number; best_before_date?: string; location_id?: number; note?: string },
  ): Promise<StockLogEntry[]> {
    const raw = await this.call(`/stock/products/${productId}/inventory`, { method: "POST", body, timeoutMs: 20_000 });
    return parse(z.array(stockLogEntrySchema), raw, "inventory", true);
  }

  async transaction(transactionId: string): Promise<StockLogEntry[] | null> {
    const raw = await this.call(`/stock/transactions/${encodeURIComponent(transactionId)}`, { allow404: true });
    if (raw === null) return null;
    return parse(z.array(stockLogEntrySchema), raw, "transaction");
  }

  async undoTransaction(transactionId: string): Promise<void> {
    await this.call(`/stock/transactions/${encodeURIComponent(transactionId)}/undo`, { method: "POST" });
  }
}

/** `afterWrite`: the request was a write that Grocy accepted, so a malformed reply leaves the outcome uncertain. */
function parse<S extends z.ZodType>(schema: S, raw: unknown, what: string, afterWrite = false): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new UpstreamError({
      service: "Grocy",
      message: `Unexpected Grocy response for ${what}: ${r.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
      httpStatus: 200,
      outcomeUncertain: afterWrite,
      unreachable: false,
    });
  }
  return r.data;
}

export function isNeverExpires(date: string | null | undefined): boolean {
  return !date || date.startsWith("2999-12-31");
}

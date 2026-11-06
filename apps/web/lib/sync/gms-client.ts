import { z } from "zod";
import { UpstreamError } from "../errors";
import { requestJson, type FetchLike, type RequestOptions } from "../http";

/**
 * Client for Grocy-Mealie Sync (GMS), which owns the Mealie-food ↔ Grocy-product and
 * Mealie-unit ↔ Grocy-unit mappings. The hub reads these mappings instead of keeping its own copy.
 *
 * GMS mappings are 1:1. One Mealie ingredient backed by several Grocy products is modelled the
 * Grocy-native way: map the food to a generic parent product and attach brand products as
 * sub-products (GMS runs with SYNC_SUB_PRODUCTS=true).
 */

export const productMappingSchema = z
  .object({
    id: z.string(),
    mealieFoodId: z.string(),
    mealieFoodName: z.string(),
    grocyProductId: z.number().int(),
    grocyProductName: z.string(),
    unitMappingId: z.string().nullable().optional(),
  })
  .loose();
export type ProductMapping = z.infer<typeof productMappingSchema>;

export const unitMappingSchema = z
  .object({
    id: z.string(),
    mealieUnitId: z.string(),
    mealieUnitName: z.string(),
    mealieUnitAbbreviation: z.string().optional().default(""),
    grocyUnitId: z.number().int(),
    grocyUnitName: z.string(),
    conversionFactor: z.number().default(1),
  })
  .loose();
export type UnitMapping = z.infer<typeof unitMappingSchema>;

export const gmsStatusSchema = z
  .object({
    lastGrocyPoll: z.string().nullable().optional(),
    lastMealiePoll: z.string().nullable().optional(),
    productMappings: z.number().optional(),
    unitMappings: z.number().optional(),
    schedulerStatus: z.string().optional(),
  })
  .loose();

export class GmsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authSecret: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(path: string, opts: RequestOptions = {}): Promise<T | null> {
    const headers: Record<string, string> = { ...opts.headers };
    if (this.authSecret) headers.Authorization = `Bearer ${this.authSecret}`;
    return requestJson<T>("Grocy-Mealie Sync", `${this.baseUrl.replace(/\/$/, "")}${path}`, { ...opts, headers }, this.fetchImpl);
  }

  async health(): Promise<boolean> {
    try {
      await this.call("/api/health", { timeoutMs: 4000 });
      return true;
    } catch {
      return false;
    }
  }

  async status() {
    return parse(gmsStatusSchema, await this.call("/api/status"), "status");
  }

  async productMappings(): Promise<ProductMapping[]> {
    return parse(z.array(productMappingSchema), await this.call("/api/mappings/products"), "product mappings");
  }

  async unitMappings(): Promise<UnitMapping[]> {
    return parse(z.array(unitMappingSchema), await this.call("/api/mappings/units"), "unit mappings");
  }

  /**
   * Create or update a food ↔ product mapping through the GMS mapping wizard.
   * Note: GMS renames the Grocy product to the Mealie food name, so map foods to generic parent
   * products ("Pasta"), never to brand products ("Barilla Spaghetti 1 lb").
   */
  async upsertProductMapping(entry: { mealieFoodId: string; grocyProductId: number; grocyUnitId: number }) {
    const raw = await this.call("/api/mapping-wizard/products/sync", {
      method: "POST",
      body: { mappings: [entry] },
      timeoutMs: 30_000,
    });
    return z.object({ synced: z.number().optional(), conflicts: z.array(z.unknown()).optional() }).loose().parse(raw ?? {});
  }

  /** Ask GMS to reconcile Mealie "In possession" flags with Grocy stock now. */
  async reconcileInPossession(): Promise<void> {
    await this.call("/api/sync/grocy-to-mealie/in-possession", { method: "POST", timeoutMs: 60_000 });
  }

  /** Ask GMS to run its Grocy → Mealie poll now (low stock → needs list). */
  async runGrocyToMealie(): Promise<void> {
    await this.call("/api/sync/grocy-to-mealie", { method: "POST", timeoutMs: 60_000 });
  }

  /** Ask GMS to re-run name matching for products and units. */
  async runProductSync(): Promise<void> {
    await this.call("/api/sync/products", { method: "POST", timeoutMs: 60_000 });
  }
}

function parse<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new UpstreamError({
      service: "Grocy-Mealie Sync",
      message: `Unexpected GMS response for ${what}`,
      httpStatus: 200,
      outcomeUncertain: false,
      unreachable: false,
      details: r.error.issues.slice(0, 3),
    });
  }
  return r.data;
}

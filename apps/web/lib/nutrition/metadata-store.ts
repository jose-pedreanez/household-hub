import type { Db } from "../db";
import { nowIso } from "../db";
import { METADATA_SCHEMA_VERSION, productMetadataSchema, type ProductMetadata } from "./off";

/**
 * Local store for product metadata that Grocy and Mealie cannot represent faithfully
 * (nutrition with its basis, ingredients, allergens, data provenance) plus edible yield.
 *
 * Callers depend on the `MetadataStore` interface only, so the backing store can later move
 * (for example into Grocy userfields or another service) without touching application code.
 */
export interface StoredMetadata {
  barcode: string;
  source: ProductMetadata["source"];
  grocyProductId: number | null;
  verification: "unverified" | "user_confirmed";
  fetchedAt: string | null;
  updatedAt: string;
  data: ProductMetadata;
}

export interface MetadataStore {
  get(barcode: string, source?: ProductMetadata["source"]): StoredMetadata | null;
  forProduct(grocyProductId: number): StoredMetadata[];
  save(data: ProductMetadata, opts?: { grocyProductId?: number | null; verification?: StoredMetadata["verification"]; fetched?: boolean }): void;
  linkProduct(barcode: string, grocyProductId: number): void;
  markVerified(barcode: string, source: ProductMetadata["source"]): void;
  edibleYield(grocyProductId: number): number | null;
  setEdibleYield(grocyProductId: number, edibleYield: number | null, note?: string): void;
}

interface Row {
  barcode: string;
  source: ProductMetadata["source"];
  grocy_product_id: number | null;
  schema_version: number;
  verification: StoredMetadata["verification"];
  payload_json: string;
  fetched_at: string | null;
  updated_at: string;
}

/** Upgrade older payload versions here when METADATA_SCHEMA_VERSION changes. */
function upgradePayload(version: number, payload: unknown): ProductMetadata | null {
  if (version === METADATA_SCHEMA_VERSION) {
    const r = productMetadataSchema.safeParse(payload);
    return r.success ? r.data : null;
  }
  return null;
}

export class SqliteMetadataStore implements MetadataStore {
  constructor(private readonly db: Db) {}

  private toStored(row: Row | undefined): StoredMetadata | null {
    if (!row) return null;
    const data = upgradePayload(row.schema_version, JSON.parse(row.payload_json));
    if (!data) return null;
    return {
      barcode: row.barcode,
      source: row.source,
      grocyProductId: row.grocy_product_id,
      verification: row.verification,
      fetchedAt: row.fetched_at,
      updatedAt: row.updated_at,
      data,
    };
  }

  get(barcode: string, source?: ProductMetadata["source"]): StoredMetadata | null {
    const row = source
      ? (this.db.prepare("SELECT * FROM product_metadata WHERE barcode = ? AND source = ?").get(barcode, source) as Row | undefined)
      : (this.db
          .prepare(
            "SELECT * FROM product_metadata WHERE barcode = ? ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END LIMIT 1",
          )
          .get(barcode) as Row | undefined);
    return this.toStored(row);
  }

  forProduct(grocyProductId: number): StoredMetadata[] {
    const rows = this.db
      .prepare("SELECT * FROM product_metadata WHERE grocy_product_id = ? ORDER BY updated_at DESC")
      .all(grocyProductId) as Row[];
    return rows.map((r) => this.toStored(r)).filter((r): r is StoredMetadata => r !== null);
  }

  save(
    data: ProductMetadata,
    opts: { grocyProductId?: number | null; verification?: StoredMetadata["verification"]; fetched?: boolean } = {},
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO product_metadata(barcode, source, grocy_product_id, schema_version, verification, payload_json, fetched_at, updated_at)
         VALUES (@barcode, @source, @pid, @v, @verification, @payload, @fetched, @now)
         ON CONFLICT(barcode, source) DO UPDATE SET
           grocy_product_id = COALESCE(@pid, grocy_product_id),
           schema_version = @v,
           verification = CASE WHEN @verification = 'user_confirmed' THEN 'user_confirmed' ELSE verification END,
           payload_json = @payload,
           fetched_at = COALESCE(@fetched, fetched_at),
           updated_at = @now`,
      )
      .run({
        barcode: data.barcode,
        source: data.source,
        pid: opts.grocyProductId ?? null,
        v: METADATA_SCHEMA_VERSION,
        verification: opts.verification ?? "unverified",
        payload: JSON.stringify(data),
        fetched: opts.fetched ? now : null,
        now,
      });
  }

  linkProduct(barcode: string, grocyProductId: number): void {
    this.db
      .prepare("UPDATE product_metadata SET grocy_product_id = ?, updated_at = ? WHERE barcode = ?")
      .run(grocyProductId, nowIso(), barcode);
  }

  markVerified(barcode: string, source: ProductMetadata["source"]): void {
    this.db
      .prepare("UPDATE product_metadata SET verification = 'user_confirmed', updated_at = ? WHERE barcode = ? AND source = ?")
      .run(nowIso(), barcode, source);
  }

  edibleYield(grocyProductId: number): number | null {
    const row = this.db.prepare("SELECT edible_yield FROM product_attributes WHERE grocy_product_id = ?").get(grocyProductId) as
      | { edible_yield: number | null }
      | undefined;
    return row?.edible_yield ?? null;
  }

  setEdibleYield(grocyProductId: number, edibleYield: number | null, note?: string): void {
    this.db
      .prepare(
        `INSERT INTO product_attributes(grocy_product_id, edible_yield, note, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(grocy_product_id) DO UPDATE SET edible_yield = excluded.edible_yield, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(grocyProductId, edibleYield, note ?? null, nowIso());
  }
}

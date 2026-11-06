import type { Db } from "../db";
import { nowIso } from "../db";

export type ScanKind = "purchase" | "consume";
export type ScanStatus = "pending" | "uncertain" | "completed" | "failed" | "undone";

export interface ScanTransaction {
  id: number;
  kind: ScanKind;
  idempotencyKey: string;
  requestHash: string;
  batchId: string | null;
  barcode: string | null;
  grocyProductId: number;
  productName: string;
  packages: number;
  packageAmount: number;
  packageQuId: number;
  stockAmount: number;
  stockQuId: number;
  locationId: number | null;
  shoppingLocationId: number | null;
  bestBeforeDate: string | null;
  pricePerPackage: number | null;
  source: string;
  status: ScanStatus;
  grocyTransactionId: string | null;
  logWatermark: number | null;
  error: string | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  undoneAt: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toTx(r: any): ScanTransaction {
  return {
    id: r.id,
    kind: r.kind,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    batchId: r.batch_id,
    barcode: r.barcode,
    grocyProductId: r.grocy_product_id,
    productName: r.product_name,
    packages: r.packages,
    packageAmount: r.package_amount,
    packageQuId: r.package_qu_id,
    stockAmount: r.stock_amount,
    stockQuId: r.stock_qu_id,
    locationId: r.location_id,
    shoppingLocationId: r.shopping_location_id,
    bestBeforeDate: r.best_before_date,
    pricePerPackage: r.price_per_package,
    source: r.source,
    status: r.status,
    grocyTransactionId: r.grocy_transaction_id,
    logWatermark: r.log_watermark,
    error: r.error,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    completedAt: r.completed_at,
    undoneAt: r.undone_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type NewScanTransaction = Omit<
  ScanTransaction,
  "id" | "status" | "grocyTransactionId" | "logWatermark" | "error" | "createdAt" | "submittedAt" | "completedAt" | "undoneAt"
>;

export class ScanJournal {
  constructor(private readonly db: Db) {}

  byKey(key: string): ScanTransaction | null {
    const r = this.db.prepare("SELECT * FROM scan_transactions WHERE idempotency_key = ?").get(key);
    return r ? toTx(r) : null;
  }

  get(id: number): ScanTransaction | null {
    const r = this.db.prepare("SELECT * FROM scan_transactions WHERE id = ?").get(id);
    return r ? toTx(r) : null;
  }

  recent(limit = 50, batchId?: string): ScanTransaction[] {
    const rows = batchId
      ? this.db.prepare("SELECT * FROM scan_transactions WHERE batch_id = ? ORDER BY id DESC LIMIT ?").all(batchId, limit)
      : this.db.prepare("SELECT * FROM scan_transactions ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map(toTx);
  }

  /** Insert a pending transaction; returns the existing row instead if the key is already known. */
  insert(tx: NewScanTransaction): { row: ScanTransaction; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.byKey(tx.idempotencyKey);
      if (existing) return { row: existing, created: false };
      const info = this.db
        .prepare(
          `INSERT INTO scan_transactions(kind, idempotency_key, request_hash, batch_id, barcode, grocy_product_id, product_name,
             packages, package_amount, package_qu_id, stock_amount, stock_qu_id, location_id, shopping_location_id,
             best_before_date, price_per_package, source, status, created_at)
           VALUES (@kind, @idempotencyKey, @requestHash, @batchId, @barcode, @grocyProductId, @productName,
             @packages, @packageAmount, @packageQuId, @stockAmount, @stockQuId, @locationId, @shoppingLocationId,
             @bestBeforeDate, @pricePerPackage, @source, 'pending', @now)`,
        )
        .run({ ...tx, now: nowIso() });
      return { row: this.get(Number(info.lastInsertRowid))!, created: true };
    })();
  }

  markSubmitting(id: number, watermark: number): void {
    this.db
      .prepare("UPDATE scan_transactions SET status = 'pending', log_watermark = ?, submitted_at = ?, error = NULL WHERE id = ?")
      .run(watermark, nowIso(), id);
  }

  mark(id: number, status: ScanStatus, fields: { transactionId?: string | null; error?: string | null } = {}): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE scan_transactions SET status = @status,
           grocy_transaction_id = CASE WHEN @setTid THEN @tid ELSE grocy_transaction_id END,
           error = @error,
           completed_at = CASE WHEN @status = 'completed' THEN @now ELSE completed_at END,
           undone_at = CASE WHEN @status = 'undone' THEN @now ELSE undone_at END
         WHERE id = @id`,
      )
      .run({ status, setTid: fields.transactionId !== undefined ? 1 : 0, tid: fields.transactionId ?? null, error: fields.error ?? null, now, id });
  }
}

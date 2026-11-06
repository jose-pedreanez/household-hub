import { z } from "zod";
import { AppError, UpstreamError, errorMessage } from "../errors";
import type { AddStockBody, ConsumeStockBody } from "../grocy/client";
import type { GrocyProduct, ProductBarcode, StockLogEntry } from "../grocy/schemas";
import { hashRequest } from "../idempotency";
import { convertGrocy, roundAmount, unitName, type UnitCatalog } from "../units/convert";
import { barcodeVariants } from "./normalize";
import { ScanJournal, type ScanTransaction } from "./journal";

/**
 * Receiving (and consume-by-scan) with exactly-once semantics per intended scan.
 *
 * One scan = one package by default. The package is defined by the scanned barcode in Grocy
 * (`product_barcodes.amount` in `product_barcodes.qu_id`), falling back to one purchase unit. The
 * package is converted explicitly into the product's stock unit — Grocy's add/consume endpoints
 * take stock-unit amounts and do not apply the barcode's package size for us.
 *
 * Every intended scan carries a client-generated idempotency key. Retrying the same key never books
 * twice; a new scan of the same product (new key) books another package.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const receiveRequestSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  productId: z.number().int().positive(),
  barcode: z.string().min(4).max(64).nullable().default(null),
  packages: z.number().positive().max(1000).default(1),
  /** Override the package definition (e.g. produce without a barcode): amount in `packageQuId`. */
  packageAmount: z.number().positive().optional(),
  packageQuId: z.number().int().positive().optional(),
  locationId: z.number().int().positive().optional(),
  shoppingLocationId: z.number().int().positive().optional(),
  bestBeforeDate: date.optional(),
  pricePerPackage: z.number().nonnegative().optional(),
  batchId: z.string().max(64).optional(),
  source: z.enum(["camera", "keyboard", "manual"]).default("manual"),
});
export type ReceiveRequest = z.infer<typeof receiveRequestSchema>;

export const consumeScanRequestSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  productId: z.number().int().positive(),
  barcode: z.string().min(4).max(64).nullable().default(null),
  /** Amount in the product's stock unit; defaults to one package. */
  amount: z.number().positive().optional(),
  packages: z.number().positive().max(1000).default(1),
  spoiled: z.boolean().default(false),
  batchId: z.string().max(64).optional(),
  source: z.enum(["camera", "keyboard", "manual"]).default("manual"),
});
export type ConsumeScanRequest = z.infer<typeof consumeScanRequestSchema>;

export interface ReceivingStock {
  getProduct(id: number): Promise<GrocyProduct | null>;
  listBarcodes(query?: string[]): Promise<ProductBarcode[]>;
  addStock(productId: number, body: AddStockBody): Promise<StockLogEntry[]>;
  consumeStock(productId: number, body: ConsumeStockBody): Promise<StockLogEntry[]>;
  listStockLog(query: string[], order?: string, limit?: number): Promise<StockLogEntry[]>;
  undoTransaction(transactionId: string): Promise<void>;
  transaction(transactionId: string): Promise<StockLogEntry[] | null>;
}

export interface ReceivingDeps {
  journal: ScanJournal;
  grocy: ReceivingStock;
  catalog: () => Promise<UnitCatalog>;
  today: () => string;
  reconcileAfterMs?: number;
}

export interface PackageDefinition {
  amount: number;
  quId: number;
  unitName: string;
  stockPerPackage: number;
  stockQuId: number;
  stockUnitName: string;
  conversionSource: "identity" | "grocy" | "builtin";
  from: "request" | "barcode" | "purchase_unit";
}

export interface ScanResult {
  transaction: ScanTransaction;
  replayed: boolean;
  package: PackageDefinition | null;
  dueDate: { value: string | null; assumed: "none" | "product_default" | "provided" | "never_expires" };
}

/** Resolve how much one package of this product is, in its stock unit. */
export function packageDefinition(
  product: GrocyProduct,
  barcodeRow: ProductBarcode | null,
  catalog: UnitCatalog,
  override?: { amount?: number; quId?: number },
): PackageDefinition {
  let amount = 1;
  let quId = product.qu_id_purchase;
  let from: PackageDefinition["from"] = "purchase_unit";
  if (override?.amount && override.quId) {
    amount = override.amount;
    quId = override.quId;
    from = "request";
  } else if (barcodeRow && barcodeRow.amount && barcodeRow.amount > 0) {
    amount = barcodeRow.amount;
    quId = barcodeRow.qu_id ?? product.qu_id_purchase;
    from = "barcode";
  }
  const conv = convertGrocy(catalog, product.id, amount, quId, product.qu_id_stock);
  if (!conv) {
    throw new AppError(
      "unprocessable",
      `No conversion from ${unitName(catalog, quId)} to ${unitName(catalog, product.qu_id_stock)} is defined for ${product.name}. ` +
        "Add a product-specific unit conversion (for example 1 Pack = 500 g) or set the package size on the barcode.",
    );
  }
  return {
    amount,
    quId,
    unitName: unitName(catalog, quId, amount),
    stockPerPackage: conv.amount,
    stockQuId: product.qu_id_stock,
    stockUnitName: unitName(catalog, product.qu_id_stock, conv.amount),
    conversionSource: conv.source,
    from,
  };
}

export function defaultDueDate(product: GrocyProduct, today: string): { value: string; assumed: ScanResult["dueDate"]["assumed"] } {
  const days = product.default_best_before_days ?? 0;
  if (days === -1) return { value: "2999-12-31", assumed: "never_expires" };
  if (days > 0) return { value: addDays(today, days), assumed: "product_default" };
  // Grocy would otherwise stamp today's date, marking new stock as due immediately.
  return { value: "2999-12-31", assumed: "none" };
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function findBarcodeRow(grocy: ReceivingStock, productId: number, barcode: string | null): Promise<ProductBarcode | null> {
  if (!barcode) return null;
  const rows = await grocy.listBarcodes([`product_id=${productId}`]);
  for (const v of barcodeVariants(barcode)) {
    const hit = rows.find((r) => r.barcode === v);
    if (hit) return hit;
  }
  return null;
}

export function receiptNote(key: string): string {
  return `hub:${key}`;
}

export async function receive(deps: ReceivingDeps, req: ReceiveRequest): Promise<ScanResult> {
  const { journal, grocy } = deps;
  const requestHash = hashRequest({ ...req, idempotencyKey: undefined, source: undefined });

  const existing = journal.byKey(req.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash || existing.kind !== "purchase") {
      throw new AppError("idempotency_mismatch", "This idempotency key was already used for a different scan");
    }
    return settleExisting(deps, existing);
  }

  const product = await grocy.getProduct(req.productId);
  if (!product) throw new AppError("not_found", `Grocy product #${req.productId} not found`);
  if (product.no_own_stock) {
    throw new AppError("unprocessable", `${product.name} is a generic product without own stock; receive a specific product instead.`);
  }
  const catalog = await deps.catalog();
  const barcodeRow = await findBarcodeRow(grocy, product.id, req.barcode);
  const pkg = packageDefinition(product, barcodeRow, catalog, { amount: req.packageAmount, quId: req.packageQuId });
  const stockAmount = roundAmount(req.packages * pkg.stockPerPackage);
  const due = req.bestBeforeDate
    ? { value: req.bestBeforeDate, assumed: "provided" as const }
    : defaultDueDate(product, deps.today());

  const { row, created } = journal.insert({
    kind: "purchase",
    idempotencyKey: req.idempotencyKey,
    requestHash,
    batchId: req.batchId ?? null,
    barcode: req.barcode,
    grocyProductId: product.id,
    productName: product.name,
    packages: req.packages,
    packageAmount: pkg.amount,
    packageQuId: pkg.quId,
    stockAmount,
    stockQuId: pkg.stockQuId,
    locationId: req.locationId ?? product.location_id ?? null,
    shoppingLocationId: req.shoppingLocationId ?? barcodeRow?.shopping_location_id ?? product.shopping_location_id ?? null,
    bestBeforeDate: due.value,
    pricePerPackage: req.pricePerPackage ?? null,
    source: req.source,
  });
  if (!created) return settleExisting(deps, row);

  await submitPurchase(deps, row, pkg);
  return { transaction: journal.get(row.id)!, replayed: false, package: pkg, dueDate: due };
}

async function submitPurchase(deps: ReceivingDeps, tx: ScanTransaction, pkg: PackageDefinition | null): Promise<void> {
  const { journal, grocy } = deps;
  const watermark = (await grocy.listStockLog([`product_id=${tx.grocyProductId}`], "id:desc", 1))[0]?.id ?? 0;
  journal.markSubmitting(tx.id, watermark);
  const body: AddStockBody = {
    amount: tx.stockAmount,
    transaction_type: "purchase",
    best_before_date: tx.bestBeforeDate ?? undefined,
    note: receiptNote(tx.idempotencyKey),
  };
  if (tx.locationId) body.location_id = tx.locationId;
  if (tx.shoppingLocationId) body.shopping_location_id = tx.shoppingLocationId;
  const perStock = pkg?.stockPerPackage ?? (tx.packages > 0 ? tx.stockAmount / tx.packages : 0);
  if (tx.pricePerPackage != null && perStock > 0) {
    // Grocy expects the price per stock unit.
    body.price = Math.round((tx.pricePerPackage / perStock) * 1e6) / 1e6;
  }
  try {
    const rows = await grocy.addStock(tx.grocyProductId, body);
    const tid = rows.find((r) => r.transaction_id)?.transaction_id ?? null;
    if (tid) journal.mark(tx.id, "completed", { transactionId: tid });
    else journal.mark(tx.id, "uncertain", { error: "Grocy returned no transaction id" });
  } catch (e) {
    if (e instanceof UpstreamError && e.outcomeUncertain) journal.mark(tx.id, "uncertain", { error: e.message });
    else journal.mark(tx.id, "failed", { error: errorMessage(e) });
  }
}

async function submitConsume(deps: ReceivingDeps, tx: ScanTransaction, spoiled: boolean): Promise<void> {
  const { journal, grocy } = deps;
  const watermark = (await grocy.listStockLog([`product_id=${tx.grocyProductId}`], "id:desc", 1))[0]?.id ?? 0;
  journal.markSubmitting(tx.id, watermark);
  try {
    const rows = await grocy.consumeStock(tx.grocyProductId, { amount: tx.stockAmount, spoiled });
    const tid = rows.find((r) => r.transaction_id)?.transaction_id ?? null;
    if (tid) journal.mark(tx.id, "completed", { transactionId: tid });
    else journal.mark(tx.id, "uncertain", { error: "Grocy returned no transaction id" });
  } catch (e) {
    if (e instanceof UpstreamError && e.outcomeUncertain) journal.mark(tx.id, "uncertain", { error: e.message });
    else journal.mark(tx.id, "failed", { error: errorMessage(e) });
  }
}

/** A retry of a known key: replay a finished result, or reconcile/resubmit an unfinished one. */
async function settleExisting(deps: ReceivingDeps, tx: ScanTransaction): Promise<ScanResult> {
  const { journal } = deps;
  const replay = (t: ScanTransaction): ScanResult => ({
    transaction: t,
    replayed: true,
    package: null,
    dueDate: { value: t.bestBeforeDate, assumed: "provided" },
  });
  if (tx.status === "completed" || tx.status === "undone") return replay(tx);

  if (tx.status === "failed") {
    // A definitive rejection applied nothing; the same intent may be tried again.
    if (tx.kind === "purchase") await submitPurchase(deps, tx, null);
    else await submitConsume(deps, tx, false);
    return { ...replay(journal.get(tx.id)!), replayed: false };
  }

  // pending (crashed or in flight) or uncertain: reconcile with Grocy's stock log first. A request that
  // timed out on our side may still be running in Grocy, so wait out a settling window before deciding
  // it was not applied — otherwise a resubmission could book the package twice.
  const now = Date.now();
  const waitMs = deps.reconcileAfterMs ?? 30_000;
  if (tx.submittedAt && now - Date.parse(tx.submittedAt) < waitMs) {
    throw new AppError("in_progress", "This scan is still being confirmed with Grocy; retry in a few seconds");
  }
  const found = await findApplied(deps, tx);
  if (found === "ambiguous") {
    journal.mark(tx.id, "uncertain", { error: "Several matching Grocy transactions; review the stock journal." });
    return replay(journal.get(tx.id)!);
  }
  if (found) {
    journal.mark(tx.id, "completed", { transactionId: found });
    return replay(journal.get(tx.id)!);
  }
  if (tx.kind === "purchase") await submitPurchase(deps, tx, null);
  else await submitConsume(deps, tx, false);
  return { ...replay(journal.get(tx.id)!), replayed: false };
}

async function findApplied(deps: ReceivingDeps, tx: ScanTransaction): Promise<string | null | "ambiguous"> {
  if (tx.logWatermark == null) return null;
  const type = tx.kind === "purchase" ? "purchase" : "consume";
  const rows = await deps.grocy.listStockLog(
    [`product_id=${tx.grocyProductId}`, `id>${tx.logWatermark}`, `transaction_type=${type}`],
    "id:asc",
    200,
  );
  if (tx.kind === "purchase") {
    const tagged = rows.filter((r) => r.note === receiptNote(tx.idempotencyKey) && !r.undone);
    return tagged[0]?.transaction_id ?? null;
  }
  const byTx = new Map<string, number>();
  for (const r of rows) if (!r.undone) byTx.set(r.transaction_id, (byTx.get(r.transaction_id) ?? 0) + Math.abs(r.amount));
  const matches = [...byTx.entries()].filter(([, sum]) => Math.abs(roundAmount(sum) - tx.stockAmount) < 0.0002);
  if (matches.length === 1) return matches[0][0];
  return matches.length > 1 ? "ambiguous" : null;
}

export async function consumeByScan(deps: ReceivingDeps, req: ConsumeScanRequest): Promise<ScanResult> {
  const { journal, grocy } = deps;
  const requestHash = hashRequest({ ...req, idempotencyKey: undefined, source: undefined });
  const existing = journal.byKey(req.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash || existing.kind !== "consume") {
      throw new AppError("idempotency_mismatch", "This idempotency key was already used for a different scan");
    }
    return settleExisting(deps, existing);
  }
  const product = await grocy.getProduct(req.productId);
  if (!product) throw new AppError("not_found", `Grocy product #${req.productId} not found`);
  const catalog = await deps.catalog();
  const barcodeRow = await findBarcodeRow(grocy, product.id, req.barcode);
  const pkg = packageDefinition(product, barcodeRow, catalog);
  const stockAmount = roundAmount(req.amount ?? req.packages * pkg.stockPerPackage);

  const { row, created } = journal.insert({
    kind: "consume",
    idempotencyKey: req.idempotencyKey,
    requestHash,
    batchId: req.batchId ?? null,
    barcode: req.barcode,
    grocyProductId: product.id,
    productName: product.name,
    packages: req.amount ? roundAmount(req.amount / pkg.stockPerPackage) : req.packages,
    packageAmount: pkg.amount,
    packageQuId: pkg.quId,
    stockAmount,
    stockQuId: pkg.stockQuId,
    locationId: null,
    shoppingLocationId: null,
    bestBeforeDate: null,
    pricePerPackage: null,
    source: req.source,
  });
  if (!created) return settleExisting(deps, row);
  await submitConsume(deps, row, req.spoiled);
  return { transaction: journal.get(row.id)!, replayed: false, package: pkg, dueDate: { value: null, assumed: "none" } };
}

/** Undo a booked scan by its Grocy transaction. Idempotent. */
export async function undoScan(deps: ReceivingDeps, id: number): Promise<ScanTransaction> {
  const { journal, grocy } = deps;
  const tx = journal.get(id);
  if (!tx) throw new AppError("not_found", "Scan not found");
  if (tx.status === "undone") return tx;
  if (tx.status !== "completed" || !tx.grocyTransactionId) {
    throw new AppError("conflict", `A ${tx.status} scan cannot be undone; retry it first so its outcome is known`);
  }
  try {
    await grocy.undoTransaction(tx.grocyTransactionId);
  } catch (e) {
    const rows = await grocy.transaction(tx.grocyTransactionId).catch(() => null);
    if (!(rows && rows.length > 0 && rows.every((r) => r.undone))) {
      throw new AppError("upstream_error", `Grocy could not undo this scan: ${errorMessage(e)}`);
    }
  }
  journal.mark(tx.id, "undone");
  return journal.get(tx.id)!;
}

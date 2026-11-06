import { UpstreamError } from "@/lib/errors";
import type { AddStockBody, ConsumeStockBody } from "@/lib/grocy/client";
import type { GrocyProduct, ProductBarcode, ProductDetails, QuantityUnit, StockEntry, StockLogEntry } from "@/lib/grocy/schemas";

/**
 * In-memory model of the Grocy 4.x stock API surface the hub uses. It mirrors the behaviour the hub
 * relies on (amounts in stock units, FEFO default consumption, per-request transaction ids, notes on
 * purchase log rows, undo) and lets tests inject failures, including "applied but no response".
 */
export type Failure = "reject" | "timeout_after_apply" | "timeout_before_apply" | "server_error_after_apply";

export class FakeGrocy {
  products = new Map<number, GrocyProduct>();
  barcodes: ProductBarcode[] = [];
  units: QuantityUnit[] = [];
  entries: StockEntry[] = [];
  log: StockLogEntry[] = [];
  calls: Array<{ op: string; productId?: number; body?: unknown }> = [];
  private nextEntry = 1;
  private nextLog = 1;
  private nextTx = 1;
  private failures: Array<{ op: "add" | "consume" | "undo"; productId?: number; kind: Failure }> = [];

  unit(id: number, name: string, plural = `${name}s`): this {
    this.units.push({ id, name, name_plural: plural, description: null } as QuantityUnit);
    return this;
  }

  product(p: Partial<GrocyProduct> & { id: number; name: string; qu_id_stock: number }): this {
    this.products.set(p.id, {
      description: null,
      location_id: 1,
      qu_id_purchase: p.qu_id_stock,
      min_stock_amount: 0,
      default_best_before_days: 0,
      parent_product_id: null,
      no_own_stock: false,
      active: true,
      ...p,
    } as GrocyProduct);
    return this;
  }

  barcode(productId: number, barcode: string, amount: number | null, quId: number | null): this {
    this.barcodes.push({ id: this.barcodes.length + 1, product_id: productId, barcode, amount, qu_id: quId, note: null } as ProductBarcode);
    return this;
  }

  stock(productId: number, amount: number, bestBefore: string, opts: { open?: boolean; purchased?: string; location?: number } = {}): string {
    const stockId = `s${this.nextEntry}`;
    this.entries.push({
      id: this.nextEntry++,
      product_id: productId,
      location_id: opts.location ?? 1,
      amount,
      best_before_date: bestBefore,
      purchased_date: opts.purchased ?? "2026-10-01",
      stock_id: stockId,
      price: null,
      open: !!opts.open,
      opened_date: null,
      note: null,
    } as StockEntry);
    return stockId;
  }

  failNext(op: "add" | "consume" | "undo", kind: Failure, productId?: number): void {
    this.failures.push({ op, kind, productId });
  }

  total(productId: number): number {
    return Math.round(this.entries.filter((e) => e.product_id === productId).reduce((s, e) => s + e.amount, 0) * 10_000) / 10_000;
  }

  private takeFailure(op: "add" | "consume" | "undo", productId?: number): Failure | null {
    const i = this.failures.findIndex((f) => f.op === op && (f.productId === undefined || f.productId === productId));
    if (i < 0) return null;
    return this.failures.splice(i, 1)[0].kind;
  }

  private fail(kind: Failure, what: string): never {
    if (kind === "reject") {
      throw new UpstreamError({ service: "Grocy", message: `Grocy rejected ${what}`, httpStatus: 400, outcomeUncertain: false, unreachable: false });
    }
    throw new UpstreamError({
      service: "Grocy",
      message: `Grocy ${kind === "server_error_after_apply" ? "returned HTTP 500" : "timed out"} for ${what}`,
      httpStatus: kind === "server_error_after_apply" ? 500 : null,
      outcomeUncertain: true,
      unreachable: kind !== "server_error_after_apply",
    });
  }

  // ---- API surface ---------------------------------------------------------

  async getProduct(id: number) {
    return this.products.get(id) ?? null;
  }

  async listProducts(query?: string[]) {
    let ps = [...this.products.values()];
    for (const q of query ?? []) {
      const [k, v] = q.split("=");
      ps = ps.filter((p) => String((p as Record<string, unknown>)[k]) === v);
    }
    return ps;
  }

  async listBarcodes(query?: string[]) {
    const pid = query?.find((q) => q.startsWith("product_id="))?.split("=")[1];
    return pid ? this.barcodes.filter((b) => b.product_id === Number(pid)) : this.barcodes;
  }

  async productByBarcode(barcode: string): Promise<ProductDetails | null> {
    const b = this.barcodes.find((x) => x.barcode === barcode);
    if (!b) return null;
    const p = this.products.get(b.product_id)!;
    const unit = this.units.find((u) => u.id === p.qu_id_stock)!;
    return {
      product: p,
      product_barcodes: this.barcodes.filter((x) => x.product_id === p.id),
      quantity_unit_stock: unit,
      stock_amount: this.total(p.id),
      stock_amount_opened: 0,
      next_due_date: null,
      last_price: null,
    } as unknown as ProductDetails;
  }

  async stockEntries(productId: number) {
    return this.entries.filter((e) => e.product_id === productId && e.amount > 0).map((e) => ({ ...e }));
  }

  async listStockLog(query: string[] = [], order = "id:desc", limit = 200) {
    let rows = [...this.log];
    for (const q of query) {
      const m = q.match(/^(\w+)(>=|<=|=|>|<)(.*)$/);
      if (!m) continue;
      const [, field, op, value] = m;
      rows = rows.filter((r) => {
        const v = (r as Record<string, unknown>)[field];
        if (op === "=") return String(v) === value;
        if (op === ">") return Number(v) > Number(value);
        if (op === "<") return Number(v) < Number(value);
        return true;
      });
    }
    rows.sort((a, b) => (order.endsWith("desc") ? b.id - a.id : a.id - b.id));
    return rows.slice(0, limit).map((r) => ({ ...r }));
  }

  async addStock(productId: number, body: AddStockBody): Promise<StockLogEntry[]> {
    this.calls.push({ op: "add", productId, body });
    const failure = this.takeFailure("add", productId);
    if (failure === "reject" || failure === "timeout_before_apply") this.fail(failure, "add");
    const tx = `tx${this.nextTx++}`;
    const stockId = this.stock(productId, body.amount, body.best_before_date ?? "2026-10-21");
    const row: StockLogEntry = {
      id: this.nextLog++,
      product_id: productId,
      amount: body.amount,
      best_before_date: body.best_before_date ?? null,
      purchased_date: "2026-10-21",
      used_date: null,
      spoiled: false,
      stock_id: stockId,
      transaction_id: tx,
      transaction_type: "purchase",
      note: body.note ?? null,
      undone: false,
      row_created_timestamp: "2026-10-21 12:00:00",
    } as StockLogEntry;
    this.log.push(row);
    if (failure) this.fail(failure, "add");
    return [{ ...row }];
  }

  async consumeStock(productId: number, body: ConsumeStockBody): Promise<StockLogEntry[]> {
    this.calls.push({ op: "consume", productId, body });
    const failure = this.takeFailure("consume", productId);
    if (failure === "reject" || failure === "timeout_before_apply") this.fail(failure, "consume");
    const candidates = this.entries
      .filter((e) => e.product_id === productId && e.amount > 0 && (!body.stock_entry_id || e.stock_id === body.stock_entry_id))
      .sort((a, b) => Number(b.open) - Number(a.open) || (a.best_before_date ?? "").localeCompare(b.best_before_date ?? "") || a.id - b.id);
    const available = candidates.reduce((s, e) => s + e.amount, 0);
    if (body.amount > available + 1e-9) {
      throw new UpstreamError({ service: "Grocy", message: "Amount to be consumed cannot be > current stock amount", httpStatus: 400, outcomeUncertain: false, unreachable: false });
    }
    const tx = `tx${this.nextTx++}`;
    let remaining = body.amount;
    const rows: StockLogEntry[] = [];
    for (const e of candidates) {
      if (remaining <= 1e-9) break;
      const take = Math.min(e.amount, remaining);
      e.amount = Math.round((e.amount - take) * 10_000) / 10_000;
      remaining -= take;
      const row = {
        id: this.nextLog++,
        product_id: productId,
        amount: -take,
        best_before_date: e.best_before_date,
        purchased_date: e.purchased_date,
        used_date: "2026-10-21",
        spoiled: !!body.spoiled,
        stock_id: e.stock_id,
        transaction_id: tx,
        transaction_type: "consume",
        note: null,
        undone: false,
        row_created_timestamp: "2026-10-21 12:00:00",
      } as StockLogEntry;
      this.log.push(row);
      rows.push({ ...row });
    }
    if (failure) this.fail(failure, "consume");
    return rows;
  }

  async undoTransaction(tid: string): Promise<void> {
    this.calls.push({ op: "undo", body: tid });
    const failure = this.takeFailure("undo");
    if (failure) this.fail(failure, "undo");
    const rows = this.log.filter((r) => r.transaction_id === tid);
    if (rows.length === 0 || rows.every((r) => r.undone)) {
      throw new UpstreamError({ service: "Grocy", message: "Transaction not found or already undone", httpStatus: 400, outcomeUncertain: false, unreachable: false });
    }
    for (const r of rows) {
      r.undone = true;
      const entry = this.entries.find((e) => e.stock_id === r.stock_id);
      if (r.transaction_type === "purchase") {
        if (entry) entry.amount = Math.round((entry.amount - r.amount) * 10_000) / 10_000;
      } else if (entry) {
        entry.amount = Math.round((entry.amount - r.amount) * 10_000) / 10_000; // r.amount is negative
      }
    }
  }

  async transaction(tid: string) {
    const rows = this.log.filter((r) => r.transaction_id === tid);
    return rows.length ? rows.map((r) => ({ ...r })) : null;
  }

  async createObject(entity: string, body: Record<string, unknown>): Promise<number> {
    this.calls.push({ op: `create:${entity}`, body });
    if (entity === "products") {
      const id = Math.max(0, ...this.products.keys()) + 1;
      this.product({ id, ...(body as { name: string; qu_id_stock: number }) });
      return id;
    }
    if (entity === "product_barcodes") {
      this.barcode(body.product_id as number, body.barcode as string, (body.amount as number) ?? null, (body.qu_id as number) ?? null);
      return this.barcodes.length;
    }
    return 1;
  }
}

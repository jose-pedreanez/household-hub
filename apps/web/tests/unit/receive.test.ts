import { beforeEach, describe, expect, it } from "vitest";
import { ScanJournal } from "@/lib/barcode/journal";
import { consumeByScan, defaultDueDate, receive, receiveRequestSchema, undoScan, type ReceivingDeps } from "@/lib/barcode/receive";
import { openDatabase } from "@/lib/db";
import type { FakeGrocy } from "../support/fake-grocy";
import { makeContext, makeGrocy, P, U } from "../support/kitchen";

let grocy: FakeGrocy;
let deps: ReceivingDeps;

beforeEach(() => {
  grocy = makeGrocy();
  deps = {
    journal: new ScanJournal(openDatabase(":memory:")),
    grocy,
    catalog: async () => makeContext(grocy).catalog,
    today: () => "2026-10-21",
    reconcileAfterMs: 30_000,
  };
});

const req = (o: Record<string, unknown>) => receiveRequestSchema.parse({ source: "camera", ...o });
const adds = () => grocy.calls.filter((c) => c.op === "add");

describe("receiving: package → stock unit", () => {
  it("one 500 g bag adds 500 g", async () => {
    const r = await receive(deps, req({ idempotencyKey: "scan-0001", productId: P.tjPasta, barcode: "00512345" }));
    expect(r.transaction.status).toBe("completed");
    expect(grocy.total(P.tjPasta)).toBe(500);
    expect(r.package).toMatchObject({ amount: 500, stockPerPackage: 500, from: "barcode" });
  });

  it("a different barcode for the same product books its own package size (1 kg)", async () => {
    await receive(deps, req({ idempotencyKey: "scan-0002", productId: P.tjPasta, barcode: "4006381333931" }));
    expect(grocy.total(P.tjPasta)).toBe(1000);
  });

  it("a 1 lb box converts to grams", async () => {
    await receive(deps, req({ idempotencyKey: "scan-0003", productId: P.barilla, barcode: "076808280739" }));
    expect(grocy.total(P.barilla)).toBeCloseTo(453.5924, 4);
  });

  it("one milk carton adds 946 mL; one dozen eggs adds 12 eggs", async () => {
    await receive(deps, req({ idempotencyKey: "scan-0004", productId: P.milk, barcode: "0070038000563" }));
    await receive(deps, req({ idempotencyKey: "scan-0005", productId: P.eggs, barcode: "0012345678905" }));
    expect(grocy.total(P.milk)).toBe(946);
    expect(grocy.total(P.eggs)).toBe(12);
  });

  it("a six-pack adds six units through the product's pack conversion", async () => {
    await receive(deps, req({ idempotencyKey: "scan-0006", productId: P.yogurt, barcode: "0036632036935" }));
    expect(grocy.total(P.yogurt)).toBe(6);
  });

  it("finds the barcode row under its EAN-13 or UPC-A form", async () => {
    await receive(deps, req({ idempotencyKey: "scan-0007", productId: P.eggs, barcode: "012345678905" }));
    expect(grocy.total(P.eggs)).toBe(12);
  });

  it("multiple packages in one scan", async () => {
    await receive(deps, req({ idempotencyKey: "scan-0008", productId: P.milk, barcode: "0070038000563", packages: 2 }));
    expect(grocy.total(P.milk)).toBe(1892);
  });

  it("refuses when no conversion exists instead of guessing", async () => {
    grocy.barcode(P.milk, "999999999993", 1, U.pack);
    await expect(receive(deps, req({ idempotencyKey: "scan-0009", productId: P.milk, barcode: "999999999993" }))).rejects.toThrow(/No conversion/);
    expect(adds()).toHaveLength(0);
  });

  it("refuses to receive into a generic product without own stock", async () => {
    await expect(receive(deps, req({ idempotencyKey: "scan-0010", productId: P.pasta, barcode: null }))).rejects.toThrow(/generic/);
  });

  it("converts the package price to Grocy's price per stock unit and tags the entry", async () => {
    await receive(deps, req({ idempotencyKey: "scan-0011", productId: P.milk, barcode: "0070038000563", pricePerPackage: 4.73 }));
    expect(adds()[0].body).toMatchObject({ amount: 946, price: 0.005, note: "hub:scan-0011" });
  });
});

describe("receiving: exactly once per intended scan", () => {
  it("a duplicate network request with the same key books once", async () => {
    const a = await receive(deps, req({ idempotencyKey: "dup-00001", productId: P.milk, barcode: "0070038000563" }));
    const b = await receive(deps, req({ idempotencyKey: "dup-00001", productId: P.milk, barcode: "0070038000563" }));
    expect(b.replayed).toBe(true);
    expect(b.transaction.id).toBe(a.transaction.id);
    expect(adds()).toHaveLength(1);
    expect(grocy.total(P.milk)).toBe(946);
  });

  it("an intentional rescan (new key) books another package", async () => {
    await receive(deps, req({ idempotencyKey: "rescan-001", productId: P.milk, barcode: "0070038000563" }));
    await receive(deps, req({ idempotencyKey: "rescan-002", productId: P.milk, barcode: "0070038000563" }));
    expect(grocy.total(P.milk)).toBe(1892);
  });

  it("rejects a reused key carrying a different request", async () => {
    await receive(deps, req({ idempotencyKey: "mismatch-1", productId: P.milk, barcode: "0070038000563" }));
    await expect(receive(deps, req({ idempotencyKey: "mismatch-1", productId: P.eggs, barcode: "0012345678905" }))).rejects.toThrow(/different scan/);
  });

  it("timeout after Grocy applied: retry reconciles via the tagged log row, no second add", async () => {
    grocy.failNext("add", "timeout_after_apply");
    const first = await receive(deps, req({ idempotencyKey: "uncert-001", productId: P.milk, barcode: "0070038000563" }));
    expect(first.transaction.status).toBe("uncertain");
    deps.reconcileAfterMs = 0; // settling window has passed
    const retry = await receive(deps, req({ idempotencyKey: "uncert-001", productId: P.milk, barcode: "0070038000563" }));
    expect(retry.transaction.status).toBe("completed");
    expect(retry.transaction.grocyTransactionId).toBe(grocy.log[0].transaction_id);
    expect(adds()).toHaveLength(1);
    expect(grocy.total(P.milk)).toBe(946);
  });

  it("timeout before Grocy applied: retry submits exactly once", async () => {
    grocy.failNext("add", "timeout_before_apply");
    const first = await receive(deps, req({ idempotencyKey: "uncert-002", productId: P.milk, barcode: "0070038000563" }));
    expect(first.transaction.status).toBe("uncertain");
    deps.reconcileAfterMs = 0; // settling window has passed
    const retry = await receive(deps, req({ idempotencyKey: "uncert-002", productId: P.milk, barcode: "0070038000563" }));
    expect(retry.transaction.status).toBe("completed");
    expect(grocy.total(P.milk)).toBe(946);
  });

  it("a retry inside the settling window is told to wait, not resubmitted", async () => {
    grocy.failNext("add", "timeout_before_apply");
    await receive(deps, req({ idempotencyKey: "uncert-003", productId: P.milk, barcode: "0070038000563" }));
    // Grocy might still be processing the timed-out request: no resubmission yet.
    await expect(receive(deps, req({ idempotencyKey: "uncert-003", productId: P.milk, barcode: "0070038000563" }))).rejects.toThrow(/still being confirmed/);
    expect(adds()).toHaveLength(1);
    deps.reconcileAfterMs = 0; // settling window has passed
    const retry = await receive(deps, req({ idempotencyKey: "uncert-003", productId: P.milk, barcode: "0070038000563" }));
    expect(retry.transaction.status).toBe("completed");
    expect(grocy.total(P.milk)).toBe(946);
  });

  it("a definitive rejection applies nothing and can be retried", async () => {
    grocy.failNext("add", "reject");
    const first = await receive(deps, req({ idempotencyKey: "reject-001", productId: P.milk, barcode: "0070038000563" }));
    expect(first.transaction.status).toBe("failed");
    expect(grocy.total(P.milk)).toBe(0);
    const retry = await receive(deps, req({ idempotencyKey: "reject-001", productId: P.milk, barcode: "0070038000563" }));
    expect(retry.transaction.status).toBe("completed");
    expect(grocy.total(P.milk)).toBe(946);
  });
});

describe("undo and consume by scan", () => {
  it("undo reverses the Grocy transaction and is idempotent", async () => {
    const r = await receive(deps, req({ idempotencyKey: "undo-0001", productId: P.milk, barcode: "0070038000563" }));
    await undoScan(deps, r.transaction.id);
    expect(grocy.total(P.milk)).toBe(0);
    const again = await undoScan(deps, r.transaction.id);
    expect(again.status).toBe("undone");
    expect(grocy.calls.filter((c) => c.op === "undo")).toHaveLength(1);
  });

  it("consume by scan takes one package and is exactly-once", async () => {
    grocy.stock(P.milk, 1892, "2026-10-25");
    const c = { idempotencyKey: "cons-0001", productId: P.milk, barcode: "0070038000563", packages: 1, spoiled: false, source: "keyboard" as const };
    await consumeByScan(deps, c);
    await consumeByScan(deps, c);
    expect(grocy.total(P.milk)).toBe(946);
  });
});

describe("default due dates", () => {
  it("uses the product default, never expiring, or no date (not today)", () => {
    const g = makeGrocy();
    expect(defaultDueDate(g.products.get(P.milk)!, "2026-10-21")).toEqual({ value: "2026-10-28", assumed: "product_default" });
    expect(defaultDueDate(g.products.get(P.flour)!, "2026-10-21")).toEqual({ value: "2999-12-31", assumed: "never_expires" });
    expect(defaultDueDate(g.products.get(P.yogurt)!, "2026-10-21")).toEqual({ value: "2999-12-31", assumed: "none" });
  });
});

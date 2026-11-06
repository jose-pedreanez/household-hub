import { describe, expect, it } from "vitest";
import { filterNewAlerts, type Alert } from "@/lib/alerts";
import { createSessionToken, secretsEqual, verifySessionToken } from "@/lib/auth/session";
import { openDatabase } from "@/lib/db";
import { hashRequest, withIdempotency } from "@/lib/idempotency";
import { isAmbiguous, rank, tokens } from "@/lib/match";
import { computeRequirements } from "@/lib/meals/requirements";
import type { CurrentStock } from "@/lib/grocy/schemas";
import { F, ing, makeContext, makeGrocy, MU, P, recipe } from "../support/kitchen";

describe("idempotency", () => {
  it("hashes requests independent of key order", () => {
    expect(hashRequest({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashRequest({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it("runs once, replays, rejects mismatches, and retries after failure", async () => {
    const db = openDatabase(":memory:");
    let runs = 0;
    const fn = async () => ++runs;
    expect(await withIdempotency(db, { key: "key-00001", scope: "t", payload: { x: 1 } }, fn)).toEqual({ result: 1, replayed: false });
    expect(await withIdempotency(db, { key: "key-00001", scope: "t", payload: { x: 1 } }, fn)).toEqual({ result: 1, replayed: true });
    await expect(withIdempotency(db, { key: "key-00001", scope: "t", payload: { x: 2 } }, fn)).rejects.toThrow(/different request/);
    await expect(withIdempotency(db, { key: "key-00002", scope: "t", payload: {} }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await withIdempotency(db, { key: "key-00002", scope: "t", payload: {} }, fn)).replayed).toBe(false);
    expect(runs).toBe(2);
  });
});

describe("sessions", () => {
  const secret = "s".repeat(40);
  it("verifies its own tokens and rejects tampered or expired ones", async () => {
    const t = await createSessionToken(secret, 1000);
    expect(await verifySessionToken(secret, t, 1001)).toBe(true);
    expect(await verifySessionToken("x".repeat(40), t, 1001)).toBe(false);
    expect(await verifySessionToken(secret, `${t.slice(0, -2)}xx`, 1001)).toBe(false);
    expect(await verifySessionToken(secret, t, 1000 + 31 * 86400)).toBe(false);
    expect(await verifySessionToken(secret, undefined)).toBe(false);
  });
  it("compares secrets without short-circuiting on length", async () => {
    expect(await secretsEqual("abc", "abc")).toBe(true);
    expect(await secretsEqual("abc", "abcd")).toBe(false);
  });
});

describe("alert deduplication", () => {
  const alert = (body: string): Alert => ({ kind: "due_soon", dedupeKey: "alert:due_soon", title: "Due soon (1)", body, link: "/inventory" });
  it("does not repeat an unchanged alert within the window, but sends changes", () => {
    const db = openDatabase(":memory:");
    const t0 = Date.parse("2026-10-21T08:00:00Z");
    expect(filterNewAlerts(db, [alert("Milk")], 24, t0).send).toHaveLength(1);
    expect(filterNewAlerts(db, [alert("Milk")], 24, t0 + 3600_000)).toEqual({ send: [], suppressed: 1 });
    expect(filterNewAlerts(db, [alert("Milk, Eggs")], 24, t0 + 7200_000).send).toHaveLength(1);
    expect(filterNewAlerts(db, [alert("Milk, Eggs")], 24, t0 + 31 * 3600_000).send).toHaveLength(1);
  });
});

describe("fuzzy matching", () => {
  it("tokenises, singularises and flags close calls as ambiguous", () => {
    expect(tokens("Trader Joe's Organic Tomatoes 28 oz")).toEqual(["tomato"]);
    const ranked = rank(["penne", "pasta"], [{ n: "Pasta" }, { n: "Pasta sauce" }, { n: "Milk" }], (x) => tokens(x.n));
    expect(ranked.map((r) => r.item.n)).toEqual(["Pasta", "Pasta sauce"]);
    expect(isAmbiguous(ranked)).toBe(false); // 0.85 vs 0.5: a clear winner
    const close = rank(["chicken"], [{ n: "Chicken thighs" }, { n: "Chicken breast" }], (x) => tokens(x.n));
    expect(isAmbiguous(close)).toBe(true);
    expect(isAmbiguous([])).toBe(true);
  });
});

describe("ingredient requirements", () => {
  it("aggregates planned meals, subtracts usable stock across product families, lists unmapped items", () => {
    const g = makeGrocy();
    const ctx = makeContext(g);
    const stock = [
      { product_id: P.tjPasta, amount: 500, product: g.products.get(P.tjPasta) },
      { product_id: P.eggs, amount: 4, product: g.products.get(P.eggs) },
    ] as CurrentStock[];
    const pasta = recipe("Pasta", 4, [ing({ id: F.pasta, name: "Pasta" }, 1, { id: MU.pound, name: "pound" }), ing({ id: "food-basil", name: "Basil" }, 1, null)]);
    const omelette = recipe("Omelette", 2, [ing({ id: F.egg, name: "Egg" }, 3, null)]);
    const r = computeRequirements(
      [
        { entryId: 1, date: "2026-10-22", recipe: pasta, servings: 8 },
        { entryId: 2, date: "2026-10-23", recipe: omelette, servings: 2 },
      ],
      ctx,
      stock,
      () => null,
    );
    const pastaReq = r.requirements.find((x) => x.productId === P.pasta)!;
    expect(pastaReq).toMatchObject({ required: 907.1847, available: 500, shortfall: 407.1847 });
    expect(r.requirements.find((x) => x.productId === P.eggs)).toMatchObject({ required: 3, available: 4, shortfall: 0 });
    expect(r.unresolved).toMatchObject([{ foodName: "Basil", reason: "unmapped" }]);
  });
});

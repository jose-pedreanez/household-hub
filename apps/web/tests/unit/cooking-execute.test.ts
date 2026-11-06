import { beforeEach, describe, expect, it } from "vitest";
import { correctLine, resumeCooking, reverseCooking, skipLine, startCooking, type CookingDeps } from "@/lib/cooking/execute";
import { CookingJournal } from "@/lib/cooking/journal";
import { buildCookingPlan, productsToLoad, type CookingPlan } from "@/lib/cooking/plan";
import { openDatabase } from "@/lib/db";
import type { FakeGrocy } from "../support/fake-grocy";
import { F, ing, makeContext, makeGrocy, MU, P, recipe } from "../support/kitchen";

let g: FakeGrocy;
let deps: CookingDeps;
let mealieCalls: string[];
let mealieFails: boolean;

beforeEach(() => {
  g = makeGrocy();
  mealieCalls = [];
  mealieFails = false;
  deps = {
    journal: new CookingJournal(openDatabase(":memory:")),
    grocy: g,
    mealie: {
      setLastMade: async (slug) => {
        if (mealieFails) throw new Error("Mealie down");
        mealieCalls.push(`lastMade:${slug}`);
      },
      addTimelineEvent: async (e) => {
        if (mealieFails) throw new Error("Mealie down");
        mealieCalls.push(`timeline:${e.subject}`);
      },
    },
    reconcileAfterMs: 30_000,
  };
});

const spaghetti = () =>
  recipe("Spaghetti", 4, [
    ing({ id: F.pasta, name: "Pasta" }, 1, { id: MU.pound, name: "pound" }),
    ing({ id: F.egg, name: "Egg" }, 2, null),
    ing({ id: F.milk, name: "Milk" }, 1, { id: MU.cup, name: "cup" }),
  ]);

function makePlan(servings = 4): CookingPlan {
  const r = spaghetti();
  const ctx = makeContext(g);
  const entries = productsToLoad(r, ctx).flatMap((id) => g.entries.filter((e) => e.product_id === id).map((e) => ({ ...e })));
  return buildCookingPlan({ recipe: r, servings, ctx, entries, edibleYield: () => null });
}

function stockUp() {
  g.stock(P.tjPasta, 500, "2026-12-01");
  g.stock(P.barilla, 453.5924, "2027-03-01");
  g.stock(P.eggs, 12, "2026-11-01");
  g.stock(P.milk, 946, "2026-10-25");
}

const start = (key: string, plan: CookingPlan, mealplanEntryId: number | null = 101) =>
  startCooking(deps, { idempotencyKey: key, requestHash: `hash-${plan.servings}-${mealplanEntryId}`, mealplanEntryId, servings: plan.servings, leftoverServings: 0, plan });

const consumes = () => g.calls.filter((c) => c.op === "consume").length;

describe("cooking execution", () => {
  it("normal completion deducts every ingredient and records Grocy transaction ids", async () => {
    stockUp();
    const v = await start("cook-000001", makePlan());
    expect(v.occurrence.status).toBe("completed");
    expect(v.lines.every((l) => l.status === "consumed" && l.grocyTransactionId)).toBe(true);
    expect(g.total(P.tjPasta) + g.total(P.barilla)).toBeCloseTo(500, 3);
    expect(g.total(P.eggs)).toBe(10);
    expect(g.total(P.milk)).toBeCloseTo(709.4118, 3);
    expect(v.occurrence.mealieSynced).toBe(true);
    expect(mealieCalls).toEqual(["lastMade:spaghetti", "timeline:Cooked 4 servings (Household Hub)"]);
  });

  it("variable servings deduct proportionally", async () => {
    stockUp();
    await start("cook-000002", makePlan(2));
    expect(g.total(P.eggs)).toBe(11);
  });

  it("a duplicate completion request (same key) never deducts twice", async () => {
    stockUp();
    const plan = makePlan();
    await start("cook-000003", plan);
    const before = consumes();
    const again = await start("cook-000003", plan);
    expect(again.replayed).toBe(true);
    expect(consumes()).toBe(before);
    expect(g.total(P.eggs)).toBe(10);
  });

  it("the same meal cannot be cooked twice with a new key until reversed", async () => {
    stockUp();
    await start("cook-000004", makePlan());
    await expect(start("cook-000005", makePlan())).rejects.toThrow(/already marked as cooked/);
    expect(g.total(P.eggs)).toBe(10);
  });

  it("partial API failure leaves a resumable partial occurrence; retry completes it without repeats", async () => {
    stockUp();
    g.failNext("consume", "reject", P.eggs);
    const v = await start("cook-000006", makePlan());
    expect(v.occurrence.status).toBe("partial");
    expect(v.lines.find((l) => l.grocyProductId === P.eggs)?.status).toBe("failed");
    const consumedBefore = v.lines.filter((l) => l.status === "consumed").length;
    const retry = await resumeCooking(deps, v.occurrence.id);
    expect(retry.occurrence.status).toBe("completed");
    expect(consumes()).toBe(consumedBefore + 2); // one failed attempt + one retry for eggs
    expect(g.total(P.eggs)).toBe(10);
    expect(g.total(P.milk)).toBeCloseTo(709.4118, 3);
  });

  it("timeout after Grocy applied: retry reconciles from the stock log, no second consume", async () => {
    stockUp();
    g.failNext("consume", "timeout_after_apply", P.milk);
    const v = await start("cook-000007", makePlan());
    expect(v.lines.find((l) => l.grocyProductId === P.milk)?.status).toBe("uncertain");
    await expect(resumeCooking(deps, v.occurrence.id)).resolves.toBeDefined(); // inside settling window: line left alone
    expect(g.total(P.milk)).toBeCloseTo(709.4118, 3);
    deps.reconcileAfterMs = 0; // settling window has passed
    const retry = await resumeCooking(deps, v.occurrence.id);
    expect(retry.occurrence.status).toBe("completed");
    expect(g.calls.filter((c) => c.op === "consume" && c.productId === P.milk)).toHaveLength(1);
    expect(g.total(P.milk)).toBeCloseTo(709.4118, 3);
  });

  it("timeout before Grocy applied: retry resubmits exactly once", async () => {
    stockUp();
    g.failNext("consume", "timeout_before_apply", P.milk);
    const v = await start("cook-000008", makePlan());
    deps.reconcileAfterMs = 0; // settling window has passed
    const retry = await resumeCooking(deps, v.occurrence.id);
    expect(retry.occurrence.status).toBe("completed");
    expect(g.total(P.milk)).toBeCloseTo(709.4118, 3);
  });

  it("reversal undoes every consume, frees the meal, and is idempotent", async () => {
    stockUp();
    const v = await start("cook-000009", makePlan());
    const r = await reverseCooking(deps, v.occurrence.id);
    expect(r.occurrence.status).toBe("reversed");
    expect(g.total(P.eggs)).toBe(12);
    expect(g.total(P.milk)).toBe(946);
    expect(g.total(P.tjPasta) + g.total(P.barilla)).toBeCloseTo(953.5924, 3);
    await reverseCooking(deps, v.occurrence.id);
    expect(g.calls.filter((c) => c.op === "undo")).toHaveLength(v.lines.length);
    const again = await start("cook-000010", makePlan());
    expect(again.occurrence.status).toBe("completed");
  });

  it("stock correction: a consumed line can be corrected to the amount actually used", async () => {
    stockUp();
    const v = await start("cook-000011", makePlan());
    const milkLine = v.lines.find((l) => l.grocyProductId === P.milk)!;
    const c = await correctLine(deps, v.occurrence.id, milkLine.lineNo, 100);
    expect(c.occurrence.status).toBe("completed");
    expect(g.total(P.milk)).toBe(846);
    expect(c.lines.find((l) => l.lineNo === milkLine.lineNo)?.status).toBe("reversed");
    expect(c.lines.find((l) => l.correctsLineNo === milkLine.lineNo)).toMatchObject({ status: "consumed", amount: 100, kind: "correction" });
  });

  it("a line that cannot be consumed can be skipped so the meal completes", async () => {
    stockUp();
    g.failNext("consume", "reject", P.eggs);
    const v = await start("cook-000012", makePlan());
    const eggs = v.lines.find((l) => l.grocyProductId === P.eggs)!;
    const s = await skipLine(deps, v.occurrence.id, eggs.lineNo);
    expect(s.occurrence.status).toBe("completed");
    expect(g.total(P.eggs)).toBe(12);
  });

  it("Mealie bookkeeping failure does not undo stock; it is retried later", async () => {
    stockUp();
    mealieFails = true;
    const v = await start("cook-000013", makePlan());
    expect(v.occurrence.status).toBe("completed");
    expect(v.occurrence.mealieSynced).toBe(false);
    mealieFails = false;
    const later = await resumeCooking(deps, v.occurrence.id);
    expect(later.occurrence.mealieSynced).toBe(true);
    expect(g.total(P.eggs)).toBe(10);
  });

  it("refuses a blocking plan", async () => {
    const plan = makePlan(); // nothing in stock → every line short
    await expect(start("cook-000014", plan)).rejects.toThrow(/unresolved/);
    expect(consumes()).toBe(0);
  });

  it("rejects a reused key with a different request", async () => {
    stockUp();
    await start("cook-000015", makePlan(4));
    await expect(startCooking(deps, { idempotencyKey: "cook-000015", requestHash: "other", mealplanEntryId: 101, servings: 2, leftoverServings: 0, plan: makePlan(2) })).rejects.toThrow(/different cooking request/);
  });
});

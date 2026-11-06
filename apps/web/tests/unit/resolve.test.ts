import { beforeEach, describe, expect, it } from "vitest";
import { resolveBarcode, type ResolveDeps } from "@/lib/barcode/resolve";
import { registerProduct, registerRequestSchema } from "@/lib/barcode/register";
import { openDatabase } from "@/lib/db";
import type { MealieFood } from "@/lib/mealie/schemas";
import { SqliteMetadataStore } from "@/lib/nutrition/metadata-store";
import { normalizeOffProduct, type OffLookup } from "@/lib/nutrition/off";
import type { FakeGrocy } from "../support/fake-grocy";
import { F, makeContext, makeGrocy, P, U } from "../support/kitchen";

let g: FakeGrocy;
let offResult: OffLookup;
let offCalls: number;
let deps: ResolveDeps;
let metadata: SqliteMetadataStore;
const foods = [
  { id: F.pasta, name: "Pasta" },
  { id: F.milk, name: "Milk" },
  { id: "food-pasta-sauce", name: "Pasta sauce" },
] as MealieFood[];

beforeEach(() => {
  g = makeGrocy();
  offCalls = 0;
  offResult = { status: "not_found" };
  metadata = new SqliteMetadataStore(openDatabase(":memory:"));
  deps = {
    grocy: g,
    mealie: { listFoods: async () => foods.map((f) => ({ ...f, aliases: [], substitutions: [], householdsWithIngredientFood: [] })) as MealieFood[] },
    off: {
      lookup: async () => {
        offCalls++;
        return offResult;
      },
    },
    metadata,
    ctx: async () => makeContext(g),
    today: () => "2026-10-21",
  };
});

describe("barcode resolution", () => {
  it("existing barcode: product, package and Mealie food via the parent product", async () => {
    const r = await resolveBarcode(deps, "076808280739");
    expect(r.status).toBe("known");
    if (r.status !== "known") return;
    expect(r.product.id).toBe(P.barilla);
    expect(r.package?.stockPerPackage).toBeCloseTo(453.5924, 4);
    expect(r.family).toMatchObject({ parentId: P.pasta, mealieFoodName: "Pasta" });
    expect(r.defaults.dueDate).toBe("2027-10-21");
    expect(offCalls).toBe(0);
  });

  it("matches an EAN-13 scan to a UPC-A registration", async () => {
    const r = await resolveBarcode(deps, "0076808280739");
    expect(r.status).toBe("known");
  });

  it("unknown barcode: Open Food Facts data plus ranked suggestions, flagged for confirmation", async () => {
    offResult = { status: "found", metadata: normalizeOffProduct("8076809513388", { product_name: "Penne Rigate pasta", brands: "Barilla", product_quantity: 454, product_quantity_unit: "g", categories_tags: ["en:pastas"] }) };
    const r = await resolveBarcode(deps, "8076809513388");
    expect(r.status).toBe("unknown");
    if (r.status !== "unknown") return;
    expect(r.off.status).toBe("found");
    expect(r.suggestions.foods[0].name).toBe("Pasta");
    expect(r.suggestions.foods[0].mappedProductId).toBe(P.pasta);
    expect(r.suggestions.products.some((p) => p.id === P.pasta && p.generic)).toBe(true);
    // A clear winner is pre-selected, but nothing is linked until the household confirms.
    expect(r.suggestions.ambiguous).toBe(false);
    expect(g.calls.filter((c) => c.op.startsWith("create"))).toHaveLength(0);
    // cached locally: a second lookup does not call Open Food Facts again
    await resolveBarcode(deps, "8076809513388");
    expect(offCalls).toBe(1);
  });

  it("no usable match is flagged ambiguous", async () => {
    offResult = { status: "found", metadata: normalizeOffProduct("1", { product_name: "Chicken" }) };
    deps.mealie = { listFoods: async () => [{ id: "a", name: "Chicken thighs" }, { id: "b", name: "Chicken breast" }].map((f) => ({ ...f, aliases: [], substitutions: [], householdsWithIngredientFood: [] })) as unknown as MealieFood[] };
    const r = await resolveBarcode(deps, "0000000000017");
    if (r.status === "unknown") expect(r.suggestions.ambiguous).toBe(true);
  });

  it("failed external lookup is reported as an error, not as 'unknown product data'", async () => {
    offResult = { status: "error", message: "Open Food Facts unreachable" };
    const r = await resolveBarcode(deps, "8076809513388");
    expect(r.status).toBe("unknown");
    if (r.status === "unknown") expect(r.off.status).toBe("error");
  });
});

describe("new product registration", () => {
  const regDeps = () => ({
    grocy: g,
    mealie: {
      getFood: async (id: string) => (foods.find((f) => f.id === id) as MealieFood) ?? null,
      createFood: async (name: string) => ({ id: `food-${name.toLowerCase()}`, name }) as MealieFood,
      listFoods: async () => [] as MealieFood[],
    },
    gms: { upsertProductMapping: async () => ({ synced: 1 }) },
    metadata,
    ctx: async () => makeContext(g),
  });

  it("registers a brand product under the mapped generic product with its package size", async () => {
    offResult = { status: "found", metadata: normalizeOffProduct("8076809513388", { product_name: "Penne", nutriments: { "energy-kcal_100g": 350 }, product_quantity_unit: "g" }) };
    await resolveBarcode(deps, "8076809513388"); // caches OFF data
    const r = await registerProduct(
      regDeps(),
      registerRequestSchema.parse({
        idempotencyKey: "reg-000001",
        barcode: "8076809513388",
        name: "Penne Rigate",
        brand: "Barilla",
        stockQuId: U.g,
        packageAmount: 454,
        packageQuId: U.g,
        locationId: 1,
        defaultBestBeforeDays: 365,
        link: { kind: "food", mealieFoodId: F.pasta },
      }),
    );
    expect(r).toMatchObject({ productName: "Barilla Penne Rigate", parent: { id: P.pasta, created: false }, mapping: "existing" });
    const created = g.products.get(r.productId)!;
    expect(created).toMatchObject({ parent_product_id: P.pasta, qu_id_stock: U.g, calories: 3.5 });
    expect(g.barcodes.find((b) => b.barcode === "8076809513388")).toMatchObject({ amount: 454, qu_id: U.g });
    expect(metadata.get("8076809513388", "openfoodfacts")).toMatchObject({ grocyProductId: r.productId, verification: "user_confirmed" });
    // future scans need no registration
    expect((await resolveBarcode(deps, "8076809513388")).status).toBe("known");
  });

  it("creates a generic parent and a mapping for a Mealie food that has none", async () => {
    const r = await registerProduct(
      regDeps(),
      registerRequestSchema.parse({
        idempotencyKey: "reg-000002",
        barcode: "0000000000017",
        name: "Basmati rice",
        stockQuId: U.g,
        packageAmount: 2000,
        packageQuId: U.g,
        locationId: 1,
        link: { kind: "new_food", foodName: "Rice" },
      }),
    );
    expect(r).toMatchObject({ mealieFood: { name: "Rice", created: true }, parent: { name: "Rice", created: true }, mapping: "created" });
    expect(g.products.get(r.parent!.id)).toMatchObject({ no_own_stock: 1 });
  });

  it("refuses a barcode that is already registered (no silent re-linking)", async () => {
    await expect(
      registerProduct(regDeps(), registerRequestSchema.parse({ idempotencyKey: "reg-000003", barcode: "076808280739", name: "x", stockQuId: U.g, packageAmount: 1, packageQuId: U.g, locationId: 1, link: { kind: "none" } })),
    ).rejects.toThrow(/already registered/);
  });
});

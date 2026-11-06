import { describe, expect, it } from "vitest";
import { caloriesPerStockUnit, normalizeOffProduct, OpenFoodFactsClient, parsePackage } from "@/lib/nutrition/off";

const pastaOff = {
  product_name: "Spaghetti n.5",
  brands: "Barilla,Barilla Group",
  quantity: "16 oz (454 g)",
  product_quantity: "454",
  product_quantity_unit: "g",
  serving_size: "56 g",
  serving_quantity: "56",
  nutrition_data_per: "100g",
  nutriments: { "energy-kcal_100g": 359, proteins_100g: 13, carbohydrates_100g: 71, fat_100g: 2, "energy-kcal_serving": 200, sodium_100g: 0 },
  ingredients_text_en: "Semolina (wheat), durum wheat flour",
  allergens_tags: ["en:gluten"],
  categories_tags: ["en:pastas", "en:spaghetti"],
};

describe("Open Food Facts normalisation", () => {
  it("keeps the nutrition basis and never fills in missing values", () => {
    const m = normalizeOffProduct("076808280739", pastaOff);
    expect(m.name).toBe("Spaghetti n.5");
    expect(m.brand).toBe("Barilla");
    expect(m.packageAmount).toBe(454);
    expect(m.packageUnit).toBe("g");
    expect(m.nutrition?.basis).toBe("per_100g");
    expect(m.nutrition?.basisSource).toBe("off_field");
    expect(m.nutrition?.per100).toMatchObject({ energyKcal: 359, protein: 13, sodium: 0 });
    expect(m.nutrition?.per100.fiber).toBeNull(); // absent upstream → null, not 0
    expect(m.nutrition?.perServing.energyKcal).toBe(200);
    expect(m.allergens).toEqual(["gluten"]);
    expect(m.categories).toContain("spaghetti");
  });

  it("infers per-100 mL for liquids and records that it was inferred", () => {
    const m = normalizeOffProduct("1", { product_name: "Milk", quantity: "1 gal", nutriments: { "energy-kcal_100g": 61 } });
    expect(m.nutrition).toMatchObject({ basis: "per_100ml", basisSource: "inferred_from_package" });
  });

  it("returns null nutrition when OFF has none", () => {
    expect(normalizeOffProduct("1", { product_name: "X" }).nutrition).toBeNull();
  });

  it("parses package sizes without guessing", () => {
    expect(parsePackage({ quantity: "6 x 150 g" })).toEqual({ amount: 900, unit: "g", count: 6 });
    expect(parsePackage({ quantity: "12 eggs" })).toEqual({ amount: 12, unit: "piece", count: 12 });
    expect(parsePackage({ quantity: "1 gal" })).toEqual({ amount: 1, unit: "gallon", count: null });
    expect(parsePackage({ quantity: "family size" })).toEqual({ amount: null, unit: null, count: null });
  });

  it("only fills Grocy calories when exact (per-100 g data and a mass stock unit)", () => {
    const m = normalizeOffProduct("x", pastaOff);
    expect(caloriesPerStockUnit(m, "g")).toBe(3.59);
    expect(caloriesPerStockUnit(m, "kg")).toBe(3590);
    expect(caloriesPerStockUnit(m, "Piece")).toBeNull();
    expect(caloriesPerStockUnit(m, "mL")).toBeNull();
  });
});

describe("Open Food Facts client", () => {
  const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("found / not found / failed lookups are distinct", async () => {
    const found = new OpenFoodFactsClient("https://off.test", "test", json({ status: 1, product: pastaOff }));
    expect((await found.lookup("076808280739")).status).toBe("found");
    const missing = new OpenFoodFactsClient("https://off.test", "test", json({ status: 0 }, 404));
    expect((await missing.lookup("1")).status).toBe("not_found");
    const zero = new OpenFoodFactsClient("https://off.test", "test", json({ status: 0, status_verbose: "product not found" }));
    expect((await zero.lookup("1")).status).toBe("not_found");
    const down = new OpenFoodFactsClient("https://off.test", "test", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await down.lookup("1")).status).toBe("error");
    const busy = new OpenFoodFactsClient("https://off.test", "test", json({ error: "rate limited" }, 503));
    expect((await busy.lookup("1")).status).toBe("error");
  });

  it("identifies itself with the configured User-Agent", async () => {
    let ua: string | null = null;
    const c = new OpenFoodFactsClient("https://off.test", "HouseholdHub/test (me@example.com)", async (_u, init) => {
      ua = new Headers(init?.headers).get("User-Agent");
      return new Response(JSON.stringify({ status: 0 }));
    });
    await c.lookup("1");
    expect(ua).toBe("HouseholdHub/test (me@example.com)");
  });
});

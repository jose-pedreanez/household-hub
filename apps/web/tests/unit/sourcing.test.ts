import { describe, expect, it } from "vitest";
import { retailerConfigSchema } from "@/lib/config";
import { ManualRetailerAdapter } from "@/lib/retailers/adapters";
import { packagesFor, selectSources, type Need } from "@/lib/retailers/sourcing";
import type { AvailabilityResult } from "@/lib/retailers/types";

const cfg = retailerConfigSchema.parse({
  retailers: [
    { id: "trader_joes", name: "Trader Joe's (Alameda)" },
    { id: "grocery_outlet", name: "Grocery Outlet (Alameda)" },
    { id: "amazon_fresh", name: "Amazon Fresh", searchUrlTemplate: "https://www.amazon.com/s?k={query}&i=amazonfresh" },
  ],
  defaults: { preferredRetailer: "trader_joes" },
  products: [
    {
      food: "Milk",
      preferred: { retailer: "trader_joes", product: "TJ milk", packageSize: { amount: 0.5, unit: "gallon" }, price: 3.99 },
      backups: [{ retailer: "amazon_fresh", product: "Fresh milk", packageSize: { amount: 0.5, unit: "gallon" } }],
      substitutions: [{ food: "Oat milk", requiresApproval: true }],
    },
    { food: "Pasta", preferred: { retailer: "grocery_outlet", product: "GO pasta", packageSize: { amount: 1, unit: "lb" } }, backups: [{ retailer: "trader_joes", product: "TJ pasta", packageSize: { amount: 1, unit: "lb" } }] },
    { food: "Eggs", preferred: { retailer: "trader_joes", product: "Dozen", packageSize: { amount: 12, unit: "piece" } } },
    { food: "Caviar", preferred: { retailer: "amazon_fresh", product: "Caviar", price: 90, maxPrice: 50 } },
  ],
});

const need = (foodName: string, amount: number, unitName: string): Need => ({ key: `food:${foodName}`, foodName, amount, unitName, source: "plan" });
const unknown = () => undefined;

describe("source selection", () => {
  it("rounds needs up to whole packages when units are compatible", () => {
    expect(packagesFor(2500, "mL", { amount: 0.5, unit: "gallon" })).toBe(2);
    expect(packagesFor(13, "Pieces", { amount: 12, unit: "piece" })).toBe(2);
    expect(packagesFor(100, "g", { amount: 0.5, unit: "gallon" })).toBeNull();
  });

  it("uses the preferred product while availability is merely unknown", () => {
    const [milk] = selectSources([need("Milk", 1500, "mL")], cfg, unknown);
    expect(milk).toMatchObject({ retailerId: "trader_joes", product: "TJ milk", packages: 1, availability: "unknown", estimatedCost: 3.99 });
  });

  it("only a verified out-of-stock moves an item to its backup; an API failure does not", () => {
    const oos = (r: string): AvailabilityResult | undefined => (r === "trader_joes" ? { status: "out_of_stock", reason: "verified", checkedAt: "" } : undefined);
    expect(selectSources([need("Milk", 1000, "mL")], cfg, oos)[0].retailerId).toBe("amazon_fresh");
    const failed = (): AvailabilityResult => ({ status: "unknown", reason: "lookup failed: 503", checkedAt: "" });
    expect(selectSources([need("Milk", 1000, "mL")], cfg, failed)[0].retailerId).toBe("trader_joes");
  });

  it("never selects a substitution that needs approval; it is surfaced instead", () => {
    const oosEverywhere = (): AvailabilityResult => ({ status: "out_of_stock", reason: "verified", checkedAt: "" });
    const [milk] = selectSources([need("Milk", 1000, "mL")], cfg, oosEverywhere);
    expect(milk.product).toBeNull();
    expect(milk.pendingApprovals).toEqual([{ food: "Oat milk", retailerId: null }]);
  });

  it("respects maximum prices", () => {
    const [caviar] = selectSources([need("Caviar", 1, "Piece")], cfg, unknown);
    expect(caviar.product).toBeNull();
    expect(caviar.reasons.join(" ")).toMatch(/limit/);
  });

  it("consolidates a lone item into a store already being visited", () => {
    const items = selectSources([need("Pasta", 400, "g"), need("Milk", 1000, "mL"), need("Eggs", 6, "Pieces")], cfg, unknown);
    const pasta = items.find((i) => i.foodName === "Pasta")!;
    expect(pasta.retailerId).toBe("trader_joes");
    expect(pasta.reasons.join(" ")).toMatch(/combine trips/);
  });

  it("items without rules go to the default store", () => {
    expect(selectSources([need("Basil", 1, "bunch")], cfg, unknown)[0].retailerId).toBe("trader_joes");
  });
});

describe("manual retailer adapter", () => {
  it("never claims availability and produces a shareable list", async () => {
    const a = new ManualRetailerAdapter(cfg.retailers[2], cfg);
    expect((await a.getAvailability()).status).toBe("unknown");
    const list = await a.createShoppingList([{ name: "Milk", quantity: 1, unit: null, display: "1 × 0.5 gallon", note: null, upc: null }], "Amazon Fresh");
    expect(list.kind).toBe("manual");
    if (list.kind === "manual") {
      expect(list.text).toContain("[ ] 1 × 0.5 gallon Milk");
      expect(list.links[0].url).toBe("https://www.amazon.com/s?k=Milk&i=amazonfresh");
    }
    expect(a.capabilities.cart).toBe(false);
  });
});

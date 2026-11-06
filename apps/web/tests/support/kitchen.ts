import type { ResolvedConversion } from "@/lib/grocy/schemas";
import type { MealieIngredient, MealieRecipe } from "@/lib/mealie/schemas";
import type { ProductMapping, UnitMapping } from "@/lib/sync/gms-client";
import { buildMappingContext, type MappingContext } from "@/lib/sync/mappings";
import { FakeGrocy } from "./fake-grocy";

/** Units (Grocy ids) used across tests. */
export const U = { g: 1, kg: 2, ml: 3, l: 4, piece: 5, pack: 6, lb: 7, gallon: 8, cup: 9, tbsp: 10 } as const;
/** Products (Grocy ids). */
export const P = {
  pasta: 10, // generic, no own stock, mapped to Mealie "Pasta"
  barilla: 11, // brand sub-product, 1 lb box, stocked in g
  tjPasta: 12, // brand sub-product, 500 g bag, stocked in g
  milk: 20, // stocked in mL, 946 mL carton
  eggs: 30, // stocked in pieces, dozen
  chicken: 40, // stocked in g, edible yield 0.8
  yogurt: 50, // stocked in pieces, 6-pack
  flour: 60, // stocked in g, 1 cup = 120 g (product-specific)
  oatMilk: 70, // substitute for milk
} as const;
export const F = { pasta: "food-pasta", milk: "food-milk", egg: "food-egg", chicken: "food-chicken", flour: "food-flour", oatMilk: "food-oat-milk", salt: "food-salt" } as const;
export const MU = { gram: "mu-gram", cup: "mu-cup", pound: "mu-pound", tbsp: "mu-tbsp" } as const;

export function makeGrocy(): FakeGrocy {
  const g = new FakeGrocy()
    .unit(U.g, "g", "g")
    .unit(U.kg, "kg", "kg")
    .unit(U.ml, "mL", "mL")
    .unit(U.l, "L", "L")
    .unit(U.piece, "Piece", "Pieces")
    .unit(U.pack, "Pack", "Packs")
    .unit(U.lb, "lb", "lb")
    .unit(U.gallon, "gallon", "gallons")
    .unit(U.cup, "cup", "cups")
    .unit(U.tbsp, "tbsp", "tbsp");
  g.product({ id: P.pasta, name: "Pasta", qu_id_stock: U.g, no_own_stock: true })
    .product({ id: P.barilla, name: "Barilla Spaghetti 1 lb", qu_id_stock: U.g, parent_product_id: P.pasta, default_best_before_days: 365 })
    .product({ id: P.tjPasta, name: "Trader Joe's Penne 500 g", qu_id_stock: U.g, parent_product_id: P.pasta, default_best_before_days: 365 })
    .product({ id: P.milk, name: "Milk", qu_id_stock: U.ml, default_best_before_days: 7 })
    .product({ id: P.eggs, name: "Eggs", qu_id_stock: U.piece, default_best_before_days: 21 })
    .product({ id: P.chicken, name: "Chicken thighs", qu_id_stock: U.g, default_best_before_days: 3 })
    .product({ id: P.yogurt, name: "Yogurt cups", qu_id_stock: U.piece, qu_id_purchase: U.pack })
    .product({ id: P.flour, name: "Flour", qu_id_stock: U.g, default_best_before_days: -1 })
    .product({ id: P.oatMilk, name: "Oat milk", qu_id_stock: U.ml });
  g.barcode(P.barilla, "076808280739", 1, U.lb) // 1 lb box (UPC-A)
    .barcode(P.tjPasta, "00512345", 500, U.g) // 500 g
    .barcode(P.tjPasta, "4006381333931", 1000, U.g) // same pasta, 1 kg bag
    .barcode(P.milk, "0070038000563", 946, U.ml)
    .barcode(P.eggs, "0012345678905", 12, U.piece)
    .barcode(P.yogurt, "0036632036935", 1, U.pack); // 1 pack = 6 pieces (product conversion)
  return g;
}

export const CONVERSIONS: ResolvedConversion[] = [
  { product_id: null, from_qu_id: U.kg, to_qu_id: U.g, factor: 1000 },
  { product_id: null, from_qu_id: U.l, to_qu_id: U.ml, factor: 1000 },
  { product_id: null, from_qu_id: U.cup, to_qu_id: U.ml, factor: 236.5882365 },
  { product_id: null, from_qu_id: U.tbsp, to_qu_id: U.ml, factor: 14.78676478125 },
  { product_id: P.yogurt, from_qu_id: U.pack, to_qu_id: U.piece, factor: 6 },
  { product_id: P.flour, from_qu_id: U.cup, to_qu_id: U.g, factor: 120 },
] as ResolvedConversion[];

export const PRODUCT_MAPPINGS: ProductMapping[] = [
  { id: "m1", mealieFoodId: F.pasta, mealieFoodName: "Pasta", grocyProductId: P.pasta, grocyProductName: "Pasta" },
  { id: "m2", mealieFoodId: F.milk, mealieFoodName: "Milk", grocyProductId: P.milk, grocyProductName: "Milk" },
  { id: "m3", mealieFoodId: F.egg, mealieFoodName: "Egg", grocyProductId: P.eggs, grocyProductName: "Eggs" },
  { id: "m4", mealieFoodId: F.chicken, mealieFoodName: "Chicken thighs", grocyProductId: P.chicken, grocyProductName: "Chicken thighs" },
  { id: "m5", mealieFoodId: F.flour, mealieFoodName: "Flour", grocyProductId: P.flour, grocyProductName: "Flour" },
  { id: "m6", mealieFoodId: F.oatMilk, mealieFoodName: "Oat milk", grocyProductId: P.oatMilk, grocyProductName: "Oat milk" },
];

export const UNIT_MAPPINGS: UnitMapping[] = [
  { id: "u1", mealieUnitId: MU.gram, mealieUnitName: "gram", mealieUnitAbbreviation: "g", grocyUnitId: U.g, grocyUnitName: "g", conversionFactor: 1 },
  { id: "u2", mealieUnitId: MU.cup, mealieUnitName: "cup", mealieUnitAbbreviation: "c", grocyUnitId: U.cup, grocyUnitName: "cup", conversionFactor: 1 },
  { id: "u3", mealieUnitId: MU.pound, mealieUnitName: "pound", mealieUnitAbbreviation: "lb", grocyUnitId: U.lb, grocyUnitName: "lb", conversionFactor: 1 },
  { id: "u4", mealieUnitId: MU.tbsp, mealieUnitName: "tablespoon", mealieUnitAbbreviation: "tbsp", grocyUnitId: U.tbsp, grocyUnitName: "tbsp", conversionFactor: 1 },
];

export function makeContext(g: FakeGrocy, opts: { mappings?: ProductMapping[]; mappingsAvailable?: boolean } = {}): MappingContext {
  return buildMappingContext([...g.products.values()], g.units, CONVERSIONS, opts.mappings ?? PRODUCT_MAPPINGS, UNIT_MAPPINGS, opts.mappingsAvailable ?? true);
}

export function ing(
  food: { id: string; name: string; substitutions?: MealieIngredient["substitutions"] } | null,
  quantity: number | null,
  unit: { id: string; name: string } | null,
  extra: Partial<MealieIngredient> = {},
): MealieIngredient {
  return {
    quantity,
    unit: unit ? { id: unit.id, name: unit.name, pluralName: null, abbreviation: null, standardQuantity: null, standardUnit: null } : null,
    food: food ? { id: food.id, name: food.name, pluralName: null, description: null, labelId: null, aliases: [], substitutions: food.substitutions ?? [], householdsWithIngredientFood: [] } : null,
    note: null,
    display: `${quantity ?? ""} ${unit?.name ?? ""} ${food?.name ?? ""}`.trim(),
    title: null,
    originalText: null,
    referenceId: `ref-${food?.id ?? "none"}-${quantity}`,
    substitutions: [],
    ...extra,
  } as MealieIngredient;
}

export function recipe(name: string, servings: number, ingredients: MealieIngredient[]): MealieRecipe {
  return {
    id: `recipe-${name.toLowerCase().replace(/\W+/g, "-")}`,
    slug: name.toLowerCase().replace(/\W+/g, "-"),
    name,
    description: null,
    recipeServings: servings,
    recipeYieldQuantity: 0,
    recipeYield: null,
    totalTime: null,
    prepTime: null,
    performTime: null,
    rating: null,
    lastMade: null,
    tags: [],
    recipeCategory: [],
    tools: [],
    recipeIngredient: ingredients,
  } as unknown as MealieRecipe;
}

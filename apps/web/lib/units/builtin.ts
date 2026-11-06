/**
 * Exact physical unit definitions, used only when Grocy has no conversion between two units.
 *
 * Only same-dimension conversions are defined (mass↔mass, volume↔volume). Mass↔volume needs a
 * product density and must come from a product-specific Grocy conversion, never from here.
 * US customary volumes are used (this household is in California).
 */

export type Dimension = "mass" | "volume";

interface UnitDef {
  dimension: Dimension;
  /** Size of one unit in the dimension's base unit (grams or millilitres). */
  toBase: number;
}

const DEFS: Record<string, UnitDef> = {
  mg: { dimension: "mass", toBase: 0.001 },
  g: { dimension: "mass", toBase: 1 },
  kg: { dimension: "mass", toBase: 1000 },
  oz: { dimension: "mass", toBase: 28.349523125 },
  lb: { dimension: "mass", toBase: 453.59237 },
  ml: { dimension: "volume", toBase: 1 },
  cl: { dimension: "volume", toBase: 10 },
  dl: { dimension: "volume", toBase: 100 },
  l: { dimension: "volume", toBase: 1000 },
  tsp: { dimension: "volume", toBase: 4.92892159375 },
  tbsp: { dimension: "volume", toBase: 14.78676478125 },
  floz: { dimension: "volume", toBase: 29.5735295625 },
  cup: { dimension: "volume", toBase: 236.5882365 },
  pint: { dimension: "volume", toBase: 473.176473 },
  quart: { dimension: "volume", toBase: 946.352946 },
  gallon: { dimension: "volume", toBase: 3785.411784 },
};

const ALIASES: Record<string, string> = {
  milligram: "mg", milligrams: "mg",
  gram: "g", grams: "g", gr: "g", grs: "g",
  kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg", kgs: "kg",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lbs: "lb",
  milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml", mls: "ml",
  centiliter: "cl", centiliters: "cl",
  deciliter: "dl", deciliters: "dl",
  liter: "l", liters: "l", litre: "l", litres: "l", ltr: "l",
  teaspoon: "tsp", teaspoons: "tsp", tsps: "tsp", t: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp", tbsps: "tbsp", tbs: "tbsp", tbl: "tbsp",
  "fluid ounce": "floz", "fluid ounces": "floz", "fl oz": "floz", "fl. oz": "floz", "fl.oz": "floz",
  cups: "cup", c: "cup",
  pints: "pint", pt: "pint",
  quarts: "quart", qt: "quart",
  gallons: "gallon", gal: "gallon",
};

/** Count-like units: a unitless recipe line ("2 eggs") can be read in these. */
const COUNT_UNITS = new Set([
  "piece", "pieces", "pc", "pcs", "each", "ea", "unit", "units", "item", "items", "count", "ct", "whole",
]);

export function canonicalUnit(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
  if (n in DEFS) return n;
  return ALIASES[n] ?? null;
}

export function isCountUnitName(name: string | null | undefined): boolean {
  if (!name) return false;
  return COUNT_UNITS.has(name.trim().toLowerCase());
}

export function unitDimension(name: string | null | undefined): Dimension | null {
  const c = canonicalUnit(name);
  return c ? DEFS[c].dimension : null;
}

/** Factor such that 1 `from` = factor `to`, or null if the units are unknown or of different dimensions. */
export function builtinFactor(fromName: string | null | undefined, toName: string | null | undefined): number | null {
  const a = canonicalUnit(fromName);
  const b = canonicalUnit(toName);
  if (!a || !b) return null;
  if (DEFS[a].dimension !== DEFS[b].dimension) return null;
  return DEFS[a].toBase / DEFS[b].toBase;
}

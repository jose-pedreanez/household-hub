import type { RetailerConfig, RetailerSource } from "../config";
import { builtinFactor, isCountUnitName } from "../units/builtin";
import type { AvailabilityResult, AvailabilityStatus } from "./types";

/**
 * Deterministic store selection for each grocery need, in priority order:
 *   1. usable inventory (already subtracted before an item becomes a need),
 *   2. the household's preferred product,
 *   3. verified availability (only a *verified* out-of-stock demotes a source; unknown never does),
 *   4. backups, then substitutions — substitutions needing approval are offered, never chosen,
 *   5. price and package size when known (maxPrice is a hard limit),
 *   6. trip consolidation: a lone item moves to a store already being visited if it has a valid source there.
 */

export interface Need {
  key: string;
  foodName: string;
  amount: number;
  unitName: string;
  source: "plan" | "low_stock" | "adhoc";
}

export interface SourcedItem {
  key: string;
  foodName: string;
  retailerId: string;
  retailerName: string;
  product: string | null;
  packages: number | null;
  packageSize: { amount: number; unit: string } | null;
  display: string;
  estimatedCost: number | null;
  availability: AvailabilityStatus;
  reasons: string[];
  pendingApprovals: Array<{ food: string; retailerId: string | null }>;
  need: Need;
}

export type AvailabilityLookup = (retailerId: string, product: string) => AvailabilityResult | undefined;

export function packagesFor(amount: number, unitName: string, size: { amount: number; unit: string }): number | null {
  let inPackageUnit: number | null = null;
  if (isCountUnitName(size.unit) || size.unit === "piece") {
    if (isCountUnitName(unitName) || /^(piece|pieces|egg|eggs)$/i.test(unitName)) inPackageUnit = amount;
  } else {
    const f = builtinFactor(unitName, size.unit);
    if (f !== null) inPackageUnit = amount * f;
  }
  if (inPackageUnit === null || !(size.amount > 0)) return null;
  return Math.max(1, Math.ceil(inPackageUnit / size.amount - 1e-9));
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

export function selectSources(needs: Need[], cfg: RetailerConfig, availability: AvailabilityLookup): SourcedItem[] {
  const retailerName = (id: string) => cfg.retailers.find((r) => r.id === id)?.name ?? id;
  const defaultRetailer = cfg.defaults.preferredRetailer ?? cfg.retailers[0].id;
  const rules = new Map(cfg.products.map((r) => [r.food.trim().toLowerCase(), r]));

  const items: Array<SourcedItem & { alternatives: RetailerSource[] }> = [];
  for (const need of [...needs].sort((a, b) => a.foodName.localeCompare(b.foodName) || a.key.localeCompare(b.key))) {
    const rule = rules.get(need.foodName.trim().toLowerCase());
    const reasons: string[] = [];
    const pendingApprovals: SourcedItem["pendingApprovals"] = [];
    const sources = rule ? [rule.preferred, ...rule.backups].filter((s): s is RetailerSource => !!s) : [];

    let chosen: RetailerSource | null = null;
    let chosenAvailability: AvailabilityStatus = "unknown";
    for (const [i, src] of sources.entries()) {
      const label = i === 0 && rule?.preferred === src ? "preferred" : "backup";
      const avail = availability(src.retailer, src.product);
      if (avail?.status === "out_of_stock") {
        reasons.push(`${label} ${src.product} at ${retailerName(src.retailer)} is out of stock (verified)`);
        continue;
      }
      if (src.maxPrice !== undefined && src.price !== undefined && src.price > src.maxPrice) {
        reasons.push(`${label} ${src.product} costs more than the ${fmt(src.maxPrice)} limit`);
        continue;
      }
      chosen = src;
      chosenAvailability = avail?.status ?? "unknown";
      reasons.push(`${label} product${chosenAvailability === "unknown" ? "; availability unknown" : ""}`);
      break;
    }

    for (const sub of rule?.substitutions ?? []) {
      const requiresApproval = sub.requiresApproval || cfg.defaults.substitutionsRequireApproval;
      if (requiresApproval) pendingApprovals.push({ food: sub.food, retailerId: null });
    }

    const retailerId = chosen?.retailer ?? defaultRetailer;
    if (!chosen) reasons.push(rule ? "no usable product rule; default store" : "no product rule; default store");
    const packages = chosen?.packageSize ? packagesFor(need.amount, need.unitName, chosen.packageSize) : null;
    const display =
      packages !== null && chosen?.packageSize
        ? `${packages} × ${fmt(chosen.packageSize.amount)} ${chosen.packageSize.unit}`
        : `${fmt(need.amount)} ${need.unitName}`;
    items.push({
      key: need.key,
      foodName: need.foodName,
      retailerId,
      retailerName: retailerName(retailerId),
      product: chosen?.product ?? null,
      packages,
      packageSize: chosen?.packageSize ?? null,
      display,
      estimatedCost: packages !== null && chosen?.price !== undefined ? Math.round(packages * chosen.price * 100) / 100 : null,
      availability: chosenAvailability,
      reasons,
      pendingApprovals,
      need,
      alternatives: sources.filter((s) => s !== chosen),
    });
  }

  // Trip consolidation: move items that are alone at a store to a store already being visited.
  const counts = () => {
    const c = new Map<string, number>();
    for (const it of items) c.set(it.retailerId, (c.get(it.retailerId) ?? 0) + 1);
    return c;
  };
  for (const it of items) {
    const c = counts();
    if ((c.get(it.retailerId) ?? 0) !== 1) continue;
    const alt = it.alternatives.find((s) => {
      if ((c.get(s.retailer) ?? 0) < 1 || s.retailer === it.retailerId) return false;
      if (availability(s.retailer, s.product)?.status === "out_of_stock") return false;
      return !(s.maxPrice !== undefined && s.price !== undefined && s.price > s.maxPrice);
    });
    if (!alt) continue;
    const packages = alt.packageSize ? packagesFor(it.need.amount, it.need.unitName, alt.packageSize) : null;
    it.reasons.push(`moved from ${it.retailerName} to combine trips`);
    it.retailerId = alt.retailer;
    it.retailerName = retailerName(alt.retailer);
    it.product = alt.product;
    it.packageSize = alt.packageSize ?? null;
    it.packages = packages;
    it.display = packages !== null && alt.packageSize ? `${packages} × ${fmt(alt.packageSize.amount)} ${alt.packageSize.unit}` : `${fmt(it.need.amount)} ${it.need.unitName}`;
    it.estimatedCost = packages !== null && alt.price !== undefined ? Math.round(packages * alt.price * 100) / 100 : null;
    it.availability = availability(alt.retailer, alt.product)?.status ?? "unknown";
  }

  return items.map(({ alternatives: _alternatives, ...rest }) => rest);
}

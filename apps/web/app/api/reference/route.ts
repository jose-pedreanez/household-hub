import { route } from "@/lib/api";
import { householdConfig, retailerConfig } from "@/lib/config";
import { services } from "@/lib/services";

/** Small lookup tables the UI needs (locations, units, stores, groups, retailers, meal slots). */
export const GET = route(async () => {
  const { grocy } = services();
  const [locations, units, stores, groups] = await Promise.all([
    grocy.listLocations(),
    grocy.listQuantityUnits(),
    grocy.listShoppingLocations(),
    grocy.listProductGroups(),
  ]);
  const h = householdConfig().config;
  const r = retailerConfig().config;
  return {
    locations: locations.map((l) => ({ id: l.id, name: l.name, isFreezer: !!l.is_freezer })),
    units: units.map((u) => ({ id: u.id, name: u.name, plural: u.name_plural })),
    stores: stores.map((s) => ({ id: s.id, name: s.name })),
    productGroups: groups.map((g) => ({ id: g.id, name: g.name })),
    retailers: r.retailers.map((x) => ({ id: x.id, name: x.name, adapter: x.adapter, grocyStore: x.grocyStore ?? null })),
    defaultRetailer: r.defaults.preferredRetailer ?? r.retailers[0].id,
    meals: { slots: h.meals.slots, plannerSlots: h.meals.plannerSlots, defaultServings: h.household.defaultServings, showNutrition: h.meals.showNutrition },
    cooking: h.cooking,
  };
});

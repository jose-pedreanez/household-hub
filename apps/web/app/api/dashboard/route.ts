import { route, today } from "@/lib/api";
import { listNotifications } from "@/lib/alerts";
import { householdConfig } from "@/lib/config";
import { mappingContext } from "@/lib/context";
import { buildInventory } from "@/lib/inventory/overview";
import { addDays, listMeals, weekStart } from "@/lib/meals/service";
import { services } from "@/lib/services";
import { storeListViews } from "@/lib/shopping/service";

export const GET = route(async () => {
  const { grocy, db } = services();
  const cfg = householdConfig().config;
  const t = today();
  const start = weekStart(t);
  const [meals, stock, volatile, locations, ctx, lists] = await Promise.all([
    listMeals(start, addDays(start, 6)),
    grocy.currentStock(),
    grocy.volatileStock(cfg.inventory.expiringSoonDays),
    grocy.listLocations(),
    mappingContext(),
    storeListViews().catch(() => null),
  ]);
  const items = buildInventory(stock, [], locations, volatile, ctx, t, cfg.inventory.expiringSoonDays);
  return {
    today: t,
    tonight: meals.filter((m) => m.date === t && m.entryType === "dinner"),
    week: meals,
    expiring: items.filter((i) => ["expired", "overdue", "due_soon"].includes(i.dueStatus)).sort((a, b) => (a.nextDue ?? "").localeCompare(b.nextDue ?? "")),
    lowStock: volatile.missing_products.map((m) => ({
      productId: m.product_id,
      name: ctx.products.get(m.product_id)?.name ?? m.name ?? `#${m.product_id}`,
      missing: m.amount_missing ?? null,
    })),
    groceries: lists
      ? lists.stores.map((s) => ({ retailerId: s.retailerId, name: s.name, open: s.items.filter((i) => !i.checked).length }))
      : [],
    notifications: listNotifications(db, 5),
  };
});

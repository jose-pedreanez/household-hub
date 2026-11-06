import { z } from "zod";
import { query, route, today } from "@/lib/api";
import { householdConfig } from "@/lib/config";
import { mappingContext } from "@/lib/context";
import { buildInventory, stockLocations } from "@/lib/inventory/overview";
import { services } from "@/lib/services";

const q = z.object({
  q: z.string().optional(),
  location: z.coerce.number().int().optional(),
  status: z.enum(["expiring", "low", "all"]).default("all"),
});

export const GET = route(async (req) => {
  const { q: text, location, status } = query(req, q);
  const { grocy } = services();
  const cfg = householdConfig().config;
  const [stock, locs, allLocations, volatile, ctx] = await Promise.all([
    grocy.currentStock(),
    stockLocations(grocy),
    grocy.listLocations(),
    grocy.volatileStock(cfg.inventory.expiringSoonDays),
    mappingContext(),
  ]);
  let items = buildInventory(stock, locs, allLocations, volatile, ctx, today(), cfg.inventory.expiringSoonDays);
  if (text) {
    const t = text.toLowerCase();
    items = items.filter((i) => i.name.toLowerCase().includes(t) || i.parentName?.toLowerCase().includes(t) || i.mealieFoodName?.toLowerCase().includes(t));
  }
  if (location) items = items.filter((i) => i.locations.some((l) => l.id === location));
  if (status === "expiring") items = items.filter((i) => ["expired", "overdue", "due_soon"].includes(i.dueStatus));
  if (status === "low") items = items.filter((i) => i.belowMin);
  return { items, locations: allLocations.map((l) => ({ id: l.id, name: l.name })) };
});

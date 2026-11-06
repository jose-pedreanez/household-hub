import { audit, route, today } from "@/lib/api";
import { notify } from "@/lib/alerts";
import { addDays } from "@/lib/meals/service";
import { services } from "@/lib/services";
import { generateStoreLists } from "@/lib/shopping/service";

/** Shopping preparation for n8n: rebuild store lists for the next 7 days and notify. */
export const POST = route(async (_req, { actor }) => {
  const start = today();
  const end = addDays(start, 6);
  const r = await generateStoreLists(start, end);
  const byStore = new Map<string, number>();
  for (const i of r.items) byStore.set(i.retailerName, (byStore.get(i.retailerName) ?? 0) + 1);
  const lines = [...byStore.entries()].map(([s, n]) => `${s}: ${n} item${n > 1 ? "s" : ""}`);
  const changed = r.created + r.updated + r.removed > 0;
  const message = r.items.length
    ? `Shopping lists updated for ${start} – ${end}\n${lines.join("\n")}` + (r.unresolved.length ? `\nNot checked: ${r.unresolved.map((u) => u.foodName ?? u.display).join(", ")}` : "")
    : "";
  if (changed && message) notify(services().db, { kind: "shopping", title: "Shopping lists updated", body: message, link: "/shopping" });
  audit(actor, "automation.shopping", { items: r.items.length, created: r.created, updated: r.updated, removed: r.removed });
  return { items: r.items.length, created: r.created, updated: r.updated, removed: r.removed, changed, message: changed ? message : "" };
});

import { auditCandidates, filterNewAlerts } from "@/lib/alerts";
import { route } from "@/lib/api";
import { services } from "@/lib/services";

/** Items worth a physical check (opened, perishable, past date). Prompts at most weekly. For n8n. */
export const POST = route(async () => {
  const items = await auditCandidates();
  const body = items.slice(0, 25).map((i) => `${i.name}: ${i.amount} ${i.unit} (${i.reasons.join(", ")})`).join("\n");
  const { send } = items.length
    ? filterNewAlerts(services().db, [{ kind: "due_soon", dedupeKey: "audit:weekly", title: `Quick inventory check (${items.length} items)`, body, link: "/inventory?audit=1" }], 24 * 6)
    : { send: [] };
  return { items, notified: send.length > 0, message: send.length ? `${send[0].title}\n${body}` : "" };
});

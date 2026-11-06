import { audit, route } from "@/lib/api";
import { currentAlerts, filterNewAlerts } from "@/lib/alerts";
import { householdConfig } from "@/lib/config";
import { services } from "@/lib/services";

/** Low-stock and expiry alerts that are new or due for a reminder (deduplicated). For n8n. */
export const POST = route(async (_req, { actor }) => {
  const alerts = await currentAlerts();
  const { send, suppressed } = filterNewAlerts(services().db, alerts, householdConfig().config.alerts.repeatAfterHours);
  audit(actor, "automation.alerts", { total: alerts.length, sent: send.length, suppressed });
  return {
    send,
    suppressed,
    message: send.map((a) => `${a.title}\n${a.body}`).join("\n\n"),
  };
});

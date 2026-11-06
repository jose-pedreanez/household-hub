import { route } from "@/lib/api";
import { aiProvider } from "@/lib/ai";
import { householdConfig, retailerConfig } from "@/lib/config";
import { env } from "@/lib/env";
import { services } from "@/lib/services";

/** Non-secret configuration summary for the settings/diagnostics screen. Never returns credentials. */
export const GET = route(async () => {
  const e = env();
  const ai = aiProvider();
  const gms = await services().gms.status().catch((err: Error) => ({ error: err.message }));
  const h = householdConfig();
  const r = retailerConfig();
  return {
    ai: { configured: ai.configured, model: ai.provider?.model ?? null, problem: ai.problem },
    instacart: { enabled: !!e.INSTACART_API_KEY, environment: e.INSTACART_ENV },
    mealieNeedsListConfigured: !!e.MEALIE_NEEDS_LIST_ID,
    mealieUrl: e.MEALIE_PUBLIC_URL,
    config: { household: { file: h.file, isExample: h.isExample }, retailers: { file: r.file, isExample: r.isExample } },
    gms,
  };
});

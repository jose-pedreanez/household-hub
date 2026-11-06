import { route } from "@/lib/api";
import { resumeCooking } from "@/lib/cooking/execute";
import { cookingDeps } from "@/lib/cooking/service";

/**
 * Housekeeping for n8n: finish Mealie bookkeeping (last made, timeline) for cooked meals whose Mealie
 * update failed earlier. Stock is never touched here.
 */
export const POST = route(async () => {
  const deps = cookingDeps();
  const pending = deps.journal.unsyncedCompleted();
  let synced = 0;
  for (const o of pending) {
    const v = await resumeCooking(deps, o.id).catch(() => null);
    if (v?.occurrence.mealieSynced) synced++;
  }
  return { pending: pending.length, synced };
});

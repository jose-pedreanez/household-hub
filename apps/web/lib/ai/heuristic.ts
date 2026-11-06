import type { PlanSlot } from "./schemas";

/**
 * Deterministic meal suggestions, used when no AI provider is configured or the provider fails.
 * Scores recipes by how much of their tracked ingredients are on hand, with extra weight for items
 * expiring soon; avoids recent repeats; respects time limits. Same inputs → same plan.
 */

export interface RecipeInfo {
  id: string;
  slug: string;
  name: string;
  foodIds: string[];
  foodNames: string[];
  totalMinutes: number | null;
  rating: number | null;
  tags: string[];
}

export interface HeuristicInput {
  slots: PlanSlot[];
  recipes: RecipeInfo[];
  inStockFoodIds: Set<string>;
  /** food id → due date (YYYY-MM-DD) for items expiring soon */
  expiringFoodIds: Map<string, string>;
  /** recipe id → date last cooked or planned */
  recent: Map<string, string>;
  favorites: Set<string>;
  maxMinutes: (date: string) => number;
  avoidRepeatDays: number;
  dislikes: string[];
}

export interface HeuristicChoice {
  date: string;
  entryType: PlanSlot["entryType"];
  recipeId: string;
  recipeSlug: string;
  recipeName: string;
  score: number;
  usesExpiringFoodIds: string[];
  reasons: string[];
}

export function parseMinutes(text: string | null | undefined): number | null {
  if (!text) return null;
  const iso = text.match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?$/i);
  if (iso && (iso[1] || iso[2])) return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0);
  const h = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  const m = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (h || m) return Math.round(Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0));
  const n = text.match(/^\s*(\d+)\s*$/);
  return n ? Number(n[1]) : null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export function planHeuristically(input: HeuristicInput): HeuristicChoice[] {
  const expiring = new Map(input.expiringFoodIds);
  const chosen = new Map<string, string>(); // recipe id → date chosen in this plan
  const out: HeuristicChoice[] = [];
  const dislikes = input.dislikes.map((d) => d.toLowerCase());
  const eligible = input.recipes.filter(
    (r) => r.foodIds.length > 0 && !dislikes.some((d) => r.name.toLowerCase().includes(d) || r.foodNames.some((f) => f.toLowerCase() === d)),
  );

  for (const slot of [...input.slots].sort((a, b) => a.date.localeCompare(b.date) || a.entryType.localeCompare(b.entryType))) {
    let best: HeuristicChoice | null = null;
    for (const r of eligible) {
      const reasons: string[] = [];
      const last = chosen.get(r.id) ?? input.recent.get(r.id);
      if (last && Math.abs(daysBetween(last, slot.date)) < input.avoidRepeatDays) continue;

      const onHand = r.foodIds.filter((f) => input.inStockFoodIds.has(f)).length / r.foodIds.length;
      const exp = r.foodIds.filter((f) => expiring.has(f));
      let score = onHand * 2;
      if (onHand >= 0.8) reasons.push("most ingredients on hand");
      for (const f of exp) {
        const days = Math.max(0, daysBetween(slot.date, expiring.get(f)!));
        score += 3 / (1 + days * 0.5);
      }
      if (exp.length > 0) reasons.push(`uses ${exp.length} expiring item${exp.length > 1 ? "s" : ""}`);
      if (input.favorites.has(r.id)) {
        score += 1.5;
        reasons.push("household favourite");
      }
      if (r.rating) score += r.rating / 5;
      if (r.totalMinutes !== null && r.totalMinutes > input.maxMinutes(slot.date)) score -= 2;

      const candidate: HeuristicChoice = {
        date: slot.date,
        entryType: slot.entryType,
        recipeId: r.id,
        recipeSlug: r.slug,
        recipeName: r.name,
        score: Math.round(score * 1000) / 1000,
        usesExpiringFoodIds: exp,
        reasons,
      };
      if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.recipeName.localeCompare(best.recipeName) < 0)) {
        best = candidate;
      }
    }
    if (best) {
      out.push(best);
      chosen.set(best.recipeId, best.date);
      // Spread expiring items across meals instead of building every meal around the same one.
      for (const f of best.usesExpiringFoodIds) expiring.delete(f);
    }
  }
  return out;
}

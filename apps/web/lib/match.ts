/**
 * Deterministic fuzzy matching for suggestions (never for automatic linking).
 * Scores are 0..1 from token overlap plus a containment bonus; ties break by name.
 */

const STOP = new Set([
  "the", "and", "with", "of", "a", "an", "in", "for", "organic", "natural", "fresh", "original", "classic",
  "trader", "joe", "joes", "s", "brand", "pack", "family", "size", "value", "oz", "lb", "g", "kg", "ml", "l", "fl",
]);

export function tokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .map(singular)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

function singular(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("es") && /(ch|sh|x|ss|o)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function similarity(query: string[], candidate: string[]): number {
  if (query.length === 0 || candidate.length === 0) return 0;
  const q = new Set(query);
  const c = new Set(candidate);
  let shared = 0;
  for (const t of c) if (q.has(t)) shared++;
  if (shared === 0) return 0;
  // Candidate coverage matters most: "Pasta" should match "Barilla Spaghetti Pasta".
  const coverage = shared / c.size;
  const precision = shared / q.size;
  return Math.round((0.7 * coverage + 0.3 * precision) * 1000) / 1000;
}

export interface Scored<T> {
  item: T;
  score: number;
}

export function rank<T>(query: string[], items: T[], text: (t: T) => string[], limit = 5, minScore = 0.25): Scored<T>[] {
  return items
    .map((item) => ({ item, score: similarity(query, text(item)) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || String(text(a.item).join(" ")).localeCompare(text(b.item).join(" ")))
    .slice(0, limit);
}

/** A suggestion is only "confident" when it is strong and clearly ahead of the runner-up. */
export function isAmbiguous<T>(ranked: Scored<T>[]): boolean {
  if (ranked.length === 0) return true;
  if (ranked[0].score < 0.75) return true;
  return ranked.length > 1 && ranked[0].score - ranked[1].score < 0.15;
}

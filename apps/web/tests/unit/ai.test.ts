import { describe, expect, it } from "vitest";
import { planHeuristically, parseMinutes, type RecipeInfo } from "@/lib/ai/heuristic";
import type { AiProvider } from "@/lib/ai/provider";
import { validateAiPlan, type AiPlan, type PlanSlot } from "@/lib/ai/schemas";
import { suggestWithProvider } from "@/lib/ai/suggest";
import { UpstreamError } from "@/lib/errors";

const slots: PlanSlot[] = [
  { date: "2026-10-26", entryType: "dinner" },
  { date: "2026-10-27", entryType: "dinner" },
];
const recipes = [
  { id: "r-chili", slug: "chili", name: "Chili" },
  { id: "r-curry", slug: "curry", name: "Chicken curry" },
];
const opts = { slots, recipes, expiringNames: ["Chicken thighs"], knownFoods: ["Chicken thighs", "Rice", "Beans"] };

const meal = (o: Partial<AiPlan["meals"][number]>): AiPlan["meals"][number] => ({
  date: "2026-10-26",
  slot: "dinner",
  recipeId: "r-curry",
  newRecipe: null,
  servings: 4,
  usesExpiring: [],
  reason: "uses the chicken",
  ...o,
});

describe("AI plan validation", () => {
  it("drops meals that reference recipes that do not exist", () => {
    const v = validateAiPlan({ meals: [meal({ recipeId: "r-imaginary" })], notes: "" }, opts);
    expect(v.meals).toHaveLength(0);
    expect(v.issues[0]).toMatch(/does not exist/);
  });

  it("drops meals for slots that were not requested and duplicates", () => {
    const v = validateAiPlan({ meals: [meal({ date: "2026-12-25" }), meal({}), meal({ recipeId: "r-chili" })], notes: "" }, opts);
    expect(v.meals.map((m) => m.recipeName)).toEqual(["Chicken curry"]);
    expect(v.issues).toHaveLength(2);
  });

  it("keeps only expiring items that are really in inventory", () => {
    const v = validateAiPlan({ meals: [meal({ usesExpiring: ["chicken thighs", "Dragon fruit"] })], notes: "" }, opts);
    expect(v.meals[0].usesExpiring).toEqual(["Chicken thighs"]);
    expect(v.issues.join(" ")).toMatch(/Dragon fruit/);
  });

  it("flags unsupported ingredients in proposed new recipes", () => {
    const v = validateAiPlan(
      {
        meals: [
          meal({
            date: "2026-10-27",
            recipeId: null,
            newRecipe: { name: "Bean bowl", description: "", servings: 2, totalTimeMinutes: 20, ingredients: [{ food: "Beans", quantity: 1, unit: "can", note: null }, { food: "Unobtainium", quantity: 1, unit: null, note: null }], steps: ["Cook"] },
          }),
        ],
        notes: "",
      },
      opts,
    );
    expect(v.meals[0].newRecipe?.unknownFoods).toEqual(["Unobtainium"]);
  });

  it("clamps impossible servings", () => {
    expect(validateAiPlan({ meals: [meal({ servings: 500 })], notes: "" }, opts).meals[0].servings).toBe(2);
  });
});

function provider(structured: AiProvider["structured"]): AiProvider {
  return { name: "anthropic", model: "test", structured, runTools: async () => ({ text: "", refusal: null, toolCalls: [] }) };
}

describe("AI provider failures fall back cleanly", () => {
  const base = { system: "s", context: {}, ...opts };

  it("invalid JSON / schema mismatch", async () => {
    const r = await suggestWithProvider(provider(async () => ({ data: null, raw: "{not json", refusal: null })), base);
    expect(r).toMatchObject({ status: "invalid", meals: [] });
    const wrongShape = await suggestWithProvider(provider(async () => ({ data: { meals: "lots" } as never, raw: "", refusal: null })), base);
    expect(wrongShape.status).toBe("invalid");
  });

  it("refusal", async () => {
    const r = await suggestWithProvider(provider(async () => ({ data: null, raw: "", refusal: "declined" })), base);
    expect(r.status).toBe("invalid");
    expect(r.issues[0]).toMatch(/declined/);
  });

  it("provider unavailable", async () => {
    const r = await suggestWithProvider(
      provider(async () => {
        throw new UpstreamError({ service: "Anthropic", message: "Could not reach the Anthropic API", httpStatus: null, outcomeUncertain: false, unreachable: true });
      }),
      base,
    );
    expect(r).toMatchObject({ status: "error", meals: [] });
    expect(r.issues[0]).toMatch(/unavailable/);
  });

  it("valid output passes through validation", async () => {
    const r = await suggestWithProvider(provider(async () => ({ data: { meals: [meal({})], notes: "" } as never, raw: "{}", refusal: null })), base);
    expect(r.status).toBe("ok");
    expect(r.meals[0].recipeSlug).toBe("curry");
  });
});

describe("deterministic heuristic planner", () => {
  const infos: RecipeInfo[] = [
    { id: "a", slug: "a", name: "Chicken curry", foodIds: ["chicken", "rice"], foodNames: ["Chicken", "Rice"], totalMinutes: 40, rating: 4, tags: [] },
    { id: "b", slug: "b", name: "Bean chili", foodIds: ["beans", "tomato"], foodNames: ["Beans", "Tomato"], totalMinutes: 50, rating: 3, tags: [] },
    { id: "c", slug: "c", name: "Roast", foodIds: ["beef"], foodNames: ["Beef"], totalMinutes: 180, rating: 5, tags: [] },
  ];
  const input = {
    slots,
    recipes: infos,
    inStockFoodIds: new Set(["chicken", "rice", "beans", "tomato"]),
    expiringFoodIds: new Map([["chicken", "2026-10-26"]]),
    recent: new Map<string, string>(),
    favorites: new Set<string>(),
    maxMinutes: () => 60,
    avoidRepeatDays: 7,
    dislikes: [],
  };

  it("uses expiring food first, avoids repeats and is deterministic", () => {
    const a = planHeuristically(input);
    expect(a.map((c) => c.recipeName)).toEqual(["Chicken curry", "Bean chili"]);
    expect(planHeuristically(input)).toEqual(a);
  });

  it("skips recently cooked recipes", () => {
    const r = planHeuristically({ ...input, recent: new Map([["a", "2026-10-24"]]) });
    expect(r[0].recipeName).toBe("Bean chili");
  });

  it("parses Mealie time strings", () => {
    expect(parseMinutes("1 hour 30 minutes")).toBe(90);
    expect(parseMinutes("PT45M")).toBe(45);
    expect(parseMinutes("45")).toBe(45);
    expect(parseMinutes("a while")).toBeNull();
  });
});

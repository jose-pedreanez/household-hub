import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { today } from "../api";
import { householdConfig, retailerConfig } from "../config";
import { nowIso } from "../db";
import { AppError, errorMessage } from "../errors";
import { PlanAnnotations } from "../meals/annotations";
import { addDays, listMeals, weekStart } from "../meals/service";
import { PLAN_ENTRY_TYPES, type PlanEntryType } from "../mealie/schemas";
import { services } from "../services";
import { addAdhocItem, computeNeeds } from "../shopping/service";
import { planHeuristically } from "./heuristic";
import { aiProvider } from "./index";
import { applyPlan, generatePlan, inventoryFacts, recipeCatalog } from "./planner";
import { defineTool, type ChatTurn, type ToolDef } from "./provider";

/**
 * Household assistant. It answers only from tool results (live Grocy/Mealie data) and never writes
 * directly: write tools create a *proposed* action that a person confirms in the UI.
 */

export interface ProposedAction {
  id: string;
  kind: "add_to_shopping_list" | "replace_meal" | "apply_plan";
  summary: string;
}

export interface AssistantReply {
  reply: string;
  mode: "ai" | "rules";
  actions: ProposedAction[];
  toolCalls: Array<{ name: string; ok: boolean }>;
  notice: string | null;
}

function propose(kind: ProposedAction["kind"], summary: string, payload: unknown): ProposedAction {
  const id = randomUUID();
  services()
    .db.prepare("INSERT INTO assistant_actions(id, kind, summary, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'proposed', ?)")
    .run(id, kind, summary, JSON.stringify(payload), nowIso());
  return { id, kind, summary };
}

function resolveStore(store: string | null): string {
  const cfg = retailerConfig().config;
  if (store) {
    const s = store.toLowerCase();
    const hit = cfg.retailers.find((r) => r.id === s || r.name.toLowerCase().includes(s) || s.includes(r.name.toLowerCase().split(" (")[0]));
    if (hit) return hit.id;
  }
  return cfg.defaults.preferredRetailer ?? cfg.retailers[0].id;
}

export function buildTools(actions: ProposedAction[]): ToolDef[] {
  const nullableDate = z.string().nullable().describe("YYYY-MM-DD or null");
  return [
    defineTool({
      name: "search_inventory",
      description: "Current household inventory from Grocy (product, amount, unit, location, due date). Filter by text and/or storage location (e.g. freezer, fridge, pantry).",
      schema: z.object({ query: z.string().nullable(), location: z.string().nullable() }),
      run: async ({ query, location }) => {
        const { grocy } = services();
        const facts = await inventoryFacts();
        const [locs, stockLocs] = await Promise.all([grocy.listLocations(), grocy.listObjectsLoose("stock_current_locations", z.object({ product_id: z.coerce.number(), location_id: z.coerce.number(), amount: z.coerce.number().optional() }).loose())]);
        const stock = await grocy.currentStock();
        const locMatch = location ? locs.filter((l) => l.name.toLowerCase().includes(location.toLowerCase())).map((l) => l.id) : null;
        const items = stock
          .filter((s) => s.amount > 0)
          .filter((s) => !query || s.product.name.toLowerCase().includes(query.toLowerCase()))
          .filter((s) => !locMatch || stockLocs.some((x) => x.product_id === s.product_id && locMatch.includes(x.location_id)))
          .map((s) => {
            const f = facts.inventory.find((i) => i.name === s.product.name);
            return { name: s.product.name, amount: s.amount, unit: f?.unit ?? "", due: f?.due ?? null, locations: stockLocs.filter((x) => x.product_id === s.product_id).map((x) => locs.find((l) => l.id === x.location_id)?.name) };
          });
        return { count: items.length, items: items.slice(0, 60), locationsMatched: locMatch ? locs.filter((l) => locMatch.includes(l.id)).map((l) => l.name) : null };
      },
    }),
    defineTool({
      name: "list_expiring",
      description: "Inventory items that are overdue or due within the household's expiring-soon window.",
      schema: z.object({}),
      run: async () => ({ expiring: (await inventoryFacts()).expiring }),
    }),
    defineTool({
      name: "get_meal_plan",
      description: "Planned meals from Mealie for a date range (defaults to the current week).",
      schema: z.object({ start: nullableDate, end: nullableDate }),
      run: async ({ start, end }) => {
        const s = start ?? weekStart(today());
        const meals = await listMeals(s, end ?? addDays(s, 6));
        return meals.map((m) => ({ date: m.date, slot: m.entryType, recipe: m.recipe?.name ?? m.title, recipeId: m.recipe?.id ?? null, servings: m.plannedServings, cooked: !!m.cooked, leftovers: !!m.leftoverOf }));
      },
    }),
    defineTool({
      name: "find_recipes",
      description: "Search the household's Mealie recipes by name text and/or an ingredient they use.",
      schema: z.object({ query: z.string().nullable(), ingredient: z.string().nullable() }),
      run: async ({ query, ingredient }) => {
        const { infos } = await recipeCatalog();
        return infos
          .filter((r) => !query || r.name.toLowerCase().includes(query.toLowerCase()))
          .filter((r) => !ingredient || r.foodNames.some((f) => f.toLowerCase().includes(ingredient.toLowerCase())))
          .slice(0, 15)
          .map((r) => ({ id: r.id, name: r.name, minutes: r.totalMinutes, ingredients: r.foodNames }));
      },
    }),
    defineTool({
      name: "suggest_meals",
      description: "Rank recipes for a given day by ingredients on hand and items expiring soon (deterministic).",
      schema: z.object({ date: nullableDate }),
      run: async ({ date }) => suggestFor(date ?? today(), 3),
    }),
    defineTool({
      name: "get_shopping_needs",
      description: "Groceries needed for the next 7 days of planned meals (after subtracting stock) plus low-stock items.",
      schema: z.object({}),
      run: async () => {
        const t = today();
        const n = await computeNeeds(t, addDays(t, 6));
        return { needs: n.needs.map((x) => ({ item: x.foodName, amount: x.amount, unit: x.unitName, why: x.source })), unresolved: n.unresolved.map((u) => ({ item: u.foodName ?? u.display, reason: u.detail })) };
      },
    }),
    defineTool({
      name: "propose_add_to_shopping_list",
      description: "Propose adding an item to a store shopping list. The household must confirm it.",
      schema: z.object({ item: z.string(), quantity: z.number().nullable(), store: z.string().nullable() }),
      run: async ({ item, quantity, store }) => {
        const retailerId = resolveStore(store);
        const name = retailerConfig().config.retailers.find((r) => r.id === retailerId)?.name ?? retailerId;
        const a = propose("add_to_shopping_list", `Add ${quantity ? `${quantity} × ` : ""}${item} to ${name}`, { item, quantity, retailerId });
        actions.push(a);
        return { proposed: a.summary, needsConfirmation: true };
      },
    }),
    defineTool({
      name: "propose_replace_meal",
      description: "Propose putting a catalog recipe (by id) into a meal slot, replacing what is planned there. Needs confirmation.",
      schema: z.object({ date: z.string(), slot: z.enum(PLAN_ENTRY_TYPES), recipeId: z.string() }),
      run: async ({ date, slot, recipeId }) => {
        const { infos } = await recipeCatalog();
        const r = infos.find((x) => x.id === recipeId);
        if (!r) throw new Error("That recipe id does not exist");
        const a = propose("replace_meal", `Put ${r.name} on ${date} (${slot})`, { date, slot, recipeId });
        actions.push(a);
        return { proposed: a.summary, needsConfirmation: true };
      },
    }),
    defineTool({
      name: "propose_week_plan",
      description: "Draft a meal plan for the 7 days starting at `start` (defaults to next Monday) and propose saving it. Needs confirmation.",
      schema: z.object({ start: nullableDate }),
      run: async ({ start }) => {
        const s = start ?? addDays(weekStart(today()), 7);
        const plan = await generatePlan({ start: s, days: 7, useAi: false });
        const a = propose("apply_plan", `Save ${plan.meals.length} planned meals for the week of ${s}`, { runId: plan.runId, accept: plan.meals.map((_, i) => i) });
        actions.push(a);
        return { proposed: a.summary, meals: plan.meals.map((m) => ({ date: m.date, slot: m.entryType, recipe: m.recipeName, why: m.reason })), needsConfirmation: true };
      },
    }),
  ];
}

async function suggestFor(date: string, n: number) {
  const cfg = householdConfig().config;
  const [{ infos, recipes }, facts, recent] = await Promise.all([recipeCatalog(), inventoryFacts(), listMeals(addDays(date, -14), date).catch(() => [])]);
  const recentMap = new Map<string, string>();
  for (const r of recipes) if (r.lastMade) recentMap.set(r.id, r.lastMade.slice(0, 10));
  for (const m of recent) if (m.recipe && m.date < date) recentMap.set(m.recipe.id, m.date);
  const ranked: ReturnType<typeof planHeuristically> = [];
  let pool = infos;
  for (let i = 0; i < n && pool.length > 0; i++) {
    const [best] = planHeuristically({
      slots: [{ date, entryType: "dinner" }],
      recipes: pool,
      inStockFoodIds: facts.inStockFoodIds,
      expiringFoodIds: facts.expiringFoodIds,
      recent: recentMap,
      favorites: new Set(recipes.filter((r) => (r.rating ?? 0) >= 4).map((r) => r.id)),
      maxMinutes: () => cfg.meals.maxCookingMinutes.weeknight,
      avoidRepeatDays: cfg.meals.avoidRepeatDays,
      dislikes: cfg.meals.preferences.dislikes,
    });
    if (!best) break;
    ranked.push(best);
    pool = pool.filter((r) => r.id !== best.recipeId);
  }
  return ranked.map((r) => ({ recipeId: r.recipeId, recipe: r.recipeName, why: r.reasons.join("; ") || "fits what you have" }));
}

const SYSTEM = `You are the household's kitchen assistant. You help with inventory, meals and groceries.
Rules:
- Facts about inventory, meal plans, recipes and shopping come only from tool results. If a tool does not tell you something, say you don't know.
- Never invent quantities, expiry dates or nutrition values.
- You cannot change anything yourself. To add to a shopping list, change a meal or save a plan, call the matching propose_* tool; the household confirms it in the app. Say that it is waiting for their confirmation.
- Keep answers short and practical.`;

export async function askAssistant(messages: ChatTurn[]): Promise<AssistantReply> {
  const actions: ProposedAction[] = [];
  const tools = buildTools(actions);
  const status = aiProvider();
  if (status.provider) {
    try {
      const dated: ChatTurn[] = messages.map((m, i) =>
        i === messages.length - 1 && m.role === "user" ? { ...m, content: `(Today is ${today()}.)\n${m.content}` } : m,
      );
      const out = await status.provider.runTools({ system: SYSTEM, messages: dated, tools, maxIterations: 8 });
      return {
        reply: out.refusal ? "Sorry, I can't help with that request." : out.text || "Done.",
        mode: "ai",
        actions,
        toolCalls: out.toolCalls.map((t) => ({ name: t.name, ok: t.ok })),
        notice: null,
      };
    } catch (e) {
      const fallback = await rulesAssistant(messages[messages.length - 1]?.content ?? "", tools, actions);
      return { ...fallback, notice: `AI provider unavailable (${errorMessage(e)}); answered with built-in rules.` };
    }
  }
  return rulesAssistant(messages[messages.length - 1]?.content ?? "", tools, actions);
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function nextDate(dayName: string): string {
  const t = today();
  const dow = new Date(`${t}T12:00:00Z`).getUTCDay();
  const target = DAYS.indexOf(dayName);
  return addDays(t, (target - dow + 7) % 7);
}

/** Deterministic fallback covering the common requests; still uses the same tools. */
export async function rulesAssistant(text: string, tools: ToolDef[], actions: ProposedAction[]): Promise<AssistantReply> {
  const call = async (name: string, input: unknown) => {
    const t = tools.find((x) => x.name === name)!;
    return t.run(t.schema.parse(input));
  };
  const q = text.trim().toLowerCase();
  const reply = (r: string, used: string[]): AssistantReply => ({ reply: r, mode: "rules", actions, toolCalls: used.map((name) => ({ name, ok: true })), notice: null });

  let m = q.match(/^(?:please\s+)?add\s+(.+?)\s+to\s+(?:the\s+|our\s+)?(?:(.+?)\s+)?(?:grocery|shopping)\s+list/);
  if (m) {
    await call("propose_add_to_shopping_list", { item: m[1], quantity: null, store: m[2] ?? null });
    return reply(`I've prepared “${actions[0].summary}”. Confirm it below to add it.`, ["propose_add_to_shopping_list"]);
  }
  m = q.match(/what'?s?\s+(?:is\s+)?in\s+(?:our|the)\s+(freezer|fridge|refrigerator|pantry)/);
  if (m) {
    const r = (await call("search_inventory", { query: null, location: m[1] === "refrigerator" ? "fridge" : m[1] })) as { items: Array<{ name: string; amount: number; unit: string; due: string | null }>; locationsMatched: string[] | null };
    if (!r.locationsMatched?.length) return reply(`I couldn't find a storage location called “${m[1]}” in Grocy.`, ["search_inventory"]);
    if (r.items.length === 0) return reply(`Nothing is recorded in the ${m[1]} right now.`, ["search_inventory"]);
    return reply(`In the ${m[1]}:\n${r.items.map((i) => `• ${i.name}: ${fmt(i.amount)} ${i.unit}${i.due ? ` (due ${i.due})` : ""}`).join("\n")}`, ["search_inventory"]);
  }
  if (/what (?:groceries|do we need)|shopping (?:list|needs)|need to buy/.test(q)) {
    const r = (await call("get_shopping_needs", {})) as { needs: Array<{ item: string; amount: number; unit: string; why: string }>; unresolved: Array<{ item: string }> };
    if (r.needs.length === 0) return reply("Nothing is missing for the next 7 days of planned meals, and nothing is below its minimum stock.", ["get_shopping_needs"]);
    return reply(
      `For the next 7 days you need:\n${r.needs.map((n) => `• ${n.item}: ${fmt(n.amount)} ${n.unit}${n.why === "low_stock" ? " (low stock)" : ""}`).join("\n")}` +
        (r.unresolved.length ? `\nI couldn't check: ${r.unresolved.map((u) => u.item).join(", ")}.` : ""),
      ["get_shopping_needs"],
    );
  }
  m = q.match(/use (?:the |our )?(.+?)(?: that'?s| that is| which is)? expiring/);
  if (m) {
    const r = (await call("find_recipes", { query: null, ingredient: m[1] })) as Array<{ name: string; minutes: number | null }>;
    if (r.length === 0) return reply(`I didn't find a recipe in Mealie that uses ${m[1]}.`, ["find_recipes"]);
    return reply(`Recipes that use ${m[1]}:\n${r.slice(0, 5).map((x) => `• ${x.name}${x.minutes ? ` (${x.minutes} min)` : ""}`).join("\n")}`, ["find_recipes"]);
  }
  m = q.match(/replace\s+(\w+)'?s\s+(breakfast|lunch|dinner|snack)/);
  if (m && DAYS.includes(m[1])) {
    const date = nextDate(m[1]);
    const s = (await call("suggest_meals", { date })) as Array<{ recipeId: string; recipe: string; why: string }>;
    if (s.length === 0) return reply("I couldn't find a suitable replacement recipe.", ["suggest_meals"]);
    await call("propose_replace_meal", { date, slot: m[2] as PlanEntryType, recipeId: s[0].recipeId });
    return reply(`How about ${s[0].recipe} (${s[0].why}) for ${m[1]}'s ${m[2]}? Confirm below to change the plan.`, ["suggest_meals", "propose_replace_meal"]);
  }
  if (/(make|plan|create).*(next week|week'?s).*(meal )?plan|meal plan for next week/.test(q)) {
    const r = (await call("propose_week_plan", { start: null })) as { meals: Array<{ date: string; slot: string; recipe: string }> };
    if (r.meals.length === 0) return reply("I couldn't build a plan: no suitable recipes or every slot is already planned.", ["propose_week_plan"]);
    return reply(`Here's a draft:\n${r.meals.map((x) => `• ${x.date} ${x.slot}: ${x.recipe}`).join("\n")}\nConfirm below to save it to Mealie.`, ["propose_week_plan"]);
  }
  if (/(what|which).*(cook|make|eat).*(tonight|today|dinner)|what'?s for dinner/.test(q)) {
    const planned = (await call("get_meal_plan", { start: today(), end: today() })) as Array<{ slot: string; recipe: string }>;
    const dinner = planned.find((p) => p.slot === "dinner");
    const s = (await call("suggest_meals", { date: today() })) as Array<{ recipe: string; why: string }>;
    const head = dinner ? `Tonight's plan is ${dinner.recipe}.` : "Nothing is planned for dinner tonight.";
    return reply(s.length ? `${head} Good options with what you have:\n${s.map((x) => `• ${x.recipe} — ${x.why}`).join("\n")}` : head, ["get_meal_plan", "suggest_meals"]);
  }
  if (/expir/.test(q)) {
    const r = (await call("list_expiring", {})) as { expiring: Array<{ name: string; due: string }> };
    return reply(r.expiring.length ? `Expiring soon:\n${r.expiring.map((e) => `• ${e.name} (due ${e.due})`).join("\n")}` : "Nothing is expiring soon.", ["list_expiring"]);
  }
  return reply(
    "Without a cloud AI provider I understand requests like: “Add milk to the grocery list”, “What should we cook tonight?”, “What's in our freezer?”, “What groceries do we need?”, “Replace Thursday's dinner”, “Make next week's meal plan”.",
    [],
  );
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

/** Execute a proposed action after the household confirms it. Idempotent per action. */
export async function decideAction(id: string, approve: boolean) {
  const { db, mealie } = services();
  const row = db.prepare("SELECT * FROM assistant_actions WHERE id = ?").get(id) as { kind: ProposedAction["kind"]; status: string; payload_json: string; result_json: string | null } | undefined;
  if (!row) throw new AppError("not_found", "Action not found");
  if (row.status !== "proposed") return { status: row.status, result: row.result_json ? JSON.parse(row.result_json) : null };
  if (!approve) {
    db.prepare("UPDATE assistant_actions SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), id);
    return { status: "rejected", result: null };
  }
  const p = JSON.parse(row.payload_json);
  let result: unknown;
  try {
    if (row.kind === "add_to_shopping_list") {
      await addAdhocItem(p.retailerId, p.item, p.quantity ?? undefined);
      result = { added: p.item };
    } else if (row.kind === "replace_meal") {
      const existing = (await listMeals(p.date, p.date)).find((x) => x.entryType === p.slot);
      if (existing?.cooked) throw new AppError("conflict", "That meal is already marked cooked");
      if (existing) {
        const entry = await mealie.getMealPlan(existing.id);
        await mealie.updateMealPlan({ ...entry!, recipeId: p.recipeId });
        result = { entryId: existing.id, replaced: true };
      } else {
        const e = await mealie.createMealPlan({ date: p.date, entryType: p.slot, recipeId: p.recipeId });
        new PlanAnnotations(db).set(e.id, {});
        result = { entryId: e.id, replaced: false };
      }
    } else {
      result = await applyPlan(p.runId, p.accept);
    }
    db.prepare("UPDATE assistant_actions SET status = 'executed', result_json = ?, decided_at = ? WHERE id = ?").run(JSON.stringify(result), nowIso(), id);
    return { status: "executed", result };
  } catch (e) {
    db.prepare("UPDATE assistant_actions SET status = 'failed', result_json = ?, decided_at = ? WHERE id = ?").run(JSON.stringify({ error: errorMessage(e) }), nowIso(), id);
    throw e;
  }
}

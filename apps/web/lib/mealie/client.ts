import { z } from "zod";
import { UpstreamError } from "../errors";
import { requestJson, type FetchLike, type RequestOptions } from "../http";
import {
  mealPlanEntrySchema,
  mealieFoodSchema,
  mealieRecipeSchema,
  mealieRecipeSummarySchema,
  mealieUnitSchema,
  paginated,
  recipeActionSchema,
  shoppingListItemSchema,
  shoppingListSchema,
  type MealPlanEntry,
  type MealieFood,
  type MealieRecipe,
  type MealieUnit,
  type PlanEntryType,
  type ShoppingList,
  type ShoppingListItem,
} from "./schemas";

export interface NewShoppingItem {
  shoppingListId: string;
  note?: string | null;
  quantity?: number;
  foodId?: string | null;
  unitId?: string | null;
  checked?: boolean;
  extras?: Record<string, string>;
}

/** Validated wrapper around the Mealie v3 REST API (server-side only). */
export class MealieClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(path: string, opts: RequestOptions = {}): Promise<T | null> {
    return requestJson<T>(
      "Mealie",
      `${this.baseUrl.replace(/\/$/, "")}${path}`,
      { ...opts, headers: { Authorization: `Bearer ${this.token}`, ...opts.headers } },
      this.fetchImpl,
    );
  }

  private async get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    return parse(schema, await this.call(path), path);
  }

  async about() {
    return this.get("/api/app/about", z.object({ version: z.string() }).loose());
  }

  // ---- Recipes ----------------------------------------------------------------

  async searchRecipes(opts: { search?: string; page?: number; perPage?: number; orderBy?: string } = {}) {
    const p = new URLSearchParams({ page: String(opts.page ?? 1), perPage: String(opts.perPage ?? 50) });
    if (opts.search) p.set("search", opts.search);
    p.set("orderBy", opts.orderBy ?? "name");
    p.set("orderDirection", opts.orderBy === "lastMade" || opts.orderBy === "rating" ? "desc" : "asc");
    return this.get(`/api/recipes?${p}`, paginated(mealieRecipeSummarySchema));
  }

  async allRecipeSummaries() {
    return (await this.get(`/api/recipes?page=1&perPage=-1&orderBy=name`, paginated(mealieRecipeSummarySchema))).items;
  }

  async getRecipe(slugOrId: string): Promise<MealieRecipe | null> {
    const raw = await this.call(`/api/recipes/${encodeURIComponent(slugOrId)}`, { allow404: true });
    return raw === null ? null : parse(mealieRecipeSchema, raw, `recipe ${slugOrId}`);
  }

  /** Create a recipe (Mealie returns its slug) and then fill in its body. */
  async createRecipe(name: string, body: Record<string, unknown>): Promise<string> {
    const slug = parse(z.string(), await this.call("/api/recipes", { method: "POST", body: { name } }), "create recipe");
    if (Object.keys(body).length > 0) {
      await this.call(`/api/recipes/${encodeURIComponent(slug)}`, { method: "PATCH", body });
    }
    return slug;
  }

  async setLastMade(slug: string, timestamp: string): Promise<void> {
    await this.call(`/api/recipes/${encodeURIComponent(slug)}/last-made`, { method: "PATCH", body: { timestamp } });
  }

  async addTimelineEvent(event: { recipeId: string; subject: string; eventMessage?: string; timestamp?: string }) {
    await this.call("/api/recipes/timeline/events", {
      method: "POST",
      body: { eventType: "info", timestamp: new Date().toISOString(), ...event },
    });
  }

  // ---- Foods & units ----------------------------------------------------------

  async listFoods(search?: string): Promise<MealieFood[]> {
    const p = new URLSearchParams({ page: "1", perPage: search ? "50" : "-1", orderBy: "name", orderDirection: "asc" });
    if (search) p.set("search", search);
    return (await this.get(`/api/foods?${p}`, paginated(mealieFoodSchema))).items;
  }

  async getFood(id: string): Promise<MealieFood | null> {
    const raw = await this.call(`/api/foods/${encodeURIComponent(id)}`, { allow404: true });
    return raw === null ? null : parse(mealieFoodSchema, raw, `food ${id}`);
  }

  async createFood(name: string, extra: Record<string, unknown> = {}): Promise<MealieFood> {
    return parse(mealieFoodSchema, await this.call("/api/foods", { method: "POST", body: { name, ...extra } }), "create food");
  }

  async listUnits(): Promise<MealieUnit[]> {
    return (await this.get("/api/units?page=1&perPage=-1", paginated(mealieUnitSchema))).items;
  }

  // ---- Meal plans ---------------------------------------------------------------

  async mealPlans(startDate: string, endDate: string): Promise<MealPlanEntry[]> {
    const p = new URLSearchParams({ start_date: startDate, end_date: endDate, page: "1", perPage: "-1" });
    return (await this.get(`/api/households/mealplans?${p}`, paginated(mealPlanEntrySchema))).items;
  }

  async getMealPlan(id: number): Promise<MealPlanEntry | null> {
    const raw = await this.call(`/api/households/mealplans/${id}`, { allow404: true });
    return raw === null ? null : parse(mealPlanEntrySchema, raw, `mealplan ${id}`);
  }

  async createMealPlan(entry: {
    date: string;
    entryType: PlanEntryType;
    recipeId?: string | null;
    title?: string;
    text?: string;
  }): Promise<MealPlanEntry> {
    const raw = await this.call("/api/households/mealplans", {
      method: "POST",
      body: { title: "", text: "", recipeId: null, ...entry },
    });
    return parse(mealPlanEntrySchema, raw, "create mealplan");
  }

  async updateMealPlan(entry: MealPlanEntry & Record<string, unknown>): Promise<MealPlanEntry> {
    const raw = await this.call(`/api/households/mealplans/${entry.id}`, { method: "PUT", body: entry });
    return parse(mealPlanEntrySchema, raw, "update mealplan");
  }

  async deleteMealPlan(id: number): Promise<void> {
    await this.call(`/api/households/mealplans/${id}`, { method: "DELETE" });
  }

  // ---- Shopping lists -------------------------------------------------------------

  async shoppingLists(): Promise<ShoppingList[]> {
    return (await this.get("/api/households/shopping/lists?page=1&perPage=-1", paginated(shoppingListSchema))).items;
  }

  async shoppingList(id: string): Promise<ShoppingList | null> {
    const raw = await this.call(`/api/households/shopping/lists/${encodeURIComponent(id)}`, { allow404: true });
    return raw === null ? null : parse(shoppingListSchema, raw, `shopping list ${id}`);
  }

  async createShoppingList(name: string, extras: Record<string, string> = {}): Promise<ShoppingList> {
    return parse(
      shoppingListSchema,
      await this.call("/api/households/shopping/lists", { method: "POST", body: { name, extras } }),
      "create shopping list",
    );
  }

  async createShoppingItem(item: NewShoppingItem): Promise<void> {
    await this.call("/api/households/shopping/items", {
      method: "POST",
      body: { quantity: 1, checked: false, note: "", ...item },
    });
  }

  async updateShoppingItem(item: ShoppingListItem, changes: Partial<NewShoppingItem>): Promise<void> {
    const body = {
      shoppingListId: item.shoppingListId,
      quantity: item.quantity,
      note: item.note ?? "",
      foodId: item.foodId,
      unitId: item.unitId,
      checked: item.checked,
      position: item.position,
      extras: item.extras,
      ...changes,
    };
    await this.call(`/api/households/shopping/items/${encodeURIComponent(item.id)}`, { method: "PUT", body });
  }

  async deleteShoppingItem(id: string): Promise<void> {
    await this.call(`/api/households/shopping/items/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async getShoppingItem(id: string): Promise<ShoppingListItem | null> {
    const raw = await this.call(`/api/households/shopping/items/${encodeURIComponent(id)}`, { allow404: true });
    return raw === null ? null : parse(shoppingListItemSchema, raw, `shopping item ${id}`);
  }

  // ---- Recipe actions -------------------------------------------------------------

  async recipeActions() {
    return (await this.get("/api/households/recipe-actions?page=1&perPage=-1", paginated(recipeActionSchema))).items;
  }

  async createRecipeAction(action: { actionType: "link" | "post"; title: string; url: string }) {
    return parse(
      recipeActionSchema,
      await this.call("/api/households/recipe-actions", { method: "POST", body: action }),
      "create recipe action",
    );
  }
}

function parse<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new UpstreamError({
      service: "Mealie",
      message: `Unexpected Mealie response for ${what}: ${r.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
      httpStatus: 200,
      outcomeUncertain: false,
      unreachable: false,
    });
  }
  return r.data;
}

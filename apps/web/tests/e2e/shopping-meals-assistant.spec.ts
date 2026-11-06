import { expect, test } from "@playwright/test";
import { E2E_API_TOKEN } from "../../playwright.config";
import { login, mockState, resetMock, total } from "./helpers";

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

test("low stock flows to the preferred store; checking it off never changes inventory", async ({ page, request }) => {
  // Use some milk so it drops below its 946 mL minimum.
  await page.request.post("/api/scan/consume", { data: { idempotencyKey: "e2e-cons-0001", productId: 20, barcode: null, amount: 500, source: "manual" } });
  await page.goto("/shopping");
  await page.getByRole("button", { name: "Update from meal plan" }).click();
  await expect(page.getByText(/Milk — 1 × 0\.5 gallon/)).toBeVisible();
  const before = total(await mockState(request), 20);
  await page.getByRole("checkbox", { name: /Picked up Milk/ }).check();
  await expect.poll(async () => (await mockState(request)).items.find((i) => i.foodId === "food-milk")?.checked).toBe(true);
  expect(total(await mockState(request), 20)).toBe(before);
  // Regenerating is idempotent and leaves checked items alone.
  await page.getByRole("button", { name: "Update from meal plan" }).click();
  await expect(page.getByText(/0 added, 0 changed, 0 removed/)).toBeVisible();
});

test("the synced low-stock list cannot be checked off from the hub (no double counting)", async ({ page }) => {
  const r = await page.request.patch("/api/shopping/items/does-not-matter", { data: { checked: true } });
  expect([404, 409]).toContain(r.status());
  // Seed an item on the GMS list through the mock and try to check it.
  const created = await page.request.post("http://127.0.0.1:4010/mealie/api/households/shopping/items", {
    headers: { Authorization: "Bearer mock-mealie-token" },
    data: { shoppingListId: "list-needs", note: "Milk", quantity: 1 },
  });
  const id = (await created.json()).createdItems[0].id;
  const refused = await page.request.patch(`/api/shopping/items/${id}`, { data: { checked: true } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).message).toMatch(/scanning the purchase/);
});

test("weekly planning (built-in planner) suggests, caches repeats, and saves only what is accepted", async ({ page, request }) => {
  const start = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toLocaleDateString("en-CA");
  });
  const body = { start, days: 3, slots: ["dinner"], useAi: false };
  const first = await (await page.request.post("/api/meals/plan", { data: body })).json();
  expect(first.source).toBe("heuristic");
  expect(first.meals.length).toBe(3);
  // Chicken expires soonest, so the first suggestion uses it.
  expect(first.meals[0].recipeName).toBe("Garlic Chicken Thighs");
  const again = await (await page.request.post("/api/meals/plan", { data: body })).json();
  expect(again.cached).toBe(true);
  expect(again.runId).toBe(first.runId);
  const plansBefore = (await mockState(request)).mealplans.length;
  const applied = await (await page.request.post("/api/meals/plan/apply", { data: { runId: first.runId, accept: [0, 1] } })).json();
  expect(applied.created).toHaveLength(2);
  expect((await mockState(request)).mealplans.length).toBe(plansBefore + 2);
});

test("meals page shows the week and the ingredients needed", async ({ page }) => {
  await page.goto("/meals");
  await expect(page.getByRole("heading", { name: "Meals" })).toBeVisible();
  await expect(page.getByText("Spaghetti al Pomodoro").first()).toBeVisible();
  await expect(page.getByText("Ingredients needed this week")).toBeVisible();
  await expect(page.getByText(/Butter — No Grocy product is mapped/)).toBeVisible();
});

test("assistant answers from live inventory and only writes after confirmation", async ({ page, request }) => {
  await page.goto("/assistant");
  await page.getByRole("button", { name: "What's in our freezer?" }).click();
  await expect(page.getByText(/Chicken thighs: 680 g/)).toBeVisible();
  await page.getByPlaceholder("Ask about food, meals or groceries").fill("Add oat milk to the grocery list");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Add oat milk to Trader Joe's (Alameda)", { exact: true })).toBeVisible();
  expect((await mockState(request)).items).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("main").getByText("Done", { exact: true })).toBeVisible();
  expect((await mockState(request)).items.some((i) => i.note === "oat milk")).toBe(true);
});

test("automation endpoints answer n8n with the API token", async ({ request }) => {
  const r = await request.post("/api/automation/alerts", { headers: { Authorization: `Bearer ${E2E_API_TOKEN}` }, data: {} });
  expect(r.ok()).toBe(true);
  const body = await r.json();
  expect(body.message).toMatch(/Chicken thighs/);
  const repeat = await (await request.post("/api/automation/alerts", { headers: { Authorization: `Bearer ${E2E_API_TOKEN}` }, data: {} })).json();
  expect(repeat.send).toHaveLength(0);
});

import { expect, test } from "@playwright/test";
import { grocyCalls, login, mockState, resetMock, total } from "./helpers";

const P = { barilla: 11, penne: 12, tomatoes: 50, onion: 60, parmesan: 70, milk: 20, eggs: 30 };

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
});

test("mark tonight's dinner cooked: preview, resolve, deduct exactly once, reverse", async ({ page, request }) => {
  // Fresh plan entry so earlier runs' journals never interfere.
  const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
  const created = await page.request.post("/api/meals", { data: { date: today, entryType: "dinner", recipeId: "recipe-spaghetti-al-pomodoro", servings: 4 } });
  const { id } = await created.json();
  await page.goto(`/cook/spaghetti-al-pomodoro?entry=${id}&servings=4`);

  await expect(page.getByRole("heading", { name: "Spaghetti al Pomodoro" })).toBeVisible();
  // Butter has no Grocy product mapping: it blocks until the household decides.
  await expect(page.getByText("Not linked")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark as cooked" })).toBeDisabled();
  await expect(page.getByText("1 line(s) need a decision above.")).toBeVisible();
  const butter = page.locator("div").filter({ hasText: /^2 tablespoon Butter/ }).first();
  await butter.getByLabel("Didn’t use").check();
  // 1 lb of pasta comes from the earliest-expiring compatible product first (the 500 g penne).
  await expect(page.getByText("− 453.6 g Trader Joe's Penne 500 g")).toBeVisible();
  await page.getByRole("button", { name: "Mark as cooked" }).click();

  await expect(page.getByText("Recorded", { exact: true })).toBeVisible();
  let s = await mockState(request);
  expect(total(s, P.penne)).toBeCloseTo(46.4076, 3);
  expect(total(s, P.barilla)).toBeCloseTo(453.5924, 3);
  expect(total(s, P.tomatoes)).toBe(794);
  expect(total(s, P.onion)).toBe(2);
  expect(total(s, P.parmesan)).toBe(100);
  expect(s.timeline.at(-1)?.subject).toBe("Cooked 4 servings (Household Hub)");
  const consumesAfterCook = grocyCalls(s, /\/consume$/).length;

  // Opening the same planned meal again cannot deduct it a second time.
  await page.goto(`/cook/spaghetti-al-pomodoro?entry=${id}&servings=4`);
  await expect(page.getByText("already recorded as cooked")).toBeVisible();

  // Reverse from the cooking record: everything goes back.
  await page.getByRole("button", { name: "View cooking record" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Undo cooking" }).click();
  await expect(page.getByText("Reversed")).toBeVisible();
  s = await mockState(request);
  expect(total(s, P.penne)).toBe(500);
  expect(total(s, P.onion)).toBe(3);
  expect(grocyCalls(s, /\/consume$/).length).toBe(consumesAfterCook);
});

test("a repeated completion request with the same key is replayed, not re-deducted", async ({ page, request }) => {
  const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
  const { id } = await (await page.request.post("/api/meals", { data: { date: today, entryType: "lunch", recipeId: "recipe-scrambled-eggs", servings: 2 } })).json();
  const body = { idempotencyKey: "e2e-cook-000001", recipeSlug: "scrambled-eggs", mealplanEntryId: id, servings: 2, leftoverServings: 0, overrides: {}, extras: [] };
  const first = await (await page.request.post("/api/cook", { data: body })).json();
  const second = await (await page.request.post("/api/cook", { data: body })).json();
  expect(first.occurrence.status).toBe("completed");
  expect(second.replayed).toBe(true);
  const s = await mockState(request);
  expect(total(s, P.eggs)).toBe(8);
  expect(total(s, P.milk)).toBeCloseTo(886.8529, 3);
  // A different key for the same planned meal is refused.
  const other = await page.request.post("/api/cook", { data: { ...body, idempotencyKey: "e2e-cook-000002" } });
  expect(other.status()).toBe(409);
});

test("servings scale the deduction", async ({ page, request }) => {
  const r = await page.request.post("/api/cook", { data: { idempotencyKey: "e2e-cook-000003", recipeSlug: "scrambled-eggs", mealplanEntryId: null, servings: 1, overrides: {}, extras: [] } });
  expect((await r.json()).occurrence.status).toBe("completed");
  expect(total(await mockState(request), P.eggs)).toBe(10);
});

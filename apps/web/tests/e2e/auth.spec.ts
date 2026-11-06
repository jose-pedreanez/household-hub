import { expect, test } from "@playwright/test";
import { E2E_API_TOKEN, E2E_PASSWORD } from "../../playwright.config";
import { resetMock } from "./helpers";

test.beforeEach(async ({ request }) => resetMock(request));

test("signed-out visitors are sent to the login page", async ({ page }) => {
  await page.goto("/scan");
  await expect(page).toHaveURL(/\/login\?next=%2Fscan/);
});

test("wrong password is rejected; the right one opens the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Household password").fill("not-it");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Wrong password" })).toBeVisible();
  await page.getByLabel("Household password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Tonight" })).toBeVisible();
  await expect(page.getByText("Spaghetti al Pomodoro").first()).toBeVisible();
});

test("API routes require a session or the automation token", async ({ request }) => {
  expect((await request.get("/api/inventory")).status()).toBe(401);
  expect((await request.get("/api/inventory", { headers: { Authorization: "Bearer wrong-token" } })).status()).toBe(401);
  expect((await request.get("/api/inventory", { headers: { Authorization: `Bearer ${E2E_API_TOKEN}` } })).status()).toBe(200);
  expect((await request.get("/api/health")).status()).toBe(200);
});

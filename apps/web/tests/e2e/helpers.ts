import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_PASSWORD, MOCK_PORT } from "../../playwright.config";

export const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

export interface MockState {
  totals: Record<string, number>;
  calls: Array<{ service: string; method: string; path: string; body: Record<string, unknown> }>;
  items: Array<{ id: string; shoppingListId: string; checked: boolean; note: string; foodId: string | null; extras: Record<string, string> }>;
  timeline: Array<{ subject: string }>;
  products: Array<{ id: number; name: string; parent: number | null }>;
  barcodes: Array<{ barcode: string; product_id: number; amount: number; qu_id: number }>;
  mealplans: Array<{ id: number; date: string; entryType: string; recipeId: string | null }>;
}

export async function resetMock(request: APIRequestContext) {
  await request.post(`${MOCK}/__reset`);
}

export async function mockState(request: APIRequestContext): Promise<MockState> {
  return (await request.get(`${MOCK}/__state`)).json();
}

export const total = (s: MockState, productId: number) => s.totals[String(productId)];
export const grocyCalls = (s: MockState, path: RegExp) => s.calls.filter((c) => c.service === "grocy" && c.method === "POST" && path.test(c.path));

export async function login(page: Page) {
  const r = await page.request.post("/api/auth/login", { data: { password: E2E_PASSWORD } });
  expect(r.ok()).toBe(true);
}

/** Type like a USB/Bluetooth scanner in keyboard-wedge mode: fast keystrokes, then Enter. */
export async function wedgeScan(page: Page, code: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type(code, { delay: 4 });
  await page.keyboard.press("Enter");
}

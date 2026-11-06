import { expect, test } from "@playwright/test";
import { MILK_BARCODE } from "../../playwright.config";
import { grocyCalls, login, mockState, resetMock, total, wedgeScan } from "./helpers";

const MILK = 20;
const NUTELLA = "3017620422003";

test.beforeEach(async ({ page, request }) => {
  await resetMock(request);
  await login(page);
  await page.goto("/scan");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
});

test("hardware scanner (keyboard wedge): one scan adds one carton = 946 mL", async ({ page, request }) => {
  await page.getByRole("tab", { name: "Scanner" }).click();
  await wedgeScan(page, MILK_BARCODE);
  await expect(page.getByTestId("scan-session").getByText("+946 mL").first()).toBeVisible();
  expect(total(await mockState(request), MILK)).toBe(1892);
});

test("intentional rescans add more; +1 adds another; undo removes it", async ({ page, request }) => {
  await wedgeScan(page, MILK_BARCODE);
  await expect(page.getByTestId("scan-session").getByText("+946 mL")).toHaveCount(1);
  await page.waitForTimeout(500); // a person scanning the next carton
  await wedgeScan(page, MILK_BARCODE);
  await expect(page.getByTestId("scan-session").getByText("+946 mL")).toHaveCount(2);
  await page.getByRole("button", { name: "Book another package" }).first().click();
  await expect(page.getByTestId("scan-session").getByText("+946 mL")).toHaveCount(3);
  expect(total(await mockState(request), MILK)).toBe(946 * 4);
  await page.getByRole("button", { name: "Undo", exact: true }).first().click();
  await expect(page.getByTestId("scan-session").getByText("undone").first()).toBeVisible();
  expect(total(await mockState(request), MILK)).toBe(946 * 3);
});

test("retrying the same scan transaction never books twice", async ({ page, request }) => {
  const body = { idempotencyKey: "e2e-retry-0001", productId: MILK, barcode: MILK_BARCODE, packages: 1, source: "manual" };
  const a = await page.request.post("/api/scan/receive", { data: body });
  const b = await page.request.post("/api/scan/receive", { data: body });
  expect(a.ok() && b.ok()).toBe(true);
  expect((await b.json()).replayed).toBe(true);
  const s = await mockState(request);
  expect(total(s, MILK)).toBe(1892);
  expect(grocyCalls(s, /\/stock\/products\/20\/add$/)).toHaveLength(1);
});

test("unknown barcode: Open Food Facts prefill, register once, then booked", async ({ page, request }) => {
  await page.getByRole("tab", { name: "Type" }).click();
  await page.getByPlaceholder("Barcode number").fill(NUTELLA);
  await page.getByRole("button", { name: "Look up" }).click();
  const sheet = page.getByRole("dialog", { name: "New product" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByPlaceholder("Spaghetti")).toHaveValue("Nutella");
  await expect(sheet.getByPlaceholder("Optional")).toHaveValue("Ferrero");
  await expect(sheet.getByPlaceholder("500")).toHaveValue("400");
  await expect(sheet.getByText("Open Food Facts · unverified")).toBeVisible();
  await sheet.getByPlaceholder("e.g. Pasta").fill("Hazelnut spread");
  await expect(sheet.getByRole("button", { name: "Save product" })).toBeEnabled();
  await sheet.getByRole("button", { name: "Save product" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("scan-session").getByText("Ferrero Nutella").first()).toBeVisible();
  await expect(page.getByTestId("scan-session").getByText("+400 g").first()).toBeVisible();
  const s = await mockState(request);
  const bc = s.barcodes.find((b) => b.barcode === NUTELLA)!;
  expect(bc).toMatchObject({ amount: 400 });
  expect(total(s, bc.product_id)).toBe(400);
  const product = s.products.find((p) => p.id === bc.product_id)!;
  expect(s.products.find((p) => p.id === product.parent)?.name).toBe("Hazelnut spread");
  // A second scan needs no registration.
  await page.getByPlaceholder("Barcode number").fill(NUTELLA);
  await page.getByRole("button", { name: "Look up" }).click();
  await expect(page.getByRole("button", { name: "Put away" }).last()).toBeVisible();
});

test("barcode unknown to Open Food Facts asks for manual details and links nothing by itself", async ({ page, request }) => {
  await page.getByRole("tab", { name: "Type" }).click();
  await page.getByPlaceholder("Barcode number").fill("2000000000992");
  await page.getByRole("button", { name: "Look up" }).click();
  const sheet = page.getByRole("dialog", { name: "New product" });
  await expect(sheet.getByText("Open Food Facts doesn’t know this barcode")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save product" })).toBeDisabled();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  const s = await mockState(request);
  expect(s.calls.filter((c) => c.service === "grocy" && c.method === "POST")).toHaveLength(0);
});

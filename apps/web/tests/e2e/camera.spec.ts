import { expect, test } from "@playwright/test";
import { grocyCalls, login, mockState, resetMock, total } from "./helpers";

// Chromium's fake camera plays a looping video of the milk carton's EAN-13 (tests/support/make-barcode-video.mjs).
test("phone camera: decodes locally, books one package, and ignores the barcode while it stays in view", async ({ page, request }) => {
  await resetMock(request);
  await login(page);
  await page.goto("/scan");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByText("Hold the barcode inside the frame")).toBeVisible();
  await expect(page.getByTestId("scan-session").getByText("+946 mL").first()).toBeVisible({ timeout: 20_000 });
  // The same barcode keeps playing for several more seconds: no duplicate bookings.
  await page.waitForTimeout(5000);
  await expect(page.getByTestId("scan-session").getByText("+946 mL")).toHaveCount(1);
  const s = await mockState(request);
  expect(total(s, 20)).toBe(1892);
  expect(grocyCalls(s, /\/stock\/products\/20\/add$/)).toHaveLength(1);
  // The decoder was served by the hub itself, not a CDN.
  const wasm = await page.evaluate(() => {
    const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(".wasm"));
    return { count: urls.length, allLocal: urls.every((u) => u.startsWith(location.origin)) };
  });
  expect(wasm.count).toBeGreaterThan(0);
  expect(wasm.allLocal).toBe(true);
  await page.getByRole("button", { name: "Stop camera" }).click();
  await expect(page.getByText("Camera is off")).toBeVisible();
});

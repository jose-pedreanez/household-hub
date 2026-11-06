import { expect, test } from "@playwright/test";
import { E2E_API_TOKEN } from "../../playwright.config";
import { login } from "./helpers";

const SECRETS = ["mock-grocy-key", "mock-mealie-token", "mock-gms-secret", E2E_API_TOKEN, "e2e-session-secret"];

test("no upstream credential reaches the browser (HTML, JS bundles, or API responses)", async ({ page }) => {
  await login(page);
  const seen: string[] = [];
  page.on("response", async (r) => {
    const type = r.headers()["content-type"] ?? "";
    if (/javascript|html|json/.test(type)) seen.push(await r.text().catch(() => ""));
  });
  for (const path of ["/", "/scan", "/inventory", "/meals", "/shopping", "/assistant", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  const all = seen.join("\n");
  expect(all.length).toBeGreaterThan(10_000);
  for (const s of SECRETS) expect(all.includes(s), `${s} leaked`).toBe(false);
});

test("security headers are set", async ({ request }) => {
  const r = await request.get("/login");
  expect(r.headers()["x-frame-options"]).toBe("DENY");
  expect(r.headers()["permissions-policy"]).toContain("camera=(self)");
});

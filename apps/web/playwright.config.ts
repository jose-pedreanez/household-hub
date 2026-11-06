import { execFileSync } from "node:child_process";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run the production build of the hub against tests/support/mock-upstreams.mjs, a
 * deterministic stand-in for Grocy, Mealie, Grocy-Mealie Sync and Open Food Facts. They verify the UI,
 * the hub's API routes and its HTTP clients end to end — not the real upstream services, which are
 * covered by the integration suite (npm run test:integration) against a running stack.
 */
export const HUB_PORT = 3100;
export const MOCK_PORT = 4010;
export const E2E_PASSWORD = "e2e-household-password";
export const E2E_API_TOKEN = "e2e-automation-token-0123456789abcdef";
export const MILK_BARCODE = "2000000000039";

const here = __dirname;
const video = path.join(here, "tests/fixtures/generated/milk.y4m");
execFileSync(process.execPath, [path.join(here, "tests/support/make-barcode-video.mjs"), MILK_BARCODE, video]);

const mock = `http://127.0.0.1:${MOCK_PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${HUB_PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "phone", testIgnore: /camera\.spec/, use: { ...devices["Pixel 7"] } },
    {
      name: "camera",
      testMatch: /camera\.spec/,
      use: {
        ...devices["Pixel 7"],
        permissions: ["camera"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${video}`] },
      },
    },
  ],
  webServer: [
    { command: `node tests/support/mock-upstreams.mjs ${MOCK_PORT}`, url: `${mock}/__state`, reuseExistingServer: false, timeout: 20_000 },
    {
      command: "node tests/support/start-standalone.mjs",
      url: `http://127.0.0.1:${HUB_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(HUB_PORT),
        HOSTNAME: "127.0.0.1",
        TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
        HUB_PASSWORD: E2E_PASSWORD,
        HUB_SESSION_SECRET: "e2e-session-secret-0123456789abcdefghijklmnop",
        HUB_API_TOKEN: E2E_API_TOKEN,
        HUB_CONFIG_DIR: path.resolve(here, "../../config"),
        PUBLIC_BASE_URL: `http://127.0.0.1:${HUB_PORT}`,
        MEALIE_PUBLIC_URL: `${mock}/mealie`,
        GROCY_URL: `${mock}/grocy`,
        GROCY_API_KEY: "mock-grocy-key",
        MEALIE_URL: `${mock}/mealie`,
        MEALIE_API_TOKEN: "mock-mealie-token",
        MEALIE_NEEDS_LIST_ID: "list-needs",
        GMS_URL: `${mock}/gms`,
        GMS_AUTH_SECRET: "mock-gms-secret",
        OFF_BASE_URL: `${mock}/off`,
        OFF_USER_AGENT: "HouseholdHub/e2e",
        AI_PROVIDER: "none",
      },
    },
  ],
});

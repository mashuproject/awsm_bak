import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

export default defineConfig({
  testDir: ".",
  testMatch: "*.design.e2e.test.ts",
  globalTeardown: "../e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    baseURL: "http://127.0.0.1:3300",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  webServer: {
    command: resolve(repositoryRoot, "apps/coordination-server/script/run-browser-proof.sh"),
    url: "http://127.0.0.1:3300/ready",
    timeout: 180_000,
    reuseExistingServer: false,
  },
});

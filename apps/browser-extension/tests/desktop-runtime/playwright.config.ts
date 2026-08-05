import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "wails-management.e2e.test.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs",
    port: 4174,
    reuseExistingServer: false,
  },
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "desktop-runtime.e2e.test.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
});

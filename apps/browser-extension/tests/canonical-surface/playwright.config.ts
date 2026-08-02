import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.test.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 90_000,
  use: {
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
});

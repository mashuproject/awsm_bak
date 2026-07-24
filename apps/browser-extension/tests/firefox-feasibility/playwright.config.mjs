import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "firefox-feasibility.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  reporter: "line",
});

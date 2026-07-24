import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "synchronization.spec.mjs",
  globalTeardown: "../e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 300_000,
  expect: { timeout: 120_000 },
  webServer: [
    {
      command: "node ../e2e/server.mjs",
      port: 4174,
      reuseExistingServer: false,
    },
    {
      command: "../../../coordination-server/script/run-browser-proof.sh",
      url: "http://127.0.0.1:3300/ready",
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
});

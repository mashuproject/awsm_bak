import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.test.ts",
  globalTeardown: "../e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
  use: {
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

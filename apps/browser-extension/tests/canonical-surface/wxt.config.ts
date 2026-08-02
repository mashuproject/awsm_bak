import { defineConfig } from "wxt";

import { createManifest } from "../../wxt.config";

export default defineConfig({
  entrypointsDir: "tests/canonical-surface/entrypoints",
  outDir: ".output/canonical-surface",
  manifest: ({ browser }) => createManifest(browser === "firefox" ? "firefox" : "chrome"),
});

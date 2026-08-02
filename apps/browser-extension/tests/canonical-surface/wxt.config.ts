import { defineConfig } from "wxt";

import { createManifest } from "../../wxt.config";

export default defineConfig({
  outDir: ".output/canonical-surface",
  manifest: ({ browser }) => createManifest(browser === "firefox" ? "firefox" : "chrome"),
});

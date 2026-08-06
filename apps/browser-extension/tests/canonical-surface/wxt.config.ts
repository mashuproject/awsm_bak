import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";

import { createManifest } from "../../wxt.config";

export default defineConfig({
  outDir: ".output/canonical-surface",
  vite: () => ({ plugins: [react(), tailwindcss()] }),
  manifest: ({ browser }) => createManifest(browser === "firefox" ? "firefox" : "chrome"),
});

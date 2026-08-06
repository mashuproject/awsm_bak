import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserManifest } from "wxt";
import { FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES } from "./src/hosts/firefox/synchronization-permission";

export const FIREFOX_EXTENSION_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const ONNX_RUNTIME_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"] as const;
const THIRD_PARTY_NOTICES = fileURLToPath(
  new URL("./notices/THIRD_PARTY_NOTICES.txt", import.meta.url),
);

export function createManifest(browser: "chrome" | "firefox"): UserManifest {
  const shared: UserManifest = {
    name: "AWSM",
    short_name: "AWSM",
    description: "Archive what should matter, privately and locally.",
    icons: {
      16: "icon-16.png",
      32: "icon-32.png",
      48: "icon-48.png",
      128: "icon-128.png",
    },
    action: {
      default_icon: {
        16: "icon-16.png",
        32: "icon-32.png",
        48: "icon-48.png",
      },
    },
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };

  if (browser === "firefox") {
    return {
      ...shared,
      permissions: ["activeTab", "scripting", "unlimitedStorage", "downloads", "alarms"],
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_EXTENSION_ID,
          strict_min_version: "140.0",
          data_collection_permissions: {
            required: ["none"],
            optional: [...FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES],
          },
        },
        gecko_android: {
          strict_min_version: "142.0",
        },
      },
    };
  }

  return {
    ...shared,
    minimum_chrome_version: "116",
    permissions: ["activeTab", "scripting", "offscreen", "unlimitedStorage", "downloads", "alarms"],
  };
}

export default defineConfig({
  manifest: ({ browser }) => createManifest(browser === "firefox" ? "firefox" : "chrome"),
  vite: () => ({
    resolve: {
      conditions: ["onnxruntime-web-use-extern-wasm"],
    },
    build: {
      assetsInlineLimit: 0,
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "awsm-search-onnx-runtime-assets",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "THIRD_PARTY_NOTICES.txt",
            source: readFileSync(THIRD_PARTY_NOTICES),
          });
          for (const filename of ONNX_RUNTIME_FILES) {
            const source = readFileSync(
              fileURLToPath(import.meta.resolve(`onnxruntime-web/${filename}`)),
            );
            this.emitFile({
              type: "asset",
              fileName: `search-model-runtime/${filename}`,
              source,
            });
          }
        },
      },
    ],
  }),
  zip: {
    excludeSources: [
      "blob-report/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "tests/**",
    ],
  },
});

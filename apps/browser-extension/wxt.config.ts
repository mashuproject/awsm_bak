import { defineConfig, type UserManifest } from "wxt";

export const FIREFOX_EXTENSION_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";

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
          },
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
});

import { defineConfig } from "wxt";

const FIREFOX_EXTENSION_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";

export default defineConfig({
  entrypointsDir: "tests/firefox-feasibility/entrypoints",
  outDir: ".output/firefox-feasibility",
  manifest: {
    name: "AWSM Firefox feasibility gate",
    description: "Retained local Firefox Host capability proof.",
    permissions: ["activeTab", "scripting", "unlimitedStorage", "downloads", "alarms"],
    action: {
      default_title: "Run AWSM Firefox feasibility gate",
      default_area: "navbar",
    },
    commands: {
      _execute_action: {
        suggested_key: {
          default: "Ctrl+Shift+Y",
        },
      },
    },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_EXTENSION_ID,
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
  },
});

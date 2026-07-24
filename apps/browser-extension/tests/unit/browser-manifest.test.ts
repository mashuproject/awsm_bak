import { describe, expect, it } from "vitest";
import { createManifest, FIREFOX_EXTENSION_ID } from "../../wxt.config";

describe("browser manifests", () => {
  it("keeps the approved Chrome MV3 metadata", () => {
    expect(createManifest("chrome")).toMatchObject({
      minimum_chrome_version: "116",
      permissions: [
        "activeTab",
        "scripting",
        "offscreen",
        "unlimitedStorage",
        "downloads",
        "alarms",
      ],
      optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    });
  });

  it("emits the exact local-only Firefox MV3 metadata", () => {
    const manifest = createManifest("firefox");

    expect(manifest).toMatchObject({
      permissions: ["activeTab", "scripting", "unlimitedStorage", "downloads", "alarms"],
      optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_EXTENSION_ID,
          strict_min_version: "140.0",
          data_collection_permissions: {
            required: ["none"],
          },
        },
      },
    });
    expect(manifest).not.toHaveProperty("minimum_chrome_version");
    expect(manifest.permissions).not.toContain("pageCapture");
    expect(manifest.permissions).not.toContain("offscreen");
  });
});

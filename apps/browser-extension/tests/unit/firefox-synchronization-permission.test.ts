import { describe, expect, it, vi } from "vitest";
import {
  FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
  firefoxServerPermissionPattern,
  hasFirefoxSynchronizationPermission,
  requestFirefoxSynchronizationPermission,
  requestFirefoxSynchronizationPermissions,
} from "../../src/hosts/firefox/synchronization-permission";

const origin = "https://sync.example.test/*";

describe("Firefox synchronization permission", () => {
  it("uses Firefox's host-level pattern for a selected non-default port", () => {
    expect(firefoxServerPermissionPattern("http://127.0.0.1:4174")).toBe("http://127.0.0.1/*");
    expect(firefoxServerPermissionPattern("https://sync.example.test:8443/*")).toBe(
      "https://sync.example.test/*",
    );
  });

  it("requires the complete approved data category set and selected origin", () => {
    expect(
      hasFirefoxSynchronizationPermission(
        {
          origins: [origin],
          data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
        },
        origin,
      ),
    ).toBe(true);
    expect(
      hasFirefoxSynchronizationPermission(
        {
          origins: [origin],
          data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES.slice(1),
        },
        origin,
      ),
    ).toBe(false);
    expect(
      hasFirefoxSynchronizationPermission(
        {
          origins: ["https://other.example.test/*"],
          data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
        },
        origin,
      ),
    ).toBe(false);
  });

  it("requests the complete data and selected-origin permission from the user gesture", async () => {
    const request = vi.fn(async () => true);
    const granted = await requestFirefoxSynchronizationPermission(
      {
        getAll: async () => ({}),
        request,
      },
      origin,
    );

    expect(granted).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      origins: [origin],
      data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
    });
  });

  it("requests all selected Hosted Replica origins in one user gesture", async () => {
    const request = vi.fn(async () => true);
    await expect(
      requestFirefoxSynchronizationPermissions({ getAll: async () => ({}), request }, [
        origin,
        "https://archive.example.test/*",
        origin,
      ]),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({
      origins: ["https://archive.example.test/*", origin],
      data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
    });
  });

  it("lets Firefox silently resolve an already-granted request", async () => {
    const request = vi.fn(async () => true);
    await expect(
      requestFirefoxSynchronizationPermission(
        {
          getAll: async () => ({
            origins: [origin],
            data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
          }),
          request,
        },
        origin,
      ),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });
});

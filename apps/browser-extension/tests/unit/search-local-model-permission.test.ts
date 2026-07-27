import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MODEL_DOWNLOAD_ORIGINS,
  LocalModelDownloadPermission,
} from "../../src/runtime/search/local-model/permission";

describe("local model download permission", () => {
  it("requests only the two declared model-host origins and removes them after use", async () => {
    const api = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    const permission = new LocalModelDownloadPermission(api);

    await expect(permission.acquire()).resolves.toBe(true);
    await expect(permission.release()).resolves.toBe(true);
    expect(api.contains).toHaveBeenCalledWith({ origins: LOCAL_MODEL_DOWNLOAD_ORIGINS });
    expect(api.request).toHaveBeenCalledWith({ origins: LOCAL_MODEL_DOWNLOAD_ORIGINS });
    expect(api.remove).toHaveBeenCalledWith({ origins: LOCAL_MODEL_DOWNLOAD_ORIGINS });
  });

  it("does not request a permission that is already present", async () => {
    const api = {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => true),
    };

    await expect(new LocalModelDownloadPermission(api).acquire()).resolves.toBe(true);
    expect(api.request).not.toHaveBeenCalled();
  });
});

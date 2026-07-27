import { describe, expect, it, vi } from "vitest";
import { SearchProviderPermission } from "../../src/hosts/shared/search-provider-permission";
import {
  normalizeRemoteSearchEndpoint,
  remoteSearchEndpointIdentity,
  remoteSearchPermissionPattern,
} from "../../src/runtime/search/remote-endpoint";

describe("remote Search endpoint and permission boundary", () => {
  it("preserves a normalized exact endpoint while hashing only its path and query", async () => {
    const endpoint = "https://embeddings.example.test:8443/v1/embeddings?route=private";
    expect(normalizeRemoteSearchEndpoint(endpoint)).toBe(endpoint);
    expect(remoteSearchPermissionPattern(endpoint)).toBe("https://embeddings.example.test/*");
    await expect(remoteSearchEndpointIdentity(endpoint)).resolves.toEqual({
      endpoint,
      origin: "https://embeddings.example.test:8443",
      pathHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("allows loopback HTTP and rejects unsafe or ambiguous endpoints", () => {
    expect(normalizeRemoteSearchEndpoint("http://localhost:11434/v1/embeddings")).toBe(
      "http://localhost:11434/v1/embeddings",
    );
    expect(normalizeRemoteSearchEndpoint("http://[::1]:11434/v1/embeddings")).toBe(
      "http://[::1]:11434/v1/embeddings",
    );
    for (const endpoint of [
      "http://embeddings.example.test/v1/embeddings",
      "https://user:secret@embeddings.example.test/v1/embeddings",
      "https://embeddings.example.test/v1/embeddings#fragment",
      "file:///v1/embeddings",
      "/v1/embeddings",
    ]) {
      expect(() => normalizeRemoteSearchEndpoint(endpoint)).toThrow();
    }
  });

  it("requests only the host pattern and Firefox disclosure categories", async () => {
    const chromeApi = {
      getAll: vi.fn(async () => ({ origins: [] })),
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
    };
    await expect(
      new SearchProviderPermission(
        "https://embeddings.example.test:8443/v1/embeddings",
        chromeApi,
        false,
      ).acquire(),
    ).resolves.toBe(true);
    expect(chromeApi.request).toHaveBeenCalledWith({
      origins: ["https://embeddings.example.test/*"],
    });

    const firefoxApi = {
      getAll: vi.fn(async () => ({ origins: [] })),
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
    };
    await new SearchProviderPermission(
      "https://embeddings.example.test/v1/embeddings",
      firefoxApi,
      true,
    ).acquire();
    expect(firefoxApi.request).toHaveBeenCalledWith({
      origins: ["https://embeddings.example.test/*"],
      data_collection: [
        "websiteContent",
        "browsingActivity",
        "authenticationInfo",
        "personallyIdentifyingInfo",
      ],
    });
  });
});

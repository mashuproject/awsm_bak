import { describe, expect, it } from "vitest";
import { encodeCanonicalCbor } from "../../src/domain/cbor";
import { remoteSearchEndpointPathHash } from "../../src/runtime/search/remote-endpoint";
import {
  decodeSearchSettings,
  encodeSearchSettings,
  type SearchSettings,
  searchSettingsRevision,
} from "../../src/runtime/search/settings";

describe("per-Vault Search settings", () => {
  it("round-trips disabled, local, and remote settings with canonical revisions", async () => {
    const remoteEndpoint = "https://embeddings.example/v1/embeddings?route=private";
    const local: SearchSettings = {
      version: 1,
      semantic: "Local",
      provider: {
        version: 1,
        kind: "LocalMiniLm",
        model: "Xenova/all-MiniLM-L6-v2",
        modelRevision: "revision",
        dimensions: 384,
        pooling: "Mean",
        normalized: true,
      },
      disclosureVersion: 1,
    };
    const remote: SearchSettings = {
      version: 1,
      semantic: "Remote",
      provider: {
        version: 1,
        kind: "RemoteOpenAiCompatible",
        endpointOrigin: "https://embeddings.example",
        endpointPathHash: remoteSearchEndpointPathHash(remoteEndpoint),
        model: "embedding-model",
        dimensions: 768,
        pooling: "Mean",
        normalized: true,
      },
      endpoint: remoteEndpoint,
      protectedCredentialId: "search-key",
      disclosureVersion: 1,
    };

    for (const setting of [{ version: 1, semantic: "Disabled" } as const, local, remote]) {
      expect(decodeSearchSettings(encodeSearchSettings(setting))).toEqual(setting);
      expect(await searchSettingsRevision(setting)).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("rejects unknown fields and inconsistent provider/endpoint identity", () => {
    expect(() =>
      decodeSearchSettings(
        encodeCanonicalCbor({ version: 1, semantic: "Disabled", plaintextLeak: "no" }),
      ),
    ).toThrow();
    expect(() =>
      decodeSearchSettings(
        encodeCanonicalCbor({
          version: 1,
          semantic: "Remote",
          provider: {
            version: 1,
            kind: "RemoteOpenAiCompatible",
            endpointOrigin: "https://other.example",
            endpointPathHash: "a".repeat(64),
            model: "model",
            dimensions: 2,
            pooling: "Mean",
            normalized: true,
          },
          endpoint: "https://embeddings.example/v1/embeddings",
          protectedCredentialId: "key",
          disclosureVersion: 1,
        }),
      ),
    ).toThrow();
  });
});

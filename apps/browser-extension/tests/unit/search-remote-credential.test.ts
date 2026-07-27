import { describe, expect, it } from "vitest";
import type { EmbeddingProviderIdentity } from "../../src/runtime/search/contracts";
import {
  createRemoteSearchCredentialKey,
  openRemoteSearchCredential,
  sealRemoteSearchCredential,
} from "../../src/runtime/search/remote-credential";

const provider: EmbeddingProviderIdentity = {
  version: 1,
  kind: "RemoteOpenAiCompatible",
  endpointOrigin: "https://embeddings.example.test",
  endpointPathHash: "a".repeat(64),
  model: "resolved-model",
  dimensions: 384,
  pooling: "Mean",
  normalized: true,
};

describe("remote Search API-key protection", () => {
  it("round-trips through a non-exportable AES-GCM key bound to exact provider identity", async () => {
    const key = await createRemoteSearchCredentialKey();
    const stored = await sealRemoteSearchCredential({
      key,
      vaultId: "00000000-0000-4000-8000-000000000001",
      credentialId: "search-credential",
      provider,
      apiKey: new TextEncoder().encode("private-api-key"),
    });

    expect(key.extractable).toBe(false);
    expect(new TextDecoder().decode(stored.ciphertext)).not.toContain("private-api-key");
    await expect(
      openRemoteSearchCredential({
        key,
        vaultId: "00000000-0000-4000-8000-000000000001",
        credentialId: "search-credential",
        provider,
        stored,
      }),
    ).resolves.toEqual(new TextEncoder().encode("private-api-key"));
  });

  it("rejects a wrong Vault, credential, endpoint identity, model, or dimensions", async () => {
    const key = await createRemoteSearchCredentialKey();
    const stored = await sealRemoteSearchCredential({
      key,
      vaultId: "00000000-0000-4000-8000-000000000001",
      credentialId: "search-credential",
      provider,
      apiKey: new TextEncoder().encode("private-api-key"),
    });
    const attempts = [
      {
        vaultId: "00000000-0000-4000-8000-000000000002",
        credentialId: "search-credential",
        provider,
      },
      {
        vaultId: "00000000-0000-4000-8000-000000000001",
        credentialId: "other-credential",
        provider,
      },
      {
        vaultId: "00000000-0000-4000-8000-000000000001",
        credentialId: "search-credential",
        provider: { ...provider, endpointPathHash: "b".repeat(64) },
      },
      {
        vaultId: "00000000-0000-4000-8000-000000000001",
        credentialId: "search-credential",
        provider: { ...provider, model: "other-model" },
      },
      {
        vaultId: "00000000-0000-4000-8000-000000000001",
        credentialId: "search-credential",
        provider: { ...provider, dimensions: 768 },
      },
    ];
    for (const attempt of attempts) {
      await expect(openRemoteSearchCredential({ key, stored, ...attempt })).rejects.toThrow();
    }
  });
});

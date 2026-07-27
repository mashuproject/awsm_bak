import { describe, expect, it } from "vitest";
import { decodeStoredSearchEnvelope } from "../../src/drivers/indexeddb/search-decode";
import { openSearchProjectionRow, sealSearchProjectionRow } from "../../src/runtime/search/crypto";
import { importVaultKeyring } from "../../src/runtime/vault/keyring";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const EPOCH_ID = "20000000-0000-4000-8000-000000000002";
const SOURCE_REVISION = "ab".repeat(32);

async function keyring(seed = 7) {
  return importVaultKeyring(EPOCH_ID, [
    {
      keyEpochId: EPOCH_ID,
      ordinal: 0,
      rootKey: Uint8Array.from({ length: 32 }, (_, index) => (index + seed) % 256),
    },
  ]);
}

describe("Search Projection encryption", () => {
  it("round-trips one authenticated AES-GCM Projection row without plaintext persistence", async () => {
    const plaintext = new TextEncoder().encode("private title and passage");
    const stored = await sealSearchProjectionRow({
      keyring: await keyring(),
      vaultId: VAULT_ID,
      rowId: "bundle-row",
      projectionType: "SearchKeyword-v1",
      sourceRevision: SOURCE_REVISION,
      plaintext,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
    });

    expect(stored.nonce).toHaveLength(12);
    expect(new TextDecoder().decode(stored.ciphertext)).not.toContain("private title");
    expect(
      new TextDecoder().decode(
        await openSearchProjectionRow({
          keyring: await keyring(),
          stored,
        }),
      ),
    ).toBe("private title and passage");
  });

  it("binds Vault, row, type, revision, epoch, and ciphertext", async () => {
    const stored = await sealSearchProjectionRow({
      keyring: await keyring(),
      vaultId: VAULT_ID,
      rowId: "bundle-row",
      projectionType: "SearchSemantic-v1",
      sourceRevision: SOURCE_REVISION,
      plaintext: new Uint8Array([1, 2, 3]),
    });

    for (const tampered of [
      { ...stored, vaultId: "30000000-0000-4000-8000-000000000003" },
      { ...stored, rowId: "other-row" },
      { ...stored, projectionType: "SearchKeyword-v1" as const },
      { ...stored, sourceRevision: "cd".repeat(32) },
      { ...stored, keyEpochId: "40000000-0000-4000-8000-000000000004" },
      {
        ...stored,
        ciphertext: Uint8Array.from(stored.ciphertext, (byte, index) =>
          index === 0 ? byte ^ 1 : byte,
        ),
      },
    ]) {
      await expect(
        openSearchProjectionRow({ keyring: await keyring(), stored: tampered }),
      ).rejects.toThrow();
    }
  });

  it("strictly decodes persisted envelopes", () => {
    const canonical = {
      version: 1,
      vaultId: VAULT_ID,
      keyEpochId: EPOCH_ID,
      rowId: "bundle-row",
      projectionType: "SearchKeyword-v1",
      sourceRevision: SOURCE_REVISION,
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    } as const;

    expect(decodeStoredSearchEnvelope(canonical)).toEqual(canonical);
    for (const value of [
      { ...canonical, version: 2 },
      { ...canonical, nonce: new Uint8Array(24) },
      { ...canonical, sourceRevision: "not-a-hash" },
      { ...canonical, projectionType: "SearchHistory-v1" },
      { ...canonical, plaintextTitle: "leak" },
    ]) {
      expect(() => decodeStoredSearchEnvelope(value)).toThrow();
    }
  });

  it("uses projection generations only for the Vault statistics envelope", () => {
    const generation = "30000000-0000-4000-8000-000000000003:42";
    const statistics = {
      version: 1,
      vaultId: VAULT_ID,
      keyEpochId: EPOCH_ID,
      rowId: VAULT_ID,
      projectionType: "SearchKeywordStatistics-v1",
      sourceRevision: generation,
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(16),
    } as const;

    expect(decodeStoredSearchEnvelope(statistics).sourceRevision).toBe(generation);
    expect(() =>
      decodeStoredSearchEnvelope({
        ...statistics,
        projectionType: "SearchKeyword-v1",
      }),
    ).toThrow();
    expect(() =>
      decodeStoredSearchEnvelope({
        ...statistics,
        projectionType: "SearchKeywordStatistics-v1",
        sourceRevision: SOURCE_REVISION,
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { buildSearchDocument } from "../../src/runtime/search/documents";
import { buildKeywordRow } from "../../src/runtime/search/keyword";
import {
  deriveSearchKeywordLookupKey,
  keywordPostingEntries,
  searchKeywordPostingKey,
  searchKeywordPostingRevision,
} from "../../src/runtime/search/postings";
import { importVaultKeyring } from "../../src/runtime/vault/keyring";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_VAULT_ID = "30000000-0000-4000-8000-000000000003";
const EPOCH_ID = "20000000-0000-4000-8000-000000000002";

async function keyring(seed: number) {
  return importVaultKeyring(EPOCH_ID, [
    {
      keyEpochId: EPOCH_ID,
      ordinal: 0,
      rootKey: Uint8Array.from({ length: 32 }, (_, index) => (index + seed) % 256),
    },
  ]);
}

describe("secret-keyed Search postings", () => {
  it("derives a non-exportable HMAC lookup key and opaque deterministic posting keys", async () => {
    const lookupKey = await deriveSearchKeywordLookupKey(await keyring(7), VAULT_ID);
    const first = await searchKeywordPostingKey(lookupKey, "term", "private");
    const repeated = await searchKeywordPostingKey(lookupKey, "term", "private");

    expect(lookupKey.type).toBe("secret");
    expect(lookupKey.extractable).toBe(false);
    expect(lookupKey.usages).toEqual(["sign"]);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toBe(repeated);
    expect(first).not.toContain("private");
  });

  it("separates namespaces, Vaults, and epoch root keys", async () => {
    const lookupKey = await deriveSearchKeywordLookupKey(await keyring(7), VAULT_ID);
    const otherVaultKey = await deriveSearchKeywordLookupKey(await keyring(7), OTHER_VAULT_ID);
    const otherRootKey = await deriveSearchKeywordLookupKey(await keyring(8), VAULT_ID);

    const values = await Promise.all([
      searchKeywordPostingKey(lookupKey, "term", "example"),
      searchKeywordPostingKey(lookupKey, "title-exact", "example"),
      searchKeywordPostingKey(lookupKey, "url-exact", "example"),
      searchKeywordPostingKey(otherVaultKey, "term", "example"),
      searchKeywordPostingKey(otherRootKey, "term", "example"),
    ]);

    expect(new Set(values)).toHaveLength(values.length);
  });

  it("rejects empty or non-normalized posting values", async () => {
    const lookupKey = await deriveSearchKeywordLookupKey(await keyring(7), VAULT_ID);

    await expect(searchKeywordPostingKey(lookupKey, "term", "")).rejects.toThrow();
    await expect(searchKeywordPostingKey(lookupKey, "term", "e\u0301")).rejects.toThrow();
    await expect(
      searchKeywordPostingKey(lookupKey, "history" as "term", "example"),
    ).rejects.toThrow();
  });

  it("builds unique term and exact-value entries with authenticated revisions", async () => {
    const document = await buildSearchDocument({
      vaultId: VAULT_ID,
      bundleId: "40000000-0000-4000-8000-000000000004",
      collectionId: "50000000-0000-4000-8000-000000000005",
      collectionTitle: "Research",
      status: "Active",
      title: "Private PRIVATE notes",
      canonicalUrl: "https://example.com/Private",
      knownUrls: ["https://example.com/Private", "https://example.com/other"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: "60000000-0000-4000-8000-000000000006",
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: "Private local search" },
    });
    const lookupKey = await deriveSearchKeywordLookupKey(await keyring(7), VAULT_ID);
    const entries = await keywordPostingEntries(lookupKey, buildKeywordRow(document));

    expect(
      entries.filter(({ namespace, value }) => namespace === "term" && value === "private"),
    ).toHaveLength(1);
    expect(entries).toEqual(
      [...entries].sort(
        (left, right) =>
          left.opaqueMac.localeCompare(right.opaqueMac) ||
          left.namespace.localeCompare(right.namespace) ||
          left.value.localeCompare(right.value),
      ),
    );
    expect(entries.every(({ opaqueMac }) => /^[0-9a-f]{64}$/u.test(opaqueMac))).toBe(true);

    const revision = await searchKeywordPostingRevision({
      namespace: entries[0]?.namespace ?? "term",
      opaqueMac: entries[0]?.opaqueMac ?? "00".repeat(32),
      Active: [document.bundleId],
      Deleted: [],
    });
    expect(revision).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      searchKeywordPostingRevision({
        namespace: entries[0]?.namespace ?? "term",
        opaqueMac: entries[0]?.opaqueMac ?? "00".repeat(32),
        Active: [document.bundleId, document.bundleId],
        Deleted: [],
      }),
    ).rejects.toThrow();
  });
});

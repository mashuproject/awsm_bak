import { describe, expect, it } from "vitest";
import { buildSearchDocument } from "../../src/runtime/search/documents";
import { buildKeywordRow } from "../../src/runtime/search/keyword";
import {
  type RetainedSearchResult,
  SearchCoordinator,
  SearchCursorExpiredError,
  SearchSessionStore,
} from "../../src/runtime/search/service";
import {
  applyKeywordStatisticsChange,
  createKeywordStatistics,
} from "../../src/runtime/search/statistics";
import type { VaultKeyring } from "../../src/runtime/vault/keyring";

function result(index: number): RetainedSearchResult {
  return {
    bundleId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    passageId: String(index).padStart(64, "0"),
    match: "Keyword",
    score: index,
  };
}

describe("memory-only Search sessions", () => {
  it("pages with opaque 192-bit cursors and enforces Vault, generation, and client fences", () => {
    let now = 1_000;
    let random = 0;
    const sessions = new SearchSessionStore({
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(++random),
    });
    const created = sessions.create({
      clientInstanceId: "AAAAAAAAAAAAAAAAAAAAAA",
      vaultId: "10000000-0000-4000-8000-000000000001",
      vaultGeneration: "vault-generation",
      projectionGeneration: "30000000-0000-4000-8000-000000000003:4",
      filtersHash: "a".repeat(64),
      scope: "Active",
      results: Array.from({ length: 75 }, (_, index) => result(index)),
      resultCountIsComplete: true,
    });

    expect(created.results).toHaveLength(50);
    expect(created.cursor).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(
      sessions.more({
        cursor: created.cursor ?? "",
        clientInstanceId: "AAAAAAAAAAAAAAAAAAAAAA",
        vaultId: "10000000-0000-4000-8000-000000000001",
        vaultGeneration: "vault-generation",
        projectionGeneration: "30000000-0000-4000-8000-000000000003:4",
      }).results,
    ).toHaveLength(25);

    const fenced = sessions.create({
      clientInstanceId: "AAAAAAAAAAAAAAAAAAAAAA",
      vaultId: "10000000-0000-4000-8000-000000000001",
      vaultGeneration: "vault-generation",
      projectionGeneration: "30000000-0000-4000-8000-000000000003:4",
      filtersHash: "a".repeat(64),
      scope: "Active",
      results: Array.from({ length: 51 }, (_, index) => result(index)),
      resultCountIsComplete: true,
    });
    expect(() =>
      sessions.more({
        cursor: fenced.cursor ?? "",
        clientInstanceId: "BBBBBBBBBBBBBBBBBBBBBB",
        vaultId: "10000000-0000-4000-8000-000000000001",
        vaultGeneration: "vault-generation",
        projectionGeneration: "30000000-0000-4000-8000-000000000003:4",
      }),
    ).toThrow(SearchCursorExpiredError);

    now += 10 * 60_000 + 1;
    expect(() =>
      sessions.more({
        cursor: fenced.cursor ?? "",
        clientInstanceId: "AAAAAAAAAAAAAAAAAAAAAA",
        vaultId: "10000000-0000-4000-8000-000000000001",
        vaultGeneration: "vault-generation",
        projectionGeneration: "30000000-0000-4000-8000-000000000003:4",
      }),
    ).toThrow(SearchCursorExpiredError);
  });

  it("keeps four sessions per page, sixteen globally, and invalidates without persistence", () => {
    let tick = 0;
    const sessions = new SearchSessionStore({
      now: () => ++tick,
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    });
    const cursorByClient = new Map<string, string>();
    for (let index = 0; index < 20; index += 1) {
      const client = `${String(index).padStart(22, "A")}`.slice(-22);
      for (let own = 0; own < 5; own += 1) {
        const page = sessions.create({
          clientInstanceId: client,
          vaultId: "10000000-0000-4000-8000-000000000001",
          vaultGeneration: "generation",
          projectionGeneration: "30000000-0000-4000-8000-000000000003:1",
          filtersHash: "a".repeat(64),
          scope: "Active",
          results: Array.from({ length: 51 }, (_, item) => result(item)),
          resultCountIsComplete: true,
        });
        if (page.cursor !== undefined) cursorByClient.set(client, page.cursor);
      }
    }
    expect(sessions.size()).toBe(16);
    expect(sessions.countForClient("AAAAAAAAAAAAAAAAAAAAAA")).toBeLessThanOrEqual(4);
    sessions.invalidate();
    expect(sessions.size()).toBe(0);
  });
});

describe("Search coordinator", () => {
  it("retrieves posting-selected rows and returns useful keyword results without semantics", async () => {
    const vaultId = "10000000-0000-4000-8000-000000000001";
    const row = buildKeywordRow(
      await buildSearchDocument({
        vaultId,
        bundleId: "20000000-0000-4000-8000-000000000002",
        collectionId: "30000000-0000-4000-8000-000000000003",
        collectionTitle: "Research",
        status: "Active",
        title: "Private Search",
        canonicalUrl: "https://example.com/search",
        knownUrls: ["https://example.com/search"],
        capturedAt: "2026-07-26T00:00:00.000Z",
        artifactObjectId: "40000000-0000-4000-8000-000000000004",
        artifactChecksum: new Uint8Array(32),
        source: {
          role: "TEXT_EXTRACTED",
          text: `${"context ".repeat(200)}private passage match${" context".repeat(200)}`,
        },
      }),
    );
    const statistics = applyKeywordStatisticsChange(
      createKeywordStatistics("50000000-0000-4000-8000-000000000005"),
      undefined,
      row,
    );
    const coordinator = new SearchCoordinator({
      repository: {
        loadKeywordStatistics: async () => statistics,
        loadSearchSettings: async () => ({ version: 1, semantic: "Disabled" }),
        keywordCandidateBundleIds: async () => ({
          ordinary: [row.document.bundleId],
          exactTitle: [],
          exactUrl: [],
          documentFrequencies: new Map([["match", 1]]),
        }),
        loadKeywordRows: async (_keyring, _vaultId, ids) =>
          ids.includes(row.document.bundleId) ? [row] : [],
        scanSemanticCaptures: async () => undefined,
        loadSemanticPassages: async () => undefined,
      },
      providerFor: async () => {
        throw new Error("Semantic provider must not be loaded.");
      },
    });

    const page = await coordinator.search({
      keyring: {} as VaultKeyring,
      vaultId,
      vaultGeneration: "vault-generation",
      clientInstanceId: "AAAAAAAAAAAAAAAAAAAAAA",
      query: "match",
      filters: { scope: "Active", hosts: [], collectionIds: [] },
      signal: new AbortController().signal,
    });

    expect(page).toMatchObject({
      resultCount: 1,
      resultCountIsComplete: true,
      semantic: { state: "NotConfigured" },
      coverage: { eligibleCaptures: 1, keywordCaptures: 1, semanticCaptures: 0 },
      results: [
        {
          bundleId: row.document.bundleId,
          title: "Private Search",
          match: "Keyword",
        },
      ],
    });
    expect(page.results[0]?.snippet).toContain("private passage match");
    expect(Array.from(page.results[0]?.snippet ?? "").length).toBeLessThanOrEqual(320);
  });
});

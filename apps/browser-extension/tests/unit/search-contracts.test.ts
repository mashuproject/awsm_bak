import { describe, expect, it } from "vitest";
import { isAppRequest } from "../../src/app/protocol";
import { isSearchRequest } from "../../src/app/search-protocol";
import { decodeRuntimeError } from "../../src/domain/decode";
import { DATABASE_VERSION, STORES } from "../../src/drivers/indexeddb/schema";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const CLIENT_ID = "abcdefghijklmnopqrstuv";

describe("Search contracts", () => {
  it("declares every local-only Search store in the fresh schema", () => {
    expect(DATABASE_VERSION).toBe(1);
    expect([
      STORES.searchSettings,
      STORES.searchModelReferences,
      STORES.searchKeywordRows,
      STORES.searchKeywordStatistics,
      STORES.searchKeywordPostings,
      STORES.searchSemanticRows,
      STORES.searchSemanticPassages,
      STORES.searchIndexJobs,
      STORES.searchIndexCheckpoints,
    ]).toEqual([
      "search_settings",
      "search_model_references",
      "search_keyword_rows",
      "search_keyword_statistics",
      "search_keyword_postings",
      "search_semantic_rows",
      "search_semantic_passages",
      "search_index_jobs",
      "search_index_checkpoints",
    ]);
  });

  it("accepts a strict explicit Search request through the App boundary", () => {
    const request = {
      type: "SearchLibrary",
      expectedVaultId: VAULT_ID,
      clientInstanceId: CLIENT_ID,
      query: 'archive "exact phrase"',
      scope: "Active",
      filters: {
        hosts: ["example.com"],
        collectionIds: ["20000000-0000-4000-8000-000000000002"],
        capturedFrom: "2026-07-01T00:00:00.000Z",
        capturedBefore: "2026-08-01T00:00:00.000Z",
      },
      pageSize: 50,
    } as const;

    expect(isSearchRequest(request)).toBe(true);
    expect(isAppRequest(request)).toBe(true);
  });

  it("rejects implicit, oversized, unsorted, duplicated, and extended Search requests", () => {
    const canonical = {
      type: "SearchLibrary",
      expectedVaultId: VAULT_ID,
      clientInstanceId: CLIENT_ID,
      query: "archive",
      scope: "Active",
      filters: { hosts: [], collectionIds: [] },
      pageSize: 50,
    } as const;
    for (const request of [
      { ...canonical, pageSize: 25 },
      { ...canonical, query: "" },
      { ...canonical, query: "a".repeat(1_025) },
      { ...canonical, clientInstanceId: "short" },
      { ...canonical, scope: "All" },
      { ...canonical, filters: { hosts: ["b.example", "a.example"], collectionIds: [] } },
      { ...canonical, filters: { hosts: ["a.example", "a.example"], collectionIds: [] } },
      { ...canonical, filters: { hosts: [], collectionIds: [], unknown: true } },
      { ...canonical, unknown: true },
    ]) {
      expect(isSearchRequest(request)).toBe(false);
      expect(isAppRequest(request)).toBe(false);
    }
  });

  it("accepts only generation-bound Load more cursors", () => {
    expect(
      isSearchRequest({
        type: "LoadMoreSearchResults",
        expectedVaultId: VAULT_ID,
        clientInstanceId: CLIENT_ID,
        cursor: "a".repeat(32),
        pageSize: 50,
      }),
    ).toBe(true);
    expect(
      isSearchRequest({
        type: "LoadMoreSearchResults",
        expectedVaultId: VAULT_ID,
        clientInstanceId: CLIENT_ID,
        cursor: "query=private",
        pageSize: 50,
      }),
    ).toBe(false);
  });

  it("accepts only opaque Bundle and passage identities for local passage focus", () => {
    const request = {
      type: "GetSearchPassageFocus",
      expectedVaultId: VAULT_ID,
      bundleId: "20000000-0000-4000-8000-000000000002",
      passageId: "ab".repeat(32),
    } as const;
    expect(isSearchRequest(request)).toBe(true);
    expect(isAppRequest(request)).toBe(true);
    expect(isSearchRequest({ ...request, passageId: "query=private" })).toBe(false);
    expect(isSearchRequest({ ...request, query: "private" })).toBe(false);
  });

  it("strictly validates remote probes and local configuration Commands", () => {
    expect(
      isSearchRequest({
        type: "ProbeRemoteSearchProvider",
        expectedVaultId: VAULT_ID,
        endpoint: "https://embeddings.example.test/v1/embeddings?api-version=1",
        model: "embedding-model",
        dimensions: 384,
        apiKey: "secret",
      }),
    ).toBe(true);
    for (const endpoint of [
      "http://embeddings.example.test/v1/embeddings",
      "ftp://embeddings.example.test/v1/embeddings",
      "https://user:secret@embeddings.example.test/v1/embeddings",
      "relative",
    ]) {
      expect(
        isSearchRequest({
          type: "ProbeRemoteSearchProvider",
          expectedVaultId: VAULT_ID,
          endpoint,
          model: "embedding-model",
          apiKey: "secret",
        }),
      ).toBe(false);
    }
    expect(
      isSearchRequest({
        type: "ProbeRemoteSearchProvider",
        expectedVaultId: VAULT_ID,
        endpoint: "http://127.0.0.1:8080/v1/embeddings",
        model: "embedding-model",
        apiKey: "secret",
      }),
    ).toBe(true);
    expect(
      isSearchRequest({
        type: "ConfigureLocalSearch",
        expectedVaultId: VAULT_ID,
        acceptedDisclosureVersion: 1,
      }),
    ).toBe(true);
  });

  it("recognizes stable Search Runtime errors", () => {
    expect(
      decodeRuntimeError({
        id: "SEARCH_MODEL_INTEGRITY_FAILED",
        message: "The Search model failed integrity verification.",
      }),
    ).toMatchObject({ id: "SEARCH_MODEL_INTEGRITY_FAILED" });
  });
});

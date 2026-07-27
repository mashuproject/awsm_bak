import { describe, expect, it, vi } from "vitest";
import type { SearchIndexCheckpointV1, SearchIndexJobV1 } from "../../src/drivers/indexeddb/schema";
import type { EmbeddingProvider } from "../../src/runtime/search/contracts";
import { buildSearchDocument } from "../../src/runtime/search/documents";
import { SearchKeywordIndexer } from "../../src/runtime/search/indexer";
import { buildKeywordRow } from "../../src/runtime/search/keyword";
import { normalizeEmbedding, providerIdentityHash } from "../../src/runtime/search/semantic";
import {
  createKeywordStatistics,
  type SearchKeywordStatisticsMaterialization,
} from "../../src/runtime/search/statistics";
import { importVaultKeyring } from "../../src/runtime/vault/keyring";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const JOB_ID = "20000000-0000-4000-8000-000000000002";
const BUNDLE_ID = "30000000-0000-4000-8000-000000000003";
const GENERATION_ID = "40000000-0000-4000-8000-000000000004";
const readyGate = {
  connected: true,
  visible: true,
  expectedVaultActive: true,
  unlocked: true,
  paused: false,
  permissionPresent: true,
  online: true,
};

async function fixture() {
  const keyring = await importVaultKeyring("50000000-0000-4000-8000-000000000005", [
    {
      keyEpochId: "50000000-0000-4000-8000-000000000005",
      ordinal: 0,
      rootKey: new Uint8Array(32).fill(7),
    },
  ]);
  const row = buildKeywordRow(
    await buildSearchDocument({
      vaultId: VAULT_ID,
      bundleId: BUNDLE_ID,
      collectionId: "60000000-0000-4000-8000-000000000006",
      collectionTitle: "Research",
      status: "Active",
      title: "Private Search",
      canonicalUrl: "https://example.com/search",
      knownUrls: ["https://example.com/search"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: "70000000-0000-4000-8000-000000000007",
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: "Private local Search." },
    }),
  );
  const statistics = createKeywordStatistics(GENERATION_ID);
  const pending: SearchIndexCheckpointV1 = {
    version: 1,
    vaultId: VAULT_ID,
    jobId: JOB_ID,
    bundleId: BUNDLE_ID,
    sourceRevision: row.document.sourceRevision,
    keywordState: "Pending",
    semanticState: "NotConfigured",
    attemptCount: 0,
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
  const claimed: SearchIndexJobV1 = {
    version: 1,
    jobId: JOB_ID,
    vaultId: VAULT_ID,
    state: "Running",
    stage: "Keyword",
    projectionGeneration: `${GENERATION_ID}:0`,
    completedCaptures: 0,
    totalCaptures: 1,
    failedCaptures: 0,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:01.000Z",
    leaseOwner: "library-a",
    leaseExpiresAt: "2026-07-26T00:00:31.000Z",
  };
  return { keyring, row, statistics, pending, claimed };
}

describe("Search keyword indexer", () => {
  it("resumes pending checkpoints, commits one Capture, and completes the Job", async () => {
    const { keyring, row, statistics, pending, claimed } = await fixture();
    let currentJob = claimed;
    let currentStatistics: SearchKeywordStatisticsMaterialization = statistics;
    const commitKeywordCapture = vi.fn(async (input) => {
      currentJob = input.job;
      currentStatistics = {
        ...currentStatistics,
        revision: currentStatistics.revision + 1,
        Active: {
          documentCount: 1,
          totalFieldLengths: {
            Title: 2,
            Host: 2,
            CanonicalUrl: 2,
            KnownUrls: 2,
            Body: 3,
          },
          averageFieldLengths: {
            Title: 2,
            Host: 2,
            CanonicalUrl: 2,
            KnownUrls: 2,
            Body: 3,
          },
        },
      };
    });
    const completeSearchIndexJob = vi.fn(async () => {
      const { leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...durable } = currentJob;
      return {
        ...durable,
        state: "Succeeded" as const,
        stage: "Terminal" as const,
      };
    });
    const indexer = new SearchKeywordIndexer({
      repository: {
        claimSearchIndexLease: vi.fn(async () => claimed),
        renewSearchIndexLease: vi.fn(async () => currentJob),
        releaseSearchIndexLease: vi.fn(async () => currentJob),
        completeSearchIndexJob,
        listSearchIndexCheckpoints: vi.fn(async () => [pending]),
        loadSearchIndexCheckpoint: vi.fn(async () => pending),
        loadKeywordStatistics: vi.fn(async () => currentStatistics),
        loadSearchIndexJob: vi.fn(async () => currentJob),
        commitKeywordCapture,
        commitSemanticCapture: vi.fn(),
      },
      source: { loadKeywordRow: vi.fn(async () => row) },
      gate: async () => readyGate,
      now: () => "2026-07-26T00:00:02.000Z",
      onCommitted: vi.fn(async () => undefined),
    });

    const result = await indexer.run({
      vaultId: VAULT_ID,
      jobId: JOB_ID,
      owner: "library-a",
      keyring,
      signal: new AbortController().signal,
    });

    expect(result.state).toBe("Succeeded");
    expect(commitKeywordCapture).toHaveBeenCalledOnce();
    expect(commitKeywordCapture.mock.calls[0]?.[0]).toMatchObject({
      expectedProjectionGeneration: `${GENERATION_ID}:0`,
      checkpoint: {
        keywordState: "Committed",
        sourceRevision: row.document.sourceRevision,
      },
      job: { completedCaptures: 1, projectionGeneration: `${GENERATION_ID}:1` },
    });
    expect(completeSearchIndexJob).toHaveBeenCalledOnce();
  });

  it("claims then durably waits without loading plaintext when the Library is hidden", async () => {
    const { keyring, claimed } = await fixture();
    const releaseSearchIndexLease = vi.fn(async () => ({
      ...claimed,
      state: "WaitingForLibrary" as const,
    }));
    const loadKeywordRow = vi.fn();
    const indexer = new SearchKeywordIndexer({
      repository: {
        claimSearchIndexLease: vi.fn(async () => claimed),
        renewSearchIndexLease: vi.fn(async () => claimed),
        releaseSearchIndexLease,
        completeSearchIndexJob: vi.fn(),
        listSearchIndexCheckpoints: vi.fn(async () => []),
        loadSearchIndexCheckpoint: vi.fn(),
        loadKeywordStatistics: vi.fn(),
        loadSearchIndexJob: vi.fn(),
        commitKeywordCapture: vi.fn(),
        commitSemanticCapture: vi.fn(),
      },
      source: { loadKeywordRow },
      gate: async () => ({ ...readyGate, visible: false }),
      now: () => "2026-07-26T00:00:02.000Z",
      onCommitted: vi.fn(),
    });

    const result = await indexer.run({
      vaultId: VAULT_ID,
      jobId: JOB_ID,
      owner: "library-a",
      keyring,
      signal: new AbortController().signal,
    });

    expect(result.state).toBe("WaitingForLibrary");
    expect(releaseSearchIndexLease).toHaveBeenCalledWith(
      VAULT_ID,
      JOB_ID,
      "library-a",
      "WaitingForLibrary",
      "2026-07-26T00:00:02.000Z",
    );
    expect(loadKeywordRow).not.toHaveBeenCalled();
  });

  it("counts a configured-semantic Capture only after all passage vectors commit", async () => {
    const { keyring, row, statistics, pending, claimed } = await fixture();
    const provider: EmbeddingProvider = {
      identity: {
        version: 1,
        kind: "LocalMiniLm",
        model: "fixture",
        modelRevision: "revision",
        dimensions: 3,
        pooling: "Mean",
        normalized: true,
      },
      maximumBatchItems: 8,
      maximumInputBytes: 65_536,
      embed: vi.fn(async ({ texts }) => texts.map(() => normalizeEmbedding([1, 2, 3]))),
      dispose: vi.fn(async () => undefined),
    };
    const identityHash = await providerIdentityHash(provider.identity);
    const semanticPending = { ...pending, semanticState: "Pending" as const };
    let checkpoint: SearchIndexCheckpointV1 = semanticPending;
    let currentJob: SearchIndexJobV1 = { ...claimed, providerIdentityHash: identityHash };
    let currentStatistics = statistics;
    const commitKeywordCapture = vi.fn(async (input) => {
      currentJob = input.job;
      checkpoint = input.checkpoint;
      currentStatistics = { ...currentStatistics, revision: currentStatistics.revision + 1 };
    });
    const commitSemanticCapture = vi.fn(async (input) => {
      currentJob = input.job;
      checkpoint = input.checkpoint;
    });
    const indexer = new SearchKeywordIndexer({
      repository: {
        claimSearchIndexLease: vi.fn(async () => currentJob),
        renewSearchIndexLease: vi.fn(async () => currentJob),
        releaseSearchIndexLease: vi.fn(async () => currentJob),
        completeSearchIndexJob: vi.fn(async () => {
          const {
            leaseOwner: _leaseOwner,
            leaseExpiresAt: _leaseExpiresAt,
            ...durable
          } = currentJob;
          return { ...durable, state: "Succeeded" as const, stage: "Terminal" as const };
        }),
        listSearchIndexCheckpoints: vi.fn(async () => [semanticPending]),
        loadSearchIndexCheckpoint: vi.fn(async () => checkpoint),
        loadKeywordStatistics: vi.fn(async () => currentStatistics),
        loadSearchIndexJob: vi.fn(async () => currentJob),
        commitKeywordCapture,
        commitSemanticCapture,
      },
      source: { loadKeywordRow: vi.fn(async () => row) },
      gate: async () => readyGate,
      now: () => "2026-07-26T00:00:02.000Z",
      onCommitted: vi.fn(async () => undefined),
      embeddingProvider: provider,
    });

    const result = await indexer.run({
      vaultId: VAULT_ID,
      jobId: JOB_ID,
      owner: "library-a",
      keyring,
      signal: new AbortController().signal,
    });

    expect(commitKeywordCapture.mock.calls[0]?.[0].job.completedCaptures).toBe(0);
    expect(commitSemanticCapture.mock.calls[0]?.[0]).toMatchObject({
      job: { stage: "Semantic", completedCaptures: 1 },
      checkpoint: { keywordState: "Committed", semanticState: "Committed" },
      capture: { providerIdentityHash: identityHash },
    });
    expect(result).toMatchObject({ state: "Succeeded", completedCaptures: 1 });
  });

  it("durably fails the exact semantic checkpoint after provider retries are exhausted", async () => {
    const { keyring, row, pending, claimed } = await fixture();
    const provider: EmbeddingProvider = {
      identity: {
        version: 1,
        kind: "RemoteOpenAiCompatible",
        endpointOrigin: "https://embeddings.example.test",
        endpointPathHash: "ab".repeat(32),
        model: "fixture",
        dimensions: 3,
        pooling: "Mean",
        normalized: true,
      },
      maximumBatchItems: 32,
      maximumInputBytes: 24 * 1024,
      embed: vi.fn(async () => {
        throw Object.assign(new Error("redacted provider failure"), {
          id: "SEARCH_PROVIDER_UNAVAILABLE",
        });
      }),
      dispose: vi.fn(async () => undefined),
    };
    const identityHash = await providerIdentityHash(provider.identity);
    const checkpoint = {
      ...pending,
      keywordState: "Committed" as const,
      semanticState: "Pending" as const,
    };
    const currentJob = { ...claimed, providerIdentityHash: identityHash };
    const failSearchIndexCapture = vi.fn(async () => ({
      ...currentJob,
      state: "Failed" as const,
      failedCaptures: 1,
      errorId: "SEARCH_PROVIDER_UNAVAILABLE",
      retryAt: "2026-07-26T00:05:02.000Z",
    }));
    const indexer = new SearchKeywordIndexer({
      repository: {
        claimSearchIndexLease: vi.fn(async () => currentJob),
        renewSearchIndexLease: vi.fn(async () => currentJob),
        releaseSearchIndexLease: vi.fn(async () => currentJob),
        completeSearchIndexJob: vi.fn(),
        failSearchIndexCapture,
        listSearchIndexCheckpoints: vi.fn(async () => [checkpoint]),
        loadSearchIndexCheckpoint: vi.fn(async () => checkpoint),
        loadKeywordStatistics: vi.fn(),
        loadSearchIndexJob: vi.fn(async () => currentJob),
        commitKeywordCapture: vi.fn(),
        commitSemanticCapture: vi.fn(),
      },
      source: { loadKeywordRow: vi.fn(async () => row) },
      gate: async () => readyGate,
      now: () => "2026-07-26T00:00:02.000Z",
      onCommitted: vi.fn(),
      embeddingProvider: provider,
    });

    await expect(
      indexer.run({
        vaultId: VAULT_ID,
        jobId: JOB_ID,
        owner: "library-a",
        keyring,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("redacted provider failure");
    expect(failSearchIndexCapture).toHaveBeenCalledWith({
      vaultId: VAULT_ID,
      jobId: JOB_ID,
      bundleId: BUNDLE_ID,
      owner: "library-a",
      stage: "Semantic",
      errorId: "SEARCH_PROVIDER_UNAVAILABLE",
      now: "2026-07-26T00:00:02.000Z",
      retryAt: "2026-07-26T00:05:02.000Z",
    });
  });

  it("durably fails the exact semantic checkpoint for a malformed provider response", async () => {
    const { keyring, row, pending, claimed } = await fixture();
    const provider: EmbeddingProvider = {
      identity: {
        version: 1,
        kind: "LocalMiniLm",
        model: "fixture",
        modelRevision: "revision",
        dimensions: 3,
        pooling: "Mean",
        normalized: true,
      },
      maximumBatchItems: 8,
      maximumInputBytes: 65_536,
      embed: vi.fn(async () => []),
      dispose: vi.fn(async () => undefined),
    };
    const identityHash = await providerIdentityHash(provider.identity);
    const checkpoint = {
      ...pending,
      keywordState: "Committed" as const,
      semanticState: "Pending" as const,
    };
    const currentJob = { ...claimed, providerIdentityHash: identityHash };
    const failSearchIndexCapture = vi.fn(async () => ({
      ...currentJob,
      state: "Failed" as const,
      failedCaptures: 1,
      errorId: "SEARCH_PROVIDER_RESPONSE_INVALID",
    }));
    const indexer = new SearchKeywordIndexer({
      repository: {
        claimSearchIndexLease: vi.fn(async () => currentJob),
        renewSearchIndexLease: vi.fn(async () => currentJob),
        releaseSearchIndexLease: vi.fn(async () => currentJob),
        completeSearchIndexJob: vi.fn(),
        failSearchIndexCapture,
        listSearchIndexCheckpoints: vi.fn(async () => [checkpoint]),
        loadSearchIndexCheckpoint: vi.fn(async () => checkpoint),
        loadKeywordStatistics: vi.fn(),
        loadSearchIndexJob: vi.fn(async () => currentJob),
        commitKeywordCapture: vi.fn(),
        commitSemanticCapture: vi.fn(),
      },
      source: { loadKeywordRow: vi.fn(async () => row) },
      gate: async () => readyGate,
      now: () => "2026-07-26T00:00:02.000Z",
      onCommitted: vi.fn(),
      embeddingProvider: provider,
    });

    await expect(
      indexer.run({
        vaultId: VAULT_ID,
        jobId: JOB_ID,
        owner: "library-a",
        keyring,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("returned the wrong number of passage embeddings");
    expect(failSearchIndexCapture).toHaveBeenCalledWith({
      vaultId: VAULT_ID,
      jobId: JOB_ID,
      bundleId: BUNDLE_ID,
      owner: "library-a",
      stage: "Semantic",
      errorId: "SEARCH_PROVIDER_RESPONSE_INVALID",
      now: "2026-07-26T00:00:02.000Z",
    });
  });
});

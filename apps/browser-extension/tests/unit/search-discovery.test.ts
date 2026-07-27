import { describe, expect, it, vi } from "vitest";
import type { SearchIndexCheckpointV1, SearchIndexJobV1 } from "../../src/drivers/indexeddb/schema";
import { SearchIndexDiscovery } from "../../src/runtime/search/discovery";
import { createKeywordStatistics } from "../../src/runtime/search/statistics";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const JOB_ID = "20000000-0000-4000-8000-000000000002";
const GENERATION_ID = "30000000-0000-4000-8000-000000000003";
const BUNDLE_A = "40000000-0000-4000-8000-000000000004";
const BUNDLE_B = "50000000-0000-4000-8000-000000000005";
const REVISION_A = "aa".repeat(32);
const REVISION_B = "bb".repeat(32);
const NOW = "2026-07-26T00:00:00.000Z";

describe("Search index discovery", () => {
  it("durably creates each sorted checkpoint before finishing discovery", async () => {
    let job: SearchIndexJobV1 | undefined;
    const checkpoints: SearchIndexCheckpointV1[] = [];
    const beginKeywordGeneration = vi.fn(async (input) => {
      job = input.job;
    });
    const appendSearchIndexCheckpoint = vi.fn(async (_vaultId, _jobId, checkpoint, now) => {
      checkpoints.push(checkpoint);
      if (job === undefined) throw new Error("Fixture Job was not created.");
      job = { ...job, totalCaptures: checkpoints.length, updatedAt: now };
      return job;
    });
    const finishSearchIndexDiscovery = vi.fn(async () => {
      if (job === undefined) throw new Error("Fixture Job was not created.");
      job = { ...job, stage: "Keyword" };
      return job;
    });
    const discovery = new SearchIndexDiscovery({
      repository: {
        latestSearchIndexJob: vi.fn(async () => undefined),
        beginKeywordGeneration,
        listSearchIndexCheckpoints: vi.fn(async () => checkpoints),
        appendSearchIndexCheckpoint,
        finishSearchIndexDiscovery,
      },
      source: {
        async *discover() {
          yield { bundleId: BUNDLE_A, sourceRevision: REVISION_A };
          yield { bundleId: BUNDLE_B, sourceRevision: REVISION_B };
        },
      },
      now: () => NOW,
      uuid: vi.fn().mockReturnValueOnce(JOB_ID).mockReturnValueOnce(GENERATION_ID),
    });

    const result = await discovery.run({
      vaultId: VAULT_ID,
      keyring: {} as never,
      force: false,
      signal: new AbortController().signal,
    });

    expect(beginKeywordGeneration).toHaveBeenCalledWith({
      keyring: {},
      vaultId: VAULT_ID,
      statistics: createKeywordStatistics(GENERATION_ID),
      job: expect.objectContaining({
        jobId: JOB_ID,
        stage: "Discover",
        projectionGeneration: `${GENERATION_ID}:0`,
        totalCaptures: 0,
      }),
    });
    expect(checkpoints.map(({ bundleId }) => bundleId)).toEqual([BUNDLE_A, BUNDLE_B]);
    expect(checkpoints.every(({ keywordState }) => keywordState === "Pending")).toBe(true);
    expect(finishSearchIndexDiscovery).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ stage: "Keyword", totalCaptures: 2 });
  });

  it("resumes an interrupted Discover Job without rebuilding an existing checkpoint", async () => {
    const existingJob: SearchIndexJobV1 = {
      version: 1,
      jobId: JOB_ID,
      vaultId: VAULT_ID,
      state: "Created",
      stage: "Discover",
      projectionGeneration: `${GENERATION_ID}:0`,
      completedCaptures: 0,
      totalCaptures: 1,
      failedCaptures: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const checkpoint: SearchIndexCheckpointV1 = {
      version: 1,
      vaultId: VAULT_ID,
      jobId: JOB_ID,
      bundleId: BUNDLE_A,
      sourceRevision: REVISION_A,
      keywordState: "Pending",
      semanticState: "NotConfigured",
      attemptCount: 0,
      updatedAt: NOW,
    };
    const discover = vi.fn(async function* (_signal, skip: ReadonlySet<string>) {
      expect(skip).toEqual(new Set([BUNDLE_A]));
      yield { bundleId: BUNDLE_B, sourceRevision: REVISION_B };
    });
    const appendSearchIndexCheckpoint = vi.fn(async (_vaultId, _jobId, _checkpoint, now) => ({
      ...existingJob,
      totalCaptures: 2,
      updatedAt: now,
    }));
    const discovery = new SearchIndexDiscovery({
      repository: {
        latestSearchIndexJob: vi.fn(async () => existingJob),
        beginKeywordGeneration: vi.fn(),
        listSearchIndexCheckpoints: vi.fn(async () => [checkpoint]),
        appendSearchIndexCheckpoint,
        finishSearchIndexDiscovery: vi.fn(async () => ({
          ...existingJob,
          stage: "Keyword" as const,
          totalCaptures: 2,
        })),
      },
      source: { discover },
      now: () => NOW,
      uuid: vi.fn(),
    });

    const result = await discovery.run({
      vaultId: VAULT_ID,
      keyring: {} as never,
      force: false,
      signal: new AbortController().signal,
    });

    expect(discover).toHaveBeenCalledOnce();
    expect(appendSearchIndexCheckpoint).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ stage: "Keyword", totalCaptures: 2 });
  });
});

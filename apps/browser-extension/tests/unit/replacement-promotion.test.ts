import { describe, expect, it, vi } from "vitest";

import type { VaultReplacementJobV1 } from "../../src/drivers/indexeddb/schema";
import { VaultReplacementLocalPromoter } from "../../src/runtime/recovery/replacement-promotion";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function purgeJob(): VaultReplacementJobV1 {
  return {
    version: 1,
    jobId: id(1),
    accountId: id(2),
    sourceVaultId: id(3),
    sourceHead: {
      version: 1,
      vaultId: id(3),
      generationId: id(4),
      generationNumber: 2,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    sourceHeadCursor: 5,
    verifiedExportJobId: id(5),
    safelyStoredConfirmed: true,
    candidateIdempotencyKey: id(12),
    generationUploadCompleteIdempotencyKey: id(13),
    candidateCompleteIdempotencyKey: id(14),
    activationIdempotencyKey: id(15),
    state: "Running",
    stage: "PurgeSource",
    createdAt: "2026-07-25T23:00:00.000Z",
    updatedAt: "2026-07-25T23:01:00.000Z",
    targetVaultId: id(6),
    targetDeviceId: id(7),
    targetRecoveryGenerationId: id(8),
    targetKeyEpochId: id(9),
    targetGenerationId: id(10),
    targetGenerationNumber: 0,
    targetHeadCursor: 1,
    completedItems: 0,
    totalItems: 3,
    processedBytes: 0,
    totalBytes: 30,
    retryCount: 0,
    purgeId: id(11),
  };
}

describe("replacement local promotion cleanup", () => {
  it("retries source Artifact removal without requiring replacement secrets", async () => {
    const job = purgeJob();
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockResolvedValue(undefined);
    const clearSensitive = vi.fn(async () => undefined);
    const promoter = new VaultReplacementLocalPromoter(
      {
        commitVaultReplacement: async () => ({
          job,
          removedSourceArtifactObjectIds: [],
        }),
      },
      { reconcile },
      {
        clearSensitive,
        save: async () => undefined,
      },
    );

    await expect(promoter.finishLocalCleanup(job)).rejects.toThrow("interrupted");
    expect(clearSensitive).not.toHaveBeenCalled();

    await expect(promoter.finishLocalCleanup(job)).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenLastCalledWith(job.sourceVaultId, new Set());
    expect(clearSensitive).toHaveBeenCalledWith(job);
  });

  it("marks the Job terminal only after server purge succeeds", async () => {
    const job = purgeJob();
    const save = vi.fn(async () => undefined);
    const promoter = new VaultReplacementLocalPromoter(
      {
        commitVaultReplacement: async () => ({
          job,
          removedSourceArtifactObjectIds: [],
        }),
      },
      { reconcile: async () => undefined },
      { clearSensitive: async () => undefined, save },
    );

    const completed = await promoter.finishServerPurge(job, "2026-07-25T23:02:00.000Z");

    expect(completed).toMatchObject({
      state: "Succeeded",
      stage: "Terminal",
      completedItems: 3,
      processedBytes: 30,
    });
    expect(save).toHaveBeenCalledWith(completed, job.updatedAt);
  });
});

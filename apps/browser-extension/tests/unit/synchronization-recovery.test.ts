import { describe, expect, it } from "vitest";
import type { SynchronizationJobV1 } from "../../src/drivers/indexeddb/schema";
import { StaleReplicaDiscardService } from "../../src/runtime/synchronization/recovery";
import type { VaultKeyring } from "../../src/runtime/vault/keyring";

describe("stale Replica discard", () => {
  it("returns interrupted replacement to Conflict and removes only prepared replacement wrappers", async () => {
    const vaultId = crypto.randomUUID();
    const staleGenerationId = crypto.randomUUID();
    const remoteGenerationId = crypto.randomUUID();
    const preparedArtifactObjectId = crypto.randomUUID();
    const initial: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      vaultId,
      generationId: remoteGenerationId,
      generationNumber: 2,
      state: "Conflict",
      stage: "Checkpoint",
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      snapshotCursor: 8,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    const saved: SynchronizationJobV1[] = [];
    const removed: string[] = [];
    const failure = new Error("worker stopped");
    const service = new StaleReplicaDiscardService(
      {
        latestSynchronizationJob: async () => initial,
        loadAccountVault: async () => ({
          version: 1,
          accountId: initial.accountId,
          vaultId,
          activeRecoveryGenerationId: crypto.randomUUID(),
          activeKeyEpochId: crypto.randomUUID(),
          remoteGenerationId,
          remoteGenerationNumber: 2,
          deliveryCursor: 8,
        }),
        saveSynchronizationJob: async (job) => {
          saved.push(job);
        },
      },
      {} as never,
      {
        listStoredEvents: async () => [],
        listStoredObjects: async () => [],
        getVaultGeneration: async () => ({}) as never,
      },
      {
        metadata: { vaultId },
        head: { generationId: staleGenerationId },
      } as never,
      {} as VaultKeyring,
      {
        prepare: async (_job, _rootKey, _existing, _scope, beforeArtifactPrepare) => {
          await beforeArtifactPrepare?.(preparedArtifactObjectId);
          return { preparedArtifactObjectIds: [preparedArtifactObjectId] } as never;
        },
      },
      {
        remove: async (_vaultId: string, objectId: string) => {
          removed.push(objectId);
        },
      } as never,
      {
        prepareServerReplacement: async () => undefined,
        serverReplacementPrepared: async () => {
          throw failure;
        },
        beforeActivation: async () => undefined,
        afterActivation: async () => undefined,
      },
    );

    await expect(service.execute("2026-07-19T01:00:00.000Z")).rejects.toBe(failure);
    expect(saved).toContainEqual(
      expect.objectContaining({
        state: "Running",
        stage: "PrepareServerReplacement",
        preparedArtifactObjectIds: [preparedArtifactObjectId],
      }),
    );
    expect(saved.at(-1)).toEqual(
      expect.objectContaining({ state: "Conflict", stage: "Checkpoint" }),
    );
    expect(saved.at(-1)).not.toHaveProperty("preparedArtifactObjectIds");
    expect(removed).toEqual([preparedArtifactObjectId]);
  });
});

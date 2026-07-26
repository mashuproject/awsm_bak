import { describe, expect, it } from "vitest";
import type { SynchronizationJobV1 } from "../../src/drivers/indexeddb/schema";
import type { AtomicRemoteReconciliation } from "../../src/drivers/indexeddb/workspace-repository";
import { IncrementalPullRunner } from "../../src/runtime/synchronization/pull";
import { prepareVaultGeneration } from "../../src/runtime/vault/generation";
import { prepareVaultNameChange } from "../../src/runtime/vault/name-crypto";
import { testKeyring } from "../helpers/keyring";

const vaultId = "01900000-0000-7000-8000-000000000301";
const generationId = "01900000-0000-7000-8000-000000000302";
const keyEpochId = "01900000-0000-7000-8000-000000000309";

describe("incremental synchronization pull", () => {
  it("uses a fixed cursor snapshot and commits canonical Event order atomically", async () => {
    const rootKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(7),
      "HKDF",
      false,
      ["deriveBits"],
    );
    const generation = await prepareVaultGeneration({
      rootKey,
      vaultId,
      keyEpochId,
      deviceId: "01900000-0000-7000-8000-000000000303",
      generationId,
      generationNumber: 0,
      createdAt: "2026-07-19T10:00:00.000Z",
      reason: "Initial",
      retainedObjectIds: [],
      retainedEventIds: [],
    });
    const created = await prepareVaultNameChange({
      keyring: testKeyring(rootKey, keyEpochId),
      eventType: "VaultCreated",
      vaultId,
      deviceId: "01900000-0000-7000-8000-000000000303",
      eventId: "01900000-0000-7000-8000-000000000304",
      timestamp: "2026-07-19T10:00:00.000Z",
      name: "First Name",
    });
    const renamed = await prepareVaultNameChange({
      keyring: testKeyring(rootKey, keyEpochId),
      eventType: "VaultRenamed",
      vaultId,
      deviceId: "01900000-0000-7000-8000-000000000303",
      eventId: "01900000-0000-7000-8000-000000000305",
      timestamp: "2026-07-19T11:00:00.000Z",
      name: "Current Name",
    });
    const accountId = "01900000-0000-7000-8000-000000000306";
    const job: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId,
      vaultId,
      generationId,
      generationNumber: 0,
      state: "Running",
      stage: "FetchChanges",
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      snapshotCursor: 0,
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    const registration = {
      version: 1 as const,
      accountId,
      vaultId,
      activeRecoveryGenerationId: "01900000-0000-7000-8000-000000000307",
      activeKeyEpochId: keyEpochId,
      remoteGenerationId: generationId,
      remoteGenerationNumber: 0,
      deliveryCursor: 0,
    };
    let committed: AtomicRemoteReconciliation | undefined;
    const requested: string[] = [];
    const runner = new IncrementalPullRunner(
      {
        latestSynchronizationJob: async () => job,
        loadAccountVault: async () => registration,
      },
      {
        getVaultGeneration: async () => generation.generation,
        getVaultHead: async () => generation.head,
        listStoredEvents: async () => [],
        listStoredObjects: async () => [],
      },
      {
        load: async () => ({
          metadata: { workspaceId: "01900000-0000-7000-8000-000000000308" },
          nameCacheKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
          ]),
        }),
        commitRemoteReconciliation: async (input) => {
          committed = input;
        },
      },
      {
        prepare: async () => {
          throw new Error("unexpected");
        },
        prepareEncrypted: async () => undefined,
        openEncrypted: async () => {
          throw new Error("unexpected");
        },
        openPlaintext: async () => {
          throw new Error("unexpected");
        },
        has: async () => false,
        verifyEncrypted: async () => false,
        remove: async () => undefined,
        reconcile: async () => undefined,
      },
      {
        request: async (_method, path) => {
          requested.push(path);
          return {
            status: 200,
            body: {
              generationId,
              generationNumber: 0,
              changes: [
                {
                  cursor: 1,
                  kind: "EventCommitted",
                  generationId,
                  acceptedAt: "2026-07-19T10:00:01.000Z",
                },
                {
                  cursor: 2,
                  kind: "EventCommitted",
                  generationId,
                  acceptedAt: "2026-07-19T11:00:01.000Z",
                },
              ],
              nextCursor: 2,
              snapshotCursor: 2,
              hasMore: false,
            },
          };
        },
      },
      {
        prepare: async () => ({
          generation: generation.generation,
          head: {
            ...generation.head,
            appendedEventIds: [created.event.eventId, renamed.event.eventId].toSorted(),
          },
          events: [renamed.event, created.event],
          objects: [],
          preparedArtifactObjectIds: [],
        }),
      },
    );

    await expect(runner.run(testKeyring(rootKey, keyEpochId))).resolves.toBe(true);
    expect(requested[0]).toContain("after=0");
    expect(committed?.registration.deliveryCursor).toBe(2);
    expect(committed?.expectedLocalHead).toEqual(generation.head);
    expect(committed?.events.map((event) => event.eventId)).toEqual([
      created.event.eventId,
      renamed.event.eventId,
    ]);
    expect(committed?.vaultNameProjection.sourceEventId).toBe(renamed.event.eventId);
  });
});

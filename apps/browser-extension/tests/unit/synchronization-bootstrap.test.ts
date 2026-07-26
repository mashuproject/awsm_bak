import { describe, expect, it } from "vitest";
import type { SynchronizationJobV1 } from "../../src/drivers/indexeddb/schema";
import type { AtomicRemoteBootstrap } from "../../src/drivers/indexeddb/workspace-repository";
import { RemoteBootstrapRunner } from "../../src/runtime/synchronization/bootstrap";
import { prepareVaultGeneration } from "../../src/runtime/vault/generation";
import { prepareVaultNameChange } from "../../src/runtime/vault/name-crypto";
import { testKeyring } from "../helpers/keyring";

const accountId = "01900000-0000-7000-8000-000000000201";
const keyEpochId = "01900000-0000-7000-8000-000000000202";
const vaultId = "01900000-0000-7000-8000-000000000203";
const generationId = "01900000-0000-7000-8000-000000000204";

describe("remote Replica bootstrap", () => {
  it("prepares a fresh device slot and atomically activates verified authority", async () => {
    const rawRootKey = new Uint8Array(32).fill(6);
    const rootKey = await crypto.subtle.importKey("raw", rawRootKey, "HKDF", false, ["deriveBits"]);
    const generation = await prepareVaultGeneration({
      rootKey,
      vaultId,
      keyEpochId,
      deviceId: "01900000-0000-7000-8000-000000000205",
      generationId,
      generationNumber: 0,
      createdAt: "2026-07-19T12:00:00.000Z",
      reason: "Initial",
      retainedObjectIds: [],
      retainedEventIds: [],
    });
    const eventId = "01900000-0000-7000-8000-000000000206";
    const created = await prepareVaultNameChange({
      keyring: testKeyring(rootKey, keyEpochId),
      eventType: "VaultCreated",
      vaultId,
      deviceId: "01900000-0000-7000-8000-000000000205",
      eventId,
      timestamp: "2026-07-19T12:00:00.000Z",
      name: "Downloaded Vault",
    });
    let job: SynchronizationJobV1 = {
      version: 1 as const,
      jobId: crypto.randomUUID(),
      accountId,
      vaultId,
      generationId,
      generationNumber: 0,
      state: "Running" as const,
      stage: "DownloadRecords" as const,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      snapshotCursor: 2,
      completedItems: 0,
      totalItems: 2,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    let committed: AtomicRemoteBootstrap | undefined;
    const runner = new RemoteBootstrapRunner(
      {
        latestSynchronizationJob: async () => job,
        loadAccountVault: async () => ({
          version: 1,
          accountId,
          vaultId,
          activeRecoveryGenerationId: "01900000-0000-7000-8000-000000000208",
          activeKeyEpochId: keyEpochId,
          remoteGenerationId: generationId,
          remoteGenerationNumber: 0,
          deliveryCursor: 2,
        }),
        saveSynchronizationJob: async (next) => {
          job = next;
        },
      },
      {
        loadDeviceAuthority: async () =>
          ({
            accountId,
            vaultId,
            recoveryGenerationId: "01900000-0000-7000-8000-000000000208",
            identity: {
              deviceId: "01900000-0000-7000-8000-000000000209",
              signingPublicKey: new Uint8Array(32),
              signingSecretKey: new Uint8Array(64),
              wrappingPublicKey: new Uint8Array(32),
              wrappingSecretKey: new Uint8Array(32),
            },
            certificate: {},
            envelopes: [],
            keyEpochs: [{ keyEpochId, ordinal: 0, rootKey: Uint8Array.from(rawRootKey) }],
          }) as never,
      },
      {
        load: async () => ({
          metadata: { workspaceId: "01900000-0000-7000-8000-000000000207" },
          nameCacheKey: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
          ]),
        }),
        commitRemoteBootstrap: async (input) => {
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
        prepare: async () => ({
          generation: generation.generation,
          head: { ...generation.head, appendedEventIds: [eventId] },
          events: [created.event],
          objects: [],
          preparedArtifactObjectIds: [],
        }),
      },
    );

    await expect(runner.run()).resolves.toBe(vaultId);
    expect(committed?.job).toMatchObject({ stage: "ActivateLocal", state: "Running" });
    expect(committed?.records).toMatchObject({
      metadata: { vaultId, manuallyLocked: false },
      head: { generationId, appendedEventIds: [eventId] },
    });
    expect(committed?.records.metadata.deviceId).not.toBe("01900000-0000-7000-8000-000000000205");
    expect(committed?.vaultNameProjection).toMatchObject({ vaultId, sourceEventId: eventId });
  });
});

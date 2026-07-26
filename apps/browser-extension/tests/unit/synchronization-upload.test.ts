import { describe, expect, it, vi } from "vitest";
import { encodeEncryptedEnvelope, encryptEnvelope } from "../../src/crypto/envelope";
import type {
  SynchronizationCheckpointV1,
  SynchronizationJobV1,
} from "../../src/drivers/indexeddb/schema";
import { UploadRunner } from "../../src/runtime/synchronization/upload";

describe("synchronization upload ordering", () => {
  it("makes dependencies durable before publishing the Event closure", async () => {
    let job: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      vaultId: crypto.randomUUID(),
      generationId: crypto.randomUUID(),
      generationNumber: 0,
      state: "Running",
      stage: "UploadObjects",
      createdAt: "2026-07-19T21:00:00.000Z",
      updatedAt: "2026-07-19T21:00:00.000Z",
      snapshotCursor: 0,
      completedItems: 1,
      totalItems: 3,
      processedBytes: 3,
      totalBytes: 7,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    const checkpoints = new Map<string, SynchronizationCheckpointV1>();
    const calls: string[] = [];
    const transport = {
      request: vi.fn(async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path.endsWith("/uploads"))
          return {
            status: 201,
            body: {
              upload: {
                uploadId: crypto.randomUUID(),
                state: "Open",
                partSizeBytes: 1024,
                receivedParts: [],
              },
              ticket: { url: "/api/transfers/token/parts/{partNumber}" },
            },
          };
        return { status: 200, body: {} };
      }),
      putTransfer: vi.fn(async () => undefined),
    };
    const descriptorId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const keyEpochId = crypto.randomUUID();
    const descriptorEnvelope = encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType: "BundleDescriptor",
        objectId: descriptorId,
        keyEpochId,
        plaintext: new Uint8Array([1, 2]),
        key: new Uint8Array(32).fill(1),
      }),
    );
    const eventEnvelope = encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType: "Event",
        objectId: eventId,
        keyEpochId,
        plaintext: new Uint8Array([3, 4]),
        key: new Uint8Array(32).fill(2),
      }),
    );
    const runner = new UploadRunner(
      {
        latestSynchronizationJob: async () => job,
        saveSynchronizationJob: async (value) => {
          job = value;
        },
        synchronizationCheckpoint: async (_vaultId, kind, entityId) =>
          checkpoints.get(`${kind}:${entityId}`),
        saveSynchronizationCheckpoint: async (value) => {
          checkpoints.set(`${value.kind}:${value.entityId}`, value);
        },
      },
      {
        getVaultHead: async () => ({
          appendedObjectIds: [descriptorId],
          appendedEventIds: [eventId],
        }),
        listStoredObjects: async () => [
          {
            version: 1,
            objectId: descriptorId,
            objectType: "BundleDescriptor",
            envelopeBytes: descriptorEnvelope,
          },
        ],
        listStoredEvents: async () => [
          {
            version: 1,
            vaultId: job.vaultId as string,
            eventId,
            referencedObjectIds: [descriptorId],
            orderingTimestamp: "2026-07-19T20:00:00.000Z",
            envelopeBytes: eventEnvelope,
          },
        ],
      },
      { openEncrypted: vi.fn() },
      transport,
      async () => {
        calls.push("ACTIVATE");
      },
    );

    await runner.run("2026-07-19T21:01:00.000Z");

    const descriptorComplete = calls.findIndex(
      (call) => call.includes(`uploads/`) && call.endsWith("/complete"),
    );
    const commit = calls.findIndex((call) => call.endsWith("/commits"));
    const activation = calls.indexOf("ACTIVATE");
    const lastDurable = calls.findLastIndex(
      (call) => call.includes("uploads/") && call.endsWith("/complete"),
    );
    expect(descriptorComplete).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(lastDurable);
    expect(commit).toBeGreaterThan(activation);
    expect(checkpoints.get(`Event:${eventId}`)?.state).toBe("Committed");
    expect(job.stage).toBe("FetchChanges");
  });

  it("reuses an exact durable remote-only Artifact without opening OPFS", async () => {
    const vaultId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    let job: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      vaultId,
      generationId: crypto.randomUUID(),
      generationNumber: 3,
      state: "Running",
      stage: "UploadObjects",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
      snapshotCursor: 0,
      completedItems: 0,
      totalItems: 1,
      processedBytes: 0,
      totalBytes: 2048,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    let opened = 0;
    const checkpoints = new Map<string, SynchronizationCheckpointV1>();
    const runner = new UploadRunner(
      {
        latestSynchronizationJob: async () => job,
        saveSynchronizationJob: async (value) => {
          job = value;
        },
        synchronizationCheckpoint: async (_vaultId, kind, entityId) =>
          checkpoints.get(`${kind}:${entityId}`),
        saveSynchronizationCheckpoint: async (value) => {
          checkpoints.set(`${value.kind}:${value.entityId}`, value);
        },
      },
      {
        getVaultHead: async () => ({
          appendedObjectIds: [artifactId],
          appendedEventIds: [],
        }),
        listStoredObjects: async () => [
          {
            version: 1,
            objectId: artifactId,
            objectType: "Artifact",
            keyEpochId: "00000000-0000-4000-8000-000000000009",
            envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
            envelopeByteLength: 2048,
            envelopeChecksumAlgorithm: "hash:sha256:v1",
            envelopeChecksum: new Uint8Array(32).fill(3),
          },
        ],
        listStoredEvents: async () => [],
      },
      {
        openEncrypted: async () => {
          opened += 1;
          throw new Error("OPFS must not be read");
        },
      },
      {
        request: async (_method, path) =>
          path.endsWith("/uploads")
            ? {
                status: 200,
                body: {
                  upload: {
                    uploadId: crypto.randomUUID(),
                    state: "AlreadyDurable",
                    partSizeBytes: 1024,
                    receivedParts: [],
                  },
                  ticket: { url: "/unused/{partNumber}" },
                },
              }
            : { status: 200, body: {} },
        putTransfer: async () => undefined,
      },
      undefined,
      true,
      undefined,
      { isArtifactRemoteOnly: async () => true },
    );

    await runner.run();

    expect(opened).toBe(0);
    expect(checkpoints.get(`Object:${artifactId}`)?.state).toBe("Durable");
    expect(job.stage).toBe("FetchChanges");
  });

  it("blocks every pending old-epoch record before an upload request", async () => {
    const vaultId = crypto.randomUUID();
    const oldEpochId = crypto.randomUUID();
    const activeEpochId = crypto.randomUUID();
    const durableObjectId = crypto.randomUUID();
    const pendingEventId = crypto.randomUUID();
    const envelope = async (objectType: "BundleDescriptor" | "Event", objectId: string) =>
      encodeEncryptedEnvelope(
        await encryptEnvelope({
          objectType,
          objectId,
          keyEpochId: oldEpochId,
          plaintext: new Uint8Array([1]),
          key: new Uint8Array(32).fill(1),
        }),
      );
    const objectEnvelope = await envelope("BundleDescriptor", durableObjectId);
    const eventEnvelope = await envelope("Event", pendingEventId);
    const job: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      vaultId,
      generationId: crypto.randomUUID(),
      generationNumber: 1,
      state: "Running",
      stage: "UploadObjects",
      createdAt: "2026-07-25T20:00:00.000Z",
      updatedAt: "2026-07-25T20:00:00.000Z",
      snapshotCursor: 1,
      completedItems: 0,
      totalItems: 2,
      processedBytes: 0,
      totalBytes: 2,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    const request = vi.fn();
    const runner = new UploadRunner(
      {
        latestSynchronizationJob: async () => job,
        saveSynchronizationJob: async () => undefined,
        synchronizationCheckpoint: async (_vaultId, kind, entityId) =>
          kind === "Object" && entityId === durableObjectId
            ? {
                version: 1,
                vaultId,
                entityId,
                kind,
                state: "Durable",
                createIdempotencyKey: crypto.randomUUID(),
                completeIdempotencyKey: crypto.randomUUID(),
                receivedParts: [],
              }
            : undefined,
        saveSynchronizationCheckpoint: async () => undefined,
      },
      {
        getVaultHead: async () => ({
          appendedObjectIds: [durableObjectId],
          appendedEventIds: [pendingEventId],
        }),
        listStoredObjects: async () => [
          {
            version: 1,
            objectId: durableObjectId,
            objectType: "BundleDescriptor",
            envelopeBytes: objectEnvelope,
          },
        ],
        listStoredEvents: async () => [
          {
            version: 1,
            vaultId,
            eventId: pendingEventId,
            referencedObjectIds: [],
            orderingTimestamp: "2026-07-25T20:00:00.000Z",
            envelopeBytes: eventEnvelope,
          },
        ],
      },
      { openEncrypted: vi.fn() },
      { request, putTransfer: vi.fn() },
    );

    await expect(runner.assertPendingUploadsUseEpoch(activeEpochId)).rejects.toMatchObject({
      id: "KEY_EPOCH_CHANGED",
    });
    await expect(
      runner.assertPendingUploadsUseEpoch(activeEpochId, new Set([pendingEventId])),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

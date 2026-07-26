import { describe, expect, it } from "vitest";
import { bytesToBase64Url } from "../../src/runtime/account/wire";
import {
  RemoteReplicaDownloader,
  verifyPreparedRemoteReplica,
} from "../../src/runtime/synchronization/download";
import { prepareVaultGeneration } from "../../src/runtime/vault/generation";
import { prepareVaultNameChange } from "../../src/runtime/vault/name-crypto";
import { TEST_KEY_EPOCH_ID, testKeyring } from "../helpers/keyring";

const vaultId = "01900000-0000-7000-8000-000000000101";
const generationId = "01900000-0000-7000-8000-000000000102";

async function fixture(predecessorGenerationId?: string) {
  const raw = new Uint8Array(32).fill(4);
  const rootKey = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const prepared = await prepareVaultGeneration({
    rootKey,
    vaultId,
    keyEpochId: TEST_KEY_EPOCH_ID,
    deviceId: "01900000-0000-7000-8000-000000000103",
    generationId,
    generationNumber: predecessorGenerationId === undefined ? 0 : 1,
    ...(predecessorGenerationId === undefined ? {} : { predecessorGenerationId }),
    createdAt: "2026-07-19T12:00:00.000Z",
    reason: predecessorGenerationId === undefined ? "Initial" : "Vacuum",
    retainedObjectIds: [],
    retainedEventIds: [],
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(prepared.generation.envelopeBytes)),
  );
  const record = {
    objectId: generationId,
    objectType: "VaultGeneration",
    keyEpochId: TEST_KEY_EPOCH_ID,
    byteLength: prepared.generation.envelopeBytes.byteLength,
    sha256: bytesToBase64Url(digest),
    state: "Committed",
  };
  return { rootKey, keyring: testKeyring(rootKey), prepared, record };
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("remote Complete Replica download", () => {
  it("decrypts and validates canonical Vault semantics before activation", async () => {
    const value = await fixture();
    const eventId = "01900000-0000-7000-8000-000000000104";
    const created = await prepareVaultNameChange({
      keyring: value.keyring,
      eventType: "VaultCreated",
      vaultId,
      deviceId: "01900000-0000-7000-8000-000000000103",
      eventId,
      timestamp: "2026-07-19T12:00:00.000Z",
      name: "Remote Vault",
    });

    const verified = await verifyPreparedRemoteReplica({
      vaultId,
      keyring: value.keyring,
      prepared: {
        generation: value.prepared.generation,
        head: { ...value.prepared.head, appendedEventIds: [eventId] },
        events: [created.event],
        objects: [],
        preparedArtifactObjectIds: [],
      },
      artifacts: {
        openEncrypted: async () => {
          throw new Error("unexpected Artifact");
        },
      },
    });

    expect(verified).toMatchObject({
      currentVaultName: "Remote Vault",
      vaultCreatedAt: "2026-07-19T12:00:00.000Z",
    });
  });

  it("validates paged metadata and reconstructs the active head", async () => {
    const value = await fixture();
    const transport = {
      request: async (method: string) =>
        method === "GET"
          ? {
              status: 200,
              body: {
                generationId,
                generationNumber: 0,
                records: [value.record],
                hasMore: false,
              },
            }
          : {
              status: 200,
              body: { record: value.record, ticket: { url: "/transfer" } },
            },
      getTransfer: async () => stream(value.prepared.generation.envelopeBytes),
    };
    const downloader = new RemoteReplicaDownloader(transport, {
      prepareEncrypted: async () => {
        throw new Error("unexpected Artifact");
      },
    });

    const replica = await downloader.prepare(
      {
        version: 1,
        jobId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        vaultId,
        generationId,
        generationNumber: 0,
        state: "Running",
        stage: "DownloadRecords",
        createdAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:00:00.000Z",
        snapshotCursor: 1,
        completedItems: 0,
        totalItems: 1,
        processedBytes: 0,
        totalBytes: value.prepared.generation.envelopeBytes.byteLength,
        retryCount: 0,
        attachIdempotencyKey: crypto.randomUUID(),
      },
      value.keyring,
    );

    expect(replica.generation.envelopeBytes).toEqual(value.prepared.generation.envelopeBytes);
    expect(replica.head).toMatchObject({
      vaultId,
      generationId,
      appendedObjectIds: [],
      appendedEventIds: [],
    });
  });

  it("preserves the local predecessor when polling an already active Generation", async () => {
    const predecessorGenerationId = "01900000-0000-7000-8000-000000000100";
    const value = await fixture(predecessorGenerationId);
    const transport = {
      request: async () => ({
        status: 200,
        body: {
          generationId,
          generationNumber: 1,
          records: [value.record],
          hasMore: false,
        },
      }),
      getTransfer: async () => stream(value.prepared.generation.envelopeBytes),
    };
    const downloader = new RemoteReplicaDownloader(transport, {
      prepareEncrypted: async () => undefined,
    });

    const replica = await downloader.prepare(
      {
        version: 1,
        jobId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        vaultId,
        generationId,
        generationNumber: 1,
        state: "Running",
        stage: "DownloadRecords",
        createdAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:00:00.000Z",
        snapshotCursor: 1,
        completedItems: 0,
        totalItems: 1,
        processedBytes: 0,
        totalBytes: value.prepared.generation.envelopeBytes.byteLength,
        retryCount: 0,
        attachIdempotencyKey: crypto.randomUUID(),
      },
      value.keyring,
      {
        generation: {
          ...value.prepared.generation,
        },
        events: [],
        objects: [],
      },
    );

    expect(replica.generation.predecessorGenerationId).toBe(predecessorGenerationId);
  });

  it("rejects bytes that differ from the advertised checksum", async () => {
    const value = await fixture();
    const transport = {
      request: async (method: string) =>
        method === "GET"
          ? {
              status: 200,
              body: { generationId, generationNumber: 0, records: [value.record], hasMore: false },
            }
          : { status: 200, body: { record: value.record, ticket: { url: "/transfer" } } },
      getTransfer: async () => stream(new Uint8Array(value.record.byteLength)),
    };
    const downloader = new RemoteReplicaDownloader(transport, {
      prepareEncrypted: async () => undefined,
    });
    const job = {
      version: 1 as const,
      jobId: crypto.randomUUID(),
      accountId: crypto.randomUUID(),
      vaultId,
      generationId,
      generationNumber: 0,
      state: "Running" as const,
      stage: "DownloadRecords" as const,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:00:00.000Z",
      snapshotCursor: 1,
      completedItems: 0,
      totalItems: 1,
      processedBytes: 0,
      totalBytes: value.record.byteLength,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };

    await expect(downloader.prepare(job, value.keyring)).rejects.toMatchObject({
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  });

  it("hands an Artifact larger than 4 GiB to streaming storage without inline allocation", async () => {
    const artifactId = "01900000-0000-7000-8000-000000000105";
    const advertisedBytes = 4 * 1024 ** 3 + 1;
    const raw = new Uint8Array(32).fill(5);
    const rootKey = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
    const prepared = await prepareVaultGeneration({
      rootKey,
      vaultId,
      keyEpochId: TEST_KEY_EPOCH_ID,
      deviceId: "01900000-0000-7000-8000-000000000103",
      generationId,
      generationNumber: 0,
      createdAt: "2026-07-19T12:00:00.000Z",
      reason: "Initial",
      retainedObjectIds: [artifactId],
      retainedEventIds: [],
    });
    const generationDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(prepared.generation.envelopeBytes)),
    );
    const artifactDigest = new Uint8Array(32).fill(7);
    const generationRecord = {
      objectId: generationId,
      objectType: "VaultGeneration",
      keyEpochId: TEST_KEY_EPOCH_ID,
      byteLength: prepared.generation.envelopeBytes.byteLength,
      sha256: bytesToBase64Url(generationDigest),
      state: "Committed",
    };
    const artifactRecord = {
      objectId: artifactId,
      objectType: "Artifact",
      keyEpochId: TEST_KEY_EPOCH_ID,
      byteLength: advertisedBytes,
      sha256: bytesToBase64Url(artifactDigest),
      state: "Committed",
    };
    const artifactStream = new ReadableStream<Uint8Array>();
    const received: { byteLength?: number; stream?: ReadableStream<Uint8Array> } = {};
    const downloader = new RemoteReplicaDownloader(
      {
        request: async (method: string, path: string) => {
          if (method === "GET")
            return {
              status: 200,
              body: {
                generationId,
                generationNumber: 0,
                records: [generationRecord, artifactRecord],
                hasMore: false,
              },
            };
          const record = path.includes(artifactId) ? artifactRecord : generationRecord;
          return { status: 200, body: { record, ticket: { url: `/${record.objectId}` } } };
        },
        getTransfer: async (url: string, expectedByteLength: number) => {
          if (url.includes(artifactId)) return artifactStream;
          expect(expectedByteLength).toBe(prepared.generation.envelopeBytes.byteLength);
          return stream(prepared.generation.envelopeBytes);
        },
      },
      {
        prepareEncrypted: async (input) => {
          received.byteLength = input.object.envelopeByteLength;
          received.stream = input.encrypted;
        },
      },
    );

    const result = await downloader.prepare(
      {
        version: 1,
        jobId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        vaultId,
        generationId,
        generationNumber: 0,
        state: "Running",
        stage: "DownloadRecords",
        createdAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:00:00.000Z",
        snapshotCursor: 1,
        completedItems: 0,
        totalItems: 2,
        processedBytes: 0,
        totalBytes: advertisedBytes + prepared.generation.envelopeBytes.byteLength,
        retryCount: 0,
        attachIdempotencyKey: crypto.randomUUID(),
      },
      testKeyring(rootKey),
    );

    expect(received).toEqual({ byteLength: advertisedBytes, stream: artifactStream });
    expect(result.objects).toEqual([
      expect.objectContaining({ objectId: artifactId, envelopeByteLength: advertisedBytes }),
    ]);
  });
});

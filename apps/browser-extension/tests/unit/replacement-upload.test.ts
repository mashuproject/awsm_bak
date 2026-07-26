import { describe, expect, it, vi } from "vitest";

import type {
  SynchronizationCheckpointV1,
  VaultReplacementJobV1,
} from "../../src/drivers/indexeddb/schema";
import { VaultReplacementGraphUploader } from "../../src/runtime/recovery/replacement-upload";
import { importVaultRootKey, VaultKeyring } from "../../src/runtime/vault/keyring";
import { prepareVaultNameChange } from "../../src/runtime/vault/name-crypto";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("replacement graph upload", () => {
  it("uses normal resumable checkpoints and commits every target Event closure", async () => {
    const vaultId = id(1);
    const generationId = id(2);
    const epochId = id(3);
    const artifactId = id(4);
    const eventId = id(5);
    const encryptedArtifact = new Uint8Array([1, 2, 3, 4, 5]);
    const keyring = new VaultKeyring(epochId, [
      {
        keyEpochId: epochId,
        ordinal: 0,
        rootKey: await importVaultRootKey(new Uint8Array(32).fill(7)),
      },
    ]);
    const name = await prepareVaultNameChange({
      keyring,
      eventType: "VaultCreated",
      vaultId,
      deviceId: id(6),
      eventId,
      timestamp: "2026-07-25T23:30:00.000Z",
      name: "Replacement",
    });
    const artifact = {
      version: 1 as const,
      objectId: artifactId,
      objectType: "Artifact" as const,
      keyEpochId: epochId,
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1" as const,
      envelopeByteLength: encryptedArtifact.byteLength,
      envelopeChecksumAlgorithm: "hash:sha256:v1" as const,
      envelopeChecksum: new Uint8Array(await crypto.subtle.digest("SHA-256", encryptedArtifact)),
    };
    const checkpoints = new Map<string, SynchronizationCheckpointV1>();
    const checkpointKey = (kind: "Object" | "Event", entityId: string) => `${kind}:${entityId}`;
    const repository = {
      synchronizationCheckpoint: async (
        _vaultId: string,
        kind: "Object" | "Event",
        entityId: string,
      ) => checkpoints.get(checkpointKey(kind, entityId)),
      saveSynchronizationCheckpoint: async (checkpoint: SynchronizationCheckpointV1) => {
        checkpoints.set(checkpointKey(checkpoint.kind, checkpoint.entityId), checkpoint);
      },
    };
    const request = vi.fn(
      async (
        method: string,
        path: string,
        body?: unknown,
      ): Promise<{ status: number; body: unknown }> => {
        if (method === "POST" && path.endsWith("/uploads"))
          return {
            status: 201,
            body: {
              upload: {
                uploadId: crypto.randomUUID(),
                state: "Open",
                partSizeBytes: 3,
                receivedParts: [],
              },
              ticket: { url: "/transfer/{partNumber}" },
            },
          };
        if (method === "POST" && path.includes("/uploads/")) return { status: 200, body: {} };
        if (method === "POST" && path.endsWith("/commits"))
          return { status: 200, body: { accepted: body } };
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    );
    const transport = {
      request,
      putTransfer: vi.fn(async () => undefined),
    };
    const head = {
      appendedObjectIds: [artifactId],
      appendedEventIds: [eventId],
    };
    const uploader = new VaultReplacementGraphUploader(
      repository,
      {
        getVaultHead: async () => head,
        listStoredObjects: async () => [artifact],
        listStoredEvents: async () => [name.event],
      },
      {
        openEncrypted: async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encryptedArtifact);
              controller.close();
            },
          }),
      },
      transport,
    );
    const job: VaultReplacementJobV1 = {
      version: 1,
      jobId: id(10),
      accountId: id(11),
      sourceVaultId: id(12),
      sourceHead: {
        version: 1,
        vaultId: id(12),
        generationId: id(13),
        generationNumber: 4,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
      sourceHeadCursor: 9,
      verifiedExportJobId: id(14),
      safelyStoredConfirmed: true,
      candidateIdempotencyKey: id(17),
      generationUploadCompleteIdempotencyKey: id(18),
      candidateCompleteIdempotencyKey: id(19),
      activationIdempotencyKey: id(20),
      state: "Running",
      stage: "Upload",
      createdAt: "2026-07-25T23:20:00.000Z",
      updatedAt: "2026-07-25T23:31:00.000Z",
      targetVaultId: vaultId,
      targetDeviceId: id(15),
      targetRecoveryGenerationId: id(16),
      targetKeyEpochId: epochId,
      targetGenerationId: generationId,
      targetGenerationNumber: 0,
      completedItems: 0,
      totalItems: 2,
      processedBytes: 0,
      totalBytes: encryptedArtifact.byteLength + name.event.envelopeBytes.byteLength,
      retryCount: 0,
    };

    await uploader.run(job);

    expect(checkpoints.get(`Object:${artifactId}`)?.state).toBe("Durable");
    expect(checkpoints.get(`Event:${eventId}`)?.state).toBe("Committed");
    expect(request.mock.calls.filter((call) => String(call[1]).endsWith("/commits"))).toHaveLength(
      1,
    );
    const requestCount = request.mock.calls.length;
    const partCount = transport.putTransfer.mock.calls.length;

    await uploader.run(job);

    expect(request).toHaveBeenCalledTimes(requestCount);
    expect(transport.putTransfer).toHaveBeenCalledTimes(partCount);
  });
});

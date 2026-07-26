import { describe, expect, it, vi } from "vitest";
import { encodeEncryptedEnvelope, encryptEnvelope } from "../../src/crypto/envelope";
import type {
  ServerSwitchCheckpointV1,
  ServerSwitchJobV1,
  StoredAccountVaultV1,
} from "../../src/drivers/indexeddb/schema";
import { ServerSwitchRemoteApplicator } from "../../src/runtime/synchronization/server-switch-remote";
import type { VaultRecordsV1 } from "../../src/runtime/vault/contracts";

const vaultId = "01900000-0000-7000-8000-000000000001";
const generationId = "01900000-0000-7000-8000-000000000002";
const jobId = "01900000-0000-7000-8000-000000000003";
const accountId = "01900000-0000-7000-8000-000000000004";

describe("Server Switch remote application", () => {
  it("exposes source reads and durable candidate parts to relay fault controls", async () => {
    const artifactId = "01900000-0000-7000-8000-000000000009";
    const reached: string[] = [];
    const sourceFailure = Object.assign(new Error("Source authentication expired"), {
      id: "REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED",
    });
    const faults = {
      beforeSourceArtifactRead: async () => {
        reached.push("source");
        throw sourceFailure;
      },
      afterCandidateUploadPart: async () => {
        reached.push("candidate");
      },
    };
    const running = {
      version: 1 as const,
      jobId,
      sourceOrigin: "https://source.example",
      candidateOrigin: "https://candidate.example",
      candidateRegistration: { enabled: false },
      vaultId,
      state: "Running" as const,
      stage: "PrepareRemote" as const,
      direction: "PublishLocal" as const,
      expectedLocalHead: {
        version: 1 as const,
        vaultId,
        generationId,
        generationNumber: 7,
        appendedObjectIds: [artifactId],
        appendedEventIds: [],
      },
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      completedItems: 0,
      totalItems: 2,
      processedBytes: 0,
      totalBytes: 7,
      retryCount: 0,
      candidateAuthorityChanged: false,
      attachIdempotencyKey: "01900000-0000-7000-8000-000000000005",
      candidateIdempotencyKey: "01900000-0000-7000-8000-000000000006",
    } satisfies ServerSwitchJobV1;
    let current: ServerSwitchJobV1 = running;
    const checkpoints = new Map<string, ServerSwitchCheckpointV1>();
    const request = vi.fn(async (method: string, path: string) => {
      if (method === "POST" && path === "/api/vaults")
        return {
          status: 201,
          body: {
            upload: {
              uploadId: "01900000-0000-7000-8000-000000000007",
              partSizeBytes: 1024,
              receivedParts: [],
            },
            ticket: { url: "/generation/{partNumber}" },
          },
        };
      if (path.endsWith("/uploads"))
        return {
          status: 201,
          body: {
            upload: {
              uploadId: "01900000-0000-7000-8000-000000000010",
              state: "Open",
              partSizeBytes: 1024,
              receivedParts: [],
            },
            ticket: { url: "/artifact/{partNumber}" },
          },
        };
      return { status: 200, body: {} };
    });
    const applicator = new ServerSwitchRemoteApplicator(
      {
        loadJob: async () => current,
        saveJob: async (next) => {
          current = next;
        },
        loadCheckpoint: async (_jobId, kind, entityId) => checkpoints.get(`${kind}:${entityId}`),
        saveCheckpoint: async (checkpoint) => {
          checkpoints.set(`${checkpoint.kind}:${checkpoint.entityId}`, checkpoint);
        },
      },
      {
        loadAccountVault: async () => ({
          version: 1,
          accountId,
          vaultId,
          activeRecoveryGenerationId: "01900000-0000-7000-8000-000000000008",
          activeKeyEpochId: "01900000-0000-7000-8000-000000000009",
          remoteGenerationId: generationId,
          remoteGenerationNumber: 7,
          deliveryCursor: 0,
        }),
        saveAccountVault: async () => undefined,
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
            envelopeByteLength: 4,
            envelopeChecksumAlgorithm: "hash:sha256:v1",
            envelopeChecksum: new Uint8Array(32).fill(3),
          },
        ],
        listStoredEvents: async () => [],
      },
      {
        openEncrypted: async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([9, 8, 7, 6]));
              controller.close();
            },
          }),
      },
      { request, putTransfer: async () => undefined },
      undefined,
      faults,
    );

    await expect(
      applicator.publishLocal({
        metadata: { vaultId },
        generation: {
          version: 1,
          generationId,
          generationNumber: 7,
          envelopeBytes: new Uint8Array([1, 2, 3]),
        },
        head: running.expectedLocalHead,
      } as unknown as VaultRecordsV1),
    ).rejects.toBe(sourceFailure);
    expect(reached).toEqual(["source"]);
  });

  it("publishes the original Generation only after every closure record is durable", async () => {
    let job: ServerSwitchJobV1 = {
      version: 1,
      jobId,
      sourceOrigin: "https://source.example",
      candidateOrigin: "https://candidate.example",
      candidateRegistration: { enabled: false },
      vaultId,
      state: "Running",
      stage: "PrepareRemote",
      direction: "PublishLocal",
      expectedLocalHead: {
        version: 1,
        vaultId,
        generationId,
        generationNumber: 7,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      completedItems: 0,
      totalItems: 1,
      processedBytes: 0,
      totalBytes: 3,
      retryCount: 0,
      candidateAuthorityChanged: false,
      attachIdempotencyKey: "01900000-0000-7000-8000-000000000005",
      candidateIdempotencyKey: "01900000-0000-7000-8000-000000000006",
    };
    const checkpoints = new Map<string, ServerSwitchCheckpointV1>();
    const calls: string[] = [];
    const state = {
      loadJob: async () => job,
      saveJob: async (next: ServerSwitchJobV1) => {
        job = next;
      },
      loadCheckpoint: async (_jobId: string, kind: string, entityId: string) =>
        checkpoints.get(`${kind}:${entityId}`),
      saveCheckpoint: async (checkpoint: ServerSwitchCheckpointV1) => {
        checkpoints.set(`${checkpoint.kind}:${checkpoint.entityId}`, checkpoint);
      },
    };
    const transport = {
      request: vi.fn(async (method: string, path: string, _body?: unknown) => {
        calls.push(`${method} ${path}`);
        if (method === "POST" && path === "/api/vaults")
          return {
            status: 201,
            body: {
              upload: {
                uploadId: "01900000-0000-7000-8000-000000000007",
                partSizeBytes: 1024,
                receivedParts: [],
              },
              ticket: { url: "/transfer/{partNumber}" },
              session: { accessToken: "device-access" },
            },
          };
        return { status: 200, body: {} };
      }),
      putTransfer: vi.fn(async () => undefined),
      useAccessToken: vi.fn(),
    };
    const records = {
      metadata: { vaultId },
      generation: {
        version: 1,
        generationId,
        generationNumber: 7,
        envelopeBytes: new Uint8Array([1, 2, 3]),
      },
      head: job.expectedLocalHead,
    } as unknown as VaultRecordsV1;
    await new ServerSwitchRemoteApplicator(
      state,
      {
        loadAccountVault: async () => ({
          version: 1,
          accountId,
          vaultId,
          activeRecoveryGenerationId: "01900000-0000-7000-8000-000000000008",
          activeKeyEpochId: "01900000-0000-7000-8000-000000000009",
          remoteGenerationId: generationId,
          remoteGenerationNumber: 7,
          deliveryCursor: 0,
        }),
        saveAccountVault: async () => undefined,
      },
      {
        getVaultHead: async () => ({ appendedObjectIds: [], appendedEventIds: [] }),
        listStoredObjects: async () => [],
        listStoredEvents: async () => [],
      },
      { openEncrypted: vi.fn() },
      transport,
      undefined,
      undefined,
      async () => ({
        recoveryGeneration: { recoveryGenerationId: "recovery" },
        deviceCertificate: { certificateId: "certificate" },
        deviceKeyEnvelope: { keyEpochId: "epoch" },
        deviceProofSignature: "proof",
      }),
    ).publishLocal(records, "2026-07-20T00:01:00.000Z");

    expect(transport.request.mock.calls[0]?.[2]).toMatchObject({
      recoveryGeneration: { recoveryGenerationId: "recovery" },
      deviceCertificate: { certificateId: "certificate" },
      deviceKeyEnvelope: { keyEpochId: "epoch" },
      deviceProofSignature: "proof",
    });
    expect(transport.useAccessToken).toHaveBeenCalledWith("device-access");
    expect(calls).toEqual([
      "POST /api/vaults",
      `POST /api/vaults/${vaultId}/uploads/01900000-0000-7000-8000-000000000007/complete`,
      `POST /api/vaults/${vaultId}/complete`,
    ]);
    expect(checkpoints.get(`Generation:${generationId}`)?.state).toBe("Durable");
    expect(job).toMatchObject({
      stage: "PromoteContext",
      candidateAuthorityChanged: true,
      direction: "PublishLocal",
    });
  });

  it("relays a remote-only Artifact reader from the source server to the candidate", async () => {
    const artifactId = "01900000-0000-7000-8000-000000000009";
    const encrypted = new Uint8Array([9, 8, 7, 6]);
    let job: ServerSwitchJobV1 = {
      version: 1,
      jobId,
      sourceOrigin: "https://source.example",
      candidateOrigin: "https://candidate.example",
      candidateRegistration: { enabled: false },
      vaultId,
      state: "Running",
      stage: "PrepareRemote",
      direction: "PublishLocal",
      expectedLocalHead: {
        version: 1,
        vaultId,
        generationId,
        generationNumber: 7,
        appendedObjectIds: [artifactId],
        appendedEventIds: [],
      },
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      completedItems: 0,
      totalItems: 2,
      processedBytes: 0,
      totalBytes: 7,
      retryCount: 0,
      candidateAuthorityChanged: false,
      attachIdempotencyKey: "01900000-0000-7000-8000-000000000005",
      candidateIdempotencyKey: "01900000-0000-7000-8000-000000000006",
    };
    const checkpoints = new Map<string, ServerSwitchCheckpointV1>();
    const openEncrypted = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encrypted);
            controller.close();
          },
        }),
    );
    const putTransfer = vi.fn(async () => undefined);
    const reached: string[] = [];
    const request = vi.fn(async (method: string, path: string) => {
      if (method === "POST" && path === "/api/vaults")
        return {
          status: 201,
          body: {
            upload: {
              uploadId: "01900000-0000-7000-8000-000000000007",
              partSizeBytes: 1024,
              receivedParts: [],
            },
            ticket: { url: "/generation/{partNumber}" },
          },
        };
      if (path.endsWith("/uploads"))
        return {
          status: 201,
          body: {
            upload: {
              uploadId: "01900000-0000-7000-8000-000000000010",
              state: "Open",
              partSizeBytes: 1024,
              receivedParts: [],
            },
            ticket: { url: "/artifact/{partNumber}" },
          },
        };
      return { status: 200, body: {} };
    });
    await new ServerSwitchRemoteApplicator(
      {
        loadJob: async () => job,
        saveJob: async (next) => {
          job = next;
        },
        loadCheckpoint: async (_jobId, kind, entityId) => checkpoints.get(`${kind}:${entityId}`),
        saveCheckpoint: async (checkpoint) => {
          checkpoints.set(`${checkpoint.kind}:${checkpoint.entityId}`, checkpoint);
        },
      },
      {
        loadAccountVault: async () => ({
          version: 1,
          accountId,
          vaultId,
          activeRecoveryGenerationId: "01900000-0000-7000-8000-000000000008",
          activeKeyEpochId: "01900000-0000-7000-8000-000000000009",
          remoteGenerationId: generationId,
          remoteGenerationNumber: 7,
          deliveryCursor: 0,
        }),
        saveAccountVault: async () => undefined,
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
            envelopeByteLength: encrypted.byteLength,
            envelopeChecksumAlgorithm: "hash:sha256:v1",
            envelopeChecksum: new Uint8Array(32).fill(3),
          },
        ],
        listStoredEvents: async () => [],
      },
      { openEncrypted },
      { request, putTransfer },
      undefined,
      {
        beforeSourceArtifactRead: async () => {
          reached.push("source");
        },
        afterCandidateUploadPart: async () => {
          reached.push("candidate");
        },
      },
    ).publishLocal(
      {
        metadata: { vaultId },
        generation: {
          version: 1,
          generationId,
          generationNumber: 7,
          envelopeBytes: new Uint8Array([1, 2, 3]),
        },
        head: job.expectedLocalHead,
      } as unknown as VaultRecordsV1,
      "2026-07-20T00:01:00.000Z",
    );

    expect(openEncrypted).toHaveBeenCalledExactlyOnceWith(vaultId, artifactId);
    expect(putTransfer).toHaveBeenCalledWith("/artifact/{partNumber}", 0, encrypted);
    expect(reached).toEqual(["source", "candidate"]);
    expect(checkpoints.get(`Object:${artifactId}`)?.state).toBe("Durable");
  });

  it("CAS-activates the original direct successor without committing Events early", async () => {
    const predecessorId = "01900000-0000-7000-8000-000000000020";
    let job: ServerSwitchJobV1 = {
      version: 1,
      jobId,
      sourceOrigin: "https://source.example",
      candidateOrigin: "https://candidate.example",
      candidateRegistration: { enabled: false },
      vaultId,
      state: "Running",
      stage: "PrepareRemote",
      direction: "FastForwardCandidate",
      expectedLocalHead: {
        version: 1,
        vaultId,
        generationId,
        generationNumber: 8,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
      candidateGenerationId: predecessorId,
      candidateGenerationNumber: 7,
      candidateHeadCursor: 17,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      completedItems: 0,
      totalItems: 1,
      processedBytes: 0,
      totalBytes: 3,
      retryCount: 0,
      candidateAuthorityChanged: false,
      attachIdempotencyKey: "01900000-0000-7000-8000-000000000005",
      candidateIdempotencyKey: "01900000-0000-7000-8000-000000000006",
    };
    const checkpoints = new Map<string, ServerSwitchCheckpointV1>();
    const calls: string[] = [];
    let registration: StoredAccountVaultV1 = {
      version: 1 as const,
      accountId,
      vaultId,
      activeRecoveryGenerationId: "01900000-0000-7000-8000-000000000008",
      activeKeyEpochId: "01900000-0000-7000-8000-000000000009",
      remoteGenerationId: predecessorId,
      remoteGenerationNumber: 7,
      deliveryCursor: 17,
    };
    const transport = {
      request: vi.fn(async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path.endsWith("/generation-candidates"))
          return {
            status: 201,
            body: {
              upload: {
                uploadId: "01900000-0000-7000-8000-000000000021",
                partSizeBytes: 1024,
                receivedParts: [],
              },
              ticket: { url: "/transfer/{partNumber}" },
            },
          };
        if (path.endsWith("/activate"))
          return {
            status: 200,
            body: { generationId, generationNumber: 8, headCursor: 18 },
          };
        return { status: 200, body: {} };
      }),
      putTransfer: vi.fn(async () => undefined),
    };
    await new ServerSwitchRemoteApplicator(
      {
        loadJob: async () => job,
        saveJob: async (next) => {
          job = next;
        },
        loadCheckpoint: async (_jobId, kind, entityId) => checkpoints.get(`${kind}:${entityId}`),
        saveCheckpoint: async (checkpoint) => {
          checkpoints.set(`${checkpoint.kind}:${checkpoint.entityId}`, checkpoint);
        },
      },
      {
        loadAccountVault: async () => registration,
        saveAccountVault: async (next) => {
          registration = next;
        },
      },
      {
        getVaultHead: async () => ({ appendedObjectIds: [], appendedEventIds: [] }),
        listStoredObjects: async () => [],
        listStoredEvents: async () => [],
      },
      { openEncrypted: vi.fn() },
      transport,
    ).fastForwardCandidate({
      metadata: { vaultId },
      generation: {
        version: 1,
        generationId,
        generationNumber: 8,
        predecessorGenerationId: predecessorId,
        envelopeBytes: new Uint8Array([1, 2, 3]),
      },
      head: job.expectedLocalHead,
    } as unknown as VaultRecordsV1);

    expect(calls.some((call) => call.endsWith("/commits"))).toBe(false);
    expect(calls.at(-1)).toMatch(/\/activate$/u);
    expect(registration).toMatchObject({
      remoteGenerationId: generationId,
      remoteGenerationNumber: 8,
      deliveryCursor: 18,
    });
    expect(job).toMatchObject({
      stage: "PromoteContext",
      candidateAuthorityChanged: true,
      candidateHeadCursor: 18,
    });
  });

  it("journals accepted Union authority before a later candidate-head race", async () => {
    const descriptorId = "01900000-0000-7000-8000-000000000030";
    const eventId = "01900000-0000-7000-8000-000000000031";
    let job: ServerSwitchJobV1 = {
      version: 1,
      jobId,
      sourceOrigin: "https://source.example",
      candidateOrigin: "https://candidate.example",
      candidateRegistration: { enabled: false },
      vaultId,
      state: "Running",
      stage: "PrepareRemote",
      direction: "Union",
      expectedLocalHead: {
        version: 1,
        vaultId,
        generationId,
        generationNumber: 7,
        appendedObjectIds: [descriptorId],
        appendedEventIds: [eventId],
      },
      candidateGenerationId: generationId,
      candidateGenerationNumber: 7,
      candidateHeadCursor: 12,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      completedItems: 0,
      totalItems: 2,
      processedBytes: 0,
      totalBytes: 4,
      retryCount: 0,
      candidateAuthorityChanged: false,
      attachIdempotencyKey: "01900000-0000-7000-8000-000000000005",
      candidateIdempotencyKey: "01900000-0000-7000-8000-000000000006",
    };
    const checkpoints = new Map<string, ServerSwitchCheckpointV1>();
    const transport = {
      request: vi.fn(async (method: string, path: string) => {
        if (method === "GET")
          throw Object.assign(new Error("Candidate head changed"), { id: "VAULT_HEAD_CHANGED" });
        if (path.endsWith("/uploads"))
          return {
            status: 201,
            body: {
              upload: {
                uploadId: "01900000-0000-7000-8000-000000000032",
                state: "Open",
                partSizeBytes: 1024,
                receivedParts: [],
              },
              ticket: { url: "/transfer/{partNumber}" },
            },
          };
        if (path.endsWith("/commits")) return { status: 200, body: { cursor: 13 } };
        return { status: 200, body: {} };
      }),
      putTransfer: vi.fn(async () => undefined),
    };
    const activeKeyEpochId = "01900000-0000-7000-8000-000000000009";
    const registration: StoredAccountVaultV1 = {
      version: 1,
      accountId,
      vaultId,
      activeRecoveryGenerationId: "01900000-0000-7000-8000-000000000008",
      activeKeyEpochId,
      remoteGenerationId: generationId,
      remoteGenerationNumber: 7,
      deliveryCursor: 12,
    };
    const descriptorEnvelope = encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType: "BundleDescriptor",
        objectId: descriptorId,
        keyEpochId: activeKeyEpochId,
        plaintext: new Uint8Array([1, 2]),
        key: new Uint8Array(32).fill(1),
      }),
    );
    const eventEnvelope = encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType: "Event",
        objectId: eventId,
        keyEpochId: activeKeyEpochId,
        plaintext: new Uint8Array([3, 4]),
        key: new Uint8Array(32).fill(2),
      }),
    );
    const applicator = new ServerSwitchRemoteApplicator(
      {
        loadJob: async () => job,
        saveJob: async (next) => {
          job = next;
        },
        loadCheckpoint: async (_jobId, kind, entityId) => checkpoints.get(`${kind}:${entityId}`),
        saveCheckpoint: async (checkpoint) => {
          checkpoints.set(`${checkpoint.kind}:${checkpoint.entityId}`, checkpoint);
        },
      },
      {
        loadAccountVault: async () => registration,
        saveAccountVault: async () => undefined,
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
            vaultId,
            eventId,
            referencedObjectIds: [descriptorId],
            orderingTimestamp: "2026-07-20T00:00:00.000Z",
            envelopeBytes: eventEnvelope,
          },
        ],
      },
      { openEncrypted: vi.fn() },
      transport,
    );

    await expect(
      applicator.union({
        metadata: { vaultId },
        generation: {
          version: 1,
          generationId,
          generationNumber: 7,
          envelopeBytes: new Uint8Array([5]),
        },
        head: job.expectedLocalHead,
      } as unknown as VaultRecordsV1),
    ).rejects.toMatchObject({ id: "VAULT_HEAD_CHANGED" });

    expect(checkpoints.get(`Event:${eventId}`)?.state).toBe("Committed");
    expect(job).toMatchObject({
      stage: "PrepareRemote",
      candidateAuthorityChanged: true,
    });
  });
});

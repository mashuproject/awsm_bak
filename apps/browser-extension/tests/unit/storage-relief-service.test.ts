import { describe, expect, it, vi } from "vitest";

import type { StoredArtifactObjectV1 } from "../../src/drivers/indexeddb";
import { StorageReliefService } from "../../src/runtime/storage-relief/service";
import type { VaultKeyring } from "../../src/runtime/vault/keyring";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("StorageReliefService", () => {
  it("creates the immutable candidate ceiling only when the displayed estimate still matches", async () => {
    const object: StoredArtifactObjectV1 = {
      version: 1,
      objectId: id(2),
      objectType: "Artifact",
      keyEpochId: "00000000-0000-4000-8000-000000000009",
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
      envelopeByteLength: 700,
      envelopeChecksumAlgorithm: "hash:sha256:v1",
      envelopeChecksum: new Uint8Array(32).fill(3),
    };
    const estimate = {
      candidateArtifacts: 1,
      candidateBytes: 700,
      candidates: [
        {
          object,
          descriptorObjectId: id(3),
          registrationEventId: id(4),
          dependencyObjectIds: [id(2), id(3)],
        },
      ],
    };
    const createStorageReliefJob = vi.fn(async () => undefined);
    const service = new StorageReliefService(
      {
        getVaultHead: async () => ({
          version: 1,
          vaultId: id(1),
          generationId: id(5),
          generationNumber: 2,
          appendedObjectIds: [],
          appendedEventIds: [],
        }),
        listRemoteOnlyArtifacts: async () => [],
        createStorageReliefJob,
      },
      { enumerate: async () => estimate },
      () => id(6),
    );

    await expect(
      service.start({
        vaultId: id(1),
        keyring: {} as VaultKeyring,
        accountId: id(7),
        serverOrigin: "https://sync.example.test",
        candidateArtifacts: 2,
        candidateBytes: 700,
        now: "2026-07-21T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ id: "STORAGE_RELIEF_ESTIMATE_CHANGED" });
    expect(createStorageReliefJob).not.toHaveBeenCalled();

    await expect(
      service.start({
        vaultId: id(1),
        keyring: {} as VaultKeyring,
        accountId: id(7),
        serverOrigin: "https://sync.example.test",
        candidateArtifacts: 1,
        candidateBytes: 700,
        now: "2026-07-21T00:00:00.000Z",
      }),
    ).resolves.toEqual({ jobId: id(6) });
    expect(createStorageReliefJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ state: "Created", candidateArtifacts: 1 }),
        candidates: [expect.objectContaining({ artifactObjectId: id(2), state: "Candidate" })],
      }),
    );
  });

  it.each(["afterJobCreated", "afterCandidateCheckpoint"] as const)(
    "exposes %s only after the atomic Job and candidate transaction",
    async (boundary) => {
      let persisted = false;
      const crash = async (): Promise<void> => {
        expect(persisted).toBe(true);
        throw new DOMException("simulated Worker termination", "AbortError");
      };
      const service = new StorageReliefService(
        {
          getVaultHead: async () => ({
            version: 1,
            vaultId: id(1),
            generationId: id(5),
            generationNumber: 2,
            appendedObjectIds: [],
            appendedEventIds: [],
          }),
          listRemoteOnlyArtifacts: async () => [],
          createStorageReliefJob: async () => {
            persisted = true;
          },
        },
        {
          enumerate: async () => ({
            candidateArtifacts: 0,
            candidateBytes: 0,
            candidates: [],
          }),
        },
        () => id(6),
        boundary === "afterJobCreated"
          ? { afterJobCreated: crash }
          : { afterCandidateCheckpoint: crash },
      );

      await expect(
        service.start({
          vaultId: id(1),
          keyring: {} as VaultKeyring,
          accountId: id(7),
          serverOrigin: "https://sync.example.test",
          candidateArtifacts: 0,
          candidateBytes: 0,
          now: "2026-07-21T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(persisted).toBe(true);
    },
  );
});

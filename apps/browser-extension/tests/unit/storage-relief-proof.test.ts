import { describe, expect, it, vi } from "vitest";

import { bytesToBase64Url } from "../../src/runtime/account/wire";
import { ActiveGenerationStorageReliefProver } from "../../src/runtime/storage-relief/proof";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const checksum = bytesToBase64Url(new Uint8Array(32).fill(5));

describe("ActiveGenerationStorageReliefProver", () => {
  it("enumerates stable committed metadata without downloading wrapper bytes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: {
          generationId: id(1),
          generationNumber: 7,
          records: [
            {
              objectId: id(1),
              objectType: "VaultGeneration",
              keyEpochId: "00000000-0000-4000-8000-000000000009",
              state: "Committed",
              byteLength: 300,
              sha256: checksum,
            },
            {
              objectId: id(10),
              objectType: "Artifact",
              keyEpochId: "00000000-0000-4000-8000-000000000009",
              state: "Committed",
              byteLength: 500,
              sha256: checksum,
            },
          ],
          hasMore: true,
          nextObjectId: id(10),
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          generationId: id(1),
          generationNumber: 7,
          records: [
            {
              objectId: id(11),
              objectType: "BundleDescriptor",
              keyEpochId: "00000000-0000-4000-8000-000000000009",
              state: "Committed",
              byteLength: 100,
              sha256: checksum,
            },
            {
              objectId: id(12),
              objectType: "Event",
              keyEpochId: "00000000-0000-4000-8000-000000000009",
              state: "Committed",
              byteLength: 200,
              sha256: checksum,
              orderingTimestamp: "2026-07-21T00:00:00.000Z",
              dependencyObjectIds: [id(10), id(11)],
            },
          ],
          hasMore: false,
          nextObjectId: id(12),
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          generationId: id(1),
          generationNumber: 7,
          records: [],
          hasMore: false,
          nextObjectId: null,
        },
      });
    const proof = await new ActiveGenerationStorageReliefProver({ request }).prove({
      vaultId: id(2),
      generationId: id(1),
      generationNumber: 7,
      candidates: [
        {
          object: {
            version: 1,
            objectId: id(10),
            objectType: "Artifact",
            keyEpochId: "00000000-0000-4000-8000-000000000009",
            envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
            envelopeByteLength: 500,
            envelopeChecksumAlgorithm: "hash:sha256:v1",
            envelopeChecksum: new Uint8Array(32).fill(5),
          },
          descriptorObjectId: id(11),
          registrationEventId: id(12),
          dependencyObjectIds: [id(10), id(11)],
        },
      ],
    });

    expect(proof.generationNumber).toBe(7);
    expect(proof.records.get(id(10))).toMatchObject({ objectType: "Artifact", byteLength: 500 });
    expect(proof.closures.get(id(10))?.dependencyObjectIds).toEqual([id(10), id(11)]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every((call) => call[0] === "GET")).toBe(true);
  });

  it("rejects a Generation change during the final head recheck", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: {
          generationId: id(1),
          generationNumber: 7,
          records: [],
          hasMore: false,
          nextObjectId: null,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          generationId: id(9),
          generationNumber: 8,
          records: [],
          hasMore: false,
          nextObjectId: null,
        },
      });

    await expect(
      new ActiveGenerationStorageReliefProver({ request }).prove({
        vaultId: id(2),
        generationId: id(1),
        generationNumber: 7,
        candidates: [],
      }),
    ).rejects.toMatchObject({ id: "SYNCHRONIZATION_CONFLICT" });
  });
});

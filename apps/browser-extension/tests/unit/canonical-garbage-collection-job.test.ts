import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { decodeCanonicalValue, encodeCanonicalValue } from "../../src/domain/canonical/value";
import {
  decodeReplicaGarbageCollectionJob,
  encodeReplicaGarbageCollectionJob,
  type ReplicaGarbageCollectionJob,
  replicaGarbageCollectionIdempotencyKey,
} from "../../src/runtime/storage/garbage-collection-job";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required test fixture value is missing");
  return value;
}

function fixture(): ReplicaGarbageCollectionJob {
  const vaultId = filled("Vault", 1);
  const candidates = [
    {
      artifactId: filled("Artifact", 2),
      storageItemId: filled("StorageItem", 3),
      keyEpochId: filled("KeyEpoch", 4),
    },
    {
      artifactId: filled("Artifact", 5),
      storageItemId: filled("StorageItem", 6),
      keyEpochId: filled("KeyEpoch", 7),
    },
  ];
  return {
    jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
    vaultId,
    idempotencyKey: replicaGarbageCollectionIdempotencyKey(vaultId, candidates),
    createdAtMs: 1_785_658_400_000,
    state: 1,
    stage: 1,
    attempt: 0,
    lease: null,
    cancellationRequested: false,
    compactOutcome: {
      removedCompactItemCount: 3,
      removedResolutionCount: 3,
      removedEpochSecretCount: 1,
    },
    terminalOutcome: null,
    candidates,
  };
}

describe("canonical Replica Garbage Collection Job", () => {
  it("round-trips the exact resumable cleanup identity", () => {
    const job = fixture();

    const bytes = encodeReplicaGarbageCollectionJob(job);

    expect(decodeReplicaGarbageCollectionJob(bytes)).toEqual(job);
  });

  it("binds the idempotency key to every exact cleanup candidate", () => {
    const job = fixture();
    const changed = {
      ...job,
      candidates: [
        ...job.candidates.slice(0, 1),
        { ...required(job.candidates[1]), storageItemId: filled("StorageItem", 8) },
      ],
    };

    expect(() => encodeReplicaGarbageCollectionJob(changed)).toThrow(/idempotency key/u);
  });

  it("rejects malformed candidate identifiers before writing local safety state", () => {
    const job = fixture();
    const candidates = [
      {
        ...required(job.candidates[0]),
        storageItemId: new Uint8Array(31) as (typeof job.candidates)[number]["storageItemId"],
      },
      required(job.candidates[1]),
    ];
    const malformed = {
      ...job,
      candidates,
    };

    expect(() => encodeReplicaGarbageCollectionJob(malformed)).toThrow(/Storage Item ID/u);
  });

  it("rejects two physical candidates for one logical Artifact identity", () => {
    const job = fixture();
    const candidates = [
      required(job.candidates[0]),
      {
        ...required(job.candidates[1]),
        artifactId: required(job.candidates[0]).artifactId,
      },
    ];
    const duplicate = {
      ...job,
      candidates,
    };

    expect(() => encodeReplicaGarbageCollectionJob(duplicate)).toThrow(/duplicate Artifact ID/u);
  });

  it("rejects unknown persisted fields instead of interpreting another Job shape", () => {
    const bytes = encodeReplicaGarbageCollectionJob(fixture());
    const value = decodeCanonicalValue(bytes);
    if (!(value instanceof Map)) throw new TypeError("fixture Job must be a map");
    value.set(13, 1);

    expect(() => decodeReplicaGarbageCollectionJob(encodeCanonicalValue(value))).toThrow(
      /unknown fields/u,
    );
  });

  it("persists one stable terminal outcome after the final safety transaction", () => {
    const ready = fixture();
    const succeeded = {
      ...ready,
      state: 3 as const,
      attempt: 1,
      terminalOutcome: {
        removedCompactItemCount: 3,
        removedResolutionCount: 5,
        removedEpochSecretCount: 2,
        removedArtifactCount: 2,
      },
    };

    expect(decodeReplicaGarbageCollectionJob(encodeReplicaGarbageCollectionJob(succeeded))).toEqual(
      succeeded,
    );
  });

  it("rejects a terminal outcome that disagrees with its durable compact work and candidates", () => {
    const ready = fixture();
    const inconsistent = {
      ...ready,
      state: 3 as const,
      attempt: 1,
      terminalOutcome: {
        removedCompactItemCount: 3,
        removedResolutionCount: 4,
        removedEpochSecretCount: 1,
        removedArtifactCount: 2,
      },
    };

    expect(() => encodeReplicaGarbageCollectionJob(inconsistent)).toThrow(
      /terminal outcome does not match/u,
    );
  });
});

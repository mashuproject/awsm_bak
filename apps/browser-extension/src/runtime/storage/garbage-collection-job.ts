import { sha256 } from "@noble/hashes/sha2.js";

import type { Identifier } from "../../domain/canonical/identifiers";
import {
  booleanValue,
  byteString,
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  nonemptyArray,
  nonnegativeInteger,
  nullable,
  oneOfCodes,
  textValue,
} from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";

const JOB_FORMAT = 1 as const;
const JOB_STAGE_ARTIFACT_CLEANUP = 1 as const;
const JOB_STATES = [1, 2, 3] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ReplicaGarbageCollectionArtifactCandidate {
  readonly artifactId: Identifier<"Artifact">;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
}

export interface ReplicaGarbageCollectionLease {
  readonly ownerId: string;
  readonly expiresAtMs: number;
}

export interface ReplicaGarbageCollectionJob {
  readonly jobId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly idempotencyKey: Uint8Array;
  readonly createdAtMs: number;
  readonly state: 1 | 2 | 3;
  readonly stage: typeof JOB_STAGE_ARTIFACT_CLEANUP;
  readonly attempt: number;
  readonly lease: ReplicaGarbageCollectionLease | null;
  readonly cancellationRequested: false;
  readonly compactOutcome: {
    readonly removedCompactItemCount: number;
    readonly removedResolutionCount: number;
    readonly removedEpochSecretCount: number;
  };
  readonly terminalOutcome: {
    readonly removedCompactItemCount: number;
    readonly removedResolutionCount: number;
    readonly removedEpochSecretCount: number;
    readonly removedArtifactCount: number;
  } | null;
  readonly candidates: readonly ReplicaGarbageCollectionArtifactCandidate[];
}

function uuid(value: CanonicalValue, field: string): string {
  const parsed = textValue(value, field, { maxUtf8Bytes: 64 });
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a lowercase UUID`);
  return parsed;
}

function bytesKey(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function candidateValue(
  candidate: ReplicaGarbageCollectionArtifactCandidate,
): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, identifierValue(candidate.artifactId, "Artifact", "Garbage Collection Artifact ID")],
    [
      1,
      identifierValue(candidate.storageItemId, "StorageItem", "Garbage Collection Storage Item ID"),
    ],
    [2, identifierValue(candidate.keyEpochId, "KeyEpoch", "Garbage Collection Key Epoch ID")],
  ]);
}

function candidateValues(
  candidates: readonly ReplicaGarbageCollectionArtifactCandidate[],
): readonly ReadonlyMap<number, CanonicalValue>[] {
  if (candidates.length === 0) {
    throw new TypeError("Replica Garbage Collection Job must contain cleanup candidates");
  }
  const artifactKeys = candidates.map(({ artifactId }) =>
    [...artifactId].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
  if (new Set(artifactKeys).size !== artifactKeys.length) {
    throw new TypeError("Replica Garbage Collection Job contains a duplicate Artifact ID");
  }
  return canonicalSet(candidates.map(candidateValue));
}

function parseCandidate(
  value: CanonicalValue,
  index: number,
): ReplicaGarbageCollectionArtifactCandidate {
  const map = exactMap(value, [0, 1, 2], `Garbage Collection candidate ${index}`);
  return {
    artifactId: identifierValue(mapValue(map, 0), "Artifact", "Garbage Collection Artifact ID"),
    storageItemId: identifierValue(
      mapValue(map, 1),
      "StorageItem",
      "Garbage Collection Storage Item ID",
    ),
    keyEpochId: identifierValue(mapValue(map, 2), "KeyEpoch", "Garbage Collection Key Epoch ID"),
  };
}

export function replicaGarbageCollectionIdempotencyKey(
  vaultId: Identifier<"Vault">,
  candidates: readonly ReplicaGarbageCollectionArtifactCandidate[],
): Uint8Array {
  return sha256(
    transcript("awsm:replica-garbage-collection-job:v1", [
      vaultId,
      encodeCanonicalValue(candidateValues(candidates)),
    ]),
  );
}

function leaseValue(lease: ReplicaGarbageCollectionLease | null): CanonicalValue {
  if (lease === null) return null;
  return canonicalMap([
    [0, uuid(lease.ownerId, "Garbage Collection lease owner")],
    [1, nonnegativeInteger(lease.expiresAtMs, "Garbage Collection lease expiry")],
  ]);
}

function validateJob(job: ReplicaGarbageCollectionJob): ReplicaGarbageCollectionJob {
  uuid(job.jobId, "Garbage Collection Job ID");
  identifierValue(job.vaultId, "Vault", "Garbage Collection Vault ID");
  nonnegativeInteger(job.createdAtMs, "Garbage Collection creation time");
  oneOfCodes(job.state, JOB_STATES, "Garbage Collection Job state");
  exactCode(job.stage, JOB_STAGE_ARTIFACT_CLEANUP, "Garbage Collection Job stage");
  nonnegativeInteger(job.attempt, "Garbage Collection attempt");
  if (job.state === 1 && job.lease !== null) {
    throw new TypeError("A ready Garbage Collection Job cannot retain a lease");
  }
  if (job.state === 2 && (job.lease === null || job.attempt < 1)) {
    throw new TypeError("A running Garbage Collection Job requires a lease and attempt");
  }
  if (job.state === 3 && (job.lease !== null || job.attempt < 1 || job.terminalOutcome === null)) {
    throw new TypeError("A succeeded Garbage Collection Job requires one terminal outcome");
  }
  if (job.state !== 3 && job.terminalOutcome !== null) {
    throw new TypeError("A nonterminal Garbage Collection Job cannot contain a terminal outcome");
  }
  if (job.lease !== null && job.lease.expiresAtMs <= job.createdAtMs) {
    throw new TypeError("Garbage Collection lease must expire after Job creation");
  }
  if (job.cancellationRequested) {
    throw new TypeError("Artifact cleanup cannot be cancelled after its safety fence commits");
  }
  nonnegativeInteger(
    job.compactOutcome.removedCompactItemCount,
    "Garbage Collection compact item count",
  );
  nonnegativeInteger(
    job.compactOutcome.removedResolutionCount,
    "Garbage Collection resolution count",
  );
  nonnegativeInteger(
    job.compactOutcome.removedEpochSecretCount,
    "Garbage Collection Epoch Secret count",
  );
  if (job.terminalOutcome !== null) {
    nonnegativeInteger(
      job.terminalOutcome.removedCompactItemCount,
      "Garbage Collection terminal compact item count",
    );
    nonnegativeInteger(
      job.terminalOutcome.removedResolutionCount,
      "Garbage Collection terminal resolution count",
    );
    nonnegativeInteger(
      job.terminalOutcome.removedEpochSecretCount,
      "Garbage Collection terminal Epoch Secret count",
    );
    nonnegativeInteger(
      job.terminalOutcome.removedArtifactCount,
      "Garbage Collection terminal Artifact count",
    );
    const physicalArtifactCount = new Set(
      job.candidates.map(({ storageItemId }) => bytesKey(storageItemId)),
    ).size;
    const candidateEpochCount = new Set(
      job.candidates.map(({ keyEpochId }) => bytesKey(keyEpochId)),
    ).size;
    if (
      job.terminalOutcome.removedCompactItemCount !== job.compactOutcome.removedCompactItemCount ||
      job.terminalOutcome.removedResolutionCount !==
        job.compactOutcome.removedResolutionCount + job.candidates.length ||
      job.terminalOutcome.removedArtifactCount !== physicalArtifactCount ||
      job.terminalOutcome.removedEpochSecretCount < job.compactOutcome.removedEpochSecretCount ||
      job.terminalOutcome.removedEpochSecretCount >
        job.compactOutcome.removedEpochSecretCount + candidateEpochCount
    ) {
      throw new TypeError("Garbage Collection terminal outcome does not match its durable work");
    }
  }
  const expected = replicaGarbageCollectionIdempotencyKey(job.vaultId, job.candidates);
  if (
    !bytesEqual(byteString(job.idempotencyKey, 32, "Garbage Collection idempotency key"), expected)
  ) {
    throw new TypeError("Garbage Collection idempotency key does not match its candidates");
  }
  return job;
}

export function encodeReplicaGarbageCollectionJob(job: ReplicaGarbageCollectionJob): Uint8Array {
  validateJob(job);
  return encodeCanonicalValue(
    canonicalMap([
      [0, JOB_FORMAT],
      [1, job.jobId],
      [2, job.vaultId],
      [3, job.idempotencyKey],
      [4, job.createdAtMs],
      [5, job.state],
      [6, job.stage],
      [7, job.attempt],
      [8, leaseValue(job.lease)],
      [9, job.cancellationRequested],
      [
        10,
        canonicalMap([
          [0, job.compactOutcome.removedCompactItemCount],
          [1, job.compactOutcome.removedResolutionCount],
          [2, job.compactOutcome.removedEpochSecretCount],
        ]),
      ],
      [11, candidateValues(job.candidates)],
      [
        12,
        job.terminalOutcome === null
          ? null
          : canonicalMap([
              [0, job.terminalOutcome.removedCompactItemCount],
              [1, job.terminalOutcome.removedResolutionCount],
              [2, job.terminalOutcome.removedEpochSecretCount],
              [3, job.terminalOutcome.removedArtifactCount],
            ]),
      ],
    ]),
  );
}

export function decodeReplicaGarbageCollectionJob(bytes: Uint8Array): ReplicaGarbageCollectionJob {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [...Array(13).keys()],
    "Replica Garbage Collection Job",
  );
  exactCode(mapValue(map, 0), JOB_FORMAT, "Garbage Collection Job format");
  const job: ReplicaGarbageCollectionJob = {
    jobId: uuid(mapValue(map, 1), "Garbage Collection Job ID"),
    vaultId: identifierValue(mapValue(map, 2), "Vault", "Garbage Collection Vault ID"),
    idempotencyKey: byteString(mapValue(map, 3), 32, "Garbage Collection idempotency key"),
    createdAtMs: nonnegativeInteger(mapValue(map, 4), "Garbage Collection creation time"),
    state: oneOfCodes(mapValue(map, 5), JOB_STATES, "Garbage Collection Job state"),
    stage: exactCode(mapValue(map, 6), JOB_STAGE_ARTIFACT_CLEANUP, "Garbage Collection Job stage"),
    attempt: nonnegativeInteger(mapValue(map, 7), "Garbage Collection attempt"),
    lease: nullable(mapValue(map, 8), (value) => {
      const lease = exactMap(value, [0, 1], "Garbage Collection lease");
      return {
        ownerId: uuid(mapValue(lease, 0), "Garbage Collection lease owner"),
        expiresAtMs: nonnegativeInteger(mapValue(lease, 1), "Garbage Collection lease expiry"),
      };
    }),
    cancellationRequested: booleanValue(
      mapValue(map, 9),
      "Garbage Collection cancellation state",
    ) as false,
    compactOutcome: (() => {
      const outcome = exactMap(mapValue(map, 10), [0, 1, 2], "Garbage Collection compact outcome");
      return {
        removedCompactItemCount: nonnegativeInteger(
          mapValue(outcome, 0),
          "Garbage Collection compact item count",
        ),
        removedResolutionCount: nonnegativeInteger(
          mapValue(outcome, 1),
          "Garbage Collection resolution count",
        ),
        removedEpochSecretCount: nonnegativeInteger(
          mapValue(outcome, 2),
          "Garbage Collection Epoch Secret count",
        ),
      };
    })(),
    candidates: nonemptyArray(mapValue(map, 11), "Garbage Collection candidates").map(
      parseCandidate,
    ),
    terminalOutcome: nullable(mapValue(map, 12), (value) => {
      const outcome = exactMap(value, [0, 1, 2, 3], "Garbage Collection terminal outcome");
      return {
        removedCompactItemCount: nonnegativeInteger(
          mapValue(outcome, 0),
          "Garbage Collection terminal compact item count",
        ),
        removedResolutionCount: nonnegativeInteger(
          mapValue(outcome, 1),
          "Garbage Collection terminal resolution count",
        ),
        removedEpochSecretCount: nonnegativeInteger(
          mapValue(outcome, 2),
          "Garbage Collection terminal Epoch Secret count",
        ),
        removedArtifactCount: nonnegativeInteger(
          mapValue(outcome, 3),
          "Garbage Collection terminal Artifact count",
        ),
      };
    }),
  };
  if (
    !bytesEqual(
      encodeCanonicalValue(mapValue(map, 11)),
      encodeCanonicalValue(candidateValues(job.candidates)),
    )
  ) {
    throw new TypeError(
      "Garbage Collection candidates must be a sorted duplicate-free canonical set",
    );
  }
  validateJob(job);
  if (!bytesEqual(bytes, encodeReplicaGarbageCollectionJob(job))) {
    throw new TypeError("Replica Garbage Collection Job bytes are not canonical");
  }
  return job;
}

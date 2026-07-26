import { describe, expect, it } from "vitest";

import { DomainValidationError } from "../../src/domain/errors";
import type { StorageReliefCheckpointV1 } from "../../src/drivers/indexeddb/storage-relief-schema";
import {
  aggregateStorageReliefCheckpoints,
  assertStorageReliefCheckpointTransition,
  assertStorageReliefJobTransition,
} from "../../src/drivers/indexeddb/storage-relief-state";

const IDS = {
  artifactA: "00000000-0000-4000-8000-000000000001",
  artifactB: "00000000-0000-4000-8000-000000000002",
  generation: "00000000-0000-4000-8000-000000000003",
  job: "00000000-0000-4000-8000-000000000004",
  vault: "00000000-0000-4000-8000-000000000005",
} as const;

function checkpoint(
  artifactObjectId: string,
  state: StorageReliefCheckpointV1["state"],
): StorageReliefCheckpointV1 {
  const common = {
    version: 1,
    vaultId: IDS.vault,
    jobId: IDS.job,
    artifactObjectId,
    keyEpochId: "00000000-0000-4000-8000-000000000009",
    envelopeByteLength: artifactObjectId === IDS.artifactA ? 100 : 300,
    envelopeChecksum: new Uint8Array(32),
  } as const;
  switch (state) {
    case "Candidate":
      return { ...common, state };
    case "Verified":
    case "Evicting":
    case "Evicted":
      return {
        ...common,
        state,
        remoteGenerationId: IDS.generation,
        remoteGenerationNumber: 2,
      };
    case "Skipped":
      return { ...common, state, skipReason: "NotRemoteMember" };
  }
}

describe("storage-relief checkpoint state", () => {
  it.each([
    ["Candidate", "Verified"],
    ["Candidate", "Skipped"],
    ["Verified", "Evicting"],
    ["Evicting", "Evicted"],
  ] as const)("accepts the %s to %s transition", (current, next) => {
    expect(() =>
      assertStorageReliefCheckpointTransition(
        checkpoint(IDS.artifactA, current),
        checkpoint(IDS.artifactA, next),
      ),
    ).not.toThrow();
  });

  it.each([
    ["Candidate", "Evicting"],
    ["Verified", "Skipped"],
    ["Evicted", "Candidate"],
    ["Skipped", "Verified"],
  ] as const)("rejects the %s to %s transition", (current, next) => {
    expect(() =>
      assertStorageReliefCheckpointTransition(
        checkpoint(IDS.artifactA, current),
        checkpoint(IDS.artifactA, next),
      ),
    ).toThrow(DomainValidationError);
  });

  it("aggregates verified, evicted, and skipped checkpoints without double counting", () => {
    expect(
      aggregateStorageReliefCheckpoints([
        checkpoint(IDS.artifactA, "Evicted"),
        checkpoint(IDS.artifactB, "Skipped"),
      ]),
    ).toEqual({
      candidateArtifacts: 2,
      candidateBytes: 400,
      verifiedArtifacts: 1,
      verifiedBytes: 100,
      evictedArtifacts: 1,
      freedBytes: 100,
      skippedArtifacts: 1,
      skippedBytes: 300,
    });
  });

  it("rejects unsafe aggregate byte totals", () => {
    const large = {
      ...checkpoint(IDS.artifactA, "Candidate"),
      envelopeByteLength: Number.MAX_SAFE_INTEGER,
    };
    expect(() =>
      aggregateStorageReliefCheckpoints([large, { ...large, artifactObjectId: IDS.artifactB }]),
    ).toThrow(DomainValidationError);
  });
});

describe("storage-relief Job state", () => {
  const created = {
    version: 1,
    vaultId: IDS.vault,
    jobId: IDS.job,
    state: "Created",
    stage: "Synchronize",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    expectedServerOrigin: "https://sync.example.test",
    expectedAccountId: IDS.artifactA,
    candidateArtifacts: 1,
    candidateBytes: 100,
    verifiedArtifacts: 0,
    verifiedBytes: 0,
    evictedArtifacts: 0,
    freedBytes: 0,
    skippedArtifacts: 0,
    skippedBytes: 0,
    cancellationRequested: false,
  } as const;

  it("accepts forward progress and waiting-state resume", () => {
    const running = {
      ...created,
      state: "Running",
      stage: "Preflight",
      expectedLocalHead: {
        version: 1,
        vaultId: IDS.vault,
        generationId: IDS.generation,
        generationNumber: 2,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
      expectedGenerationId: IDS.generation,
      expectedGenerationNumber: 2,
    } as const;
    const waiting = { ...running, state: "WaitingForUnlock" } as const;
    expect(() => assertStorageReliefJobTransition(created, running)).not.toThrow();
    expect(() => assertStorageReliefJobTransition(running, waiting)).not.toThrow();
    expect(() => assertStorageReliefJobTransition(waiting, running)).not.toThrow();
  });

  it("rejects stage rollback, fence drift, and terminal restart", () => {
    const fenced = {
      ...created,
      state: "Running",
      stage: "Preflight",
      expectedLocalHead: {
        version: 1,
        vaultId: IDS.vault,
        generationId: IDS.generation,
        generationNumber: 2,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
      expectedGenerationId: IDS.generation,
      expectedGenerationNumber: 2,
    } as const;
    expect(() =>
      assertStorageReliefJobTransition(fenced, { ...fenced, stage: "Synchronize" }),
    ).toThrow(DomainValidationError);
    expect(() =>
      assertStorageReliefJobTransition(fenced, { ...fenced, expectedGenerationNumber: 3 }),
    ).toThrow(DomainValidationError);
    expect(() =>
      assertStorageReliefJobTransition(
        { ...fenced, state: "Cancelled" },
        { ...fenced, state: "Running" },
      ),
    ).toThrow(DomainValidationError);
  });
});

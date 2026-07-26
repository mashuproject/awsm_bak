import { describe, expect, it } from "vitest";
import { isAppRequest } from "../../src/app/protocol";
import { isStorageReliefRequest } from "../../src/app/storage-relief-protocol";
import { decodeRuntimeError } from "../../src/domain/decode";
import { DomainValidationError } from "../../src/domain/errors";
import { DATABASE_VERSION, STORES } from "../../src/drivers/indexeddb/schema";
import {
  decodeStorageReliefCheckpoint,
  decodeStorageReliefJob,
  decodeStoredRemoteOnlyArtifact,
} from "../../src/drivers/indexeddb/storage-relief-decode";
import { storageReliefJobView } from "../../src/runtime/storage-relief/view";

const IDS = {
  account: "00000000-0000-4000-8000-000000000001",
  artifact: "00000000-0000-4000-8000-000000000002",
  generation: "00000000-0000-4000-8000-000000000003",
  job: "00000000-0000-4000-8000-000000000004",
  vault: "00000000-0000-4000-8000-000000000005",
} as const;

const CREATED_JOB = {
  version: 1,
  vaultId: IDS.vault,
  jobId: IDS.job,
  state: "Created",
  stage: "Synchronize",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  expectedServerOrigin: "https://sync.example.test",
  expectedAccountId: IDS.account,
  candidateArtifacts: 1,
  candidateBytes: 1024,
  verifiedArtifacts: 0,
  verifiedBytes: 0,
  evictedArtifacts: 0,
  freedBytes: 0,
  skippedArtifacts: 0,
  skippedBytes: 0,
  cancellationRequested: false,
} as const;

const HEAD = {
  version: 1,
  vaultId: IDS.vault,
  generationId: IDS.generation,
  generationNumber: 7,
  appendedObjectIds: [],
  appendedEventIds: [],
} as const;

describe("storage-relief persisted contracts", () => {
  it("declares the canonical stores in the sole initial database schema", () => {
    expect(DATABASE_VERSION).toBe(1);
    expect([
      STORES.artifactAvailability,
      STORES.storageReliefJobs,
      STORES.storageReliefCheckpoints,
    ]).toEqual(["artifact_availability", "storage_relief_jobs", "storage_relief_checkpoints"]);
  });

  it("decodes canonical remote-only availability", () => {
    const availability = decodeStoredRemoteOnlyArtifact({
      version: 1,
      vaultId: IDS.vault,
      artifactObjectId: IDS.artifact,
      markedAt: "2026-07-21T00:00:01.000Z",
    });

    expect(availability).toEqual({
      version: 1,
      vaultId: IDS.vault,
      artifactObjectId: IDS.artifact,
      markedAt: "2026-07-21T00:00:01.000Z",
    });
  });

  it("rejects availability fields outside the canonical schema", () => {
    expect(() =>
      decodeStoredRemoteOnlyArtifact({
        version: 1,
        vaultId: IDS.vault,
        artifactObjectId: IDS.artifact,
        markedAt: "2026-07-21T00:00:01.000Z",
        serverOrigin: "https://semantic-leak.example.test",
      }),
    ).toThrow(DomainValidationError);
  });

  it("decodes a created Job without Generation fences", () => {
    expect(decodeStorageReliefJob(CREATED_JOB)).toEqual(CREATED_JOB);
    expect(() => decodeStorageReliefJob({ ...CREATED_JOB, verifiedArtifacts: 1 })).toThrow(
      DomainValidationError,
    );
  });

  it("requires local and remote Generation fences from preflight onward", () => {
    expect(() =>
      decodeStorageReliefJob({
        ...CREATED_JOB,
        state: "Running",
        stage: "Preflight",
      }),
    ).toThrow(DomainValidationError);

    expect(
      decodeStorageReliefJob({
        ...CREATED_JOB,
        state: "Running",
        stage: "Preflight",
        expectedLocalHead: HEAD,
        expectedGenerationId: IDS.generation,
        expectedGenerationNumber: 7,
      }),
    ).toMatchObject({ stage: "Preflight", expectedLocalHead: HEAD });
  });

  it("rejects impossible Job counters and terminal errors", () => {
    expect(() => decodeStorageReliefJob({ ...CREATED_JOB, verifiedArtifacts: 2 })).toThrow(
      DomainValidationError,
    );
    expect(() =>
      decodeStorageReliefJob({ ...CREATED_JOB, errorId: "STORAGE_TRANSACTION_FAILED" }),
    ).toThrow(DomainValidationError);
  });

  it("decodes verified and skipped checkpoint variants", () => {
    expect(
      decodeStorageReliefCheckpoint({
        version: 1,
        vaultId: IDS.vault,
        jobId: IDS.job,
        artifactObjectId: IDS.artifact,
        keyEpochId: "00000000-0000-4000-8000-000000000009",
        envelopeByteLength: 1024,
        envelopeChecksum: new Uint8Array(32),
        state: "Verified",
        remoteGenerationId: IDS.generation,
        remoteGenerationNumber: 7,
      }),
    ).toMatchObject({ state: "Verified", remoteGenerationId: IDS.generation });

    expect(
      decodeStorageReliefCheckpoint({
        version: 1,
        vaultId: IDS.vault,
        jobId: IDS.job,
        artifactObjectId: IDS.artifact,
        keyEpochId: "00000000-0000-4000-8000-000000000009",
        envelopeByteLength: 1024,
        envelopeChecksum: new Uint8Array(32),
        state: "Skipped",
        skipReason: "NotRemoteMember",
      }),
    ).toMatchObject({ state: "Skipped", skipReason: "NotRemoteMember" });
  });

  it("rejects checkpoint fields that do not match the state", () => {
    expect(() =>
      decodeStorageReliefCheckpoint({
        version: 1,
        vaultId: IDS.vault,
        jobId: IDS.job,
        artifactObjectId: IDS.artifact,
        keyEpochId: "00000000-0000-4000-8000-000000000009",
        envelopeByteLength: 1024,
        envelopeChecksum: new Uint8Array(32),
        state: "Candidate",
        skipReason: "NotRemoteMember",
      }),
    ).toThrow(DomainValidationError);
  });
});

describe("storage-relief application contracts", () => {
  it("projects persisted Job state without exposing server or Account identity", () => {
    expect(storageReliefJobView(CREATED_JOB)).toEqual({
      jobId: IDS.job,
      state: "Running",
      stage: "Synchronizing",
      candidateArtifacts: 1,
      candidateBytes: 1024,
      verifiedArtifacts: 0,
      verifiedBytes: 0,
      freedArtifacts: 0,
      freedBytes: 0,
      skippedArtifacts: 0,
      skippedBytes: 0,
      cancellationRequested: false,
    });
  });

  it("routes exact Vault-scoped storage-relief Commands", () => {
    expect(
      isStorageReliefRequest({ type: "GetStorageReliefEstimate", expectedVaultId: IDS.vault }),
    ).toBe(true);
    expect(
      isStorageReliefRequest({
        type: "StartStorageRelief",
        expectedVaultId: IDS.vault,
        candidateArtifacts: 2,
        candidateBytes: 4096,
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "StartStorageRelief",
        expectedVaultId: IDS.vault,
        candidateArtifacts: 1,
        candidateBytes: 1024,
      }),
    ).toBe(true);
    expect(
      isStorageReliefRequest({
        type: "CancelStorageRelief",
        expectedVaultId: IDS.vault,
        jobId: IDS.job,
      }),
    ).toBe(true);
  });

  it("rejects unsafe counters and extra storage-relief Command fields", () => {
    expect(
      isStorageReliefRequest({
        type: "StartStorageRelief",
        expectedVaultId: IDS.vault,
        candidateArtifacts: -1,
        candidateBytes: 4096,
      }),
    ).toBe(false);
    expect(
      isStorageReliefRequest({
        type: "GetStorageReliefEstimate",
        expectedVaultId: IDS.vault,
        artifactRole: "PRIMARY",
      }),
    ).toBe(false);
  });

  it.each([
    "STORAGE_RELIEF_AUTHENTICATION_REQUIRED",
    "STORAGE_RELIEF_ESTIMATE_CHANGED",
    "REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED",
    "REMOTE_ARTIFACT_OFFLINE",
    "REMOTE_ARTIFACT_UNAVAILABLE",
    "REMOTE_ARTIFACT_NOT_FOUND",
    "REMOTE_ARTIFACT_INTEGRITY_FAILED",
    "STALE_REPLICA_DISCARD_FAILED",
  ])("accepts the stable Runtime error %s", (id) => {
    expect(decodeRuntimeError({ id, message: "safe" })).toEqual({ id, message: "safe" });
  });
});

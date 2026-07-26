import { DomainValidationError } from "../../domain/errors";
import { bytes, canonicalRecord, integer, literal, timestamp, uuid } from "../../domain/validation";
import type {
  StorageReliefCheckpointState,
  StorageReliefCheckpointV1,
  StorageReliefSkipReason,
  StoredRemoteOnlyArtifactV1,
} from "./storage-relief-schema";

function checkpointState(value: unknown): StorageReliefCheckpointState {
  if (
    value === "Candidate" ||
    value === "Verified" ||
    value === "Evicting" ||
    value === "Evicted" ||
    value === "Skipped"
  ) {
    return value;
  }
  throw new DomainValidationError("storageReliefCheckpoint.state", "contains an unsupported state");
}

function skipReason(value: unknown): StorageReliefSkipReason {
  if (
    value === "NotRemoteMember" ||
    value === "RemoteMetadataMismatch" ||
    value === "DependencyClosureUnavailable"
  ) {
    return value;
  }
  throw new DomainValidationError(
    "storageReliefCheckpoint.skipReason",
    "contains an unsupported reason",
  );
}

export function decodeStoredRemoteOnlyArtifact(value: unknown): StoredRemoteOnlyArtifactV1 {
  const input = canonicalRecord(value, "artifactAvailability", [
    "version",
    "vaultId",
    "artifactObjectId",
    "markedAt",
  ]);
  return {
    version: literal(input.version, 1, "artifactAvailability.version"),
    vaultId: uuid(input.vaultId, "artifactAvailability.vaultId"),
    artifactObjectId: uuid(input.artifactObjectId, "artifactAvailability.artifactObjectId"),
    markedAt: timestamp(input.markedAt, "artifactAvailability.markedAt"),
  };
}

export function decodeStorageReliefCheckpoint(value: unknown): StorageReliefCheckpointV1 {
  const input = canonicalRecord(value, "storageReliefCheckpoint", [
    "version",
    "vaultId",
    "jobId",
    "artifactObjectId",
    "keyEpochId",
    "envelopeByteLength",
    "envelopeChecksum",
    "state",
    "remoteGenerationId",
    "remoteGenerationNumber",
    "skipReason",
  ]);
  const state = checkpointState(input.state);
  const remoteGenerationId =
    input.remoteGenerationId === undefined
      ? undefined
      : uuid(input.remoteGenerationId, "storageReliefCheckpoint.remoteGenerationId");
  const remoteGenerationNumber =
    input.remoteGenerationNumber === undefined
      ? undefined
      : integer(input.remoteGenerationNumber, "storageReliefCheckpoint.remoteGenerationNumber");
  const reason = input.skipReason === undefined ? undefined : skipReason(input.skipReason);
  const isRemoteVerified = state === "Verified" || state === "Evicting" || state === "Evicted";
  const hasRemoteFence = remoteGenerationId !== undefined && remoteGenerationNumber !== undefined;
  if (
    isRemoteVerified !== hasRemoteFence ||
    (state === "Skipped") !== (reason !== undefined) ||
    (isRemoteVerified && reason !== undefined)
  ) {
    throw new DomainValidationError(
      "storageReliefCheckpoint",
      "has fields that do not match its state",
    );
  }
  return {
    version: literal(input.version, 1, "storageReliefCheckpoint.version"),
    vaultId: uuid(input.vaultId, "storageReliefCheckpoint.vaultId"),
    jobId: uuid(input.jobId, "storageReliefCheckpoint.jobId"),
    artifactObjectId: uuid(input.artifactObjectId, "storageReliefCheckpoint.artifactObjectId"),
    keyEpochId: uuid(input.keyEpochId, "storageReliefCheckpoint.keyEpochId"),
    envelopeByteLength: integer(
      input.envelopeByteLength,
      "storageReliefCheckpoint.envelopeByteLength",
    ),
    envelopeChecksum: bytes(input.envelopeChecksum, 32, "storageReliefCheckpoint.envelopeChecksum"),
    state,
    ...(remoteGenerationId === undefined ? {} : { remoteGenerationId }),
    ...(remoteGenerationNumber === undefined ? {} : { remoteGenerationNumber }),
    ...(reason === undefined ? {} : { skipReason: reason }),
  };
}

export { decodeStorageReliefJob } from "./storage-relief-job-decode";

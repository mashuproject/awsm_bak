import { DomainValidationError } from "../../domain/errors";
import {
  bytes,
  canonicalRecord,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "../../domain/validation";
import type {
  SearchIndexCheckpointV1,
  SearchIndexJobStage,
  SearchIndexJobState,
  SearchIndexJobV1,
  SearchProjectionType,
  StoredSearchEnvelopeV1,
  StoredSearchModelReferenceV1,
} from "./schema";

const SOURCE_REVISION_PATTERN = /^[0-9a-f]{64}$/u;
const PROJECTION_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9]+$/u;
const PROJECTION_TYPES: readonly SearchProjectionType[] = [
  "SearchSettings-v1",
  "SearchKeyword-v1",
  "SearchKeywordStatistics-v1",
  "SearchKeywordPosting-v1",
  "SearchSemantic-v1",
  "SearchSemanticPassages-v1",
];
const JOB_STATES: readonly SearchIndexJobState[] = [
  "Created",
  "Running",
  "Paused",
  "WaitingForUnlock",
  "WaitingForLibrary",
  "WaitingForPermission",
  "WaitingForNetwork",
  "Failed",
  "Succeeded",
];
const JOB_STAGES: readonly SearchIndexJobStage[] = [
  "Discover",
  "Keyword",
  "Semantic",
  "Validate",
  "Terminal",
];

function projectionGeneration(value: unknown, field: string): string {
  const decoded = string(value, field);
  const match = PROJECTION_GENERATION_PATTERN.exec(decoded);
  if (match === null) throw new DomainValidationError(field, "must be canonical");
  uuid(decoded.slice(0, decoded.lastIndexOf(":")), `${field}.generationId`);
  integer(Number(decoded.slice(decoded.lastIndexOf(":") + 1)), `${field}.revision`);
  return decoded;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, field);
}

export function decodeStoredSearchEnvelope(value: unknown): StoredSearchEnvelopeV1 {
  const input = canonicalRecord(value, "searchEnvelope", [
    "version",
    "vaultId",
    "keyEpochId",
    "rowId",
    "projectionType",
    "sourceRevision",
    "nonce",
    "ciphertext",
  ]);
  const projectionType = string(
    input.projectionType,
    "searchEnvelope.projectionType",
  ) as SearchProjectionType;
  if (!PROJECTION_TYPES.includes(projectionType)) {
    throw new DomainValidationError("searchEnvelope.projectionType", "is unsupported");
  }
  const sourceRevision = string(input.sourceRevision, "searchEnvelope.sourceRevision");
  const expectsProjectionGeneration = projectionType === "SearchKeywordStatistics-v1";
  if (
    (expectsProjectionGeneration && !PROJECTION_GENERATION_PATTERN.test(sourceRevision)) ||
    (!expectsProjectionGeneration && !SOURCE_REVISION_PATTERN.test(sourceRevision))
  ) {
    throw new DomainValidationError(
      "searchEnvelope.sourceRevision",
      expectsProjectionGeneration
        ? "must be a canonical Search projection generation"
        : "must be a lowercase SHA-256 digest",
    );
  }
  const ciphertext = bytes(input.ciphertext, undefined, "searchEnvelope.ciphertext");
  if (ciphertext.byteLength < 16) {
    throw new DomainValidationError(
      "searchEnvelope.ciphertext",
      "must contain an authentication tag",
    );
  }
  return {
    version: literal(input.version, 1, "searchEnvelope.version"),
    vaultId: uuid(input.vaultId, "searchEnvelope.vaultId"),
    keyEpochId: uuid(input.keyEpochId, "searchEnvelope.keyEpochId"),
    rowId: string(input.rowId, "searchEnvelope.rowId"),
    projectionType,
    sourceRevision,
    nonce: bytes(input.nonce, 12, "searchEnvelope.nonce"),
    ciphertext,
  };
}

export function decodeStoredSearchModelReference(value: unknown): StoredSearchModelReferenceV1 {
  const input = canonicalRecord(value, "searchModelReference", [
    "version",
    "vaultReference",
    "manifestId",
  ]);
  const vaultReference = string(input.vaultReference, "searchModelReference.vaultReference");
  if (!SOURCE_REVISION_PATTERN.test(vaultReference))
    throw new DomainValidationError(
      "searchModelReference.vaultReference",
      "must be a lowercase HMAC-SHA-256 digest",
    );
  const manifestId = string(input.manifestId, "searchModelReference.manifestId");
  if (manifestId.length === 0 || manifestId.length > 256)
    throw new DomainValidationError("searchModelReference.manifestId", "is out of range");
  return {
    version: literal(input.version, 1, "searchModelReference.version"),
    vaultReference,
    manifestId,
  };
}

export function decodeSearchIndexJob(value: unknown): SearchIndexJobV1 {
  const input = canonicalRecord(value, "searchIndexJob", [
    "version",
    "jobId",
    "vaultId",
    "state",
    "stage",
    "projectionGeneration",
    "providerIdentityHash",
    "completedCaptures",
    "totalCaptures",
    "failedCaptures",
    "createdAt",
    "updatedAt",
    "leaseOwner",
    "leaseExpiresAt",
    "retryAt",
    "errorId",
  ]);
  if (!JOB_STATES.includes(input.state as SearchIndexJobState))
    throw new DomainValidationError("searchIndexJob.state", "is unsupported");
  if (!JOB_STAGES.includes(input.stage as SearchIndexJobStage))
    throw new DomainValidationError("searchIndexJob.stage", "is unsupported");
  const completedCaptures = integer(input.completedCaptures, "searchIndexJob.completedCaptures");
  const totalCaptures = integer(input.totalCaptures, "searchIndexJob.totalCaptures");
  const failedCaptures = integer(input.failedCaptures, "searchIndexJob.failedCaptures");
  if (completedCaptures + failedCaptures > totalCaptures)
    throw new DomainValidationError("searchIndexJob", "has impossible progress");
  const state = input.state as SearchIndexJobState;
  const createdAt = timestamp(input.createdAt, "searchIndexJob.createdAt");
  const updatedAt = timestamp(input.updatedAt, "searchIndexJob.updatedAt");
  if (updatedAt < createdAt)
    throw new DomainValidationError("searchIndexJob.updatedAt", "precedes creation");
  const leaseOwner = optionalString(input.leaseOwner, "searchIndexJob.leaseOwner");
  const leaseExpiresAt = optionalTimestamp(input.leaseExpiresAt, "searchIndexJob.leaseExpiresAt");
  if (
    (leaseOwner === undefined) !== (leaseExpiresAt === undefined) ||
    (leaseOwner !== undefined && state !== "Running") ||
    (leaseExpiresAt !== undefined && leaseExpiresAt <= updatedAt)
  )
    throw new DomainValidationError("searchIndexJob", "has an invalid lease");
  const errorId = optionalString(input.errorId, "searchIndexJob.errorId");
  if ((errorId !== undefined) !== (state === "Failed"))
    throw new DomainValidationError("searchIndexJob.errorId", "does not match the Job state");
  const providerIdentityHash = optionalString(
    input.providerIdentityHash,
    "searchIndexJob.providerIdentityHash",
  );
  if (providerIdentityHash !== undefined && !SOURCE_REVISION_PATTERN.test(providerIdentityHash))
    throw new DomainValidationError(
      "searchIndexJob.providerIdentityHash",
      "must be a lowercase SHA-256 digest",
    );
  const retryAt = optionalTimestamp(input.retryAt, "searchIndexJob.retryAt");
  return {
    version: literal(input.version, 1, "searchIndexJob.version"),
    jobId: uuid(input.jobId, "searchIndexJob.jobId"),
    vaultId: uuid(input.vaultId, "searchIndexJob.vaultId"),
    state,
    stage: input.stage as SearchIndexJobStage,
    projectionGeneration: projectionGeneration(
      input.projectionGeneration,
      "searchIndexJob.projectionGeneration",
    ),
    ...(providerIdentityHash === undefined ? {} : { providerIdentityHash }),
    completedCaptures,
    totalCaptures,
    failedCaptures,
    createdAt,
    updatedAt,
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(errorId === undefined ? {} : { errorId }),
  };
}

export function decodeSearchIndexCheckpoint(value: unknown): SearchIndexCheckpointV1 {
  const input = canonicalRecord(value, "searchIndexCheckpoint", [
    "version",
    "vaultId",
    "jobId",
    "bundleId",
    "sourceRevision",
    "keywordState",
    "semanticState",
    "attemptCount",
    "updatedAt",
    "errorId",
  ]);
  if (
    input.keywordState !== "Pending" &&
    input.keywordState !== "Committed" &&
    input.keywordState !== "Failed"
  )
    throw new DomainValidationError("searchIndexCheckpoint.keywordState", "is unsupported");
  if (
    input.semanticState !== "NotConfigured" &&
    input.semanticState !== "Pending" &&
    input.semanticState !== "Committed" &&
    input.semanticState !== "Failed"
  )
    throw new DomainValidationError("searchIndexCheckpoint.semanticState", "is unsupported");
  const sourceRevision = string(input.sourceRevision, "searchIndexCheckpoint.sourceRevision");
  if (!SOURCE_REVISION_PATTERN.test(sourceRevision))
    throw new DomainValidationError(
      "searchIndexCheckpoint.sourceRevision",
      "must be a lowercase SHA-256 digest",
    );
  const errorId = optionalString(input.errorId, "searchIndexCheckpoint.errorId");
  if (
    (errorId !== undefined) !==
    (input.keywordState === "Failed" || input.semanticState === "Failed")
  )
    throw new DomainValidationError(
      "searchIndexCheckpoint.errorId",
      "does not match the checkpoint state",
    );
  return {
    version: literal(input.version, 1, "searchIndexCheckpoint.version"),
    vaultId: uuid(input.vaultId, "searchIndexCheckpoint.vaultId"),
    jobId: uuid(input.jobId, "searchIndexCheckpoint.jobId"),
    bundleId: uuid(input.bundleId, "searchIndexCheckpoint.bundleId"),
    sourceRevision,
    keywordState: input.keywordState,
    semanticState: input.semanticState,
    attemptCount: integer(input.attemptCount, "searchIndexCheckpoint.attemptCount"),
    updatedAt: timestamp(input.updatedAt, "searchIndexCheckpoint.updatedAt"),
    ...(errorId === undefined ? {} : { errorId }),
  };
}

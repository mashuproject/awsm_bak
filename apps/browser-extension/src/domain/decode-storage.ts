import type { ArtifactRole } from "./artifact-graph";
import {
  CAPTURE_WARNINGS,
  type CaptureJob,
  type CaptureJobStage,
  type CaptureJobState,
  type CaptureWarningId,
  type EncryptedEnvelopeV1,
  type LibraryItemV1,
  RUNTIME_ERROR_IDS,
  type RuntimeErrorId,
  type RuntimeErrorV1,
} from "./contracts";
import { DomainValidationError } from "./errors";
import {
  bytes,
  canonicalRecord,
  httpUrl,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "./validation";

const ARTIFACT_ROLES: readonly ArtifactRole[] = [
  "PRIMARY",
  "SCREENSHOT_FULL",
  "THUMBNAIL",
  "TEXT_EXTRACTED",
  "CONTENT_STRUCTURED",
];

function artifactRoles(value: unknown): readonly ArtifactRole[] {
  if (!Array.isArray(value))
    throw new DomainValidationError("libraryItem.artifactRoles", "must be an array");
  const roles = value.map((candidate, index) => {
    if (!ARTIFACT_ROLES.includes(candidate as ArtifactRole))
      throw new DomainValidationError(`libraryItem.artifactRoles.${index}`, "is unsupported");
    return candidate as ArtifactRole;
  });
  if (new Set(roles).size !== roles.length || roles.join("\n") !== [...roles].toSorted().join("\n"))
    throw new DomainValidationError("libraryItem.artifactRoles", "must be sorted and unique");
  if (!roles.includes("PRIMARY"))
    throw new DomainValidationError("libraryItem.artifactRoles", "must contain PRIMARY");
  return roles;
}

function runtimeErrorId(value: unknown, field: string): RuntimeErrorId {
  for (const candidate of RUNTIME_ERROR_IDS) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new DomainValidationError(field, "contains an unsupported error identifier");
}

function warningId(value: unknown, field: string): CaptureWarningId {
  for (const candidate of CAPTURE_WARNINGS) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new DomainValidationError(field, "contains an unsupported warning identifier");
}

function jobState(value: unknown): CaptureJobState {
  if (value === "Created" || value === "Running" || value === "Succeeded" || value === "Failed") {
    return value;
  }
  throw new DomainValidationError("job.state", "contains an unsupported state");
}

function jobStage(value: unknown): CaptureJobStage {
  if (
    value === "Preflight" ||
    value === "Snapshot" ||
    value === "Screenshot" ||
    value === "Resources" ||
    value === "Package" ||
    value === "Commit"
  ) {
    return value;
  }
  throw new DomainValidationError("job.stage", "contains an unsupported stage");
}

function envelopeType(value: unknown): EncryptedEnvelopeV1["objectType"] {
  if (
    value === "BundleDescriptor" ||
    value === "Event" ||
    value === "Projection" ||
    value === "WrappedKey" ||
    value === "VaultGeneration"
  ) {
    return value;
  }
  throw new DomainValidationError("envelope.objectType", "contains an unsupported Object type");
}

export function decodeEncryptedEnvelope(value: unknown): EncryptedEnvelopeV1 {
  const input = canonicalRecord(value, "envelope", [
    "formatVersion",
    "objectType",
    "algorithm",
    "objectId",
    "payloadLength",
    "nonce",
    "ciphertext",
  ]);
  const payloadLength = integer(input.payloadLength, "envelope.payloadLength");
  const ciphertext = bytes(input.ciphertext, undefined, "envelope.ciphertext");
  if (ciphertext.byteLength !== payloadLength + 16) {
    throw new DomainValidationError(
      "envelope.ciphertext",
      "must contain the payload and authentication tag",
    );
  }
  return {
    formatVersion: literal(input.formatVersion, 1, "envelope.formatVersion"),
    objectType: envelopeType(input.objectType),
    algorithm: literal(input.algorithm, "enc:xchacha20poly1305:v1", "envelope.algorithm"),
    objectId: uuid(input.objectId, "envelope.objectId"),
    payloadLength,
    nonce: bytes(input.nonce, 24, "envelope.nonce"),
    ciphertext,
  };
}

export function decodeLibraryItem(value: unknown): LibraryItemV1 {
  const input = canonicalRecord(value, "libraryItem", [
    "version",
    "bundleId",
    "descriptorObjectId",
    "assignedCollectionId",
    "title",
    "originalUrl",
    "capturedAt",
    "artifactRoles",
    "status",
    "warnings",
  ]);
  if (!Array.isArray(input.warnings)) {
    throw new DomainValidationError("libraryItem.warnings", "must be an array");
  }
  if (input.status !== "Active" && input.status !== "Deleted") {
    throw new DomainValidationError("libraryItem.status", "must be Active or Deleted");
  }
  return {
    version: literal(input.version, 1, "libraryItem.version"),
    bundleId: uuid(input.bundleId, "libraryItem.bundleId"),
    descriptorObjectId: uuid(input.descriptorObjectId, "libraryItem.descriptorObjectId"),
    assignedCollectionId: uuid(input.assignedCollectionId, "libraryItem.assignedCollectionId"),
    title: string(input.title, "libraryItem.title"),
    originalUrl: httpUrl(input.originalUrl, "libraryItem.originalUrl"),
    capturedAt: timestamp(input.capturedAt, "libraryItem.capturedAt"),
    artifactRoles: artifactRoles(input.artifactRoles),
    status: input.status,
    warnings: input.warnings.map((warning, index) =>
      warningId(warning, `libraryItem.warnings[${index}]`),
    ),
  };
}

export function decodeCaptureJob(value: unknown): CaptureJob {
  const input = canonicalRecord(value, "job", [
    "version",
    "vaultId",
    "jobId",
    "commandId",
    "tabId",
    "state",
    "stage",
    "createdAt",
    "updatedAt",
    "errorId",
  ]);
  const errorId =
    input.errorId === undefined ? undefined : runtimeErrorId(input.errorId, "job.errorId");
  return {
    version: literal(input.version, 1, "job.version"),
    vaultId: uuid(input.vaultId, "job.vaultId"),
    jobId: uuid(input.jobId, "job.jobId"),
    commandId: uuid(input.commandId, "job.commandId"),
    tabId: integer(input.tabId, "job.tabId"),
    state: jobState(input.state),
    stage: jobStage(input.stage),
    createdAt: timestamp(input.createdAt, "job.createdAt"),
    updatedAt: timestamp(input.updatedAt, "job.updatedAt"),
    ...(errorId === undefined ? {} : { errorId }),
  };
}

export function decodeRuntimeError(value: unknown): RuntimeErrorV1 {
  const input = canonicalRecord(value, "error", ["id", "message"]);
  return {
    id: runtimeErrorId(input.id, "error.id"),
    message: string(input.message, "error.message"),
  };
}

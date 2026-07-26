import type {
  CaptureJob,
  CaptureJobStage,
  CaptureJobState,
  RuntimeErrorId,
} from "../../domain/contracts";
import { RUNTIME_ERROR_IDS } from "../../domain/contracts";
import { DomainValidationError } from "../../domain/errors";
import {
  boolean,
  bytes,
  canonicalRecord,
  integer,
  literal,
  timestamp,
  uuid,
} from "../../domain/validation";
import type {
  CommandOutcomeV1,
  ExportJobStage,
  ExportJobState,
  ExportJobV1,
  ImportJobStage,
  ImportJobState,
  ImportJobV1,
  StoredCollectionProjectionV1,
  StoredEvent,
  StoredObjectType,
  StoredObjectV1,
  StoredProjectionV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
  StoredVaultNameProjectionV1,
} from "./schema";

function objectType(value: unknown): StoredObjectType {
  if (value === "BundleDescriptor" || value === "Artifact") {
    return value;
  }
  throw new DomainValidationError("object.objectType", "contains an unsupported Object type");
}

export function decodeStoredVaultGeneration(value: unknown): StoredVaultGenerationV1 {
  const input = canonicalRecord(value, "vaultGeneration", [
    "version",
    "generationId",
    "generationNumber",
    "predecessorGenerationId",
    "envelopeBytes",
  ]);
  return {
    version: literal(input.version, 1, "vaultGeneration.version"),
    generationId: uuid(input.generationId, "vaultGeneration.generationId"),
    generationNumber: integer(input.generationNumber, "vaultGeneration.generationNumber"),
    ...(input.predecessorGenerationId === undefined
      ? {}
      : {
          predecessorGenerationId: uuid(
            input.predecessorGenerationId,
            "vaultGeneration.predecessorGenerationId",
          ),
        }),
    envelopeBytes: bytes(input.envelopeBytes, undefined, "vaultGeneration.envelopeBytes"),
  };
}

export function decodeStoredVaultHead(value: unknown): StoredVaultHeadV1 {
  const input = canonicalRecord(value, "vaultHead", [
    "version",
    "vaultId",
    "generationId",
    "generationNumber",
    "appendedObjectIds",
    "appendedEventIds",
  ]);
  const identifiers = (value: unknown, field: string): readonly string[] => {
    if (!Array.isArray(value)) throw new DomainValidationError(field, "must be an array");
    const result = value.map((entry, index) => uuid(entry, `${field}.${String(index)}`));
    if (
      result.length !== new Set(result).size ||
      result.join("\n") !== [...result].toSorted().join("\n")
    ) {
      throw new DomainValidationError(field, "must be a canonical sorted unique list");
    }
    return result;
  };
  return {
    version: literal(input.version, 1, "vaultHead.version"),
    vaultId: uuid(input.vaultId, "vaultHead.vaultId"),
    generationId: uuid(input.generationId, "vaultHead.generationId"),
    generationNumber: integer(input.generationNumber, "vaultHead.generationNumber"),
    appendedObjectIds: identifiers(input.appendedObjectIds, "vaultHead.appendedObjectIds"),
    appendedEventIds: identifiers(input.appendedEventIds, "vaultHead.appendedEventIds"),
  };
}

export function decodeStoredObject(value: unknown): StoredObjectV1 {
  if (typeof value !== "object" || value === null || !("objectType" in value))
    throw new DomainValidationError("object", "must identify its Object type");
  const type = objectType(value.objectType);
  if (type === "BundleDescriptor") {
    const input = canonicalRecord(value, "object", [
      "version",
      "objectId",
      "objectType",
      "envelopeBytes",
    ]);
    return {
      version: literal(input.version, 1, "object.version"),
      objectId: uuid(input.objectId, "object.objectId"),
      objectType: literal(input.objectType, "BundleDescriptor", "object.objectType"),
      envelopeBytes: bytes(input.envelopeBytes, undefined, "object.envelopeBytes"),
    };
  }
  const input = canonicalRecord(value, "object", [
    "version",
    "objectId",
    "objectType",
    "keyEpochId",
    "envelopeFormat",
    "envelopeByteLength",
    "envelopeChecksumAlgorithm",
    "envelopeChecksum",
  ]);
  return {
    version: literal(input.version, 1, "object.version"),
    objectId: uuid(input.objectId, "object.objectId"),
    objectType: literal(input.objectType, "Artifact", "object.objectType"),
    keyEpochId: uuid(input.keyEpochId, "object.keyEpochId"),
    envelopeFormat: literal(
      input.envelopeFormat,
      "artifact:xchacha20poly1305-chunked:v1",
      "object.envelopeFormat",
    ),
    envelopeByteLength: integer(input.envelopeByteLength, "object.envelopeByteLength"),
    envelopeChecksumAlgorithm: literal(
      input.envelopeChecksumAlgorithm,
      "hash:sha256:v1",
      "object.envelopeChecksumAlgorithm",
    ),
    envelopeChecksum: bytes(input.envelopeChecksum, 32, "object.envelopeChecksum"),
  };
}

export function decodeStoredEvent(value: unknown): StoredEvent {
  const input = canonicalRecord(value, "event", [
    "version",
    "vaultId",
    "eventId",
    "referencedObjectIds",
    "orderingTimestamp",
    "envelopeBytes",
  ]);
  const version = literal(input.version, 1, "event.version");
  if (!Array.isArray(input.referencedObjectIds)) {
    throw new DomainValidationError("event.referencedObjectIds", "must be an array");
  }
  const referencedObjectIds = input.referencedObjectIds.map((value, index) =>
    uuid(value, `event.referencedObjectIds.${String(index)}`),
  );
  if (
    new Set(referencedObjectIds).size !== referencedObjectIds.length ||
    referencedObjectIds.join("\n") !== [...referencedObjectIds].toSorted().join("\n")
  ) {
    throw new DomainValidationError(
      "event.referencedObjectIds",
      "must be a canonical sorted unique list",
    );
  }
  return {
    version,
    vaultId: uuid(input.vaultId, "event.vaultId"),
    eventId: uuid(input.eventId, "event.eventId"),
    referencedObjectIds,
    orderingTimestamp: timestamp(input.orderingTimestamp, "event.orderingTimestamp"),
    envelopeBytes: bytes(input.envelopeBytes, undefined, "event.envelopeBytes"),
  };
}

export function decodeStoredProjection(value: unknown): StoredProjectionV1 {
  const input = canonicalRecord(value, "projection", ["version", "bundleId", "envelopeBytes"]);
  return {
    version: literal(input.version, 1, "projection.version"),
    bundleId: uuid(input.bundleId, "projection.bundleId"),
    envelopeBytes: bytes(input.envelopeBytes, undefined, "projection.envelopeBytes"),
  };
}

export function decodeStoredCollectionProjection(value: unknown): StoredCollectionProjectionV1 {
  const input = canonicalRecord(value, "collectionProjection", [
    "version",
    "projectionId",
    "envelopeBytes",
  ]);
  return {
    version: literal(input.version, 1, "collectionProjection.version"),
    projectionId: uuid(input.projectionId, "collectionProjection.projectionId"),
    envelopeBytes: bytes(input.envelopeBytes, undefined, "collectionProjection.envelopeBytes"),
  };
}

export function decodeStoredVaultNameProjection(value: unknown): StoredVaultNameProjectionV1 {
  const input = canonicalRecord(value, "vaultNameProjection", [
    "version",
    "vaultId",
    "sourceEventId",
    "envelopeBytes",
  ]);
  return {
    version: literal(input.version, 1, "vaultNameProjection.version"),
    vaultId: uuid(input.vaultId, "vaultNameProjection.vaultId"),
    sourceEventId: uuid(input.sourceEventId, "vaultNameProjection.sourceEventId"),
    envelopeBytes: bytes(input.envelopeBytes, undefined, "vaultNameProjection.envelopeBytes"),
  };
}

export function decodeCommandOutcome(value: unknown): CommandOutcomeV1 {
  const input = canonicalRecord(value, "outcome", [
    "version",
    "commandId",
    "status",
    "bundleId",
    "descriptorObjectId",
    "eventId",
  ]);
  return {
    version: literal(input.version, 1, "outcome.version"),
    commandId: uuid(input.commandId, "outcome.commandId"),
    status: literal(input.status, "Succeeded", "outcome.status"),
    bundleId: uuid(input.bundleId, "outcome.bundleId"),
    descriptorObjectId: uuid(input.descriptorObjectId, "outcome.descriptorObjectId"),
    eventId: uuid(input.eventId, "outcome.eventId"),
  };
}

function captureJobState(value: unknown): CaptureJobState {
  if (value === "Created" || value === "Running" || value === "Succeeded" || value === "Failed") {
    return value;
  }
  throw new DomainValidationError("captureJob.state", "contains an unsupported state");
}

function captureJobStage(value: unknown): CaptureJobStage {
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
  throw new DomainValidationError("captureJob.stage", "contains an unsupported stage");
}

function runtimeErrorId(value: unknown): RuntimeErrorId {
  if (typeof value === "string" && RUNTIME_ERROR_IDS.includes(value as RuntimeErrorId)) {
    return value as RuntimeErrorId;
  }
  throw new DomainValidationError("captureJob.errorId", "contains an unsupported error identifier");
}

export function decodeCaptureJob(value: unknown): CaptureJob {
  const input = canonicalRecord(value, "captureJob", [
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
    "noticeDismissed",
  ]);
  const errorId = input.errorId === undefined ? undefined : runtimeErrorId(input.errorId);
  const noticeDismissed =
    input.noticeDismissed === undefined
      ? undefined
      : boolean(input.noticeDismissed, "captureJob.noticeDismissed");
  return {
    version: literal(input.version, 1, "captureJob.version"),
    vaultId: uuid(input.vaultId, "captureJob.vaultId"),
    jobId: uuid(input.jobId, "captureJob.jobId"),
    commandId: uuid(input.commandId, "captureJob.commandId"),
    tabId: integer(input.tabId, "captureJob.tabId"),
    state: captureJobState(input.state),
    stage: captureJobStage(input.stage),
    createdAt: timestamp(input.createdAt, "captureJob.createdAt"),
    updatedAt: timestamp(input.updatedAt, "captureJob.updatedAt"),
    ...(errorId === undefined ? {} : { errorId }),
    ...(noticeDismissed === undefined ? {} : { noticeDismissed }),
  };
}

export function decodeExportJob(value: unknown): ExportJobV1 {
  const input = canonicalRecord(value, "exportJob", [
    "version",
    "vaultId",
    "jobId",
    "packageId",
    "state",
    "stage",
    "createdAt",
    "updatedAt",
    "completedEntries",
    "totalEntries",
    "processedBytes",
    "totalBytes",
    "cancellationRequested",
    "verifiedSnapshot",
    "errorId",
  ]);
  if (!["Created", "Running", "Succeeded", "Failed", "Cancelled"].includes(String(input.state))) {
    throw new DomainValidationError("exportJob.state", "contains an unsupported state");
  }
  if (!["Preflight", "Snapshot", "Verify", "Package", "Download"].includes(String(input.stage))) {
    throw new DomainValidationError("exportJob.stage", "contains an unsupported stage");
  }
  const errorId = input.errorId === undefined ? undefined : runtimeErrorId(input.errorId);
  const verifiedSnapshot =
    input.verifiedSnapshot === undefined
      ? undefined
      : canonicalRecord(input.verifiedSnapshot, "exportJob.verifiedSnapshot", [
          "vaultId",
          "generationId",
          "generationNumber",
          "appendedObjectIds",
          "appendedEventIds",
          "coverage",
          "verifiedAt",
          "downloadedAt",
        ]);
  const identifiers = (value: unknown, field: string): readonly string[] => {
    if (!Array.isArray(value)) throw new DomainValidationError(field, "must be an array");
    const result = value.map((entry, index) => uuid(entry, `${field}.${String(index)}`));
    if (
      new Set(result).size !== result.length ||
      result.join("\n") !== result.toSorted().join("\n")
    )
      throw new DomainValidationError(field, "must contain unique sorted UUIDs");
    return result;
  };
  const decodedSnapshot =
    verifiedSnapshot === undefined
      ? undefined
      : {
          vaultId: uuid(verifiedSnapshot.vaultId, "exportJob.verifiedSnapshot.vaultId"),
          generationId: uuid(
            verifiedSnapshot.generationId,
            "exportJob.verifiedSnapshot.generationId",
          ),
          generationNumber: integer(
            verifiedSnapshot.generationNumber,
            "exportJob.verifiedSnapshot.generationNumber",
          ),
          appendedObjectIds: identifiers(
            verifiedSnapshot.appendedObjectIds,
            "exportJob.verifiedSnapshot.appendedObjectIds",
          ),
          appendedEventIds: identifiers(
            verifiedSnapshot.appendedEventIds,
            "exportJob.verifiedSnapshot.appendedEventIds",
          ),
          coverage: literal(
            verifiedSnapshot.coverage,
            "Complete",
            "exportJob.verifiedSnapshot.coverage",
          ),
          verifiedAt: timestamp(
            verifiedSnapshot.verifiedAt,
            "exportJob.verifiedSnapshot.verifiedAt",
          ),
          downloadedAt: timestamp(
            verifiedSnapshot.downloadedAt,
            "exportJob.verifiedSnapshot.downloadedAt",
          ),
        };
  if (
    (input.state === "Succeeded") !== (decodedSnapshot !== undefined) ||
    (decodedSnapshot !== undefined && decodedSnapshot.vaultId !== input.vaultId)
  )
    throw new DomainValidationError(
      "exportJob.verifiedSnapshot",
      "must exactly accompany a successful Complete Export",
    );
  return {
    version: literal(input.version, 1, "exportJob.version"),
    vaultId: uuid(input.vaultId, "exportJob.vaultId"),
    jobId: uuid(input.jobId, "exportJob.jobId"),
    packageId: uuid(input.packageId, "exportJob.packageId"),
    state: input.state as ExportJobState,
    stage: input.stage as ExportJobStage,
    createdAt: timestamp(input.createdAt, "exportJob.createdAt"),
    updatedAt: timestamp(input.updatedAt, "exportJob.updatedAt"),
    completedEntries: integer(input.completedEntries, "exportJob.completedEntries"),
    totalEntries: integer(input.totalEntries, "exportJob.totalEntries"),
    processedBytes: integer(input.processedBytes, "exportJob.processedBytes"),
    totalBytes: integer(input.totalBytes, "exportJob.totalBytes"),
    cancellationRequested: boolean(input.cancellationRequested, "exportJob.cancellationRequested"),
    ...(decodedSnapshot === undefined ? {} : { verifiedSnapshot: decodedSnapshot }),
    ...(errorId === undefined ? {} : { errorId }),
  };
}

export function decodeImportJob(value: unknown): ImportJobV1 {
  const input = canonicalRecord(value, "importJob", [
    "version",
    "jobId",
    "state",
    "stage",
    "createdAt",
    "updatedAt",
    "sourceByteLength",
    "acquiredBytes",
    "completedEntries",
    "totalEntries",
    "processedBytes",
    "totalBytes",
    "cancellationRequested",
    "destinationVaultId",
    "errorId",
  ]);
  const states = ["Created", "Running", "Succeeded", "Failed", "Cancelled"] as const;
  const stages = ["Acquire", "Authenticate", "Validate", "Prepare", "Rebuild", "Commit"] as const;
  if (!states.includes(input.state as (typeof states)[number])) {
    throw new DomainValidationError("importJob.state", "contains an unsupported state");
  }
  if (!stages.includes(input.stage as (typeof stages)[number])) {
    throw new DomainValidationError("importJob.stage", "contains an unsupported stage");
  }
  const state = input.state as ImportJobState;
  const stage = input.stage as ImportJobStage;
  const sourceByteLength = integer(input.sourceByteLength, "importJob.sourceByteLength");
  const acquiredBytes = integer(input.acquiredBytes, "importJob.acquiredBytes");
  const completedEntries = integer(input.completedEntries, "importJob.completedEntries");
  const totalEntries = integer(input.totalEntries, "importJob.totalEntries");
  const processedBytes = integer(input.processedBytes, "importJob.processedBytes");
  const totalBytes = integer(input.totalBytes, "importJob.totalBytes");
  if (
    acquiredBytes > sourceByteLength ||
    completedEntries > totalEntries ||
    processedBytes > totalBytes
  ) {
    throw new DomainValidationError("importJob", "contains progress beyond its declared total");
  }
  if (state === "Created" && stage !== "Acquire" && stage !== "Authenticate") {
    throw new DomainValidationError("importJob", "has an impossible Created stage");
  }
  if (
    state === "Running" &&
    stage !== "Validate" &&
    stage !== "Prepare" &&
    stage !== "Rebuild" &&
    stage !== "Commit"
  ) {
    throw new DomainValidationError("importJob", "has an impossible Running stage");
  }
  if (state === "Succeeded" && stage !== "Commit") {
    throw new DomainValidationError("importJob", "has an impossible Succeeded stage");
  }
  const destinationVaultId =
    input.destinationVaultId === undefined
      ? undefined
      : uuid(input.destinationVaultId, "importJob.destinationVaultId");
  if (
    ((state === "Running" || state === "Succeeded") && destinationVaultId === undefined) ||
    (state === "Created" && destinationVaultId !== undefined)
  ) {
    throw new DomainValidationError("importJob.destinationVaultId", "does not match Job state");
  }
  const errorId = input.errorId === undefined ? undefined : runtimeErrorId(input.errorId);
  if ((errorId === undefined) !== (state !== "Failed")) {
    throw new DomainValidationError("importJob.errorId", "is permitted only for failed Jobs");
  }
  return {
    version: literal(input.version, 1, "importJob.version"),
    jobId: uuid(input.jobId, "importJob.jobId"),
    state,
    stage,
    createdAt: timestamp(input.createdAt, "importJob.createdAt"),
    updatedAt: timestamp(input.updatedAt, "importJob.updatedAt"),
    sourceByteLength,
    acquiredBytes,
    completedEntries,
    totalEntries,
    processedBytes,
    totalBytes,
    cancellationRequested: boolean(input.cancellationRequested, "importJob.cancellationRequested"),
    ...(destinationVaultId === undefined ? {} : { destinationVaultId }),
    ...(errorId === undefined ? {} : { errorId }),
  };
}

import type { ArtifactRole } from "../../domain/artifact-graph";
import { CAPTURE_WARNINGS, type CaptureWarningId } from "../../domain/contracts";
import { DomainValidationError } from "../../domain/errors";
import { canonicalRecord, literal, timestamp, uuid } from "../../domain/validation";

export interface BundleRegisteredPayloadV1 {
  readonly version: 1;
  readonly eventType: "BundleRegistered";
  readonly eventVersion: 1;
  readonly payloadVersion: 1;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly timestamp: string;
  readonly protocolVersion: 1;
  readonly correlationId: string;
  readonly bundleId: string;
  readonly descriptorObjectId: string;
  readonly artifactObjectIds: readonly string[];
  readonly collectionId: string;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly warnings: readonly CaptureWarningId[];
}

function sortedUniqueIds(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new DomainValidationError(field, "must be an array");
  const ids = value.map((candidate, index) => uuid(candidate, `${field}.${index}`));
  if (ids.length === 0 || new Set(ids).size !== ids.length)
    throw new DomainValidationError(field, "must contain unique identifiers");
  if (ids.join("\n") !== [...ids].toSorted().join("\n"))
    throw new DomainValidationError(field, "must be sorted");
  return ids;
}

function warnings(value: unknown): readonly CaptureWarningId[] {
  if (!Array.isArray(value)) throw new DomainValidationError("event.warnings", "must be an array");
  const parsed = value.map((candidate, index) => {
    if (!CAPTURE_WARNINGS.includes(candidate as CaptureWarningId))
      throw new DomainValidationError(`event.warnings.${index}`, "is unsupported");
    return candidate as CaptureWarningId;
  });
  if (
    new Set(parsed).size !== parsed.length ||
    parsed.join("\n") !== [...parsed].toSorted().join("\n")
  )
    throw new DomainValidationError("event.warnings", "must be sorted and unique");
  return parsed;
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateArtifactWarnings(
  roles: readonly ArtifactRole[],
  warningIds: readonly CaptureWarningId[],
): void {
  const present = new Set(roles);
  const warnings = new Set(warningIds);
  const screenshotFailed =
    warnings.has("SCREENSHOT_CAPTURE_FAILED") || warnings.has("SCREENSHOT_UNAVAILABLE");
  if (screenshotFailed && (present.has("SCREENSHOT_FULL") || present.has("THUMBNAIL")))
    throw new DomainValidationError("event.warnings", "contradicts produced screenshot Artifacts");
  if (
    warnings.has("THUMBNAIL_CAPTURE_FAILED") &&
    (!present.has("SCREENSHOT_FULL") || present.has("THUMBNAIL"))
  )
    throw new DomainValidationError("event.warnings", "contradicts thumbnail Artifact state");
  for (const [role, warning] of [
    ["TEXT_EXTRACTED", "TEXT_EXTRACTION_FAILED"],
    ["CONTENT_STRUCTURED", "STRUCTURED_CONTENT_EXTRACTION_FAILED"],
  ] as const) {
    if (warnings.has(warning) === present.has(role))
      throw new DomainValidationError("event.warnings", `contradicts ${role} Artifact state`);
  }
}

export function decodeBundleRegisteredPayload(
  value: unknown,
  referencedObjectIds: readonly string[],
): BundleRegisteredPayloadV1 {
  const input = canonicalRecord(value, "event", [
    "version",
    "eventType",
    "eventVersion",
    "payloadVersion",
    "vaultId",
    "deviceId",
    "timestamp",
    "protocolVersion",
    "correlationId",
    "bundleId",
    "descriptorObjectId",
    "artifactObjectIds",
    "collectionId",
    "captureProfileId",
    "warnings",
  ]);
  const descriptorObjectId = uuid(input.descriptorObjectId, "event.descriptorObjectId");
  const artifactObjectIds = sortedUniqueIds(input.artifactObjectIds, "event.artifactObjectIds");
  const references = sortedUniqueIds(referencedObjectIds, "storedEvent.referencedObjectIds");
  const expected = [descriptorObjectId, ...artifactObjectIds].toSorted();
  if (new Set(expected).size !== expected.length || !same(references, expected))
    throw new DomainValidationError(
      "storedEvent.referencedObjectIds",
      "must equal the Bundle Descriptor and Artifact closure",
    );
  return {
    version: literal(input.version, 1, "event.version"),
    eventType: literal(input.eventType, "BundleRegistered", "event.eventType"),
    eventVersion: literal(input.eventVersion, 1, "event.eventVersion"),
    payloadVersion: literal(input.payloadVersion, 1, "event.payloadVersion"),
    vaultId: uuid(input.vaultId, "event.vaultId"),
    deviceId: uuid(input.deviceId, "event.deviceId"),
    timestamp: timestamp(input.timestamp, "event.timestamp"),
    protocolVersion: literal(input.protocolVersion, 1, "event.protocolVersion"),
    correlationId: uuid(input.correlationId, "event.correlationId"),
    bundleId: uuid(input.bundleId, "event.bundleId"),
    descriptorObjectId,
    artifactObjectIds,
    collectionId: uuid(input.collectionId, "event.collectionId"),
    captureProfileId: literal(
      input.captureProfileId,
      "WebPageSnapshot-v1",
      "event.captureProfileId",
    ),
    warnings: warnings(input.warnings),
  };
}

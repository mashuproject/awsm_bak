import { decodeCanonicalCbor, encodeCanonicalCbor } from "./cbor";
import { DomainValidationError } from "./errors";
import { bytesEqual } from "./hash";
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

const MAX_DESCRIPTOR_BYTES = 16 * 1024 * 1024;

export type ArtifactKind = "CAPTURE" | "IMAGE" | "TEXT" | "STRUCTURED_CONTENT";
export type ArtifactRole =
  | "PRIMARY"
  | "SCREENSHOT_FULL"
  | "THUMBNAIL"
  | "TEXT_EXTRACTED"
  | "CONTENT_STRUCTURED";

export interface ArtifactReferenceV1 {
  readonly artifactVersion: 1;
  readonly artifactObjectId: string;
  readonly kind: ArtifactKind;
  readonly role: ArtifactRole;
  readonly mimeType: string;
  readonly acquiredAt: string;
  readonly plaintextByteLength: number;
  readonly checksumAlgorithm: "hash:sha256:v1";
  readonly plaintextChecksum: Uint8Array;
}

export interface CaptureMetadataV1 {
  readonly version: 1;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly contentType: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly document: { readonly width: number; readonly height: number };
  readonly browserName: string;
  readonly browserVersion: string;
  readonly extensionVersion: string;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly captureProfileVersion: 1;
}

export interface BundleDescriptorV1 {
  readonly descriptorVersion: 1;
  readonly bundleId: string;
  readonly createdAt: string;
  readonly clientVersion: string;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly captureAdapterVersion: 1;
  readonly metadata: CaptureMetadataV1;
  readonly artifacts: readonly ArtifactReferenceV1[];
}

const ROLE_CONTRACT: Readonly<
  Record<ArtifactRole, { readonly kind: ArtifactKind; readonly mimeType: string }>
> = {
  PRIMARY: { kind: "CAPTURE", mimeType: "application/vnd.awsm.web-page+zip" },
  SCREENSHOT_FULL: { kind: "IMAGE", mimeType: "image/webp" },
  THUMBNAIL: { kind: "IMAGE", mimeType: "image/webp" },
  TEXT_EXTRACTED: { kind: "TEXT", mimeType: "text/plain;charset=utf-8" },
  CONTENT_STRUCTURED: {
    kind: "STRUCTURED_CONTENT",
    mimeType: "application/cbor-seq",
  },
};

function positiveInteger(value: unknown, field: string): number {
  const parsed = integer(value, field);
  if (parsed === 0) throw new DomainValidationError(field, "must be positive");
  return parsed;
}

function dimensions(
  value: unknown,
  field: string,
): { readonly width: number; readonly height: number } {
  const input = canonicalRecord(value, field, ["width", "height"]);
  return {
    width: positiveInteger(input.width, `${field}.width`),
    height: positiveInteger(input.height, `${field}.height`),
  };
}

function metadata(value: unknown): CaptureMetadataV1 {
  const input = canonicalRecord(value, "descriptor.metadata", [
    "version",
    "originalUrl",
    "finalUrl",
    "title",
    "capturedAt",
    "contentType",
    "viewport",
    "document",
    "browserName",
    "browserVersion",
    "extensionVersion",
    "captureProfileId",
    "captureProfileVersion",
  ]);
  return {
    version: literal(input.version, 1, "descriptor.metadata.version"),
    originalUrl: httpUrl(input.originalUrl, "descriptor.metadata.originalUrl"),
    finalUrl: httpUrl(input.finalUrl, "descriptor.metadata.finalUrl"),
    title: string(input.title, "descriptor.metadata.title"),
    capturedAt: timestamp(input.capturedAt, "descriptor.metadata.capturedAt"),
    contentType: string(input.contentType, "descriptor.metadata.contentType"),
    viewport: dimensions(input.viewport, "descriptor.metadata.viewport"),
    document: dimensions(input.document, "descriptor.metadata.document"),
    browserName: string(input.browserName, "descriptor.metadata.browserName"),
    browserVersion: string(input.browserVersion, "descriptor.metadata.browserVersion"),
    extensionVersion: string(input.extensionVersion, "descriptor.metadata.extensionVersion"),
    captureProfileId: literal(
      input.captureProfileId,
      "WebPageSnapshot-v1",
      "descriptor.metadata.captureProfileId",
    ),
    captureProfileVersion: literal(
      input.captureProfileVersion,
      1,
      "descriptor.metadata.captureProfileVersion",
    ),
  };
}

function artifactKind(value: unknown, field: string): ArtifactKind {
  const parsed = string(value, field);
  if (
    parsed === "CAPTURE" ||
    parsed === "IMAGE" ||
    parsed === "TEXT" ||
    parsed === "STRUCTURED_CONTENT"
  )
    return parsed;
  throw new DomainValidationError(field, "is unsupported");
}

function artifactRole(value: unknown, field: string): ArtifactRole {
  const parsed = string(value, field);
  if (parsed in ROLE_CONTRACT) return parsed as ArtifactRole;
  throw new DomainValidationError(field, "is unsupported");
}

function artifact(value: unknown, index: number): ArtifactReferenceV1 {
  const field = `descriptor.artifacts.${index}`;
  const input = canonicalRecord(value, field, [
    "artifactVersion",
    "artifactObjectId",
    "kind",
    "role",
    "mimeType",
    "acquiredAt",
    "plaintextByteLength",
    "checksumAlgorithm",
    "plaintextChecksum",
  ]);
  const role = artifactRole(input.role, `${field}.role`);
  const kind = artifactKind(input.kind, `${field}.kind`);
  const mimeType = string(input.mimeType, `${field}.mimeType`);
  const contract = ROLE_CONTRACT[role];
  if (kind !== contract.kind || mimeType !== contract.mimeType) {
    throw new DomainValidationError(field, "violates the canonical Role contract");
  }
  const plaintextByteLength = integer(input.plaintextByteLength, `${field}.plaintextByteLength`);
  if (
    (role === "PRIMARY" || role === "SCREENSHOT_FULL" || role === "THUMBNAIL") &&
    plaintextByteLength === 0
  )
    throw new DomainValidationError(`${field}.plaintextByteLength`, "must be positive");
  return {
    artifactVersion: literal(input.artifactVersion, 1, `${field}.artifactVersion`),
    artifactObjectId: uuid(input.artifactObjectId, `${field}.artifactObjectId`),
    kind,
    role,
    mimeType,
    acquiredAt: timestamp(input.acquiredAt, `${field}.acquiredAt`),
    plaintextByteLength,
    checksumAlgorithm: literal(
      input.checksumAlgorithm,
      "hash:sha256:v1",
      `${field}.checksumAlgorithm`,
    ),
    plaintextChecksum: bytes(input.plaintextChecksum, 32, `${field}.plaintextChecksum`),
  };
}

function decodeValue(value: unknown): BundleDescriptorV1 {
  const input = canonicalRecord(value, "descriptor", [
    "descriptorVersion",
    "bundleId",
    "createdAt",
    "clientVersion",
    "captureProfileId",
    "captureAdapterVersion",
    "metadata",
    "artifacts",
  ]);
  if (!Array.isArray(input.artifacts) || input.artifacts.length === 0)
    throw new DomainValidationError("descriptor.artifacts", "must be a non-empty array");
  const artifacts = input.artifacts.map(artifact);
  const ids = artifacts.map((entry) => entry.artifactObjectId);
  const roles = artifacts.map((entry) => entry.role);
  if (ids.join("\n") !== [...ids].toSorted().join("\n") || new Set(ids).size !== ids.length)
    throw new DomainValidationError("descriptor.artifacts", "must have sorted unique Object IDs");
  if (new Set(roles).size !== roles.length)
    throw new DomainValidationError("descriptor.artifacts", "must have unique Roles");
  if (roles.filter((role) => role === "PRIMARY").length !== 1)
    throw new DomainValidationError("descriptor.artifacts", "must contain exactly one PRIMARY");
  const parsedMetadata = metadata(input.metadata);
  const createdAt = timestamp(input.createdAt, "descriptor.createdAt");
  if (parsedMetadata.capturedAt !== createdAt)
    throw new DomainValidationError("descriptor.createdAt", "must equal metadata.capturedAt");
  return {
    descriptorVersion: literal(input.descriptorVersion, 1, "descriptor.descriptorVersion"),
    bundleId: uuid(input.bundleId, "descriptor.bundleId"),
    createdAt,
    clientVersion: string(input.clientVersion, "descriptor.clientVersion"),
    captureProfileId: literal(
      input.captureProfileId,
      "WebPageSnapshot-v1",
      "descriptor.captureProfileId",
    ),
    captureAdapterVersion: literal(
      input.captureAdapterVersion,
      1,
      "descriptor.captureAdapterVersion",
    ),
    metadata: parsedMetadata,
    artifacts,
  };
}

export function encodeBundleDescriptor(value: BundleDescriptorV1): Uint8Array {
  return encodeCanonicalCbor(decodeValue(value));
}

export function decodeBundleDescriptor(bytes: Uint8Array): BundleDescriptorV1 {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DESCRIPTOR_BYTES)
    throw new DomainValidationError("descriptor", "has an invalid byte length");
  const value = decodeCanonicalCbor(bytes);
  if (!bytesEqual(bytes, encodeCanonicalCbor(value)))
    throw new DomainValidationError("descriptor", "must use canonical CBOR");
  return decodeValue(value);
}

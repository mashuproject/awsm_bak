import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { bytesEqual } from "../../domain/hash";
import {
  bytes,
  canonicalRecord,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "../../domain/validation";

export type ExportRecordType =
  | "VaultGeneration"
  | "VaultHead"
  | "Event"
  | "Object"
  | "ArtifactPayload";

export interface ExportEntryDescriptorV1 {
  readonly path: string;
  readonly recordType: ExportRecordType;
  readonly recordId: string;
  readonly byteLength: number;
  readonly checksumAlgorithm: "hash:sha256:v1";
  readonly checksum: Uint8Array;
}

export interface ExportOmissionV1 {
  readonly artifactObjectId: string;
  readonly expectedPath: string;
  readonly envelopeByteLength: number;
  readonly envelopeChecksumAlgorithm: "hash:sha256:v1";
  readonly envelopeChecksum: Uint8Array;
  readonly reason: "NotLocallyAvailable";
}

export interface ExportManifestV1 {
  readonly exportFormatVersion: 1;
  readonly packageId: string;
  readonly createdAt: string;
  readonly originatingVaultId: string;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly coverage: "Complete" | "Selective";
  readonly eventCount: number;
  readonly objectCount: number;
  readonly artifactPayloadCount: number;
  readonly supportedFeatures: readonly ["artifact-graph", "selective-coverage", "vault-generation"];
  readonly entries: readonly ExportEntryDescriptorV1[];
  readonly omissions: readonly ExportOmissionV1[];
  readonly contentIntegrity: {
    readonly algorithm: "hash:sha256:v1";
    readonly checksum: Uint8Array;
  };
}

export interface ExportKeyEnvelopeV1 {
  readonly exportKeyEnvelopeVersion: 1;
  readonly purpose: "VaultExport";
  readonly packageId: string;
  readonly originatingVaultId: string;
  readonly algorithm: "wrap:xchacha20poly1305:passphrase:v1";
  readonly kdf: "kdf:argon2id:v1";
  readonly operations: 3;
  readonly memoryBytes: 67108864;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly manifestChecksumAlgorithm: "hash:sha256:v1";
  readonly manifestChecksum: Uint8Array;
  readonly ciphertext: Uint8Array;
}

function canonical(encoded: Uint8Array, decoded: unknown, field: string): void {
  if (!bytesEqual(encoded, encodeCanonicalCbor(decoded)))
    throw new DomainValidationError(field, "must use canonical CBOR");
}

function expectedPath(type: ExportRecordType, id: string): string {
  if (type === "VaultGeneration") return "generation.cbor";
  if (type === "VaultHead") return "head.cbor";
  if (type === "Event") return `events/${id}.cbor`;
  if (type === "Object") return `objects/${id}.cbor`;
  return `artifacts/${id}.bin`;
}

function entry(value: unknown, index: number): ExportEntryDescriptorV1 {
  const field = `manifest.entries.${index}`;
  const input = canonicalRecord(value, field, [
    "path",
    "recordType",
    "recordId",
    "byteLength",
    "checksumAlgorithm",
    "checksum",
  ]);
  const recordId = uuid(input.recordId, `${field}.recordId`);
  const type = string(input.recordType, `${field}.recordType`);
  if (!["VaultGeneration", "VaultHead", "Event", "Object", "ArtifactPayload"].includes(type))
    throw new DomainValidationError(`${field}.recordType`, "is unsupported");
  const recordType = type as ExportRecordType;
  const path = expectedPath(recordType, recordId);
  if (input.path !== path)
    throw new DomainValidationError(`${field}.path`, "does not match identity");
  return {
    path,
    recordType,
    recordId,
    byteLength: integer(input.byteLength, `${field}.byteLength`),
    checksumAlgorithm: literal(
      input.checksumAlgorithm,
      "hash:sha256:v1",
      `${field}.checksumAlgorithm`,
    ),
    checksum: bytes(input.checksum, 32, `${field}.checksum`),
  };
}

function omission(value: unknown, index: number): ExportOmissionV1 {
  const field = `manifest.omissions.${index}`;
  const input = canonicalRecord(value, field, [
    "artifactObjectId",
    "expectedPath",
    "envelopeByteLength",
    "envelopeChecksumAlgorithm",
    "envelopeChecksum",
    "reason",
  ]);
  const artifactObjectId = uuid(input.artifactObjectId, `${field}.artifactObjectId`);
  const path = `artifacts/${artifactObjectId}.bin`;
  if (input.expectedPath !== path)
    throw new DomainValidationError(`${field}.expectedPath`, "is invalid");
  return {
    artifactObjectId,
    expectedPath: path,
    envelopeByteLength: integer(input.envelopeByteLength, `${field}.envelopeByteLength`),
    envelopeChecksumAlgorithm: literal(
      input.envelopeChecksumAlgorithm,
      "hash:sha256:v1",
      `${field}.envelopeChecksumAlgorithm`,
    ),
    envelopeChecksum: bytes(input.envelopeChecksum, 32, `${field}.envelopeChecksum`),
    reason: literal(input.reason, "NotLocallyAvailable", `${field}.reason`),
  };
}

export function decodeExportManifest(encoded: Uint8Array): ExportManifestV1 {
  const decoded = decodeCanonicalCbor(encoded);
  canonical(encoded, decoded, "manifest");
  const input = canonicalRecord(decoded, "manifest", [
    "exportFormatVersion",
    "packageId",
    "createdAt",
    "originatingVaultId",
    "generationId",
    "generationNumber",
    "coverage",
    "eventCount",
    "objectCount",
    "artifactPayloadCount",
    "supportedFeatures",
    "entries",
    "omissions",
    "contentIntegrity",
  ]);
  if (
    !Array.isArray(input.entries) ||
    !Array.isArray(input.omissions) ||
    !Array.isArray(input.supportedFeatures)
  )
    throw new DomainValidationError("manifest", "contains invalid arrays");
  const entries = input.entries.map(entry);
  const omissions = input.omissions.map(omission);
  if (
    entries.map((item) => item.path).join("\n") !==
      entries
        .map((item) => item.path)
        .toSorted()
        .join("\n") ||
    new Set(entries.map((item) => item.path)).size !== entries.length
  )
    throw new DomainValidationError("manifest.entries", "must have sorted unique paths");
  if (
    omissions.map((item) => item.artifactObjectId).join("\n") !==
      omissions
        .map((item) => item.artifactObjectId)
        .toSorted()
        .join("\n") ||
    new Set(omissions.map((item) => item.artifactObjectId)).size !== omissions.length
  )
    throw new DomainValidationError("manifest.omissions", "must be sorted and unique");
  const coverage =
    input.coverage === "Complete" || input.coverage === "Selective" ? input.coverage : undefined;
  if (coverage === undefined || (coverage === "Complete") !== (omissions.length === 0))
    throw new DomainValidationError("manifest.coverage", "does not match omissions");
  const features = ["artifact-graph", "selective-coverage", "vault-generation"] as const;
  if (input.supportedFeatures.join("\n") !== features.join("\n"))
    throw new DomainValidationError("manifest.supportedFeatures", "must be canonical");
  const integrity = canonicalRecord(input.contentIntegrity, "manifest.contentIntegrity", [
    "algorithm",
    "checksum",
  ]);
  const eventCount = integer(input.eventCount, "manifest.eventCount");
  const objectCount = integer(input.objectCount, "manifest.objectCount");
  const artifactPayloadCount = integer(input.artifactPayloadCount, "manifest.artifactPayloadCount");
  if (
    entries.filter((item) => item.recordType === "Event").length !== eventCount ||
    entries.filter((item) => item.recordType === "Object").length !== objectCount ||
    entries.filter((item) => item.recordType === "ArtifactPayload").length !== artifactPayloadCount
  )
    throw new DomainValidationError("manifest", "counts do not match entries");
  return {
    exportFormatVersion: literal(input.exportFormatVersion, 1, "manifest.exportFormatVersion"),
    packageId: uuid(input.packageId, "manifest.packageId"),
    createdAt: timestamp(input.createdAt, "manifest.createdAt"),
    originatingVaultId: uuid(input.originatingVaultId, "manifest.originatingVaultId"),
    generationId: uuid(input.generationId, "manifest.generationId"),
    generationNumber: integer(input.generationNumber, "manifest.generationNumber"),
    coverage,
    eventCount,
    objectCount,
    artifactPayloadCount,
    supportedFeatures: features,
    entries,
    omissions,
    contentIntegrity: {
      algorithm: literal(
        integrity.algorithm,
        "hash:sha256:v1",
        "manifest.contentIntegrity.algorithm",
      ),
      checksum: bytes(integrity.checksum, 32, "manifest.contentIntegrity.checksum"),
    },
  };
}

export function decodeExportKeyEnvelope(encoded: Uint8Array): ExportKeyEnvelopeV1 {
  const decoded = decodeCanonicalCbor(encoded);
  canonical(encoded, decoded, "exportKeyEnvelope");
  const input = canonicalRecord(decoded, "exportKeyEnvelope", [
    "exportKeyEnvelopeVersion",
    "purpose",
    "packageId",
    "originatingVaultId",
    "algorithm",
    "kdf",
    "operations",
    "memoryBytes",
    "salt",
    "nonce",
    "manifestChecksumAlgorithm",
    "manifestChecksum",
    "ciphertext",
  ]);
  return {
    exportKeyEnvelopeVersion: literal(
      input.exportKeyEnvelopeVersion,
      1,
      "exportKeyEnvelope.exportKeyEnvelopeVersion",
    ),
    purpose: literal(input.purpose, "VaultExport", "exportKeyEnvelope.purpose"),
    packageId: uuid(input.packageId, "exportKeyEnvelope.packageId"),
    originatingVaultId: uuid(input.originatingVaultId, "exportKeyEnvelope.originatingVaultId"),
    algorithm: literal(
      input.algorithm,
      "wrap:xchacha20poly1305:passphrase:v1",
      "exportKeyEnvelope.algorithm",
    ),
    kdf: literal(input.kdf, "kdf:argon2id:v1", "exportKeyEnvelope.kdf"),
    operations: literal(input.operations, 3, "exportKeyEnvelope.operations"),
    memoryBytes: literal(input.memoryBytes, 67108864, "exportKeyEnvelope.memoryBytes"),
    salt: bytes(input.salt, 16, "exportKeyEnvelope.salt"),
    nonce: bytes(input.nonce, 24, "exportKeyEnvelope.nonce"),
    manifestChecksumAlgorithm: literal(
      input.manifestChecksumAlgorithm,
      "hash:sha256:v1",
      "exportKeyEnvelope.manifestChecksumAlgorithm",
    ),
    manifestChecksum: bytes(input.manifestChecksum, 32, "exportKeyEnvelope.manifestChecksum"),
    ciphertext:
      input.ciphertext instanceof Uint8Array && input.ciphertext.byteLength > 16
        ? Uint8Array.from(input.ciphertext)
        : (() => {
            throw new DomainValidationError(
              "exportKeyEnvelope.ciphertext",
              "must contain an encrypted Vault keyring",
            );
          })(),
  };
}

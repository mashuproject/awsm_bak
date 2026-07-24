import {
  BlobReader,
  BlobWriter,
  configure,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { readySodium } from "../../crypto/sodium";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { bytesEqual } from "../../domain/hash";
import {
  bytes,
  canonicalRecord,
  httpUrl,
  integer,
  literal,
  string,
  timestamp,
} from "../../domain/validation";
import {
  type CreatePageSnapshotInput,
  PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE,
  PAGE_SNAPSHOT_PROFILE_ID,
  type PageSnapshotManifestV1,
  type SnapshotAcquisition,
  type SnapshotCompression,
  type SnapshotDocumentV1,
  type SnapshotOmissionReason,
  type SnapshotOmissionSubject,
  type SnapshotOmissionV1,
  type SnapshotResourceV1,
  type ValidatedPageSnapshot,
} from "./contracts";

const MAX_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENTS = 1_024;
const MAX_RESOURCES = 50_000;
const MAX_ENTRIES = 100_000;
const MANIFEST_MEMBER = "manifest.cbor";
const DOCUMENT_ID = /^d\d{6}$/u;
const DOCUMENT_MEMBER = /^documents\/\d{6}\.html$/u;
const RESOURCE_MEMBER = /^resources\/\d{6}\.bin$/u;
const encoder = new TextEncoder();

configure({ useWebWorkers: false });

function indexed(prefix: "d" | "r", index: number): string {
  return `${prefix}${index.toString().padStart(6, "0")}`;
}

function documentMember(index: number): string {
  return `documents/${index.toString().padStart(6, "0")}.html`;
}

function resourceMember(index: number): string {
  return `resources/${index.toString().padStart(6, "0")}.bin`;
}

function safeInteger(value: unknown, field: string): number {
  const parsed = integer(value, field);
  if (!Number.isSafeInteger(parsed)) throw new DomainValidationError(field, "must be safe");
  return parsed;
}

function signedInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DomainValidationError(field, "must be a safe integer");
  }
  return value as number;
}

function absoluteUrl(value: unknown, field: string): string {
  const parsed = string(value, field);
  const url = new URL(parsed);
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "blob:" &&
    !(url.protocol === "urn:" && parsed.startsWith("urn:awsm:data:sha256:"))
  ) {
    throw new DomainValidationError(field, "uses an unsupported scheme");
  }
  return parsed;
}

function choice<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value === "string" && values.includes(value as T)) return value as T;
  throw new DomainValidationError(field, "is unsupported");
}

function documentRecord(value: unknown, index: number): SnapshotDocumentV1 {
  const field = `manifest.documents.${index}`;
  const input = canonicalRecord(value, field, [
    "id",
    "parentId",
    "originalUrl",
    "finalUrl",
    "member",
    "mediaType",
    "byteLength",
    "sha256",
    "scrollX",
    "scrollY",
  ]);
  const id = literal(input.id, indexed("d", index), `${field}.id`);
  const parentId =
    input.parentId === undefined ? undefined : string(input.parentId, `${field}.parentId`);
  if (index === 0 && parentId !== undefined)
    throw new DomainValidationError(`${field}.parentId`, "is forbidden for the top document");
  if (index > 0 && (parentId === undefined || !DOCUMENT_ID.test(parentId)))
    throw new DomainValidationError(`${field}.parentId`, "must reference a document");
  return {
    id,
    ...(parentId === undefined ? {} : { parentId }),
    originalUrl: httpUrl(input.originalUrl, `${field}.originalUrl`),
    finalUrl: httpUrl(input.finalUrl, `${field}.finalUrl`),
    member: literal(input.member, documentMember(index), `${field}.member`),
    mediaType: literal(input.mediaType, PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE, `${field}.mediaType`),
    byteLength: safeInteger(input.byteLength, `${field}.byteLength`),
    sha256: bytes(input.sha256, 32, `${field}.sha256`),
    scrollX: signedInteger(input.scrollX, `${field}.scrollX`),
    scrollY: signedInteger(input.scrollY, `${field}.scrollY`),
  };
}

function resourceRecord(value: unknown, index: number): SnapshotResourceV1 {
  const field = `manifest.resources.${index}`;
  const input = canonicalRecord(value, field, [
    "id",
    "ownerDocumentId",
    "requestedUrl",
    "finalUrl",
    "member",
    "mediaType",
    "contentLanguage",
    "status",
    "byteLength",
    "sha256",
    "acquisition",
    "compression",
  ]);
  const contentLanguage =
    input.contentLanguage === undefined
      ? undefined
      : string(input.contentLanguage, `${field}.contentLanguage`);
  return {
    id: literal(input.id, indexed("r", index), `${field}.id`),
    ownerDocumentId: string(input.ownerDocumentId, `${field}.ownerDocumentId`),
    requestedUrl: absoluteUrl(input.requestedUrl, `${field}.requestedUrl`),
    finalUrl: absoluteUrl(input.finalUrl, `${field}.finalUrl`),
    member: literal(input.member, resourceMember(index), `${field}.member`),
    mediaType: string(input.mediaType, `${field}.mediaType`),
    ...(contentLanguage === undefined ? {} : { contentLanguage }),
    status: safeInteger(input.status, `${field}.status`),
    byteLength: safeInteger(input.byteLength, `${field}.byteLength`),
    sha256: bytes(input.sha256, 32, `${field}.sha256`),
    acquisition: choice<SnapshotAcquisition>(input.acquisition, `${field}.acquisition`, [
      "Embedded",
      "Cache",
      "Network",
    ]),
    compression: choice<SnapshotCompression>(input.compression, `${field}.compression`, [
      "Store",
      "Deflate",
    ]),
  };
}

function omissionRecord(value: unknown, index: number): SnapshotOmissionV1 {
  const field = `manifest.omissions.${index}`;
  const input = canonicalRecord(value, field, ["ownerDocumentId", "url", "subject", "reason"]);
  return {
    ownerDocumentId: string(input.ownerDocumentId, `${field}.ownerDocumentId`),
    url: absoluteUrl(input.url, `${field}.url`),
    subject: choice<SnapshotOmissionSubject>(input.subject, `${field}.subject`, [
      "Frame",
      "Resource",
      "Media",
      "FileInput",
    ]),
    reason: choice<SnapshotOmissionReason>(input.reason, `${field}.reason`, [
      "InaccessibleFrame",
      "CrossOrigin",
      "UnsupportedScheme",
      "FetchFailed",
      "ResourceTooLarge",
      "CaptureBudgetExceeded",
      "MediaBodyExcluded",
      "FileBodyExcluded",
      "InvalidContent",
    ]),
  };
}

function decodeManifestValue(value: unknown): PageSnapshotManifestV1 {
  const input = canonicalRecord(value, "manifest", [
    "version",
    "captureProfileId",
    "capturedAt",
    "originalUrl",
    "finalUrl",
    "topDocumentId",
    "documents",
    "resources",
    "omissions",
  ]);
  if (!Array.isArray(input.documents) || input.documents.length === 0)
    throw new DomainValidationError("manifest.documents", "must contain the top document");
  if (!Array.isArray(input.resources))
    throw new DomainValidationError("manifest.resources", "must be an array");
  if (!Array.isArray(input.omissions))
    throw new DomainValidationError("manifest.omissions", "must be an array");
  if (input.documents.length > MAX_DOCUMENTS)
    throw new DomainValidationError("manifest.documents", "exceeds the document limit");
  if (input.resources.length > MAX_RESOURCES)
    throw new DomainValidationError("manifest.resources", "exceeds the resource limit");
  const documents = input.documents.map(documentRecord);
  const resources = input.resources.map(resourceRecord);
  const omissions = input.omissions.map(omissionRecord);
  const documentIds = new Set(documents.map((document) => document.id));
  for (const [index, document] of documents.entries()) {
    if (document.parentId !== undefined && !documentIds.has(document.parentId))
      throw new DomainValidationError(`manifest.documents.${index}.parentId`, "does not resolve");
  }
  for (const [index, record] of [...resources, ...omissions].entries()) {
    if (!documentIds.has(record.ownerDocumentId))
      throw new DomainValidationError(`manifest.references.${index}`, "has an unknown owner");
  }
  for (const omission of omissions) {
    if (
      omission.subject === "Frame" &&
      omission.reason === "InaccessibleFrame" &&
      documents.some((document) => document.originalUrl === omission.url)
    ) {
      throw new DomainValidationError("manifest.omissions", "contradicts a captured frame");
    }
  }
  return {
    version: literal(input.version, 1, "manifest.version"),
    captureProfileId: literal(
      input.captureProfileId,
      PAGE_SNAPSHOT_PROFILE_ID,
      "manifest.captureProfileId",
    ),
    capturedAt: timestamp(input.capturedAt, "manifest.capturedAt"),
    originalUrl: httpUrl(input.originalUrl, "manifest.originalUrl"),
    finalUrl: httpUrl(input.finalUrl, "manifest.finalUrl"),
    topDocumentId: literal(input.topDocumentId, "d000000", "manifest.topDocumentId"),
    documents,
    resources,
    omissions,
  };
}

export function decodePageSnapshotManifest(bytesValue: Uint8Array): PageSnapshotManifestV1 {
  if (bytesValue.byteLength === 0 || bytesValue.byteLength > MAX_MANIFEST_BYTES)
    throw new DomainValidationError("manifest", "has an invalid byte length");
  const decoded = decodeCanonicalCbor(bytesValue);
  if (!bytesEqual(bytesValue, encodeCanonicalCbor(decoded)))
    throw new DomainValidationError("manifest", "must use canonical CBOR");
  return decodeManifestValue(decoded);
}

function asBlob(value: Uint8Array | Blob): Blob {
  return value instanceof Blob ? value : new Blob([Uint8Array.from(value)]);
}

async function hashBlob(blob: Blob): Promise<Uint8Array> {
  const sodium = await readySodium();
  const state = sodium.crypto_hash_sha256_init();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      sodium.crypto_hash_sha256_update(state, next.value);
    }
    return Uint8Array.from(sodium.crypto_hash_sha256_final(state));
  } finally {
    reader.releaseLock();
  }
}

interface PreparedSnapshot {
  readonly capturedAt: string;
  readonly date: Date;
  readonly manifest: PageSnapshotManifestV1;
  readonly manifestBytes: Uint8Array;
}

async function preparePageSnapshot(input: CreatePageSnapshotInput): Promise<PreparedSnapshot> {
  if (input.documents.length === 0)
    throw new DomainValidationError("snapshot.documents", "must contain the top document");
  const capturedAt = timestamp(input.capturedAt, "snapshot.capturedAt");
  const documents: SnapshotDocumentV1[] = [];
  const resources: SnapshotResourceV1[] = [];
  let totalBytes = 0;
  for (const [index, source] of input.documents.entries()) {
    const blob = asBlob(source.bytes);
    if (blob.size > MAX_MEMBER_BYTES)
      throw new DomainValidationError(`snapshot.documents.${index}`, "exceeds 64 MiB");
    totalBytes += blob.size;
    documents.push({
      id: indexed("d", index),
      ...(source.parentId === undefined ? {} : { parentId: source.parentId }),
      originalUrl: source.originalUrl,
      finalUrl: source.finalUrl,
      member: documentMember(index),
      mediaType: PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE,
      byteLength: blob.size,
      sha256: await hashBlob(blob),
      scrollX: source.scrollX,
      scrollY: source.scrollY,
    });
  }
  for (const [index, source] of input.resources.entries()) {
    const blob = asBlob(source.bytes);
    if (blob.size > MAX_MEMBER_BYTES)
      throw new DomainValidationError(`snapshot.resources.${index}`, "exceeds 64 MiB");
    totalBytes += blob.size;
    resources.push({
      id: indexed("r", index),
      ownerDocumentId: source.ownerDocumentId,
      requestedUrl: source.requestedUrl,
      finalUrl: source.finalUrl,
      member: resourceMember(index),
      mediaType: source.mediaType,
      ...(source.contentLanguage === undefined ? {} : { contentLanguage: source.contentLanguage }),
      status: source.status,
      byteLength: blob.size,
      sha256: await hashBlob(blob),
      acquisition: source.acquisition,
      compression: source.compression,
    });
  }
  const manifest = decodeManifestValue({
    version: 1,
    captureProfileId: PAGE_SNAPSHOT_PROFILE_ID,
    capturedAt,
    originalUrl: input.originalUrl,
    finalUrl: input.finalUrl,
    topDocumentId: "d000000",
    documents,
    resources,
    omissions: input.omissions,
  });
  const manifestBytes = encodeCanonicalCbor(manifest);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES)
    throw new DomainValidationError("snapshot.manifest", "exceeds 16 MiB");
  totalBytes += manifestBytes.byteLength;
  if (totalBytes > MAX_TOTAL_BYTES)
    throw new DomainValidationError("snapshot", "exceeds the total byte budget");
  return { capturedAt, date: new Date(capturedAt), manifest, manifestBytes };
}

async function writePreparedSnapshot(
  input: CreatePageSnapshotInput,
  prepared: PreparedSnapshot,
  output: BlobWriter | WritableStream<Uint8Array>,
): Promise<void> {
  const writer = new ZipWriter(output, { zip64: true, bufferedWrite: false });
  for (const [index, source] of input.documents.entries()) {
    await writer.add(documentMember(index), new BlobReader(asBlob(source.bytes)), {
      level: 6,
      lastModDate: prepared.date,
      extendedTimestamp: false,
      zip64: true,
    });
  }
  for (const [index, source] of input.resources.entries()) {
    await writer.add(resourceMember(index), new BlobReader(asBlob(source.bytes)), {
      level: source.compression === "Deflate" ? 6 : 0,
      lastModDate: prepared.date,
      extendedTimestamp: false,
      zip64: true,
    });
  }
  await writer.add(
    MANIFEST_MEMBER,
    new BlobReader(new Blob([Uint8Array.from(prepared.manifestBytes)])),
    {
      level: 6,
      lastModDate: prepared.date,
      extendedTimestamp: false,
      zip64: true,
    },
  );
  await writer.close();
}

export async function createPageSnapshotBlob(
  input: CreatePageSnapshotInput,
): Promise<{ readonly blob: Blob; readonly manifest: PageSnapshotManifestV1 }> {
  const prepared = await preparePageSnapshot(input);
  const output = new BlobWriter("application/zip");
  await writePreparedSnapshot(input, prepared, output);
  return { blob: await output.getData(), manifest: prepared.manifest };
}

export async function writePageSnapshot(
  input: CreatePageSnapshotInput,
  output: WritableStream<Uint8Array>,
): Promise<PageSnapshotManifestV1> {
  const prepared = await preparePageSnapshot(input);
  await writePreparedSnapshot(input, prepared, output);
  return prepared.manifest;
}

export async function validatePageSnapshot(blob: Blob): Promise<ValidatedPageSnapshot> {
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = await reader.getEntries();
    if (entries.length === 0 || entries.length > MAX_ENTRIES)
      throw new DomainValidationError("snapshot.entries", "has an invalid count");
    const names = entries.map((entry) => entry.filename);
    if (new Set(names).size !== names.length)
      throw new DomainValidationError("snapshot.entries", "contains duplicate names");
    for (const [index, entry] of entries.entries()) {
      if (
        entry.directory ||
        entry.encrypted ||
        entry.comment !== "" ||
        entry.filename.includes("\\") ||
        entry.filename.includes("\0") ||
        entry.filename.startsWith("/") ||
        entry.filename.split("/").includes("..") ||
        encoder.encode(entry.filename).byteLength > 256 ||
        (!DOCUMENT_MEMBER.test(entry.filename) &&
          !RESOURCE_MEMBER.test(entry.filename) &&
          entry.filename !== MANIFEST_MEMBER)
      ) {
        throw new DomainValidationError(`snapshot.entries.${index}`, "is not canonical");
      }
      if (entry.uncompressedSize > MAX_MEMBER_BYTES && entry.filename !== MANIFEST_MEMBER)
        throw new DomainValidationError(`snapshot.entries.${index}`, "exceeds 64 MiB");
    }
    const manifestEntry = entries.at(-1);
    if (!manifestEntry || manifestEntry.directory || manifestEntry.filename !== MANIFEST_MEMBER)
      throw new DomainValidationError("snapshot.entries", "must end with manifest.cbor");
    const manifestBytes = new Uint8Array(await manifestEntry.getData(new Uint8ArrayWriter()));
    const manifest = decodePageSnapshotManifest(manifestBytes);
    const expectedNames = [
      ...manifest.documents.map((document) => document.member),
      ...manifest.resources.map((resource) => resource.member),
      MANIFEST_MEMBER,
    ];
    if (
      expectedNames.length !== names.length ||
      expectedNames.some((name, index) => names[index] !== name)
    ) {
      throw new DomainValidationError("snapshot.entries", "does not match manifest order");
    }
    const expectedCompression = [
      ...manifest.documents.map(() => 8),
      ...manifest.resources.map((resource) => (resource.compression === "Deflate" ? 8 : 0)),
      8,
    ];
    for (const [index, entry] of entries.entries()) {
      if (entry.compressionMethod !== expectedCompression[index])
        throw new DomainValidationError(
          `snapshot.entries.${index}`,
          "uses non-canonical compression",
        );
    }
    const members = new Map<string, Blob>();
    let totalBytes = manifestBytes.byteLength;
    for (const [index, record] of [...manifest.documents, ...manifest.resources].entries()) {
      const entry = entries[index];
      if (!entry || entry.directory)
        throw new DomainValidationError(`snapshot.entries.${index}`, "is missing");
      const memberBlob = await entry.getData(new BlobWriter());
      totalBytes += memberBlob.size;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new DomainValidationError("snapshot", "exceeds the total byte budget");
      if (
        memberBlob.size !== record.byteLength ||
        !bytesEqual(await hashBlob(memberBlob), record.sha256)
      ) {
        throw new DomainValidationError(`snapshot.entries.${index}`, "fails integrity");
      }
      members.set(record.member, memberBlob);
    }
    members.set(MANIFEST_MEMBER, new Blob([Uint8Array.from(manifestBytes)]));
    return { manifest, members };
  } finally {
    await reader.close();
  }
}

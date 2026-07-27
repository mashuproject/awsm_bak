import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { bytesEqual } from "../../domain/hash";
import {
  canonicalRecord,
  httpUrl,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "../../domain/validation";
import type { SearchDocument, SearchPassage, SearchPassageSource } from "./documents";
import { buildKeywordRow, type KeywordRow, type SearchKeywordFieldName } from "./keyword";
import {
  type SearchKeywordPostingPlaintext,
  type SearchPostingNamespace,
  validateSearchKeywordPosting,
} from "./postings";
import type {
  SearchSemanticCapture,
  SearchSemanticPassages,
  SearchSemanticVector,
} from "./semantic";
import type {
  SearchKeywordScopeStatistics,
  SearchKeywordStatisticsMaterialization,
} from "./statistics";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FIELD_NAMES: readonly SearchKeywordFieldName[] = [
  "Title",
  "Host",
  "CanonicalUrl",
  "KnownUrls",
  "Body",
];

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new DomainValidationError(field, "must be an array");
  return value;
}

function possiblyEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new DomainValidationError(field, "must be a string");
  return value;
}

function digest(value: unknown, field: string): string {
  const decoded = string(value, field);
  if (!SHA256_PATTERN.test(decoded))
    throw new DomainValidationError(field, "must be a lowercase SHA-256 digest");
  return decoded;
}

function canonicalUrl(value: unknown, field: string): string {
  const decoded = httpUrl(value, field);
  if (new URL(decoded).href !== decoded)
    throw new DomainValidationError(field, "must be a canonical URL");
  return decoded;
}

function source(value: unknown, field: string): SearchPassageSource {
  const input = canonicalRecord(value, field, [
    "role",
    "firstBlockId",
    "lastBlockId",
    "startOffset",
    "endOffset",
  ]);
  const startOffset = integer(input.startOffset, `${field}.startOffset`);
  const endOffset = integer(input.endOffset, `${field}.endOffset`);
  if (endOffset <= startOffset)
    throw new DomainValidationError(field, "must contain a nonempty source range");
  if (input.role === "CONTENT_STRUCTURED") {
    return {
      role: "CONTENT_STRUCTURED",
      firstBlockId: string(input.firstBlockId, `${field}.firstBlockId`),
      lastBlockId: string(input.lastBlockId, `${field}.lastBlockId`),
      startOffset,
      endOffset,
    };
  }
  if (input.role === "TEXT_EXTRACTED" || input.role === "METADATA") {
    if (input.firstBlockId !== undefined || input.lastBlockId !== undefined)
      throw new DomainValidationError(field, "has block identifiers for a non-structured source");
    return { role: input.role, startOffset, endOffset };
  }
  throw new DomainValidationError(`${field}.role`, "is unsupported");
}

function passage(value: unknown, index: number): SearchPassage {
  const field = `searchKeyword.document.passages[${index}]`;
  const input = canonicalRecord(value, field, [
    "version",
    "passageId",
    "ordinal",
    "text",
    "source",
  ]);
  const ordinal = integer(input.ordinal, `${field}.ordinal`);
  if (ordinal !== index)
    throw new DomainValidationError(`${field}.ordinal`, "must be contiguous and ordered");
  const text = string(input.text, `${field}.text`);
  if (text.normalize("NFC") !== text)
    throw new DomainValidationError(`${field}.text`, "must use NFC normalization");
  return {
    version: literal(input.version, 1, `${field}.version`),
    passageId: digest(input.passageId, `${field}.passageId`),
    ordinal,
    text,
    source: source(input.source, `${field}.source`),
  };
}

function document(value: unknown): SearchDocument {
  const field = "searchKeyword.document";
  const input = canonicalRecord(value, field, [
    "version",
    "vaultId",
    "bundleId",
    "collectionId",
    "collectionTitle",
    "status",
    "title",
    "canonicalUrl",
    "knownUrls",
    "host",
    "capturedAt",
    "sourceRevision",
    "passages",
  ]);
  if (input.status !== "Active" && input.status !== "Deleted")
    throw new DomainValidationError(`${field}.status`, "is unsupported");
  const canonicalUrlValue = canonicalUrl(input.canonicalUrl, `${field}.canonicalUrl`);
  const knownUrls = array(input.knownUrls, `${field}.knownUrls`).map((url, index) =>
    canonicalUrl(url, `${field}.knownUrls[${index}]`),
  );
  if (knownUrls.some((url, index) => index > 0 && url <= (knownUrls[index - 1] ?? url)))
    throw new DomainValidationError(`${field}.knownUrls`, "must be lexically sorted and unique");
  const host = string(input.host, `${field}.host`);
  if (host !== new URL(canonicalUrlValue).hostname.toLocaleLowerCase("en-US"))
    throw new DomainValidationError(`${field}.host`, "must match the canonical URL");
  const passages = array(input.passages, `${field}.passages`).map(passage);
  if (passages.length === 0 || passages[0]?.source.role !== "METADATA")
    throw new DomainValidationError(`${field}.passages`, "must begin with metadata");
  return {
    version: literal(input.version, 1, `${field}.version`),
    vaultId: uuid(input.vaultId, `${field}.vaultId`),
    bundleId: uuid(input.bundleId, `${field}.bundleId`),
    collectionId: uuid(input.collectionId, `${field}.collectionId`),
    collectionTitle: possiblyEmptyString(input.collectionTitle, `${field}.collectionTitle`),
    status: input.status,
    title: possiblyEmptyString(input.title, `${field}.title`),
    canonicalUrl: canonicalUrlValue,
    knownUrls,
    host,
    capturedAt: timestamp(input.capturedAt, `${field}.capturedAt`),
    sourceRevision: digest(input.sourceRevision, `${field}.sourceRevision`),
    passages,
  };
}

export function encodeKeywordMaterialization(row: KeywordRow): Uint8Array {
  return encodeCanonicalCbor({ version: 1, document: row.document, fields: row.fields });
}

export function decodeKeywordMaterialization(encoded: Uint8Array): KeywordRow {
  let decoded: unknown;
  try {
    decoded = decodeCanonicalCbor(encoded);
  } catch {
    throw new DomainValidationError("searchKeyword", "is not valid CBOR");
  }
  if (!bytesEqual(encoded, encodeCanonicalCbor(decoded)))
    throw new DomainValidationError("searchKeyword", "must use canonical CBOR");
  const input = canonicalRecord(decoded, "searchKeyword", ["version", "document", "fields"]);
  literal(input.version, 1, "searchKeyword.version");
  const rebuilt = buildKeywordRow(document(input.document));
  if (!bytesEqual(encodeCanonicalCbor(input.fields), encodeCanonicalCbor(rebuilt.fields)))
    throw new DomainValidationError("searchKeyword.fields", "do not match the Search document");
  return rebuilt;
}

export function encodeKeywordPostingMaterialization(
  posting: SearchKeywordPostingPlaintext,
): Uint8Array {
  return encodeCanonicalCbor({ version: 1, ...validateSearchKeywordPosting(posting) });
}

export function decodeKeywordPostingMaterialization(
  encoded: Uint8Array,
): SearchKeywordPostingPlaintext {
  let decoded: unknown;
  try {
    decoded = decodeCanonicalCbor(encoded);
  } catch {
    throw new DomainValidationError("searchPosting", "is not valid CBOR");
  }
  if (!bytesEqual(encoded, encodeCanonicalCbor(decoded)))
    throw new DomainValidationError("searchPosting", "must use canonical CBOR");
  const input = canonicalRecord(decoded, "searchPosting", [
    "version",
    "namespace",
    "opaqueMac",
    "Active",
    "Deleted",
  ]);
  literal(input.version, 1, "searchPosting.version");
  return validateSearchKeywordPosting({
    namespace: input.namespace as SearchPostingNamespace,
    opaqueMac: input.opaqueMac as string,
    Active: array(input.Active, "searchPosting.Active") as readonly string[],
    Deleted: array(input.Deleted, "searchPosting.Deleted") as readonly string[],
  });
}

function fieldLengths(
  value: unknown,
  field: string,
  integersOnly: boolean,
): Readonly<Record<SearchKeywordFieldName, number>> {
  const input = canonicalRecord(value, field, FIELD_NAMES);
  return Object.fromEntries(
    FIELD_NAMES.map((name) => {
      const candidate = input[name];
      if (
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        candidate < 0 ||
        (integersOnly && !Number.isSafeInteger(candidate))
      )
        throw new DomainValidationError(`${field}.${name}`, "must be a valid nonnegative number");
      return [name, candidate];
    }),
  ) as Record<SearchKeywordFieldName, number>;
}

function scopeStatistics(value: unknown, field: string): SearchKeywordScopeStatistics {
  const input = canonicalRecord(value, field, [
    "documentCount",
    "totalFieldLengths",
    "averageFieldLengths",
  ]);
  const documentCount = integer(input.documentCount, `${field}.documentCount`);
  const totalFieldLengths = fieldLengths(
    input.totalFieldLengths,
    `${field}.totalFieldLengths`,
    true,
  );
  const averageFieldLengths = fieldLengths(
    input.averageFieldLengths,
    `${field}.averageFieldLengths`,
    false,
  );
  for (const name of FIELD_NAMES) {
    const expected = documentCount === 0 ? 0 : totalFieldLengths[name] / documentCount;
    if (!Object.is(averageFieldLengths[name], expected))
      throw new DomainValidationError(
        `${field}.averageFieldLengths.${name}`,
        "does not match its total and document count",
      );
  }
  return { documentCount, totalFieldLengths, averageFieldLengths };
}

function keywordStatistics(value: unknown): SearchKeywordStatisticsMaterialization {
  const input = canonicalRecord(value, "searchStatistics", [
    "version",
    "generationId",
    "revision",
    "Active",
    "Deleted",
  ]);
  return {
    version: literal(input.version, 1, "searchStatistics.version"),
    generationId: uuid(input.generationId, "searchStatistics.generationId"),
    revision: integer(input.revision, "searchStatistics.revision"),
    Active: scopeStatistics(input.Active, "searchStatistics.Active"),
    Deleted: scopeStatistics(input.Deleted, "searchStatistics.Deleted"),
  };
}

export function encodeKeywordStatisticsMaterialization(
  statistics: SearchKeywordStatisticsMaterialization,
): Uint8Array {
  return encodeCanonicalCbor(keywordStatistics(statistics));
}

export function decodeKeywordStatisticsMaterialization(
  encoded: Uint8Array,
): SearchKeywordStatisticsMaterialization {
  let decoded: unknown;
  try {
    decoded = decodeCanonicalCbor(encoded);
  } catch {
    throw new DomainValidationError("searchStatistics", "is not valid CBOR");
  }
  if (!bytesEqual(encoded, encodeCanonicalCbor(decoded)))
    throw new DomainValidationError("searchStatistics", "must use canonical CBOR");
  return keywordStatistics(decoded);
}

function semanticVector(value: unknown, field: string): SearchSemanticVector {
  const input = canonicalRecord(value, field, ["version", "dimensions", "scale", "values"]);
  const dimensions = integer(input.dimensions, `${field}.dimensions`);
  if (
    dimensions < 1 ||
    dimensions > 4_096 ||
    typeof input.scale !== "number" ||
    !Number.isFinite(input.scale) ||
    input.scale <= 0 ||
    !(input.values instanceof Uint8Array) ||
    input.values.byteLength !== dimensions
  )
    throw new DomainValidationError(field, "contains an invalid quantized vector");
  const signed = new Int8Array(
    input.values.buffer,
    input.values.byteOffset,
    input.values.byteLength,
  );
  if (signed.every((component) => component === 0))
    throw new DomainValidationError(field, "contains a zero vector");
  return {
    version: literal(input.version, 1, `${field}.version`),
    dimensions,
    scale: input.scale,
    values: Uint8Array.from(input.values),
  };
}

function semanticEntry(
  value: unknown,
  field: string,
): {
  readonly passageId: string;
  readonly passageOrdinal: number;
  readonly vector: SearchSemanticVector;
} {
  const input = canonicalRecord(value, field, ["passageId", "passageOrdinal", "vector"]);
  return {
    passageId: digest(input.passageId, `${field}.passageId`),
    passageOrdinal: integer(input.passageOrdinal, `${field}.passageOrdinal`),
    vector: semanticVector(input.vector, `${field}.vector`),
  };
}

function semanticCapture(value: unknown): SearchSemanticCapture {
  const field = "searchSemanticCapture";
  const input = canonicalRecord(value, field, [
    "version",
    "bundleId",
    "collectionId",
    "status",
    "host",
    "capturedAt",
    "sourceRevision",
    "providerIdentityHash",
    "centroids",
  ]);
  if (input.status !== "Active" && input.status !== "Deleted")
    throw new DomainValidationError(`${field}.status`, "is unsupported");
  const centroids = array(input.centroids, `${field}.centroids`).map((entry, index) =>
    semanticEntry(entry, `${field}.centroids[${index}]`),
  );
  if (
    centroids.length === 0 ||
    centroids.length > 4 ||
    centroids[0]?.passageOrdinal !== 0 ||
    new Set(centroids.map(({ passageId }) => passageId)).size !== centroids.length ||
    new Set(centroids.map(({ passageOrdinal }) => passageOrdinal)).size !== centroids.length ||
    centroids.some(({ vector }) => vector.dimensions !== centroids[0]?.vector.dimensions)
  )
    throw new DomainValidationError(`${field}.centroids`, "are inconsistent");
  return {
    version: literal(input.version, 1, `${field}.version`),
    bundleId: uuid(input.bundleId, `${field}.bundleId`),
    collectionId: uuid(input.collectionId, `${field}.collectionId`),
    status: input.status,
    host: string(input.host, `${field}.host`),
    capturedAt: timestamp(input.capturedAt, `${field}.capturedAt`),
    sourceRevision: digest(input.sourceRevision, `${field}.sourceRevision`),
    providerIdentityHash: digest(input.providerIdentityHash, `${field}.providerIdentityHash`),
    centroids,
  };
}

function semanticPassages(value: unknown): SearchSemanticPassages {
  const field = "searchSemanticPassages";
  const input = canonicalRecord(value, field, [
    "version",
    "bundleId",
    "sourceRevision",
    "providerIdentityHash",
    "passages",
  ]);
  const passages = array(input.passages, `${field}.passages`).map((entry, index) =>
    semanticEntry(entry, `${field}.passages[${index}]`),
  );
  if (
    passages.length === 0 ||
    passages.some(({ passageOrdinal }, index) => passageOrdinal !== index) ||
    new Set(passages.map(({ passageId }) => passageId)).size !== passages.length ||
    passages.some(({ vector }) => vector.dimensions !== passages[0]?.vector.dimensions)
  )
    throw new DomainValidationError(`${field}.passages`, "must be contiguous and consistent");
  return {
    version: literal(input.version, 1, `${field}.version`),
    bundleId: uuid(input.bundleId, `${field}.bundleId`),
    sourceRevision: digest(input.sourceRevision, `${field}.sourceRevision`),
    providerIdentityHash: digest(input.providerIdentityHash, `${field}.providerIdentityHash`),
    passages,
  };
}

function decodeSemantic<T>(encoded: Uint8Array, field: string, validate: (value: unknown) => T): T {
  let decoded: unknown;
  try {
    decoded = decodeCanonicalCbor(encoded);
  } catch {
    throw new DomainValidationError(field, "is not valid CBOR");
  }
  if (!bytesEqual(encoded, encodeCanonicalCbor(decoded)))
    throw new DomainValidationError(field, "must use canonical CBOR");
  return validate(decoded);
}

export function encodeSemanticCaptureMaterialization(value: SearchSemanticCapture): Uint8Array {
  return encodeCanonicalCbor(semanticCapture(value));
}

export function decodeSemanticCaptureMaterialization(encoded: Uint8Array): SearchSemanticCapture {
  return decodeSemantic(encoded, "searchSemanticCapture", semanticCapture);
}

export function encodeSemanticPassagesMaterialization(value: SearchSemanticPassages): Uint8Array {
  return encodeCanonicalCbor(semanticPassages(value));
}

export function decodeSemanticPassagesMaterialization(encoded: Uint8Array): SearchSemanticPassages {
  return decodeSemantic(encoded, "searchSemanticPassages", semanticPassages);
}

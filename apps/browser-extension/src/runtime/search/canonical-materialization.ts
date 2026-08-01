import { type Identifier, identifier } from "../../domain/canonical/identifiers";
import {
  arrayValue,
  byteString,
  canonicalSetValue,
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  nullable,
  oneOfCodes,
  signedInteger,
  textValue,
} from "../../domain/canonical/schema";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual, sha256 } from "../../domain/hash";
import type { CanonicalLibraryProjection } from "../library/canonical-projection";
import { parseSearchQuery, tokenizeSearchText } from "./query";

const SEARCH_FORMAT = 1 as const;
const CORPUS_POLICY_REVISION = 1 as const;
const SEARCH_SCHEMA_REVISION = 1 as const;
const TOKENIZER_REVISION = 1 as const;
const LANGUAGE_NORMALIZATION_REVISION = 1 as const;
const PASSAGE_REVISION = 1 as const;
const KEYWORD_SCORING_REVISION = 1 as const;
const RANKING_REVISION = 1 as const;
const CORPUS_SELECTION_REVISION = 1 as const;
const MAX_RESULTS = 200;
const MAX_SNIPPET_CODE_UNITS = 240;
const MAX_PASSAGE_WORDS = 160;
const MAX_PASSAGE_BYTES = 768;
const INDEX_BATCH_SIZE = 32;

type SearchDocumentKind = "Capture" | "Collection" | "Note";
type SearchDocumentId = Identifier<"Bundle"> | Identifier<"Collection"> | Identifier<"Note">;
type SearchFieldKind = "Title" | "Url" | "Organization" | "Body";

export interface CanonicalSearchField {
  readonly kind: SearchFieldKind;
  readonly passageId: Uint8Array;
  readonly text: string;
  readonly tokens: readonly string[];
}

export interface CanonicalSearchDocument {
  readonly kind: SearchDocumentKind;
  readonly id: SearchDocumentId;
  readonly status: "Active" | "Deleted";
  readonly title: string;
  readonly host: string | null;
  readonly capturedAt: number | bigint | null;
  readonly collectionIds: readonly Identifier<"Collection">[];
  readonly tagIds: readonly Identifier<"Tag">[];
  readonly fields: readonly CanonicalSearchField[];
}

export interface CanonicalSearchCoverage {
  readonly eligibleCaptures: number;
  readonly indexedCaptures: number;
  readonly unavailableHeavyContent: number;
  readonly failedCaptures: number;
}

export interface CanonicalSearchMaterialization {
  readonly format: 1;
  readonly materializationId: Uint8Array;
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly frontier: readonly Identifier<"VaultRecord">[];
  readonly coverage: CanonicalSearchCoverage;
  readonly documents: readonly CanonicalSearchDocument[];
}

export interface CanonicalSearchQuery {
  readonly query: string;
  readonly scope: "Active" | "Deleted";
  readonly hosts: readonly string[];
  readonly collectionIds: readonly Identifier<"Collection">[];
  readonly tagIds: readonly Identifier<"Tag">[];
  readonly capturedFrom?: number | bigint;
  readonly capturedBefore?: number | bigint;
}

export interface CanonicalSearchResult {
  readonly kind: SearchDocumentKind;
  readonly id: SearchDocumentId;
  readonly title: string;
  readonly passageId: Uint8Array;
  readonly snippet: string;
  readonly score: number;
}

interface FieldDraft {
  readonly kind: SearchFieldKind;
  readonly text: string;
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, index) => [index, value] as const));
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return key(left).localeCompare(key(right));
}

function kindCode(kind: SearchDocumentKind): 1 | 2 | 3 {
  return kind === "Capture" ? 1 : kind === "Collection" ? 2 : 3;
}

function fieldCode(kind: SearchFieldKind): 1 | 2 | 3 | 4 {
  return kind === "Title" ? 1 : kind === "Url" ? 2 : kind === "Organization" ? 3 : 4;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function splitLongWord(value: string): readonly string[] {
  const output: string[] = [];
  let current = "";
  for (const scalar of value) {
    if (new TextEncoder().encode(current + scalar).byteLength > MAX_PASSAGE_BYTES) {
      if (current.length === 0) throw new TypeError("A Search scalar exceeds the passage limit");
      output.push(current);
      current = scalar;
    } else {
      current += scalar;
    }
  }
  if (current.length > 0) output.push(current);
  return output;
}

function passageTexts(value: string): readonly string[] {
  const words = (value.match(/\S+/gu) ?? []).flatMap((word) =>
    new TextEncoder().encode(word).byteLength <= MAX_PASSAGE_BYTES ? [word] : splitLongWord(word),
  );
  const output: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    const candidate = [...current, word].join(" ");
    if (
      current.length > 0 &&
      (current.length === MAX_PASSAGE_WORDS ||
        new TextEncoder().encode(candidate).byteLength > MAX_PASSAGE_BYTES)
    ) {
      output.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) output.push(current.join(" "));
  return output;
}

function integerCompare(left: number | bigint, right: number | bigint): number {
  const a = typeof left === "bigint" ? left : BigInt(left);
  const b = typeof right === "bigint" ? right : BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function includesId(values: readonly Uint8Array[], expected: Uint8Array): boolean {
  return values.some((value) => bytesEqual(value, expected));
}

function uniqueIds<Kind extends "Collection" | "Tag">(
  values: readonly Identifier<Kind>[],
): readonly Identifier<Kind>[] {
  const unique = new Map(values.map((value) => [key(value), value]));
  return [...unique.values()].sort(compareBytes);
}

function activeAssignments(
  projection: CanonicalLibraryProjection,
): CanonicalLibraryProjection["tagAssignments"] {
  return projection.tagAssignments.filter(({ active }) => active);
}

function targetTagIds(
  projection: CanonicalLibraryProjection,
  targetKind: 1 | 2,
  targetId: Identifier<"Collection"> | Identifier<"Bundle">,
): readonly Identifier<"Tag">[] {
  const assignments = activeAssignments(projection);
  return uniqueIds(
    assignments
      .filter(
        (assignment) =>
          assignment.targetKind === targetKind && bytesEqual(assignment.targetId, targetId),
      )
      .map(({ effectiveTagId }) => effectiveTagId),
  );
}

function tagNames(
  projection: CanonicalLibraryProjection,
  tagIds: readonly Identifier<"Tag">[],
): readonly string[] {
  return tagIds
    .map((tagId) => projection.tags.find(({ tagId: candidate }) => bytesEqual(candidate, tagId)))
    .filter(
      (tag): tag is CanonicalLibraryProjection["tags"][number] =>
        tag !== undefined && tag.lifecycle === 1,
    )
    .map(({ name }) => name)
    .sort();
}

async function buildFields(
  documentKind: SearchDocumentKind,
  documentId: SearchDocumentId,
  drafts: readonly FieldDraft[],
): Promise<readonly CanonicalSearchField[]> {
  const passages = drafts.flatMap((draft) =>
    passageTexts(normalizeText(draft.text)).map((text) => ({ kind: draft.kind, text })),
  );
  return Promise.all(
    passages.map(async ({ kind, text }, index) => ({
      kind,
      passageId: await sha256(
        encodeCanonicalValue(
          indexedMap(
            "awsm.search.passage",
            PASSAGE_REVISION,
            kindCode(documentKind),
            documentId,
            index,
            fieldCode(kind),
            text,
          ),
        ),
      ),
      text,
      tokens: tokenizeSearchText(text),
    })),
  );
}

async function mapInBatches<Input, Output>(
  values: readonly Input[],
  transform: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const output: Output[] = [];
  for (let start = 0; start < values.length; start += INDEX_BATCH_SIZE) {
    output.push(
      ...(await Promise.all(values.slice(start, start + INDEX_BATCH_SIZE).map(transform))),
    );
  }
  return output;
}

async function captureDocuments(
  projection: CanonicalLibraryProjection,
): Promise<readonly CanonicalSearchDocument[]> {
  return mapInBatches(projection.captures, async (capture): Promise<CanonicalSearchDocument> => {
    const collection = projection.collections.find(({ collectionId }) =>
      bytesEqual(collectionId, capture.effectiveCollectionId),
    );
    const directTags = targetTagIds(projection, 2, capture.bundleId);
    const collectionTags = targetTagIds(projection, 1, capture.effectiveCollectionId);
    const tagIds = uniqueIds([...directTags, ...collectionTags]);
    const title = normalizeText(capture.title ?? capture.originalUrl);
    return {
      kind: "Capture",
      id: capture.bundleId,
      status: capture.lifecycle === 1 ? "Active" : "Deleted",
      title,
      host: new URL(capture.finalUrl).hostname.toLocaleLowerCase("und"),
      capturedAt: capture.capturedAt,
      collectionIds: [capture.effectiveCollectionId],
      tagIds,
      fields: await buildFields("Capture", capture.bundleId, [
        { kind: "Title", text: title },
        { kind: "Url", text: `${capture.originalUrl} ${capture.finalUrl}` },
        {
          kind: "Organization",
          text: [collection?.title ?? "", ...tagNames(projection, tagIds)].join(" "),
        },
      ]),
    };
  });
}

async function collectionDocuments(
  projection: CanonicalLibraryProjection,
): Promise<readonly CanonicalSearchDocument[]> {
  return mapInBatches(
    projection.collections,
    async (collection): Promise<CanonicalSearchDocument> => {
      const tagIds = targetTagIds(projection, 1, collection.collectionId);
      return {
        kind: "Collection",
        id: collection.collectionId,
        status: "Active",
        title: normalizeText(collection.title),
        host: null,
        capturedAt: null,
        collectionIds: [collection.collectionId],
        tagIds,
        fields: await buildFields("Collection", collection.collectionId, [
          { kind: "Title", text: collection.title },
          { kind: "Organization", text: tagNames(projection, tagIds).join(" ") },
        ]),
      };
    },
  );
}

async function noteDocuments(
  projection: CanonicalLibraryProjection,
): Promise<readonly CanonicalSearchDocument[]> {
  return mapInBatches(projection.notes, async (note): Promise<CanonicalSearchDocument> => {
    const capture =
      note.targetKind === 2
        ? projection.captures.find(({ bundleId }) =>
            bytesEqual(bundleId, identifier("Bundle", note.targetId)),
          )
        : undefined;
    const collectionId =
      note.targetKind === 1
        ? identifier("Collection", note.targetId)
        : capture?.effectiveCollectionId;
    const directTags = targetTagIds(projection, note.targetKind, note.targetId);
    const collectionTags =
      collectionId === undefined ? [] : targetTagIds(projection, 1, collectionId);
    const tagIds = uniqueIds([...directTags, ...collectionTags]);
    const versionTitles = note.versions.map(({ title }) => title).filter((title) => title !== null);
    const title = normalizeText(versionTitles[0] ?? "Note");
    return {
      kind: "Note",
      id: note.noteId,
      status: note.state === 2 ? "Deleted" : "Active",
      title,
      host: capture === undefined ? null : new URL(capture.finalUrl).hostname,
      capturedAt: capture?.capturedAt ?? null,
      collectionIds: collectionId === undefined ? [] : [collectionId],
      tagIds,
      fields: await buildFields("Note", note.noteId, [
        ...versionTitles.map((text): FieldDraft => ({ kind: "Title", text })),
        ...note.versions
          .map(({ body }) => body)
          .filter((body) => body !== null)
          .map((text): FieldDraft => ({ kind: "Body", text })),
        { kind: "Organization", text: tagNames(projection, tagIds).join(" ") },
      ]),
    };
  });
}

function identityValue(projection: CanonicalLibraryProjection): CanonicalValue {
  return indexedMap(
    "awsm.search.materialization",
    SEARCH_FORMAT,
    projection.vaultId,
    projection.generationId,
    canonicalSet(projection.frontier),
    CORPUS_POLICY_REVISION,
    SEARCH_SCHEMA_REVISION,
    TOKENIZER_REVISION,
    LANGUAGE_NORMALIZATION_REVISION,
    PASSAGE_REVISION,
    KEYWORD_SCORING_REVISION,
    RANKING_REVISION,
    CORPUS_SELECTION_REVISION,
  );
}

export async function buildCanonicalSearchMaterialization(
  projection: CanonicalLibraryProjection,
): Promise<CanonicalSearchMaterialization> {
  const documents = [
    ...(await captureDocuments(projection)),
    ...(await collectionDocuments(projection)),
    ...(await noteDocuments(projection)),
  ].sort(
    (left, right) => kindCode(left.kind) - kindCode(right.kind) || compareBytes(left.id, right.id),
  );
  return {
    format: SEARCH_FORMAT,
    materializationId: await canonicalSearchMaterializationId(projection),
    vaultId: projection.vaultId,
    generationId: projection.generationId,
    frontier: canonicalSet(projection.frontier),
    coverage: {
      eligibleCaptures: projection.captures.length,
      indexedCaptures: projection.captures.length,
      unavailableHeavyContent: projection.captures.length,
      failedCaptures: 0,
    },
    documents,
  };
}

export async function canonicalSearchMaterializationId(
  projection: CanonicalLibraryProjection,
): Promise<Uint8Array> {
  return sha256(encodeCanonicalValue(identityValue(projection)));
}

const FIELD_WEIGHTS: Readonly<Record<SearchFieldKind, number>> = {
  Title: 5,
  Url: 3,
  Organization: 2,
  Body: 1,
};

function containsSequence(tokens: readonly string[], expected: readonly string[]): boolean {
  return (
    expected.length > 0 &&
    expected.length <= tokens.length &&
    tokens.some((_token, start) =>
      expected.every((value, offset) => tokens[start + offset] === value),
    )
  );
}

function documentMatchesFilters(
  document: CanonicalSearchDocument,
  query: CanonicalSearchQuery,
): boolean {
  return (
    document.status === query.scope &&
    (query.hosts.length === 0 || (document.host !== null && query.hosts.includes(document.host))) &&
    (query.collectionIds.length === 0 ||
      query.collectionIds.some((id) => includesId(document.collectionIds, id))) &&
    (query.tagIds.length === 0 || query.tagIds.every((id) => includesId(document.tagIds, id))) &&
    (query.capturedFrom === undefined ||
      (document.capturedAt !== null &&
        integerCompare(document.capturedAt, query.capturedFrom) >= 0)) &&
    (query.capturedBefore === undefined ||
      (document.capturedAt !== null &&
        integerCompare(document.capturedAt, query.capturedBefore) < 0))
  );
}

function boundedSnippet(text: string): string {
  const escaped = (character: string): string =>
    character === "&"
      ? "&amp;"
      : character === "<"
        ? "&lt;"
        : character === ">"
          ? "&gt;"
          : character === '"'
            ? "&quot;"
            : character === "'"
              ? "&#39;"
              : character;
  let output = "";
  for (const character of text) {
    const next = escaped(character);
    if (output.length + next.length > MAX_SNIPPET_CODE_UNITS) {
      return `${output.slice(0, MAX_SNIPPET_CODE_UNITS - 1)}…`;
    }
    output += next;
  }
  return output;
}

export function queryCanonicalSearch(
  materialization: CanonicalSearchMaterialization,
  input: CanonicalSearchQuery,
): readonly CanonicalSearchResult[] {
  const query = parseSearchQuery(input.query);
  const terms = [...new Set([...query.terms, ...query.phrases.flatMap(({ tokens }) => tokens)])];
  const documentFrequency = new Map<string, number>();
  const eligible = materialization.documents.filter((document) =>
    documentMatchesFilters(document, input),
  );
  for (const document of eligible) {
    const present = new Set(document.fields.flatMap(({ tokens }) => tokens));
    for (const term of present) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const averageFieldLengths = new Map<SearchFieldKind, number>();
  for (const fieldKind of Object.keys(FIELD_WEIGHTS) as readonly SearchFieldKind[]) {
    const total = eligible.reduce(
      (sum, document) =>
        sum +
        document.fields
          .filter(({ kind }) => kind === fieldKind)
          .reduce((length, field) => length + field.tokens.length, 0),
      0,
    );
    averageFieldLengths.set(fieldKind, eligible.length === 0 ? 0 : total / eligible.length);
  }
  const candidates: CanonicalSearchResult[] = [];
  for (const document of eligible) {
    if (
      query.phrases.some(({ tokens }) =>
        document.fields.every((field) => !containsSequence(field.tokens, tokens)),
      )
    ) {
      continue;
    }
    if (
      query.terms.length > 0 &&
      document.fields.every((field) => field.tokens.every((token) => !query.terms.includes(token)))
    ) {
      continue;
    }
    let score = 0;
    const passageContributions = new Map<CanonicalSearchField, number>();
    for (const term of terms) {
      const groups = (Object.keys(FIELD_WEIGHTS) as readonly SearchFieldKind[]).map((kind) => {
        const fields = document.fields.filter((field) => field.kind === kind);
        const length = fields.reduce((sum, field) => sum + field.tokens.length, 0);
        const frequency = fields.reduce(
          (sum, field) => sum + field.tokens.filter((token) => token === term).length,
          0,
        );
        const averageLength = averageFieldLengths.get(kind) ?? 0;
        const normalizedFrequency =
          frequency === 0 || averageLength === 0
            ? 0
            : (FIELD_WEIGHTS[kind] * frequency) / (0.25 + (0.75 * length) / averageLength);
        return { kind, fields, frequency, normalizedFrequency };
      });
      const weightedFrequency = groups.reduce((sum, group) => sum + group.normalizedFrequency, 0);
      if (weightedFrequency === 0) continue;
      const frequency = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (eligible.length - frequency + 0.5) / (frequency + 0.5),
      );
      const termScore =
        (inverseDocumentFrequency * weightedFrequency * 2.2) / (weightedFrequency + 1.2);
      score += termScore;
      for (const group of groups) {
        if (group.frequency === 0 || group.normalizedFrequency === 0) continue;
        for (const field of group.fields) {
          const localFrequency = field.tokens.filter((token) => token === term).length;
          if (localFrequency === 0) continue;
          const contribution =
            termScore *
            (group.normalizedFrequency / weightedFrequency) *
            (localFrequency / group.frequency);
          passageContributions.set(field, (passageContributions.get(field) ?? 0) + contribution);
        }
      }
    }
    const best = [...passageContributions]
      .map(([field, contribution]) => ({ field, contribution }))
      .sort(
        (left, right) =>
          right.contribution - left.contribution ||
          compareBytes(left.field.passageId, right.field.passageId),
      )[0];
    if (score <= 0 || best === undefined) continue;
    candidates.push({
      kind: document.kind,
      id: document.id,
      title: document.title,
      passageId: best.field.passageId,
      snippet: boundedSnippet(best.field.text),
      score,
    });
  }
  return candidates
    .sort((left, right) => right.score - left.score || compareBytes(left.id, right.id))
    .slice(0, MAX_RESULTS);
}

function encodeDocumentId(document: CanonicalSearchDocument): Uint8Array {
  return document.id;
}

function encodeDocument(document: CanonicalSearchDocument): CanonicalValue {
  return indexedMap(
    kindCode(document.kind),
    encodeDocumentId(document),
    document.status === "Active" ? 1 : 2,
    document.title,
    document.host,
    document.capturedAt,
    canonicalSet(document.collectionIds),
    canonicalSet(document.tagIds),
    document.fields.map((field) =>
      indexedMap(fieldCode(field.kind), field.passageId, field.text, field.tokens),
    ),
  );
}

export function encodeCanonicalSearchMaterialization(
  value: CanonicalSearchMaterialization,
): Uint8Array {
  return encodeCanonicalValue(
    indexedMap(
      value.format,
      value.materializationId,
      value.vaultId,
      value.generationId,
      canonicalSet(value.frontier),
      indexedMap(
        value.coverage.eligibleCaptures,
        value.coverage.indexedCaptures,
        value.coverage.unavailableHeavyContent,
        value.coverage.failedCaptures,
      ),
      value.documents.map(encodeDocument),
    ),
  );
}

function decodeDocument(value: CanonicalValue, index: number): CanonicalSearchDocument {
  const map = exactMap(value, [...Array(9).keys()], `Search document ${index}`);
  const code = oneOfCodes(mapValue(map, 0), [1, 2, 3] as const, "Search document kind");
  const kind = code === 1 ? "Capture" : code === 2 ? "Collection" : "Note";
  const id =
    kind === "Capture"
      ? identifierValue(mapValue(map, 1), "Bundle")
      : kind === "Collection"
        ? identifierValue(mapValue(map, 1), "Collection")
        : identifierValue(mapValue(map, 1), "Note");
  const status = oneOfCodes(mapValue(map, 2), [1, 2] as const, "Search status");
  return {
    kind,
    id,
    status: status === 1 ? "Active" : "Deleted",
    title: textValue(mapValue(map, 3), "Search title", { allowEmpty: true }),
    host: nullable(mapValue(map, 4), (entry) => textValue(entry, "Search host")),
    capturedAt: nullable(mapValue(map, 5), (entry) => signedInteger(entry, "Search capturedAt")),
    collectionIds: canonicalSetValue(mapValue(map, 6), "Search Collection IDs", (entry) =>
      identifierValue(entry, "Collection"),
    ),
    tagIds: canonicalSetValue(mapValue(map, 7), "Search Tag IDs", (entry) =>
      identifierValue(entry, "Tag"),
    ),
    fields: arrayValue(mapValue(map, 8), "Search fields").map((entry, fieldIndex) => {
      const field = exactMap(entry, [0, 1, 2, 3], `Search field ${fieldIndex}`);
      const fieldKind = oneOfCodes(mapValue(field, 0), [1, 2, 3, 4] as const, "Search field kind");
      return {
        kind:
          fieldKind === 1
            ? "Title"
            : fieldKind === 2
              ? "Url"
              : fieldKind === 3
                ? "Organization"
                : "Body",
        passageId: byteString(mapValue(field, 1), 32, "Search passage digest"),
        text: textValue(mapValue(field, 2), "Search field text", {
          allowEmpty: true,
          allowLineFeed: true,
        }),
        tokens: arrayValue(mapValue(field, 3), "Search tokens").map((token) =>
          textValue(token, "Search token"),
        ),
      };
    }),
  };
}

export function decodeCanonicalSearchMaterialization(
  bytes: Uint8Array,
): CanonicalSearchMaterialization {
  const map = exactMap(decodeCanonicalValue(bytes), [...Array(7).keys()], "Search Materialization");
  exactCode(mapValue(map, 0), SEARCH_FORMAT, "Search Materialization format");
  const coverage = exactMap(mapValue(map, 5), [0, 1, 2, 3], "Search coverage");
  const value: CanonicalSearchMaterialization = {
    format: SEARCH_FORMAT,
    materializationId: byteString(mapValue(map, 1), 32, "Search Materialization digest"),
    vaultId: identifierValue(mapValue(map, 2), "Vault"),
    generationId: identifierValue(mapValue(map, 3), "Generation"),
    frontier: canonicalSetValue(mapValue(map, 4), "Search Frontier", (entry) =>
      identifierValue(entry, "VaultRecord"),
    ),
    coverage: {
      eligibleCaptures: Number(signedInteger(mapValue(coverage, 0), "eligible Captures")),
      indexedCaptures: Number(signedInteger(mapValue(coverage, 1), "indexed Captures")),
      unavailableHeavyContent: Number(
        signedInteger(mapValue(coverage, 2), "unavailable heavy content"),
      ),
      failedCaptures: Number(signedInteger(mapValue(coverage, 3), "failed Captures")),
    },
    documents: arrayValue(mapValue(map, 6), "Search documents").map(decodeDocument),
  };
  if (!bytesEqual(encodeCanonicalSearchMaterialization(value), bytes)) {
    throw new TypeError("Search Materialization is not in its one canonical representation");
  }
  return value;
}

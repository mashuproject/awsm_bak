import type { SearchDocument } from "./documents";
import type { ParsedSearchQuery } from "./query";
import { tokenizeSearchText } from "./query";

type SearchScope = "Active" | "Deleted";
export type SearchKeywordFieldName = "Title" | "Host" | "CanonicalUrl" | "KnownUrls" | "Body";

export interface IndexedKeywordField {
  readonly name: SearchKeywordFieldName;
  readonly passageId: string;
  readonly passageOrdinal: number;
  readonly tokens: readonly string[];
}

export interface KeywordRow {
  readonly document: SearchDocument;
  readonly fields: readonly IndexedKeywordField[];
}

interface ScopeStatistics {
  readonly documentCount: number;
  readonly averageLengths: Readonly<Record<SearchKeywordFieldName, number>>;
  readonly documentFrequencies: ReadonlyMap<string, number>;
}

export interface KeywordStatistics {
  readonly Active: ScopeStatistics;
  readonly Deleted: ScopeStatistics;
}

export interface KeywordFilters {
  readonly scope: SearchScope;
  readonly hosts: readonly string[];
  readonly collectionIds: readonly string[];
  readonly capturedFrom?: string;
  readonly capturedBefore?: string;
}

export interface KeywordCandidate {
  readonly bundleId: string;
  readonly passageId: string;
  readonly score: number;
  readonly capturedAt: string;
}

const FIELD_WEIGHTS: Readonly<Record<SearchKeywordFieldName, number>> = {
  Title: 5,
  Host: 4,
  CanonicalUrl: 3,
  KnownUrls: 2,
  Body: 1,
};

function decodedComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlTokens(value: string): readonly string[] {
  const url = new URL(value);
  return tokenizeSearchText(
    [
      url.hostname,
      ...url.pathname.split("/").map(decodedComponent),
      ...Array.from(url.searchParams, ([name, parameter]) => `${name} ${parameter}`),
    ].join(" "),
  );
}

export function buildKeywordRow(document: SearchDocument): KeywordRow {
  const metadataPassageId = document.passages[0]?.passageId;
  if (metadataPassageId === undefined) throw new Error("Search document has no metadata passage.");
  return {
    document,
    fields: [
      {
        name: "Title",
        passageId: metadataPassageId,
        passageOrdinal: 0,
        tokens: tokenizeSearchText(document.title),
      },
      {
        name: "Host",
        passageId: metadataPassageId,
        passageOrdinal: 0,
        tokens: tokenizeSearchText(document.host),
      },
      {
        name: "CanonicalUrl",
        passageId: metadataPassageId,
        passageOrdinal: 0,
        tokens: urlTokens(document.canonicalUrl),
      },
      {
        name: "KnownUrls",
        passageId: metadataPassageId,
        passageOrdinal: 0,
        tokens: document.knownUrls.flatMap(urlTokens),
      },
      ...document.passages.slice(1).map(
        (passage): IndexedKeywordField => ({
          name: "Body",
          passageId: passage.passageId,
          passageOrdinal: passage.ordinal,
          tokens: tokenizeSearchText(passage.text),
        }),
      ),
    ],
  };
}

function scopeStatistics(rows: readonly KeywordRow[], scope: SearchScope): ScopeStatistics {
  const selected = rows.filter(({ document }) => document.status === scope);
  const totalLengths: Record<SearchKeywordFieldName, number> = {
    Title: 0,
    Host: 0,
    CanonicalUrl: 0,
    KnownUrls: 0,
    Body: 0,
  };
  const frequencies = new Map<string, number>();
  for (const row of selected) {
    const documentTokens = new Set<string>();
    for (const field of row.fields) {
      totalLengths[field.name] += field.tokens.length;
      for (const token of field.tokens) documentTokens.add(token);
    }
    for (const token of documentTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  const averageLengths = Object.fromEntries(
    Object.entries(totalLengths).map(([field, total]) => [
      field,
      selected.length === 0 ? 0 : total / selected.length,
    ]),
  ) as Record<SearchKeywordFieldName, number>;
  return {
    documentCount: selected.length,
    averageLengths,
    documentFrequencies: frequencies,
  };
}

export function buildKeywordStatistics(rows: readonly KeywordRow[]): KeywordStatistics {
  return {
    Active: scopeStatistics(rows, "Active"),
    Deleted: scopeStatistics(rows, "Deleted"),
  };
}

export function containsSearchTokenSequence(
  tokens: readonly string[],
  phrase: readonly string[],
): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  return tokens.some(
    (_token, start) =>
      start + phrase.length <= tokens.length &&
      phrase.every((expected, offset) => tokens[start + offset] === expected),
  );
}

function termFrequency(tokens: readonly string[], term: string): number {
  return tokens.reduce((count, token) => count + Number(token === term), 0);
}

function bm25(input: {
  readonly termFrequency: number;
  readonly fieldLength: number;
  readonly averageFieldLength: number;
  readonly documentCount: number;
  readonly documentFrequency: number;
}): number {
  if (input.termFrequency === 0 || input.averageFieldLength === 0 || input.documentCount === 0)
    return 0;
  const k1 = 1.2;
  const b = 0.75;
  const idf = Math.log(
    1 + (input.documentCount - input.documentFrequency + 0.5) / (input.documentFrequency + 0.5),
  );
  return (
    (idf * input.termFrequency * (k1 + 1)) /
    (input.termFrequency + k1 * (1 - b + (b * input.fieldLength) / input.averageFieldLength))
  );
}

export function matchesSearchFilters(
  document: Pick<SearchDocument, "status" | "host" | "collectionId" | "capturedAt">,
  filters: KeywordFilters,
): boolean {
  return (
    document.status === filters.scope &&
    (filters.hosts.length === 0 || filters.hosts.includes(document.host)) &&
    (filters.collectionIds.length === 0 || filters.collectionIds.includes(document.collectionId)) &&
    (filters.capturedFrom === undefined || document.capturedAt >= filters.capturedFrom) &&
    (filters.capturedBefore === undefined || document.capturedAt < filters.capturedBefore)
  );
}

export function rankKeywordRows(
  query: ParsedSearchQuery,
  rows: readonly KeywordRow[],
  statistics: KeywordStatistics,
  filters: KeywordFilters,
): readonly KeywordCandidate[] {
  const scope = statistics[filters.scope];
  const scoringTerms = Array.from(
    new Set([...query.terms, ...query.phrases.flatMap(({ tokens }) => tokens)]),
  );
  const results: KeywordCandidate[] = [];

  for (const row of rows) {
    if (!matchesSearchFilters(row.document, filters)) continue;
    if (
      query.phrases.some(
        ({ tokens }) =>
          !row.fields.some((field) => containsSearchTokenSequence(field.tokens, tokens)),
      )
    )
      continue;
    if (
      query.terms.length > 0 &&
      !row.fields.some((field) => field.tokens.some((token) => query.terms.includes(token)))
    )
      continue;

    const fieldLengths = new Map<SearchKeywordFieldName, number>();
    const fieldsByName = new Map<SearchKeywordFieldName, IndexedKeywordField[]>();
    for (const field of row.fields) {
      fieldLengths.set(field.name, (fieldLengths.get(field.name) ?? 0) + field.tokens.length);
      const grouped = fieldsByName.get(field.name);
      if (grouped === undefined) fieldsByName.set(field.name, [field]);
      else grouped.push(field);
    }
    const passageScores = new Map<string, { score: number; ordinal: number }>();
    let score = 0;
    for (const fieldName of Object.keys(FIELD_WEIGHTS) as readonly SearchKeywordFieldName[]) {
      const matchingFields = fieldsByName.get(fieldName) ?? [];
      for (const term of scoringTerms) {
        const localFrequencies = matchingFields.map((field) => ({
          field,
          frequency: termFrequency(field.tokens, term),
        }));
        const totalTermFrequency = localFrequencies.reduce(
          (total, current) => total + current.frequency,
          0,
        );
        const contribution =
          bm25({
            termFrequency: totalTermFrequency,
            fieldLength: fieldLengths.get(fieldName) ?? 0,
            averageFieldLength: scope.averageLengths[fieldName],
            documentCount: scope.documentCount,
            documentFrequency: scope.documentFrequencies.get(term) ?? 0,
          }) * FIELD_WEIGHTS[fieldName];
        score += contribution;
        if (contribution === 0) continue;
        for (const { field, frequency: localFrequency } of localFrequencies) {
          if (localFrequency === 0 || totalTermFrequency === 0) continue;
          const current = passageScores.get(field.passageId) ?? {
            score: 0,
            ordinal: field.passageOrdinal,
          };
          passageScores.set(field.passageId, {
            score: current.score + contribution * (localFrequency / totalTermFrequency),
            ordinal: field.passageOrdinal,
          });
        }
      }
    }
    if (score === 0) continue;
    const bestPassage = Array.from(passageScores, ([passageId, value]) => ({
      passageId,
      ...value,
    })).sort(
      (left, right) =>
        right.score - left.score ||
        left.ordinal - right.ordinal ||
        left.passageId.localeCompare(right.passageId),
    )[0];
    if (bestPassage === undefined) continue;
    results.push({
      bundleId: row.document.bundleId,
      passageId: bestPassage.passageId,
      score,
      capturedAt: row.document.capturedAt,
    });
  }

  return results
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.capturedAt.localeCompare(left.capturedAt) ||
        left.bundleId.localeCompare(right.bundleId),
    )
    .slice(0, 200);
}

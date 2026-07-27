import { DomainValidationError } from "../../domain/errors";
import { integer, uuid } from "../../domain/validation";
import type { KeywordRow, SearchKeywordFieldName } from "./keyword";

export interface SearchKeywordScopeStatistics {
  readonly documentCount: number;
  readonly totalFieldLengths: Readonly<Record<SearchKeywordFieldName, number>>;
  readonly averageFieldLengths: Readonly<Record<SearchKeywordFieldName, number>>;
}

export interface SearchKeywordStatisticsMaterialization {
  readonly version: 1;
  readonly generationId: string;
  readonly revision: number;
  readonly Active: SearchKeywordScopeStatistics;
  readonly Deleted: SearchKeywordScopeStatistics;
}

const FIELD_NAMES: readonly SearchKeywordFieldName[] = [
  "Title",
  "Host",
  "CanonicalUrl",
  "KnownUrls",
  "Body",
];

function zeroLengths(): Record<SearchKeywordFieldName, number> {
  return { Title: 0, Host: 0, CanonicalUrl: 0, KnownUrls: 0, Body: 0 };
}

function emptyScope(): SearchKeywordScopeStatistics {
  return {
    documentCount: 0,
    totalFieldLengths: zeroLengths(),
    averageFieldLengths: zeroLengths(),
  };
}

function rowLengths(row: KeywordRow): Readonly<Record<SearchKeywordFieldName, number>> {
  const lengths = zeroLengths();
  for (const field of row.fields) lengths[field.name] += field.tokens.length;
  return lengths;
}

function changeScope(
  scope: SearchKeywordScopeStatistics,
  row: KeywordRow,
  direction: -1 | 1,
): SearchKeywordScopeStatistics {
  const documentCount = scope.documentCount + direction;
  if (!Number.isSafeInteger(documentCount) || documentCount < 0)
    throw new DomainValidationError("searchStatistics.documentCount", "would be invalid");
  const rowFieldLengths = rowLengths(row);
  const totalFieldLengths = Object.fromEntries(
    FIELD_NAMES.map((field) => {
      const total = scope.totalFieldLengths[field] + direction * rowFieldLengths[field];
      if (!Number.isSafeInteger(total) || total < 0)
        throw new DomainValidationError("searchStatistics.totalFieldLengths", "would be invalid");
      return [field, total];
    }),
  ) as Record<SearchKeywordFieldName, number>;
  return {
    documentCount,
    totalFieldLengths,
    averageFieldLengths: Object.fromEntries(
      FIELD_NAMES.map((field) => [
        field,
        documentCount === 0 ? 0 : totalFieldLengths[field] / documentCount,
      ]),
    ) as Record<SearchKeywordFieldName, number>,
  };
}

export function createKeywordStatistics(
  generationIdValue: string,
): SearchKeywordStatisticsMaterialization {
  return {
    version: 1,
    generationId: uuid(generationIdValue, "searchStatistics.generationId"),
    revision: 0,
    Active: emptyScope(),
    Deleted: emptyScope(),
  };
}

export function projectionGeneration(
  statistics: Pick<SearchKeywordStatisticsMaterialization, "generationId" | "revision">,
): string {
  const generationId = uuid(statistics.generationId, "searchStatistics.generationId");
  const revision = integer(statistics.revision, "searchStatistics.revision");
  return `${generationId}:${revision}`;
}

export function applyKeywordStatisticsChange(
  statistics: SearchKeywordStatisticsMaterialization,
  previous: KeywordRow | undefined,
  next: KeywordRow,
): SearchKeywordStatisticsMaterialization {
  projectionGeneration(statistics);
  if (
    previous !== undefined &&
    (previous.document.vaultId !== next.document.vaultId ||
      previous.document.bundleId !== next.document.bundleId)
  )
    throw new DomainValidationError(
      "searchStatistics",
      "cannot replace a different Capture or Vault",
    );
  if (statistics.revision === Number.MAX_SAFE_INTEGER)
    throw new DomainValidationError("searchStatistics.revision", "cannot be incremented");

  let Active = statistics.Active;
  let Deleted = statistics.Deleted;
  if (previous !== undefined) {
    if (previous.document.status === "Active") Active = changeScope(Active, previous, -1);
    else Deleted = changeScope(Deleted, previous, -1);
  }
  if (next.document.status === "Active") Active = changeScope(Active, next, 1);
  else Deleted = changeScope(Deleted, next, 1);
  return {
    version: 1,
    generationId: statistics.generationId,
    revision: statistics.revision + 1,
    Active,
    Deleted,
  };
}

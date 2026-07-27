import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { sha256 } from "../../domain/hash";
import type { KeywordCandidateBundleIds } from "../../drivers/indexeddb/search-repository";
import type { VaultKeyring } from "../vault/keyring";
import type { EmbeddingProvider } from "./contracts";
import {
  type ExactCandidate,
  fuseHybridResults,
  type HybridMatch,
  type ProviderCandidate,
} from "./hybrid";
import {
  containsSearchTokenSequence,
  type KeywordFilters,
  type KeywordRow,
  type KeywordStatistics,
  rankKeywordRows,
} from "./keyword";
import { parseSearchQuery } from "./query";
import {
  providerIdentityHash,
  rankSemanticCandidates,
  type SearchSemanticCapture,
  type SearchSemanticPassages,
  SemanticCentroidCollector,
} from "./semantic";
import type { SearchSettings } from "./settings";
import { projectionGeneration, type SearchKeywordStatisticsMaterialization } from "./statistics";

const PAGE_SIZE = 50;
const MAX_RESULTS = 1_000;
const MAX_PER_CLIENT = 4;
const MAX_GLOBAL = 16;
const SESSION_TTL_MS = 10 * 60_000;
const CLIENT_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9]+$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface RetainedSearchResult {
  readonly bundleId: string;
  readonly passageId: string;
  readonly match: HybridMatch;
  readonly score: number;
}

interface SearchSession {
  readonly cursor: string;
  readonly clientInstanceId: string;
  readonly vaultId: string;
  readonly vaultGeneration: string;
  readonly projectionGeneration: string;
  readonly filtersHash: string;
  readonly scope: "Active" | "Deleted";
  readonly results: readonly RetainedSearchResult[];
  readonly resultCountIsComplete: boolean;
  readonly nextOffset: number;
  readonly lastAccessedAt: number;
}

export interface SearchSessionPage {
  readonly results: readonly RetainedSearchResult[];
  readonly cursor?: string;
  readonly resultCount: number;
  readonly resultCountIsComplete: boolean;
  readonly scope?: "Active" | "Deleted";
}

export class SearchCursorExpiredError extends Error {
  readonly id = "SEARCH_CURSOR_EXPIRED";

  constructor() {
    super("The Search cursor expired.");
    this.name = "SearchCursorExpiredError";
  }
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function validateResult(result: RetainedSearchResult): void {
  if (
    result.bundleId.length === 0 ||
    result.passageId.length === 0 ||
    !Number.isFinite(result.score)
  )
    throw new DomainValidationError("searchSession.result", "is invalid");
}

export class SearchSessionStore {
  private readonly sessions = new Map<string, SearchSession>();
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(input?: {
    readonly now?: () => number;
    readonly randomBytes?: (length: number) => Uint8Array;
  }) {
    this.now = input?.now ?? Date.now;
    this.randomBytes =
      input?.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
  }

  create(input: {
    readonly clientInstanceId: string;
    readonly vaultId: string;
    readonly vaultGeneration: string;
    readonly projectionGeneration: string;
    readonly filtersHash: string;
    readonly scope: "Active" | "Deleted";
    readonly results: readonly RetainedSearchResult[];
    readonly resultCountIsComplete: boolean;
  }): SearchSessionPage {
    this.validateContext(input);
    if (input.results.length > MAX_RESULTS)
      throw new DomainValidationError("searchSession.results", "exceeds the retained result limit");
    for (const result of input.results) validateResult(result);
    this.purgeExpired();
    const first = input.results.slice(0, PAGE_SIZE);
    if (input.results.length <= PAGE_SIZE)
      return {
        results: first,
        resultCount: input.results.length,
        resultCountIsComplete: input.resultCountIsComplete,
        scope: input.scope,
      };
    const cursor = this.newCursor();
    const now = this.now();
    this.sessions.set(cursor, {
      ...input,
      cursor,
      results: [...input.results],
      nextOffset: PAGE_SIZE,
      lastAccessedAt: now,
    });
    this.enforceLimits(input.clientInstanceId);
    return {
      results: first,
      cursor,
      resultCount: input.results.length,
      resultCountIsComplete: input.resultCountIsComplete,
      scope: input.scope,
    };
  }

  more(input: {
    readonly cursor: string;
    readonly clientInstanceId: string;
    readonly vaultId: string;
    readonly vaultGeneration: string;
    readonly projectionGeneration: string;
  }): SearchSessionPage {
    this.purgeExpired();
    const session = this.sessions.get(input.cursor);
    if (
      session === undefined ||
      session.clientInstanceId !== input.clientInstanceId ||
      session.vaultId !== input.vaultId ||
      session.vaultGeneration !== input.vaultGeneration ||
      session.projectionGeneration !== input.projectionGeneration
    ) {
      this.sessions.delete(input.cursor);
      throw new SearchCursorExpiredError();
    }
    const nextOffset = Math.min(session.nextOffset + PAGE_SIZE, session.results.length);
    const results = session.results.slice(session.nextOffset, nextOffset);
    const hasMore = nextOffset < session.results.length;
    if (hasMore) {
      this.sessions.set(input.cursor, {
        ...session,
        nextOffset,
        lastAccessedAt: this.now(),
      });
    } else {
      this.sessions.delete(input.cursor);
    }
    return {
      results,
      ...(hasMore ? { cursor: input.cursor } : {}),
      resultCount: session.results.length,
      resultCountIsComplete: session.resultCountIsComplete,
      scope: session.scope,
    };
  }

  invalidate(): void {
    this.sessions.clear();
  }

  size(): number {
    this.purgeExpired();
    return this.sessions.size;
  }

  countForClient(clientInstanceId: string): number {
    this.purgeExpired();
    return [...this.sessions.values()].filter(
      (session) => session.clientInstanceId === clientInstanceId,
    ).length;
  }

  private validateContext(input: {
    readonly clientInstanceId: string;
    readonly vaultId: string;
    readonly vaultGeneration: string;
    readonly projectionGeneration: string;
    readonly filtersHash: string;
    readonly scope: "Active" | "Deleted";
  }): void {
    if (
      !CLIENT_PATTERN.test(input.clientInstanceId) ||
      input.vaultId.length === 0 ||
      input.vaultGeneration.length === 0 ||
      !GENERATION_PATTERN.test(input.projectionGeneration) ||
      !DIGEST_PATTERN.test(input.filtersHash) ||
      (input.scope !== "Active" && input.scope !== "Deleted")
    )
      throw new DomainValidationError("searchSession", "has an invalid context");
  }

  private newCursor(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.randomBytes(24);
      if (bytes.byteLength !== 24)
        throw new DomainValidationError("searchSession.random", "must return exactly 24 bytes");
      const cursor = base64Url(bytes);
      if (!this.sessions.has(cursor)) return cursor;
    }
    throw new Error("Unable to allocate a unique Search cursor.");
  }

  private purgeExpired(): void {
    const threshold = this.now() - SESSION_TTL_MS;
    for (const [cursor, session] of this.sessions) {
      if (session.lastAccessedAt < threshold) this.sessions.delete(cursor);
    }
  }

  private enforceLimits(clientInstanceId: string): void {
    const oldest = (sessions: readonly SearchSession[]): SearchSession | undefined =>
      [...sessions].sort(
        (left, right) =>
          left.lastAccessedAt - right.lastAccessedAt || left.cursor.localeCompare(right.cursor),
      )[0];
    while (this.countForClient(clientInstanceId) > MAX_PER_CLIENT) {
      const candidate = oldest(
        [...this.sessions.values()].filter(
          (session) => session.clientInstanceId === clientInstanceId,
        ),
      );
      if (candidate === undefined) break;
      this.sessions.delete(candidate.cursor);
    }
    while (this.sessions.size > MAX_GLOBAL) {
      const candidate = oldest([...this.sessions.values()]);
      if (candidate === undefined) break;
      this.sessions.delete(candidate.cursor);
    }
  }
}

export interface SearchDisplayResult extends RetainedSearchResult {
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly title: string;
  readonly originalUrl: string;
  readonly host: string;
  readonly capturedAt: string;
  readonly status: "Active" | "Deleted";
  readonly snippet: string;
}

export interface SearchCoordinatorPage {
  readonly results: readonly SearchDisplayResult[];
  readonly nextCursor?: string;
  readonly resultCount: number;
  readonly resultCountIsComplete: boolean;
  readonly coverage: {
    readonly eligibleCaptures: number;
    readonly keywordCaptures: number;
    readonly semanticCaptures: number;
    readonly pendingSemanticCaptures: number;
    readonly failedSemanticCaptures: number;
  };
  readonly semantic:
    | { readonly state: "NotConfigured" }
    | { readonly state: "Ready" | "Partial" | "Unavailable"; readonly providerLabel: string };
}

export interface SearchCoordinatorRepository {
  loadKeywordStatistics(
    keyring: VaultKeyring,
    vaultId: string,
  ): Promise<SearchKeywordStatisticsMaterialization | undefined>;
  keywordCandidateBundleIds(
    keyring: VaultKeyring,
    vaultId: string,
    query: ReturnType<typeof parseSearchQuery>,
    scope: "Active" | "Deleted",
  ): Promise<KeywordCandidateBundleIds>;
  loadKeywordRows(
    keyring: VaultKeyring,
    vaultId: string,
    bundleIds: readonly string[],
  ): Promise<readonly KeywordRow[]>;
  loadSearchSettings(keyring: VaultKeyring, vaultId: string): Promise<SearchSettings | undefined>;
  scanSemanticCaptures(
    keyring: VaultKeyring,
    vaultId: string,
    onBatch: (batch: readonly SearchSemanticCapture[]) => Promise<void>,
    batchSize?: number,
  ): Promise<void>;
  loadSemanticPassages(
    keyring: VaultKeyring,
    vaultId: string,
    bundleId: string,
  ): Promise<SearchSemanticPassages | undefined>;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function keywordStatistics(
  materialized: SearchKeywordStatisticsMaterialization,
  documentFrequencies: ReadonlyMap<string, number>,
): KeywordStatistics {
  const scope = (name: "Active" | "Deleted") => ({
    documentCount: materialized[name].documentCount,
    averageLengths: materialized[name].averageFieldLengths,
    documentFrequencies,
  });
  return { Active: scope("Active"), Deleted: scope("Deleted") };
}

function providerOrder(left: ProviderCandidate, right: ProviderCandidate): number {
  return (
    right.score - left.score ||
    right.capturedAt.localeCompare(left.capturedAt) ||
    left.bundleId.localeCompare(right.bundleId)
  );
}

function normalizedExact(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("und");
}

function canonicalQueryUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function exactCandidate(
  row: KeywordRow,
  query: ReturnType<typeof parseSearchQuery>,
  keywordScore: number,
): ExactCandidate | undefined {
  const metadataPassage = row.document.passages[0];
  if (metadataPassage === undefined) return undefined;
  if (normalizedExact(row.document.title) === query.exactValue)
    return {
      bundleId: row.document.bundleId,
      reason: "ExactTitle",
      keywordScore,
      capturedAt: row.document.capturedAt,
      passageId: metadataPassage.passageId,
    };
  const queryUrl = canonicalQueryUrl(query.exactValue);
  if (queryUrl !== undefined && row.document.canonicalUrl === queryUrl)
    return {
      bundleId: row.document.bundleId,
      reason: "ExactUrl",
      keywordScore,
      capturedAt: row.document.capturedAt,
      passageId: metadataPassage.passageId,
    };
  const phraseFields = query.phrases.flatMap(({ tokens }) =>
    row.fields.filter((field) => containsSearchTokenSequence(field.tokens, tokens)),
  );
  const first = phraseFields.sort(
    (left, right) =>
      left.passageOrdinal - right.passageOrdinal || left.passageId.localeCompare(right.passageId),
  )[0];
  return first === undefined
    ? undefined
    : {
        bundleId: row.document.bundleId,
        reason: "ExactPhrase",
        keywordScore,
        capturedAt: row.document.capturedAt,
        passageId: first.passageId,
      };
}

function snippet(
  text: string,
  query: ReturnType<typeof parseSearchQuery>,
  semanticOnly: boolean,
): string {
  const scalars = Array.from(text);
  if (scalars.length <= 320) return text;
  let center = 0;
  if (!semanticOnly) {
    const lowered = text.toLocaleLowerCase("und");
    const needles = [
      ...query.phrases.map(({ text: phrase }) => phrase.toLocaleLowerCase("und")),
      ...query.terms,
    ];
    center = Math.max(
      0,
      Math.min(...needles.map((needle) => lowered.indexOf(needle)).filter((offset) => offset >= 0)),
    );
    if (!Number.isFinite(center)) center = 0;
  }
  const scalarCenter = Array.from(text.slice(0, center)).length;
  let start = semanticOnly ? 0 : Math.max(0, scalarCenter - 120);
  const end = Math.min(scalars.length, start + 320);
  if (end - start < 320) start = Math.max(0, end - 320);
  let selected = scalars.slice(start, end).join("");
  if (start > 0) selected = `…${selected.replace(/^\S*\s?/u, "")}`;
  if (end < scalars.length) selected = `${selected.replace(/\s?\S*$/u, "")}…`;
  return Array.from(selected).slice(0, 320).join("");
}

function providerLabel(settings: Exclude<SearchSettings, { semantic: "Disabled" }>): string {
  return settings.semantic === "Local" ? "On-device English model" : settings.provider.model;
}

export class SearchCoordinator {
  private readonly sessions: SearchSessionStore;

  constructor(
    private readonly dependencies: {
      readonly repository: SearchCoordinatorRepository;
      readonly providerFor: (
        settings: Exclude<SearchSettings, { semantic: "Disabled" }>,
        vaultId: string,
      ) => Promise<EmbeddingProvider>;
      readonly sessions?: SearchSessionStore;
    },
  ) {
    this.sessions = dependencies.sessions ?? new SearchSessionStore();
  }

  invalidate(): void {
    this.sessions.invalidate();
  }

  async stateForScope(input: {
    readonly keyring: VaultKeyring;
    readonly vaultId: string;
    readonly scope: "Active" | "Deleted";
  }): Promise<Pick<SearchCoordinatorPage, "coverage" | "semantic">> {
    const [statistics, settings] = await Promise.all([
      this.dependencies.repository.loadKeywordStatistics(input.keyring, input.vaultId),
      this.dependencies.repository.loadSearchSettings(input.keyring, input.vaultId),
    ]);
    const eligibleCaptures = statistics?.[input.scope].documentCount ?? 0;
    const configured =
      settings === undefined || settings.semantic === "Disabled" ? undefined : settings;
    let semanticCaptures = 0;
    if (configured !== undefined) {
      const identityHash = await providerIdentityHash(configured.provider);
      await this.dependencies.repository.scanSemanticCaptures(
        input.keyring,
        input.vaultId,
        async (batch) => {
          semanticCaptures += batch.filter(
            (capture) =>
              capture.status === input.scope && capture.providerIdentityHash === identityHash,
          ).length;
        },
      );
    }
    return {
      coverage: {
        eligibleCaptures,
        keywordCaptures: eligibleCaptures,
        semanticCaptures,
        pendingSemanticCaptures: Math.max(0, eligibleCaptures - semanticCaptures),
        failedSemanticCaptures: 0,
      },
      semantic:
        configured === undefined
          ? { state: "NotConfigured" }
          : semanticCaptures < eligibleCaptures
            ? { state: "Partial", providerLabel: providerLabel(configured) }
            : { state: "Ready", providerLabel: providerLabel(configured) },
    };
  }

  async search(input: {
    readonly keyring: VaultKeyring;
    readonly vaultId: string;
    readonly vaultGeneration: string;
    readonly clientInstanceId: string;
    readonly query: string;
    readonly filters: KeywordFilters;
    readonly signal: AbortSignal;
  }): Promise<SearchCoordinatorPage> {
    input.signal.throwIfAborted();
    const parsed = parseSearchQuery(input.query);
    const { repository } = this.dependencies;
    const [statistics, settings] = await Promise.all([
      repository.loadKeywordStatistics(input.keyring, input.vaultId),
      repository.loadSearchSettings(input.keyring, input.vaultId),
    ]);
    if (statistics === undefined)
      throw Object.assign(new Error("The Search index is not available."), {
        id: "SEARCH_INDEX_UNAVAILABLE",
      });
    const generation = projectionGeneration(statistics);
    const candidateIds = await repository.keywordCandidateBundleIds(
      input.keyring,
      input.vaultId,
      parsed,
      input.filters.scope,
    );
    const allKeywordIds = [
      ...new Set([...candidateIds.ordinary, ...candidateIds.exactTitle, ...candidateIds.exactUrl]),
    ].sort();
    const statisticsForQuery = keywordStatistics(statistics, candidateIds.documentFrequencies);
    let keyword: ProviderCandidate[] = [];
    const exact: ExactCandidate[] = [];
    for (let offset = 0; offset < allKeywordIds.length; offset += 128) {
      input.signal.throwIfAborted();
      const rows = await repository.loadKeywordRows(
        input.keyring,
        input.vaultId,
        allKeywordIds.slice(offset, offset + 128),
      );
      const ranked = rankKeywordRows(parsed, rows, statisticsForQuery, input.filters);
      const scores = new Map(ranked.map((candidate) => [candidate.bundleId, candidate.score]));
      keyword = [...keyword, ...ranked].sort(providerOrder).slice(0, 200);
      for (const row of rows) {
        const score = scores.get(row.document.bundleId);
        if (score === undefined) continue;
        const candidate = exactCandidate(row, parsed, score);
        if (candidate !== undefined) exact.push(candidate);
      }
    }

    let semantic: ProviderCandidate[] = [];
    let semanticCaptures = 0;
    let semanticUnavailable = false;
    const configured =
      settings === undefined || settings.semantic === "Disabled" ? undefined : settings;
    if (configured !== undefined) {
      let queryVector: Float32Array | undefined;
      let provider: EmbeddingProvider | undefined;
      try {
        provider = await this.dependencies.providerFor(configured, input.vaultId);
        const identityHash = await providerIdentityHash(provider.identity);
        if (identityHash !== (await providerIdentityHash(configured.provider)))
          throw new DomainValidationError(
            "searchProvider",
            "does not match the active Search setting",
          );
        [queryVector] = await provider.embed({
          purpose: "Query",
          texts: [parsed.semanticText],
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
        });
        if (queryVector === undefined)
          throw new DomainValidationError("searchProvider", "returned no query vector");
        const collector = new SemanticCentroidCollector({
          query: queryVector,
          providerIdentityHash: identityHash,
          filters: input.filters,
        });
        await repository.scanSemanticCaptures(input.keyring, input.vaultId, async (batch) => {
          input.signal.throwIfAborted();
          semanticCaptures += batch.filter(
            (capture) =>
              capture.providerIdentityHash === identityHash &&
              capture.status === input.filters.scope,
          ).length;
          collector.add(batch);
        });
        const captures = collector.captures();
        const passagePairs = await Promise.all(
          captures.map(
            async ({ bundleId }) =>
              [
                bundleId,
                await repository.loadSemanticPassages(input.keyring, input.vaultId, bundleId),
              ] as const,
          ),
        );
        const passages = new Map(
          passagePairs.filter(
            (pair): pair is readonly [string, SearchSemanticPassages] => pair[1] !== undefined,
          ),
        );
        semantic = [...rankSemanticCandidates({ query: queryVector, captures, passages })];
      } catch (error) {
        if (input.signal.aborted) throw error;
        semanticUnavailable = true;
      } finally {
        queryVector?.fill(0);
        await provider?.dispose().catch(() => undefined);
      }
    }
    const fused = fuseHybridResults({ exact, keyword, semantic }).slice(0, MAX_RESULTS);
    const resultIds = [...new Set(fused.map(({ bundleId }) => bundleId))].sort();
    const rows: KeywordRow[] = [];
    for (let offset = 0; offset < resultIds.length; offset += 128) {
      rows.push(
        ...(await repository.loadKeywordRows(
          input.keyring,
          input.vaultId,
          resultIds.slice(offset, offset + 128),
        )),
      );
    }
    const rowByBundle = new Map(rows.map((row) => [row.document.bundleId, row]));
    const display = fused.flatMap((result): SearchDisplayResult[] => {
      const row = rowByBundle.get(result.bundleId);
      const passage = row?.document.passages.find(
        ({ passageId }) => passageId === result.passageId,
      );
      if (row === undefined || passage === undefined) return [];
      return [
        {
          bundleId: result.bundleId,
          passageId: passage.passageId,
          match: result.match,
          score: result.score,
          collectionId: row.document.collectionId,
          collectionTitle: row.document.collectionTitle,
          title: row.document.title,
          originalUrl: row.document.canonicalUrl,
          host: row.document.host,
          capturedAt: row.document.capturedAt,
          status: row.document.status,
          snippet: snippet(passage.text, parsed, result.match === "Semantic"),
        },
      ];
    });
    const latest = await repository.loadKeywordStatistics(input.keyring, input.vaultId);
    if (latest === undefined || projectionGeneration(latest) !== generation)
      throw new SearchCursorExpiredError();
    const filtersHash = hex(
      await sha256(
        encodeCanonicalCbor({
          scope: input.filters.scope,
          hosts: input.filters.hosts,
          collectionIds: input.filters.collectionIds,
          ...(input.filters.capturedFrom === undefined
            ? {}
            : { capturedFrom: input.filters.capturedFrom }),
          ...(input.filters.capturedBefore === undefined
            ? {}
            : { capturedBefore: input.filters.capturedBefore }),
        }),
      ),
    );
    const truncated =
      allKeywordIds.length > 200 || semanticCaptures > 100 || display.length < fused.length;
    const retained = display.map(
      ({ bundleId, passageId, match, score }): RetainedSearchResult => ({
        bundleId,
        passageId,
        match,
        score,
      }),
    );
    const page = this.sessions.create({
      clientInstanceId: input.clientInstanceId,
      vaultId: input.vaultId,
      vaultGeneration: input.vaultGeneration,
      projectionGeneration: generation,
      filtersHash,
      scope: input.filters.scope,
      results: retained,
      resultCountIsComplete: !truncated,
    });
    const firstByKey = new Map(
      display.map((result) => [`${result.bundleId}\0${result.passageId}`, result]),
    );
    return {
      results: page.results.flatMap((result) => {
        const materialized = firstByKey.get(`${result.bundleId}\0${result.passageId}`);
        return materialized === undefined ? [] : [materialized];
      }),
      resultCount: page.resultCount,
      resultCountIsComplete: page.resultCountIsComplete,
      coverage: {
        eligibleCaptures: statistics[input.filters.scope].documentCount,
        keywordCaptures: statistics[input.filters.scope].documentCount,
        semanticCaptures,
        pendingSemanticCaptures: Math.max(
          0,
          statistics[input.filters.scope].documentCount - semanticCaptures,
        ),
        failedSemanticCaptures: 0,
      },
      semantic:
        configured === undefined
          ? { state: "NotConfigured" }
          : semanticUnavailable
            ? { state: "Unavailable", providerLabel: providerLabel(configured) }
            : semanticCaptures < statistics[input.filters.scope].documentCount
              ? { state: "Partial", providerLabel: providerLabel(configured) }
              : { state: "Ready", providerLabel: providerLabel(configured) },
      ...(page.cursor === undefined ? {} : { nextCursor: page.cursor }),
    };
  }

  async more(input: {
    readonly keyring: VaultKeyring;
    readonly vaultId: string;
    readonly vaultGeneration: string;
    readonly clientInstanceId: string;
    readonly cursor: string;
  }): Promise<{
    readonly results: readonly SearchDisplayResult[];
    readonly page: SearchSessionPage;
    readonly state: Pick<SearchCoordinatorPage, "coverage" | "semantic">;
  }> {
    const statistics = await this.dependencies.repository.loadKeywordStatistics(
      input.keyring,
      input.vaultId,
    );
    if (statistics === undefined) throw new SearchCursorExpiredError();
    const page = this.sessions.more({
      cursor: input.cursor,
      clientInstanceId: input.clientInstanceId,
      vaultId: input.vaultId,
      vaultGeneration: input.vaultGeneration,
      projectionGeneration: projectionGeneration(statistics),
    });
    const ids = [...new Set(page.results.map(({ bundleId }) => bundleId))].sort();
    const rows = await this.dependencies.repository.loadKeywordRows(
      input.keyring,
      input.vaultId,
      ids,
    );
    const rowByBundle = new Map(rows.map((row) => [row.document.bundleId, row]));
    const results = page.results.flatMap((result): SearchDisplayResult[] => {
      const row = rowByBundle.get(result.bundleId);
      const passage = row?.document.passages.find(
        ({ passageId }) => passageId === result.passageId,
      );
      if (row === undefined || passage === undefined) return [];
      return [
        {
          ...result,
          collectionId: row.document.collectionId,
          collectionTitle: row.document.collectionTitle,
          title: row.document.title,
          originalUrl: row.document.canonicalUrl,
          host: row.document.host,
          capturedAt: row.document.capturedAt,
          status: row.document.status,
          snippet: Array.from(passage.text).slice(0, 320).join(""),
        },
      ];
    });
    const state = await this.stateForScope({
      keyring: input.keyring,
      vaultId: input.vaultId,
      scope: page.scope ?? "Active",
    });
    return { results, page, state };
  }
}

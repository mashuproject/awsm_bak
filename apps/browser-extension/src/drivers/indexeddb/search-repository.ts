import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { bytesEqual } from "../../domain/hash";
import { openSearchProjectionRow, sealSearchProjectionRow } from "../../runtime/search/crypto";
import {
  claimSearchIndexLease as claimLease,
  completeSearchIndexJob as completeJob,
  failSearchIndexJob as failJob,
  pauseSearchIndexJob as pauseJob,
  releaseSearchIndexLease as releaseLease,
  renewSearchIndexLease as renewLease,
  resumeSearchIndexJob as resumeJob,
  type SearchIndexWaitState,
} from "../../runtime/search/index-lifecycle";
import type { KeywordRow } from "../../runtime/search/keyword";
import {
  decodeKeywordMaterialization,
  decodeKeywordPostingMaterialization,
  decodeKeywordStatisticsMaterialization,
  decodeSemanticCaptureMaterialization,
  decodeSemanticPassagesMaterialization,
  encodeKeywordMaterialization,
  encodeKeywordPostingMaterialization,
  encodeKeywordStatisticsMaterialization,
  encodeSemanticCaptureMaterialization,
  encodeSemanticPassagesMaterialization,
} from "../../runtime/search/materialization";
import {
  createSearchModelReferenceKey,
  deriveSearchModelVaultReference,
} from "../../runtime/search/model-reference";
import {
  deriveSearchKeywordLookupKey,
  keywordPostingEntries,
  type SearchKeywordPostingPlaintext,
  searchKeywordPostingKey,
  searchKeywordPostingRevision,
} from "../../runtime/search/postings";
import type { ParsedSearchQuery } from "../../runtime/search/query";
import {
  createRemoteSearchCredentialKey,
  decodeStoredRemoteSearchCredential,
  openRemoteSearchCredential,
  sealRemoteSearchCredential,
} from "../../runtime/search/remote-credential";
import type { SearchSemanticCapture, SearchSemanticPassages } from "../../runtime/search/semantic";
import {
  decodeSearchSettings,
  encodeSearchSettings,
  type SearchSettings,
  searchSettingsRevision,
} from "../../runtime/search/settings";
import {
  applyKeywordStatisticsChange,
  projectionGeneration,
  type SearchKeywordStatisticsMaterialization,
} from "../../runtime/search/statistics";
import type { VaultKeyring } from "../../runtime/vault/keyring";
import {
  abortTransaction,
  deleteDatabase as deleteIndexedDbDatabase,
  openDatabase,
  requestValue,
  transactionDone,
} from "./database";
import { vaultKey, vaultKeyRange } from "./keys";
import {
  DATABASE_NAME,
  type SearchIndexCheckpointV1,
  type SearchIndexJobV1,
  STORES,
  type StoredSearchEnvelopeV1,
  type StoredSearchModelReferenceV1,
} from "./schema";
import {
  decodeSearchIndexCheckpoint,
  decodeSearchIndexJob,
  decodeStoredSearchEnvelope,
  decodeStoredSearchModelReference,
} from "./search-decode";

type SearchCheckpointKey = [vaultId: string, jobId: string, bundleId: string];

function checkpointKey(vaultId: string, jobId: string, bundleId: string): SearchCheckpointKey {
  return [vaultId, jobId, bundleId];
}

function sameRecord(left: unknown, right: unknown): boolean {
  return bytesEqual(encodeCanonicalCbor(left), encodeCanonicalCbor(right));
}

function envelopeRevision(value: unknown): string | undefined {
  return value === undefined ? undefined : decodeStoredSearchEnvelope(value).sourceRevision;
}

function union(sets: readonly ReadonlySet<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function intersection(sets: readonly ReadonlySet<string>[]): Set<string> {
  const [first, ...rest] = sets;
  if (first === undefined) return new Set();
  return new Set([...first].filter((value) => rest.every((set) => set.has(value))));
}

export interface CreateKeywordGenerationInput {
  readonly keyring: VaultKeyring;
  readonly vaultId: string;
  readonly statistics: SearchKeywordStatisticsMaterialization;
  readonly job: SearchIndexJobV1;
  readonly checkpoints: readonly SearchIndexCheckpointV1[];
}

export interface BeginKeywordGenerationInput {
  readonly keyring: VaultKeyring;
  readonly vaultId: string;
  readonly statistics: SearchKeywordStatisticsMaterialization;
  readonly job: SearchIndexJobV1;
}

export interface CommitKeywordCaptureInput {
  readonly keyring: VaultKeyring;
  readonly row: KeywordRow;
  readonly expectedProjectionGeneration: string;
  readonly job: SearchIndexJobV1;
  readonly checkpoint: SearchIndexCheckpointV1;
}

export interface KeywordCandidateBundleIds {
  readonly ordinary: readonly string[];
  readonly exactTitle: readonly string[];
  readonly exactUrl: readonly string[];
  readonly documentFrequencies: ReadonlyMap<string, number>;
}

export interface CommitSemanticCaptureInput {
  readonly keyring: VaultKeyring;
  readonly capture: SearchSemanticCapture;
  readonly passages: SearchSemanticPassages;
  readonly job: SearchIndexJobV1;
  readonly checkpoint: SearchIndexCheckpointV1;
}

interface PreparedKeywordCommit {
  readonly vaultId: string;
  readonly bundleId: string;
  readonly expectedRowRevision: string | undefined;
  readonly expectedStatisticsRevision: string;
  readonly expectedPostingRevisions: ReadonlyMap<string, string | undefined>;
  readonly opaqueMacs: readonly string[];
  readonly storedRow: StoredSearchEnvelopeV1;
  readonly storedStatistics: StoredSearchEnvelopeV1;
  readonly storedPostings: readonly (StoredSearchEnvelopeV1 | undefined)[];
  readonly currentJob: SearchIndexJobV1;
  readonly currentCheckpoint: SearchIndexCheckpointV1;
  readonly job: SearchIndexJobV1;
  readonly checkpoint: SearchIndexCheckpointV1;
}

export interface SaveSearchSettingsOptions {
  readonly localManifestId?: string;
  readonly remoteApiKey?: Uint8Array;
}

export class IndexedDbSearchRepository {
  private readonly databasePromise: Promise<IDBDatabase>;
  private static readonly modelReferenceKeyId = "search:model-reference-key:v1";

  constructor(private readonly databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  private indexedVaultGenerationKey(vaultId: string): string {
    return `search:indexed-vault-generation:${vaultId}:v1`;
  }

  async loadIndexedVaultGeneration(vaultId: string): Promise<string | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.deviceLocalKeys, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.deviceLocalKeys).get(this.indexedVaultGenerationKey(vaultId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    if (typeof value !== "string")
      throw new DomainValidationError("searchIndexedVaultGeneration", "is not a string");
    return value;
  }

  async saveIndexedVaultGeneration(vaultId: string, generation: string): Promise<void> {
    const [generationId, generationNumber, extra] = generation.split(":");
    if (
      extra !== undefined ||
      generationId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        generationId,
      ) ||
      generationNumber === undefined ||
      !/^(0|[1-9][0-9]*)$/u.test(generationNumber) ||
      !Number.isSafeInteger(Number(generationNumber))
    )
      throw new DomainValidationError("searchIndexedVaultGeneration", "is invalid");
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.deviceLocalKeys, "readwrite");
    transaction
      .objectStore(STORES.deviceLocalKeys)
      .put(generation, this.indexedVaultGenerationKey(vaultId));
    await transactionDone(transaction);
  }

  private async searchModelReferenceKey(): Promise<CryptoKey> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.deviceLocalKeys, "readwrite");
    try {
      const store = transaction.objectStore(STORES.deviceLocalKeys);
      const stored = await requestValue(store.get(IndexedDbSearchRepository.modelReferenceKeyId));
      if (stored !== undefined) {
        if (
          !(stored instanceof CryptoKey) ||
          stored.extractable ||
          stored.algorithm.name !== "HMAC" ||
          (stored.algorithm as HmacKeyAlgorithm).hash.name !== "SHA-256" ||
          !stored.usages.includes("sign")
        )
          throw new DomainValidationError(
            "searchModelReference.key",
            "is not a non-exportable HMAC-SHA-256 signing key",
          );
        await transactionDone(transaction);
        return stored;
      }
      const created = await createSearchModelReferenceKey();
      store.add(created, IndexedDbSearchRepository.modelReferenceKeyId);
      await transactionDone(transaction);
      return created;
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async loadSearchSettings(
    keyring: VaultKeyring,
    vaultId: string,
  ): Promise<SearchSettings | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchSettings, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.searchSettings).get(vaultKey(vaultId, vaultId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const stored = decodeStoredSearchEnvelope(value);
    if (
      stored.vaultId !== vaultId ||
      stored.rowId !== vaultId ||
      stored.projectionType !== "SearchSettings-v1"
    )
      throw new DomainValidationError("searchSettings", "does not match its storage key");
    const settings = decodeSearchSettings(await openSearchProjectionRow({ keyring, stored }));
    if ((await searchSettingsRevision(settings)) !== stored.sourceRevision)
      throw new DomainValidationError("searchSettings", "does not match its authenticated header");
    return settings;
  }

  async saveSearchSettings(
    keyring: VaultKeyring,
    vaultId: string,
    settings: SearchSettings,
    options: SaveSearchSettingsOptions = {},
  ): Promise<void> {
    const previous = await this.loadSearchSettings(keyring, vaultId);
    let validatedLocalManifestId: string | undefined;
    if (settings.semantic === "Local") {
      if (options.localManifestId === undefined)
        throw new DomainValidationError(
          "searchSettings.localManifestId",
          "is required for a local semantic provider",
        );
      validatedLocalManifestId = options.localManifestId;
    }
    const remoteApiKey = options.remoteApiKey;
    if (settings.semantic === "Remote" && remoteApiKey === undefined)
      throw new DomainValidationError(
        "searchSettings.remoteApiKey",
        "is required for a remote semantic provider",
      );
    const remoteCredential =
      settings.semantic === "Remote" && remoteApiKey !== undefined
        ? await (async () => {
            const key = await createRemoteSearchCredentialKey();
            return {
              key,
              stored: await sealRemoteSearchCredential({
                key,
                vaultId,
                credentialId: settings.protectedCredentialId,
                provider: settings.provider,
                apiKey: remoteApiKey,
              }),
            };
          })()
        : undefined;
    const modelReferenceKey =
      previous?.semantic === "Local" || settings.semantic === "Local"
        ? await this.searchModelReferenceKey()
        : undefined;
    const vaultReference =
      modelReferenceKey === undefined
        ? undefined
        : await deriveSearchModelVaultReference(modelReferenceKey, vaultId);
    const [revision, previousRevision] = await Promise.all([
      searchSettingsRevision(settings),
      previous === undefined ? undefined : searchSettingsRevision(previous),
    ]);
    const stored = await sealSearchProjectionRow({
      keyring,
      vaultId,
      rowId: vaultId,
      projectionType: "SearchSettings-v1",
      sourceRevision: revision,
      plaintext: encodeSearchSettings(settings),
    });
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.searchSettings,
        STORES.searchModelReferences,
        STORES.searchSemanticRows,
        STORES.searchSemanticPassages,
        STORES.protectedCredentials,
        STORES.deviceLocalKeys,
      ],
      "readwrite",
    );
    try {
      const settingsStore = transaction.objectStore(STORES.searchSettings);
      const current = await requestValue(settingsStore.get(vaultKey(vaultId, vaultId)));
      if (envelopeRevision(current) !== previousRevision)
        throw new DomainValidationError("searchSettings", "lost an optimistic concurrency race");
      if (previousRevision !== revision) {
        transaction.objectStore(STORES.searchSemanticRows).delete(vaultKeyRange(vaultId));
        transaction.objectStore(STORES.searchSemanticPassages).delete(vaultKeyRange(vaultId));
      }
      if (vaultReference !== undefined) {
        const referenceStore = transaction.objectStore(STORES.searchModelReferences);
        if (settings.semantic === "Local") {
          if (validatedLocalManifestId === undefined)
            throw new DomainValidationError(
              "searchSettings.localManifestId",
              "is required for a local semantic provider",
            );
          const reference = decodeStoredSearchModelReference({
            version: 1,
            vaultReference,
            manifestId: validatedLocalManifestId,
          });
          referenceStore.put(reference satisfies StoredSearchModelReferenceV1, vaultReference);
        } else {
          referenceStore.delete(vaultReference);
        }
      }
      const protectedCredentials = transaction.objectStore(STORES.protectedCredentials);
      const deviceLocalKeys = transaction.objectStore(STORES.deviceLocalKeys);
      if (
        previous?.semantic === "Remote" &&
        (settings.semantic !== "Remote" ||
          previous.protectedCredentialId !== settings.protectedCredentialId)
      ) {
        protectedCredentials.delete(previous.protectedCredentialId);
        deviceLocalKeys.delete(`${previous.protectedCredentialId}:key`);
      }
      if (settings.semantic === "Remote" && remoteCredential !== undefined) {
        protectedCredentials.add(remoteCredential.stored, settings.protectedCredentialId);
        deviceLocalKeys.add(remoteCredential.key, `${settings.protectedCredentialId}:key`);
      }
      settingsStore.put(stored, vaultKey(vaultId, vaultId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async loadRemoteSearchApiKey(
    vaultId: string,
    settings: Extract<SearchSettings, { readonly semantic: "Remote" }>,
  ): Promise<Uint8Array> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.protectedCredentials, STORES.deviceLocalKeys],
      "readonly",
    );
    const [storedValue, keyValue] = await Promise.all([
      requestValue(
        transaction.objectStore(STORES.protectedCredentials).get(settings.protectedCredentialId),
      ),
      requestValue(
        transaction
          .objectStore(STORES.deviceLocalKeys)
          .get(`${settings.protectedCredentialId}:key`),
      ),
    ]);
    await transactionDone(transaction);
    if (
      !(keyValue instanceof CryptoKey) ||
      keyValue.extractable ||
      keyValue.algorithm.name !== "AES-GCM"
    )
      throw new DomainValidationError("remoteSearchCredential.key", "is missing or invalid");
    return openRemoteSearchCredential({
      key: keyValue,
      vaultId,
      credentialId: settings.protectedCredentialId,
      provider: settings.provider,
      stored: decodeStoredRemoteSearchCredential(storedValue),
    });
  }

  async countSearchModelReferences(manifestId: string): Promise<number> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchModelReferences, "readonly");
    const values = await requestValue(
      transaction.objectStore(STORES.searchModelReferences).getAll(),
    );
    await transactionDone(transaction);
    return values.reduce((count, value) => {
      const reference = decodeStoredSearchModelReference(value);
      return count + (reference.manifestId === manifestId ? 1 : 0);
    }, 0);
  }

  async saveKeywordRow(keyring: VaultKeyring, row: KeywordRow): Promise<void> {
    const stored = await sealSearchProjectionRow({
      keyring,
      vaultId: row.document.vaultId,
      rowId: row.document.bundleId,
      projectionType: "SearchKeyword-v1",
      sourceRevision: row.document.sourceRevision,
      plaintext: encodeKeywordMaterialization(row),
    });
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchKeywordRows, "readwrite");
    transaction
      .objectStore(STORES.searchKeywordRows)
      .put(stored, vaultKey(stored.vaultId, stored.rowId));
    await transactionDone(transaction);
  }

  async loadKeywordRow(
    keyring: VaultKeyring,
    vaultId: string,
    bundleId: string,
  ): Promise<KeywordRow | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchKeywordRows, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.searchKeywordRows).get(vaultKey(vaultId, bundleId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const stored = decodeStoredSearchEnvelope(value);
    if (
      stored.vaultId !== vaultId ||
      stored.rowId !== bundleId ||
      stored.projectionType !== "SearchKeyword-v1"
    )
      throw new DomainValidationError("searchKeyword", "does not match its storage key");
    const row = decodeKeywordMaterialization(await openSearchProjectionRow({ keyring, stored }));
    if (
      row.document.vaultId !== vaultId ||
      row.document.bundleId !== bundleId ||
      row.document.sourceRevision !== stored.sourceRevision
    )
      throw new DomainValidationError("searchKeyword", "does not match its authenticated header");
    return row;
  }

  async loadSemanticCapture(
    keyring: VaultKeyring,
    vaultId: string,
    bundleId: string,
  ): Promise<SearchSemanticCapture | undefined> {
    const value = await this.loadSemanticEnvelope(STORES.searchSemanticRows, vaultId, bundleId);
    if (value === undefined) return undefined;
    if (value.projectionType !== "SearchSemantic-v1")
      throw new DomainValidationError("searchSemanticCapture", "has the wrong projection type");
    const row = decodeSemanticCaptureMaterialization(
      await openSearchProjectionRow({ keyring, stored: value }),
    );
    if (row.bundleId !== bundleId || row.sourceRevision !== value.sourceRevision)
      throw new DomainValidationError(
        "searchSemanticCapture",
        "does not match its authenticated header",
      );
    return row;
  }

  async loadSemanticPassages(
    keyring: VaultKeyring,
    vaultId: string,
    bundleId: string,
  ): Promise<SearchSemanticPassages | undefined> {
    const value = await this.loadSemanticEnvelope(STORES.searchSemanticPassages, vaultId, bundleId);
    if (value === undefined) return undefined;
    if (value.projectionType !== "SearchSemanticPassages-v1")
      throw new DomainValidationError("searchSemanticPassages", "has the wrong projection type");
    const row = decodeSemanticPassagesMaterialization(
      await openSearchProjectionRow({ keyring, stored: value }),
    );
    if (row.bundleId !== bundleId || row.sourceRevision !== value.sourceRevision)
      throw new DomainValidationError(
        "searchSemanticPassages",
        "does not match its authenticated header",
      );
    return row;
  }

  private async loadSemanticEnvelope(
    storeName: typeof STORES.searchSemanticRows | typeof STORES.searchSemanticPassages,
    vaultId: string,
    bundleId: string,
  ): Promise<StoredSearchEnvelopeV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(storeName, "readonly");
    const value = await requestValue(
      transaction.objectStore(storeName).get(vaultKey(vaultId, bundleId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const stored = decodeStoredSearchEnvelope(value);
    if (stored.vaultId !== vaultId || stored.rowId !== bundleId)
      throw new DomainValidationError("searchSemantic", "does not match its storage key");
    return stored;
  }

  async scanSemanticCaptures(
    keyring: VaultKeyring,
    vaultId: string,
    onBatch: (batch: readonly SearchSemanticCapture[]) => Promise<void>,
    batchSize = 128,
  ): Promise<void> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 512)
      throw new DomainValidationError("searchSemantic.batchSize", "must be from 1 through 512");
    const database = await this.databasePromise;
    let afterBundleId: string | undefined;
    while (true) {
      const transaction = database.transaction(STORES.searchSemanticRows, "readonly");
      const range =
        afterBundleId === undefined
          ? vaultKeyRange(vaultId)
          : IDBKeyRange.bound([vaultId, afterBundleId], [vaultId, []], true, true);
      const values = await requestValue(
        transaction.objectStore(STORES.searchSemanticRows).getAll(range, batchSize),
      );
      await transactionDone(transaction);
      if (values.length === 0) return;
      const rows = await Promise.all(
        values.map(async (value) => {
          const stored = decodeStoredSearchEnvelope(value);
          if (stored.vaultId !== vaultId || stored.projectionType !== "SearchSemantic-v1")
            throw new DomainValidationError(
              "searchSemanticCapture",
              "does not match its storage range",
            );
          const row = decodeSemanticCaptureMaterialization(
            await openSearchProjectionRow({ keyring, stored }),
          );
          if (row.bundleId !== stored.rowId || row.sourceRevision !== stored.sourceRevision)
            throw new DomainValidationError(
              "searchSemanticCapture",
              "does not match its authenticated header",
            );
          return row;
        }),
      );
      await onBatch(rows);
      afterBundleId = rows.at(-1)?.bundleId;
      if (values.length < batchSize || afterBundleId === undefined) return;
    }
  }

  async saveKeywordPosting(
    keyring: VaultKeyring,
    vaultId: string,
    posting: SearchKeywordPostingPlaintext,
  ): Promise<void> {
    const sourceRevision = await searchKeywordPostingRevision(posting);
    const stored = await sealSearchProjectionRow({
      keyring,
      vaultId,
      rowId: posting.opaqueMac,
      projectionType: "SearchKeywordPosting-v1",
      sourceRevision,
      plaintext: encodeKeywordPostingMaterialization(posting),
    });
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchKeywordPostings, "readwrite");
    transaction
      .objectStore(STORES.searchKeywordPostings)
      .put(stored, vaultKey(vaultId, posting.opaqueMac));
    await transactionDone(transaction);
  }

  async loadKeywordPostings(
    keyring: VaultKeyring,
    vaultId: string,
    opaqueMacs: readonly string[],
  ): Promise<readonly SearchKeywordPostingPlaintext[]> {
    if (
      opaqueMacs.some(
        (opaqueMac, index) => index > 0 && opaqueMac <= (opaqueMacs[index - 1] ?? opaqueMac),
      )
    )
      throw new DomainValidationError(
        "searchPosting.opaqueMacs",
        "must be lexically sorted and unique",
      );
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchKeywordPostings, "readonly");
    const store = transaction.objectStore(STORES.searchKeywordPostings);
    const values = await Promise.all(
      opaqueMacs.map((opaqueMac) => requestValue(store.get(vaultKey(vaultId, opaqueMac)))),
    );
    await transactionDone(transaction);
    const postings: SearchKeywordPostingPlaintext[] = [];
    for (let index = 0; index < opaqueMacs.length; index += 1) {
      const value = values[index];
      if (value === undefined) continue;
      const opaqueMac = opaqueMacs[index];
      if (opaqueMac === undefined) continue;
      const stored = decodeStoredSearchEnvelope(value);
      if (
        stored.vaultId !== vaultId ||
        stored.rowId !== opaqueMac ||
        stored.projectionType !== "SearchKeywordPosting-v1"
      )
        throw new DomainValidationError("searchPosting", "does not match its storage key");
      const posting = decodeKeywordPostingMaterialization(
        await openSearchProjectionRow({ keyring, stored }),
      );
      if (
        posting.opaqueMac !== opaqueMac ||
        (await searchKeywordPostingRevision(posting)) !== stored.sourceRevision
      )
        throw new DomainValidationError("searchPosting", "does not match its authenticated header");
      postings.push(posting);
    }
    return postings;
  }

  async keywordCandidateBundleIds(
    keyring: VaultKeyring,
    vaultId: string,
    query: ParsedSearchQuery,
    scope: "Active" | "Deleted",
  ): Promise<KeywordCandidateBundleIds> {
    const lookupKey = await deriveSearchKeywordLookupKey(keyring, vaultId);
    const requested = new Map<
      string,
      { readonly namespace: "term" | "title-exact" | "url-exact"; readonly value: string }
    >();
    const add = (namespace: "term" | "title-exact" | "url-exact", value: string): void => {
      requested.set(`${namespace}\0${value}`, { namespace, value });
    };
    for (const term of query.terms) add("term", term);
    for (const { tokens } of query.phrases) {
      for (const token of tokens) add("term", token);
    }
    add("title-exact", query.exactValue);
    add("url-exact", query.exactValue);
    const descriptors = await Promise.all(
      [...requested.entries()].map(async ([key, descriptor]) => ({
        key,
        ...descriptor,
        opaqueMac: await searchKeywordPostingKey(lookupKey, descriptor.namespace, descriptor.value),
      })),
    );
    if (new Set(descriptors.map(({ opaqueMac }) => opaqueMac)).size !== descriptors.length)
      throw new DomainValidationError("searchPosting", "encountered an opaque-key collision");
    const postings = await this.loadKeywordPostings(
      keyring,
      vaultId,
      descriptors.map(({ opaqueMac }) => opaqueMac).sort(),
    );
    const postingByMac = new Map(postings.map((posting) => [posting.opaqueMac, posting]));
    const candidates = (namespace: "term" | "title-exact" | "url-exact", value: string) => {
      const descriptor = descriptors.find(
        (candidate) => candidate.namespace === namespace && candidate.value === value,
      );
      if (descriptor === undefined) return new Set<string>();
      return new Set(postingByMac.get(descriptor.opaqueMac)?.[scope] ?? []);
    };

    const termCandidates = union(query.terms.map((term) => candidates("term", term)));
    const phraseCandidates = query.phrases.map(({ tokens }) =>
      intersection(tokens.map((token) => candidates("term", token))),
    );
    const requiredPhrases =
      phraseCandidates.length === 0 ? undefined : intersection(phraseCandidates);
    const ordinary =
      query.terms.length === 0
        ? (requiredPhrases ?? new Set<string>())
        : requiredPhrases === undefined
          ? termCandidates
          : intersection([termCandidates, requiredPhrases]);
    return {
      ordinary: [...ordinary].sort(),
      exactTitle: [...candidates("title-exact", query.exactValue)].sort(),
      exactUrl: [...candidates("url-exact", query.exactValue)].sort(),
      documentFrequencies: new Map(
        [...new Set([...query.terms, ...query.phrases.flatMap(({ tokens }) => tokens)])].map(
          (term) => [term, candidates("term", term).size],
        ),
      ),
    };
  }

  async loadKeywordRows(
    keyring: VaultKeyring,
    vaultId: string,
    bundleIds: readonly string[],
  ): Promise<readonly KeywordRow[]> {
    if (
      bundleIds.length > 256 ||
      bundleIds.some(
        (bundleId, index) => index > 0 && bundleId <= (bundleIds[index - 1] ?? bundleId),
      )
    )
      throw new DomainValidationError(
        "searchKeyword.bundleIds",
        "must be at most 256 lexically sorted unique identifiers",
      );
    const rows = await Promise.all(
      bundleIds.map((bundleId) => this.loadKeywordRow(keyring, vaultId, bundleId)),
    );
    return rows.filter((row) => row !== undefined);
  }

  async createKeywordGeneration(input: CreateKeywordGenerationInput): Promise<void> {
    const job = decodeSearchIndexJob(input.job);
    const checkpoints = input.checkpoints.map(decodeSearchIndexCheckpoint);
    if (
      input.statistics.revision !== 0 ||
      job.vaultId !== input.vaultId ||
      job.projectionGeneration !== projectionGeneration(input.statistics) ||
      checkpoints.some(
        (checkpoint) =>
          checkpoint.vaultId !== input.vaultId ||
          checkpoint.jobId !== job.jobId ||
          checkpoint.keywordState !== "Pending",
      ) ||
      new Set(checkpoints.map(({ bundleId }) => bundleId)).size !== checkpoints.length ||
      job.totalCaptures !== checkpoints.length ||
      job.completedCaptures !== 0 ||
      job.failedCaptures !== 0
    )
      throw new DomainValidationError("searchGeneration", "does not match its Job and checkpoints");
    const storedStatistics = await sealSearchProjectionRow({
      keyring: input.keyring,
      vaultId: input.vaultId,
      rowId: input.vaultId,
      projectionType: "SearchKeywordStatistics-v1",
      sourceRevision: projectionGeneration(input.statistics),
      plaintext: encodeKeywordStatisticsMaterialization(input.statistics),
    });
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.searchKeywordStatistics, STORES.searchIndexJobs, STORES.searchIndexCheckpoints],
      "readwrite",
    );
    try {
      transaction
        .objectStore(STORES.searchKeywordStatistics)
        .add(storedStatistics, vaultKey(input.vaultId, input.vaultId));
      transaction.objectStore(STORES.searchIndexJobs).add(job, vaultKey(input.vaultId, job.jobId));
      const checkpointStore = transaction.objectStore(STORES.searchIndexCheckpoints);
      for (const checkpoint of checkpoints)
        checkpointStore.add(
          checkpoint,
          checkpointKey(input.vaultId, job.jobId, checkpoint.bundleId),
        );
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async beginKeywordGeneration(input: BeginKeywordGenerationInput): Promise<void> {
    const job = decodeSearchIndexJob(input.job);
    if (
      input.statistics.revision !== 0 ||
      job.vaultId !== input.vaultId ||
      job.projectionGeneration !== projectionGeneration(input.statistics) ||
      job.state !== "Created" ||
      job.stage !== "Discover" ||
      job.completedCaptures !== 0 ||
      job.totalCaptures !== 0 ||
      job.failedCaptures !== 0
    )
      throw new DomainValidationError(
        "searchGeneration",
        "does not describe an empty Discover Job",
      );
    const storedStatistics = await sealSearchProjectionRow({
      keyring: input.keyring,
      vaultId: input.vaultId,
      rowId: input.vaultId,
      projectionType: "SearchKeywordStatistics-v1",
      sourceRevision: projectionGeneration(input.statistics),
      plaintext: encodeKeywordStatisticsMaterialization(input.statistics),
    });
    const generationStores = [
      STORES.searchKeywordRows,
      STORES.searchKeywordStatistics,
      STORES.searchKeywordPostings,
      STORES.searchSemanticRows,
      STORES.searchSemanticPassages,
      STORES.searchIndexJobs,
      STORES.searchIndexCheckpoints,
    ] as const;
    const database = await this.databasePromise;
    const transaction = database.transaction(generationStores, "readwrite");
    try {
      for (const storeName of generationStores)
        transaction.objectStore(storeName).delete(vaultKeyRange(input.vaultId));
      transaction
        .objectStore(STORES.searchKeywordStatistics)
        .put(storedStatistics, vaultKey(input.vaultId, input.vaultId));
      transaction.objectStore(STORES.searchIndexJobs).put(job, vaultKey(input.vaultId, job.jobId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async latestSearchIndexJob(vaultId: string): Promise<SearchIndexJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchIndexJobs, "readonly");
    const values = await requestValue(
      transaction.objectStore(STORES.searchIndexJobs).getAll(vaultKeyRange(vaultId)),
    );
    await transactionDone(transaction);
    const jobs = values.map(decodeSearchIndexJob);
    for (const job of jobs) {
      if (job.vaultId !== vaultId)
        throw new DomainValidationError("searchIndexJob", "does not match its storage range");
    }
    return jobs.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
  }

  async appendSearchIndexCheckpoint(
    vaultId: string,
    jobId: string,
    checkpointValue: SearchIndexCheckpointV1,
    now: string,
  ): Promise<SearchIndexJobV1> {
    const checkpoint = decodeSearchIndexCheckpoint(checkpointValue);
    if (
      checkpoint.vaultId !== vaultId ||
      checkpoint.jobId !== jobId ||
      checkpoint.keywordState !== "Pending" ||
      checkpoint.attemptCount !== 0 ||
      checkpoint.updatedAt !== now
    )
      throw new DomainValidationError(
        "searchIndexCheckpoint",
        "does not describe a newly discovered Capture",
      );
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.searchIndexJobs, STORES.searchIndexCheckpoints],
      "readwrite",
    );
    try {
      const jobs = transaction.objectStore(STORES.searchIndexJobs);
      const checkpoints = transaction.objectStore(STORES.searchIndexCheckpoints);
      const [jobValue, existing] = await Promise.all([
        requestValue(jobs.get(vaultKey(vaultId, jobId))),
        requestValue(checkpoints.get(checkpointKey(vaultId, jobId, checkpoint.bundleId))),
      ]);
      if (jobValue === undefined)
        throw new DomainValidationError("searchIndexJob", "does not exist");
      const job = decodeSearchIndexJob(jobValue);
      if (
        job.vaultId !== vaultId ||
        job.jobId !== jobId ||
        job.state !== "Created" ||
        job.stage !== "Discover" ||
        existing !== undefined ||
        now < job.updatedAt
      )
        throw new DomainValidationError("searchDiscovery", "lost its Job or duplicated a Capture");
      const next = decodeSearchIndexJob({
        ...job,
        totalCaptures: job.totalCaptures + 1,
        updatedAt: now,
      });
      checkpoints.add(checkpoint, checkpointKey(vaultId, jobId, checkpoint.bundleId));
      jobs.put(next, vaultKey(vaultId, jobId));
      await transactionDone(transaction);
      return next;
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async finishSearchIndexDiscovery(
    vaultId: string,
    jobId: string,
    now: string,
  ): Promise<SearchIndexJobV1> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.searchIndexJobs, STORES.searchIndexCheckpoints],
      "readwrite",
    );
    try {
      const jobs = transaction.objectStore(STORES.searchIndexJobs);
      const jobValue = await requestValue(jobs.get(vaultKey(vaultId, jobId)));
      if (jobValue === undefined)
        throw new DomainValidationError("searchIndexJob", "does not exist");
      const job = decodeSearchIndexJob(jobValue);
      const checkpointCount = await requestValue(
        transaction
          .objectStore(STORES.searchIndexCheckpoints)
          .count(IDBKeyRange.bound([vaultId, jobId], [vaultId, jobId, []], false, true)),
      );
      if (
        job.vaultId !== vaultId ||
        job.jobId !== jobId ||
        job.state !== "Created" ||
        job.stage !== "Discover" ||
        job.totalCaptures !== checkpointCount ||
        now < job.updatedAt
      )
        throw new DomainValidationError("searchDiscovery", "is not ready to finish");
      const next = decodeSearchIndexJob({ ...job, stage: "Keyword", updatedAt: now });
      jobs.put(next, vaultKey(vaultId, jobId));
      await transactionDone(transaction);
      return next;
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async pauseLatestSearchIndexJob(vaultId: string, now: string): Promise<SearchIndexJobV1> {
    const latest = await this.latestSearchIndexJob(vaultId);
    if (latest === undefined) throw new DomainValidationError("searchIndexJob", "does not exist");
    const paused = await this.updateSearchIndexJob(vaultId, latest.jobId, (job) =>
      pauseJob(job, now),
    );
    if (paused === undefined) throw new Error("Paused Search index Job disappeared.");
    return paused;
  }

  async resumeLatestSearchIndexJob(vaultId: string, now: string): Promise<SearchIndexJobV1> {
    const latest = await this.latestSearchIndexJob(vaultId);
    if (latest === undefined) throw new DomainValidationError("searchIndexJob", "does not exist");
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.searchIndexJobs, STORES.searchIndexCheckpoints],
      "readwrite",
    );
    try {
      const jobs = transaction.objectStore(STORES.searchIndexJobs);
      const checkpoints = transaction.objectStore(STORES.searchIndexCheckpoints);
      const current = decodeSearchIndexJob(
        await requestValue(jobs.get(vaultKey(vaultId, latest.jobId))),
      );
      const values = await requestValue(
        checkpoints.getAll(
          IDBKeyRange.bound([vaultId, latest.jobId], [vaultId, latest.jobId, []], false, true),
        ),
      );
      const failed = values
        .map(decodeSearchIndexCheckpoint)
        .filter(
          (checkpoint) =>
            checkpoint.keywordState === "Failed" || checkpoint.semanticState === "Failed",
        );
      if (current.state !== "Failed" && failed.length > 0)
        throw new DomainValidationError(
          "searchIndexCheckpoint",
          "has a failure without a failed Job",
        );
      if (current.state === "Failed" && current.failedCaptures !== failed.length)
        throw new DomainValidationError(
          "searchIndexJob.failedCaptures",
          "does not match its failed checkpoints",
        );
      for (const checkpoint of failed) {
        const { errorId: _errorId, keywordState, semanticState, ...durable } = checkpoint;
        checkpoints.put(
          decodeSearchIndexCheckpoint({
            ...durable,
            keywordState: keywordState === "Failed" ? "Pending" : keywordState,
            semanticState: semanticState === "Failed" ? "Pending" : semanticState,
            updatedAt: now,
          }),
          checkpointKey(vaultId, latest.jobId, checkpoint.bundleId),
        );
      }
      const resumed = resumeJob(
        { ...current, failedCaptures: current.failedCaptures - failed.length },
        now,
      );
      jobs.put(resumed, vaultKey(vaultId, latest.jobId));
      await transactionDone(transaction);
      return resumed;
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async loadKeywordStatistics(
    keyring: VaultKeyring,
    vaultId: string,
  ): Promise<SearchKeywordStatisticsMaterialization | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchKeywordStatistics, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.searchKeywordStatistics).get(vaultKey(vaultId, vaultId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const stored = decodeStoredSearchEnvelope(value);
    if (
      stored.vaultId !== vaultId ||
      stored.rowId !== vaultId ||
      stored.projectionType !== "SearchKeywordStatistics-v1"
    )
      throw new DomainValidationError("searchStatistics", "does not match its storage key");
    const statistics = decodeKeywordStatisticsMaterialization(
      await openSearchProjectionRow({ keyring, stored }),
    );
    if (projectionGeneration(statistics) !== stored.sourceRevision)
      throw new DomainValidationError(
        "searchStatistics",
        "does not match its authenticated header",
      );
    return statistics;
  }

  async loadSearchIndexJob(vaultId: string, jobId: string): Promise<SearchIndexJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchIndexJobs, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.searchIndexJobs).get(vaultKey(vaultId, jobId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const job = decodeSearchIndexJob(value);
    if (job.vaultId !== vaultId || job.jobId !== jobId)
      throw new DomainValidationError("searchIndexJob", "does not match its storage key");
    return job;
  }

  async claimSearchIndexLease(
    vaultId: string,
    jobId: string,
    owner: string,
    now: string,
  ): Promise<SearchIndexJobV1 | undefined> {
    return this.updateSearchIndexJob(vaultId, jobId, (job) => claimLease(job, owner, now));
  }

  async renewSearchIndexLease(
    vaultId: string,
    jobId: string,
    owner: string,
    now: string,
  ): Promise<SearchIndexJobV1> {
    const renewed = await this.updateSearchIndexJob(vaultId, jobId, (job) =>
      renewLease(job, owner, now),
    );
    if (renewed === undefined) throw new Error("Search index lease renewal disappeared.");
    return renewed;
  }

  async releaseSearchIndexLease(
    vaultId: string,
    jobId: string,
    owner: string,
    state: SearchIndexWaitState,
    now: string,
  ): Promise<SearchIndexJobV1> {
    const released = await this.updateSearchIndexJob(vaultId, jobId, (job) =>
      releaseLease(job, owner, state, now),
    );
    if (released === undefined) throw new Error("Search index lease release disappeared.");
    return released;
  }

  async completeSearchIndexJob(
    vaultId: string,
    jobId: string,
    owner: string,
    now: string,
  ): Promise<SearchIndexJobV1> {
    const completed = await this.updateSearchIndexJob(vaultId, jobId, (job) =>
      completeJob(job, owner, now),
    );
    if (completed === undefined) throw new Error("Completed Search index Job disappeared.");
    return completed;
  }

  async failSearchIndexJob(
    vaultId: string,
    jobId: string,
    owner: string,
    errorId: string,
    now: string,
    retryAt?: string,
  ): Promise<SearchIndexJobV1> {
    const failed = await this.updateSearchIndexJob(vaultId, jobId, (job) =>
      failJob(job, owner, errorId, now, retryAt),
    );
    if (failed === undefined) throw new Error("Failed Search index Job disappeared.");
    return failed;
  }

  async failSearchIndexCapture(input: {
    readonly vaultId: string;
    readonly jobId: string;
    readonly bundleId: string;
    readonly owner: string;
    readonly stage: "Keyword" | "Semantic";
    readonly errorId: string;
    readonly now: string;
    readonly retryAt?: string;
  }): Promise<SearchIndexJobV1> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.searchIndexJobs, STORES.searchIndexCheckpoints],
      "readwrite",
    );
    try {
      const jobs = transaction.objectStore(STORES.searchIndexJobs);
      const checkpoints = transaction.objectStore(STORES.searchIndexCheckpoints);
      const job = decodeSearchIndexJob(
        await requestValue(jobs.get(vaultKey(input.vaultId, input.jobId))),
      );
      const checkpoint = decodeSearchIndexCheckpoint(
        await requestValue(
          checkpoints.get(checkpointKey(input.vaultId, input.jobId, input.bundleId)),
        ),
      );
      const expectedState =
        input.stage === "Keyword" ? checkpoint.keywordState : checkpoint.semanticState;
      if (expectedState !== "Pending")
        throw new DomainValidationError(
          "searchIndexCheckpoint",
          "is not pending at the failed stage",
        );
      const failedJob = failJob(
        { ...job, failedCaptures: job.failedCaptures + 1 },
        input.owner,
        input.errorId,
        input.now,
        input.retryAt,
      );
      const failedCheckpoint = decodeSearchIndexCheckpoint({
        ...checkpoint,
        keywordState: input.stage === "Keyword" ? "Failed" : checkpoint.keywordState,
        semanticState: input.stage === "Semantic" ? "Failed" : checkpoint.semanticState,
        attemptCount: checkpoint.attemptCount + 1,
        updatedAt: input.now,
        errorId: input.errorId,
      });
      jobs.put(failedJob, vaultKey(input.vaultId, input.jobId));
      checkpoints.put(failedCheckpoint, checkpointKey(input.vaultId, input.jobId, input.bundleId));
      await transactionDone(transaction);
      return failedJob;
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async loadSearchIndexCheckpoint(
    vaultId: string,
    jobId: string,
    bundleId: string,
  ): Promise<SearchIndexCheckpointV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchIndexCheckpoints, "readonly");
    const value = await requestValue(
      transaction
        .objectStore(STORES.searchIndexCheckpoints)
        .get(checkpointKey(vaultId, jobId, bundleId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const checkpoint = decodeSearchIndexCheckpoint(value);
    if (
      checkpoint.vaultId !== vaultId ||
      checkpoint.jobId !== jobId ||
      checkpoint.bundleId !== bundleId
    )
      throw new DomainValidationError("searchIndexCheckpoint", "does not match its storage key");
    return checkpoint;
  }

  async listSearchIndexCheckpoints(
    vaultId: string,
    jobId: string,
  ): Promise<readonly SearchIndexCheckpointV1[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchIndexCheckpoints, "readonly");
    const values = await requestValue(
      transaction
        .objectStore(STORES.searchIndexCheckpoints)
        .getAll(IDBKeyRange.bound([vaultId, jobId], [vaultId, jobId, []], false, true)),
    );
    await transactionDone(transaction);
    return values
      .map(decodeSearchIndexCheckpoint)
      .map((checkpoint) => {
        if (checkpoint.vaultId !== vaultId || checkpoint.jobId !== jobId)
          throw new DomainValidationError(
            "searchIndexCheckpoint",
            "does not match its storage range",
          );
        return checkpoint;
      })
      .sort((left, right) => left.bundleId.localeCompare(right.bundleId));
  }

  async commitKeywordCapture(input: CommitKeywordCaptureInput): Promise<void> {
    const { row } = input;
    const vaultId = row.document.vaultId;
    const bundleId = row.document.bundleId;
    const job = decodeSearchIndexJob(input.job);
    const checkpoint = decodeSearchIndexCheckpoint(input.checkpoint);
    const [statistics, previousRow, currentJob, currentCheckpoint] = await Promise.all([
      this.loadKeywordStatistics(input.keyring, vaultId),
      this.loadKeywordRow(input.keyring, vaultId, bundleId),
      this.loadSearchIndexJob(vaultId, job.jobId),
      this.loadSearchIndexCheckpoint(vaultId, job.jobId, bundleId),
    ]);
    if (
      statistics === undefined ||
      currentJob === undefined ||
      currentCheckpoint === undefined ||
      projectionGeneration(statistics) !== input.expectedProjectionGeneration
    )
      throw new DomainValidationError("searchCommit", "has a stale projection generation");
    const nextStatistics = applyKeywordStatisticsChange(statistics, previousRow, row);
    const completedIncrement = checkpoint.semanticState === "NotConfigured" ? 1 : 0;
    if (
      job.vaultId !== vaultId ||
      checkpoint.vaultId !== vaultId ||
      checkpoint.jobId !== job.jobId ||
      checkpoint.bundleId !== bundleId ||
      checkpoint.sourceRevision !== row.document.sourceRevision ||
      checkpoint.keywordState !== "Committed" ||
      currentCheckpoint.keywordState !== "Pending" ||
      job.projectionGeneration !== projectionGeneration(nextStatistics) ||
      job.completedCaptures !== currentJob.completedCaptures + completedIncrement ||
      job.failedCaptures !== currentJob.failedCaptures ||
      job.totalCaptures !== currentJob.totalCaptures
    )
      throw new DomainValidationError(
        "searchCommit",
        "does not match its Capture, Job, and checkpoint",
      );

    const lookupKey = await deriveSearchKeywordLookupKey(input.keyring, vaultId);
    const [previousEntries, nextEntries] = await Promise.all([
      previousRow === undefined ? [] : keywordPostingEntries(lookupKey, previousRow),
      keywordPostingEntries(lookupKey, row),
    ]);
    const entriesByMac = new Map(
      [...previousEntries, ...nextEntries].map((entry) => [entry.opaqueMac, entry]),
    );
    const opaqueMacs = [...entriesByMac.keys()].sort();
    const currentPostings = await this.loadKeywordPostings(input.keyring, vaultId, opaqueMacs);
    const currentPostingByMac = new Map(
      currentPostings.map((posting) => [posting.opaqueMac, posting]),
    );
    const previousMacs = new Set(previousEntries.map(({ opaqueMac }) => opaqueMac));
    for (const opaqueMac of opaqueMacs) {
      const posting = currentPostingByMac.get(opaqueMac);
      const expectedScope =
        previousRow?.document.status === "Active" ? posting?.Active : posting?.Deleted;
      if (previousMacs.has(opaqueMac) !== (expectedScope?.includes(bundleId) ?? false))
        throw new DomainValidationError(
          "searchCommit",
          "found a posting inconsistent with the previous Capture row",
        );
    }
    const nextMacs = new Set(nextEntries.map(({ opaqueMac }) => opaqueMac));
    const nextPostings = opaqueMacs.map((opaqueMac): SearchKeywordPostingPlaintext => {
      const existing = currentPostingByMac.get(opaqueMac);
      const entry = entriesByMac.get(opaqueMac);
      if (entry === undefined) throw new Error("Search posting entry disappeared.");
      const Active = (existing?.Active ?? []).filter((candidate) => candidate !== bundleId);
      const Deleted = (existing?.Deleted ?? []).filter((candidate) => candidate !== bundleId);
      if (nextMacs.has(opaqueMac)) {
        (row.document.status === "Active" ? Active : Deleted).push(bundleId);
      }
      Active.sort();
      Deleted.sort();
      return { namespace: entry.namespace, opaqueMac, Active, Deleted };
    });

    const [storedRow, storedStatistics, ...storedPostings] = await Promise.all([
      sealSearchProjectionRow({
        keyring: input.keyring,
        vaultId,
        rowId: bundleId,
        projectionType: "SearchKeyword-v1",
        sourceRevision: row.document.sourceRevision,
        plaintext: encodeKeywordMaterialization(row),
      }),
      sealSearchProjectionRow({
        keyring: input.keyring,
        vaultId,
        rowId: vaultId,
        projectionType: "SearchKeywordStatistics-v1",
        sourceRevision: projectionGeneration(nextStatistics),
        plaintext: encodeKeywordStatisticsMaterialization(nextStatistics),
      }),
      ...nextPostings.map(async (posting) =>
        posting.Active.length === 0 && posting.Deleted.length === 0
          ? undefined
          : sealSearchProjectionRow({
              keyring: input.keyring,
              vaultId,
              rowId: posting.opaqueMac,
              projectionType: "SearchKeywordPosting-v1",
              sourceRevision: await searchKeywordPostingRevision(posting),
              plaintext: encodeKeywordPostingMaterialization(posting),
            }),
      ),
    ]);
    const expectedPostingRevisions = new Map(
      await Promise.all(
        opaqueMacs.map(async (opaqueMac) => {
          const posting = currentPostingByMac.get(opaqueMac);
          return [
            opaqueMac,
            posting === undefined ? undefined : await searchKeywordPostingRevision(posting),
          ] as const;
        }),
      ),
    );
    await this.commitPreparedKeywordCapture({
      vaultId,
      bundleId,
      expectedRowRevision: previousRow?.document.sourceRevision,
      expectedStatisticsRevision: projectionGeneration(statistics),
      expectedPostingRevisions,
      opaqueMacs,
      storedRow,
      storedStatistics,
      storedPostings,
      currentJob,
      currentCheckpoint,
      job,
      checkpoint,
    });
  }

  async commitSemanticCapture(input: CommitSemanticCaptureInput): Promise<void> {
    const { capture, passages } = input;
    const job = decodeSearchIndexJob(input.job);
    const checkpoint = decodeSearchIndexCheckpoint(input.checkpoint);
    if (
      passages.bundleId !== capture.bundleId ||
      passages.sourceRevision !== capture.sourceRevision ||
      passages.providerIdentityHash !== capture.providerIdentityHash ||
      job.vaultId !== checkpoint.vaultId ||
      job.jobId !== checkpoint.jobId ||
      job.providerIdentityHash !== capture.providerIdentityHash ||
      job.stage !== "Semantic" ||
      checkpoint.bundleId !== capture.bundleId ||
      checkpoint.sourceRevision !== capture.sourceRevision ||
      checkpoint.keywordState !== "Committed" ||
      checkpoint.semanticState !== "Committed"
    )
      throw new DomainValidationError(
        "searchSemanticCommit",
        "does not match its Capture, provider, Job, and checkpoint",
      );
    const vaultId = job.vaultId;
    const bundleId = capture.bundleId;
    const [previousCapture, currentJob, currentCheckpoint, settings] = await Promise.all([
      this.loadSemanticCapture(input.keyring, vaultId, bundleId),
      this.loadSearchIndexJob(vaultId, job.jobId),
      this.loadSearchIndexCheckpoint(vaultId, job.jobId, bundleId),
      this.loadSearchSettings(input.keyring, vaultId),
    ]);
    if (
      currentJob === undefined ||
      currentCheckpoint === undefined ||
      settings === undefined ||
      settings.semantic === "Disabled" ||
      (await searchSettingsRevision(settings)) !== capture.providerIdentityHash ||
      currentCheckpoint.semanticState !== "Pending" ||
      currentJob.providerIdentityHash !== capture.providerIdentityHash ||
      job.completedCaptures !== currentJob.completedCaptures + 1 ||
      job.failedCaptures !== currentJob.failedCaptures ||
      job.totalCaptures !== currentJob.totalCaptures
    )
      throw new DomainValidationError(
        "searchSemanticCommit",
        "has stale Job or checkpoint progress",
      );
    const [storedCapture, storedPassages] = await Promise.all([
      sealSearchProjectionRow({
        keyring: input.keyring,
        vaultId,
        rowId: bundleId,
        projectionType: "SearchSemantic-v1",
        sourceRevision: capture.sourceRevision,
        plaintext: encodeSemanticCaptureMaterialization(capture),
      }),
      sealSearchProjectionRow({
        keyring: input.keyring,
        vaultId,
        rowId: bundleId,
        projectionType: "SearchSemanticPassages-v1",
        sourceRevision: passages.sourceRevision,
        plaintext: encodeSemanticPassagesMaterialization(passages),
      }),
    ]);
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.searchSemanticRows,
        STORES.searchSemanticPassages,
        STORES.searchIndexJobs,
        STORES.searchIndexCheckpoints,
      ],
      "readwrite",
    );
    try {
      const captures = transaction.objectStore(STORES.searchSemanticRows);
      const passageRows = transaction.objectStore(STORES.searchSemanticPassages);
      const jobs = transaction.objectStore(STORES.searchIndexJobs);
      const checkpoints = transaction.objectStore(STORES.searchIndexCheckpoints);
      const [storedPreviousCapture, storedPreviousPassages, storedJob, storedCheckpoint] =
        await Promise.all([
          requestValue(captures.get(vaultKey(vaultId, bundleId))),
          requestValue(passageRows.get(vaultKey(vaultId, bundleId))),
          requestValue(jobs.get(vaultKey(vaultId, job.jobId))),
          requestValue(checkpoints.get(checkpointKey(vaultId, job.jobId, bundleId))),
        ]);
      const previousRevision = previousCapture?.sourceRevision;
      if (
        envelopeRevision(storedPreviousCapture) !== previousRevision ||
        envelopeRevision(storedPreviousPassages) !== previousRevision ||
        !sameRecord(storedJob, currentJob) ||
        !sameRecord(storedCheckpoint, currentCheckpoint)
      )
        throw new DomainValidationError(
          "searchSemanticCommit",
          "lost an optimistic concurrency race",
        );
      captures.put(storedCapture, vaultKey(vaultId, bundleId));
      passageRows.put(storedPassages, vaultKey(vaultId, bundleId));
      jobs.put(job, vaultKey(vaultId, job.jobId));
      checkpoints.put(checkpoint, checkpointKey(vaultId, job.jobId, bundleId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  private async commitPreparedKeywordCapture(input: PreparedKeywordCommit): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.searchKeywordRows,
        STORES.searchKeywordStatistics,
        STORES.searchKeywordPostings,
        STORES.searchIndexJobs,
        STORES.searchIndexCheckpoints,
      ],
      "readwrite",
    );
    try {
      const rows = transaction.objectStore(STORES.searchKeywordRows);
      const statistics = transaction.objectStore(STORES.searchKeywordStatistics);
      const postings = transaction.objectStore(STORES.searchKeywordPostings);
      const jobs = transaction.objectStore(STORES.searchIndexJobs);
      const checkpoints = transaction.objectStore(STORES.searchIndexCheckpoints);
      const [currentRow, currentStatistics, currentJob, currentCheckpoint, currentPostings] =
        await Promise.all([
          requestValue(rows.get(vaultKey(input.vaultId, input.bundleId))),
          requestValue(statistics.get(vaultKey(input.vaultId, input.vaultId))),
          requestValue(jobs.get(vaultKey(input.vaultId, input.job.jobId))),
          requestValue(
            checkpoints.get(checkpointKey(input.vaultId, input.job.jobId, input.bundleId)),
          ),
          Promise.all(
            input.opaqueMacs.map((opaqueMac) =>
              requestValue(postings.get(vaultKey(input.vaultId, opaqueMac))),
            ),
          ),
        ]);
      const postingConflict = input.opaqueMacs.some(
        (opaqueMac, index) =>
          envelopeRevision(currentPostings[index]) !==
          input.expectedPostingRevisions.get(opaqueMac),
      );
      if (
        envelopeRevision(currentRow) !== input.expectedRowRevision ||
        envelopeRevision(currentStatistics) !== input.expectedStatisticsRevision ||
        !sameRecord(currentJob, input.currentJob) ||
        !sameRecord(currentCheckpoint, input.currentCheckpoint) ||
        postingConflict
      )
        throw new DomainValidationError("searchCommit", "lost an optimistic concurrency race");

      rows.put(input.storedRow, vaultKey(input.vaultId, input.bundleId));
      statistics.put(input.storedStatistics, vaultKey(input.vaultId, input.vaultId));
      for (let index = 0; index < input.opaqueMacs.length; index += 1) {
        const opaqueMac = input.opaqueMacs[index];
        if (opaqueMac === undefined) continue;
        const stored = input.storedPostings[index];
        if (stored === undefined) postings.delete(vaultKey(input.vaultId, opaqueMac));
        else postings.put(stored, vaultKey(input.vaultId, opaqueMac));
      }
      jobs.put(input.job, vaultKey(input.vaultId, input.job.jobId));
      checkpoints.put(
        input.checkpoint,
        checkpointKey(input.vaultId, input.job.jobId, input.bundleId),
      );
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  private async updateSearchIndexJob(
    vaultId: string,
    jobId: string,
    update: (job: SearchIndexJobV1) => SearchIndexJobV1 | undefined,
  ): Promise<SearchIndexJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.searchIndexJobs, "readwrite");
    try {
      const store = transaction.objectStore(STORES.searchIndexJobs);
      const value = await requestValue(store.get(vaultKey(vaultId, jobId)));
      if (value === undefined) throw new DomainValidationError("searchIndexJob", "does not exist");
      const current = decodeSearchIndexJob(value);
      if (current.vaultId !== vaultId || current.jobId !== jobId)
        throw new DomainValidationError("searchIndexJob", "does not match its storage key");
      const next = update(current);
      if (next !== undefined) store.put(next, vaultKey(vaultId, jobId));
      await transactionDone(transaction);
      return next;
    } catch (error) {
      abortTransaction(transaction);
      throw error;
    }
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }

  async deleteDatabase(): Promise<void> {
    await deleteIndexedDbDatabase(this.databaseName, await this.databasePromise);
  }
}

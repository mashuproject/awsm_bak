import { RUNTIME_ERROR_IDS } from "../../domain/contracts";
import { DomainValidationError } from "../../domain/errors";
import type {
  SearchIndexCheckpointV1,
  SearchIndexJobState,
  SearchIndexJobV1,
} from "../../drivers/indexeddb/schema";
import type {
  CommitKeywordCaptureInput,
  CommitSemanticCaptureInput,
  IndexedDbSearchRepository,
} from "../../drivers/indexeddb/search-repository";
import type { VaultKeyring } from "../vault/keyring";
import type { EmbeddingProvider } from "./contracts";
import {
  indexingWaitState,
  type SearchIndexingGate,
  type SearchIndexWaitState,
} from "./index-lifecycle";
import type { KeywordRow } from "./keyword";
import {
  buildSemanticMaterializations,
  type PassageEmbedding,
  providerIdentityHash,
} from "./semantic";
import { projectionGeneration } from "./statistics";

export interface SearchKeywordIndexRepository {
  claimSearchIndexLease(
    vaultId: string,
    jobId: string,
    owner: string,
    now: string,
  ): Promise<SearchIndexJobV1 | undefined>;
  renewSearchIndexLease(
    vaultId: string,
    jobId: string,
    owner: string,
    now: string,
  ): Promise<SearchIndexJobV1>;
  releaseSearchIndexLease(
    vaultId: string,
    jobId: string,
    owner: string,
    state: SearchIndexWaitState,
    now: string,
  ): Promise<SearchIndexJobV1>;
  completeSearchIndexJob(
    vaultId: string,
    jobId: string,
    owner: string,
    now: string,
  ): Promise<SearchIndexJobV1>;
  failSearchIndexCapture?(input: {
    readonly vaultId: string;
    readonly jobId: string;
    readonly bundleId: string;
    readonly owner: string;
    readonly stage: "Keyword" | "Semantic";
    readonly errorId: string;
    readonly now: string;
    readonly retryAt?: string;
  }): Promise<SearchIndexJobV1>;
  listSearchIndexCheckpoints(
    vaultId: string,
    jobId: string,
  ): Promise<readonly SearchIndexCheckpointV1[]>;
  loadSearchIndexCheckpoint(
    vaultId: string,
    jobId: string,
    bundleId: string,
  ): Promise<SearchIndexCheckpointV1 | undefined>;
  loadKeywordStatistics(
    keyring: VaultKeyring,
    vaultId: string,
  ): ReturnType<IndexedDbSearchRepository["loadKeywordStatistics"]>;
  loadSearchIndexJob(vaultId: string, jobId: string): Promise<SearchIndexJobV1 | undefined>;
  commitKeywordCapture(input: CommitKeywordCaptureInput): Promise<void>;
  commitSemanticCapture(input: CommitSemanticCaptureInput): Promise<void>;
}

export interface SearchKeywordRowSource {
  loadKeywordRow(vaultId: string, bundleId: string, signal: AbortSignal): Promise<KeywordRow>;
}

export interface SearchKeywordIndexerDependencies {
  readonly repository: SearchKeywordIndexRepository;
  readonly source: SearchKeywordRowSource;
  readonly gate: () => Promise<SearchIndexingGate>;
  readonly now: () => string;
  readonly onCommitted: () => Promise<void>;
  readonly embeddingProvider?: EmbeddingProvider;
}

export interface RunSearchKeywordIndexerInput {
  readonly vaultId: string;
  readonly jobId: string;
  readonly owner: string;
  readonly keyring: VaultKeyring;
  readonly signal: AbortSignal;
}

export interface SearchKeywordIndexerResult {
  readonly state: SearchIndexJobState | "Contended";
  readonly completedCaptures: number;
  readonly totalCaptures: number;
}

function elapsedMilliseconds(left: string, right: string): number {
  return new Date(right).valueOf() - new Date(left).valueOf();
}

function semanticFailureId(error: unknown): string {
  const candidate =
    typeof error === "object" && error !== null && "id" in error ? error.id : undefined;
  return typeof candidate === "string" &&
    (RUNTIME_ERROR_IDS as readonly string[]).includes(candidate)
    ? candidate
    : "SEARCH_PROVIDER_RESPONSE_INVALID";
}

export class SearchKeywordIndexer {
  constructor(private readonly dependencies: SearchKeywordIndexerDependencies) {}

  async run(input: RunSearchKeywordIndexerInput): Promise<SearchKeywordIndexerResult> {
    input.signal.throwIfAborted();
    let job = await this.dependencies.repository.claimSearchIndexLease(
      input.vaultId,
      input.jobId,
      input.owner,
      this.dependencies.now(),
    );
    if (job === undefined) {
      return { state: "Contended", completedCaptures: 0, totalCaptures: 0 };
    }
    let leaseRenewedAt = job.updatedAt;
    const initialWait = indexingWaitState(await this.dependencies.gate());
    if (initialWait !== undefined) {
      job = await this.wait(input, initialWait);
      return this.result(job);
    }

    const checkpoints = (
      await this.dependencies.repository.listSearchIndexCheckpoints(input.vaultId, input.jobId)
    ).toSorted((left, right) => left.bundleId.localeCompare(right.bundleId));
    for (const checkpoint of checkpoints) {
      if (checkpoint.keywordState === "Committed") continue;
      if (checkpoint.keywordState !== "Pending")
        throw new DomainValidationError(
          "searchIndexCheckpoint",
          "cannot resume a failed keyword checkpoint",
        );
      input.signal.throwIfAborted();
      const beforeLoadWait = indexingWaitState(await this.dependencies.gate());
      if (beforeLoadWait !== undefined) {
        job = await this.wait(input, beforeLoadWait);
        return this.result(job);
      }
      const beforeLoad = this.dependencies.now();
      if (elapsedMilliseconds(leaseRenewedAt, beforeLoad) >= 10_000) {
        job = await this.dependencies.repository.renewSearchIndexLease(
          input.vaultId,
          input.jobId,
          input.owner,
          beforeLoad,
        );
        leaseRenewedAt = beforeLoad;
      }
      const row = await this.dependencies.source.loadKeywordRow(
        input.vaultId,
        checkpoint.bundleId,
        input.signal,
      );
      if (
        row.document.vaultId !== input.vaultId ||
        row.document.bundleId !== checkpoint.bundleId ||
        row.document.sourceRevision !== checkpoint.sourceRevision
      )
        throw new DomainValidationError(
          "searchIndexSource",
          "does not match its durable checkpoint",
        );
      input.signal.throwIfAborted();
      const beforeCommitWait = indexingWaitState(await this.dependencies.gate());
      if (beforeCommitWait !== undefined) {
        job = await this.wait(input, beforeCommitWait);
        return this.result(job);
      }
      const [statistics, currentJob] = await Promise.all([
        this.dependencies.repository.loadKeywordStatistics(input.keyring, input.vaultId),
        this.dependencies.repository.loadSearchIndexJob(input.vaultId, input.jobId),
      ]);
      if (
        statistics === undefined ||
        currentJob === undefined ||
        currentJob.state !== "Running" ||
        currentJob.leaseOwner !== input.owner
      )
        throw new DomainValidationError("searchIndexer", "lost its durable generation or lease");
      const committedAt = this.dependencies.now();
      if (
        currentJob.leaseExpiresAt === undefined ||
        currentJob.leaseExpiresAt <= committedAt ||
        elapsedMilliseconds(leaseRenewedAt, committedAt) >= 10_000
      ) {
        job = await this.dependencies.repository.renewSearchIndexLease(
          input.vaultId,
          input.jobId,
          input.owner,
          committedAt,
        );
        leaseRenewedAt = committedAt;
      } else {
        job = currentJob;
      }
      const nextProjectionGeneration = `${statistics.generationId}:${statistics.revision + 1}`;
      const completedIncrement = checkpoint.semanticState === "NotConfigured" ? 1 : 0;
      await this.dependencies.repository.commitKeywordCapture({
        keyring: input.keyring,
        row,
        expectedProjectionGeneration: projectionGeneration(statistics),
        job: {
          ...job,
          projectionGeneration: nextProjectionGeneration,
          completedCaptures: job.completedCaptures + completedIncrement,
          updatedAt: committedAt,
        },
        checkpoint: {
          ...checkpoint,
          keywordState: "Committed",
          attemptCount: checkpoint.attemptCount + 1,
          updatedAt: committedAt,
        },
      });
      job = {
        ...job,
        projectionGeneration: nextProjectionGeneration,
        completedCaptures: job.completedCaptures + completedIncrement,
        updatedAt: committedAt,
      };
      await this.dependencies.onCommitted();
    }
    if (checkpoints.some(({ semanticState }) => semanticState === "Pending")) {
      const provider = this.dependencies.embeddingProvider;
      if (provider === undefined)
        throw new DomainValidationError(
          "searchIndexer.provider",
          "is required by semantic checkpoints",
        );
      const identityHash = await providerIdentityHash(provider.identity);
      if (job.providerIdentityHash !== identityHash)
        throw new DomainValidationError(
          "searchIndexer.provider",
          "does not match the durable provider identity",
        );
      for (const initialCheckpoint of checkpoints) {
        const checkpoint = await this.dependencies.repository.loadSearchIndexCheckpoint(
          input.vaultId,
          input.jobId,
          initialCheckpoint.bundleId,
        );
        if (checkpoint?.semanticState !== "Pending") continue;
        const wait = indexingWaitState(await this.dependencies.gate());
        if (wait !== undefined) {
          job = await this.wait(input, wait);
          return this.result(job);
        }
        const row = await this.dependencies.source.loadKeywordRow(
          input.vaultId,
          checkpoint.bundleId,
          input.signal,
        );
        const vectors: PassageEmbedding[] = [];
        const encoder = new TextEncoder();
        for (let offset = 0; offset < row.document.passages.length; ) {
          input.signal.throwIfAborted();
          const passages = [];
          let inputBytes = 0;
          while (
            offset < row.document.passages.length &&
            passages.length < provider.maximumBatchItems
          ) {
            const passage = row.document.passages[offset];
            if (passage === undefined) break;
            const passageBytes = encoder.encode(passage.text).byteLength;
            if (passages.length > 0 && inputBytes + passageBytes > provider.maximumInputBytes)
              break;
            if (passageBytes > provider.maximumInputBytes)
              throw new DomainValidationError(
                "searchIndexer.passage",
                "exceeds the provider input limit",
              );
            passages.push(passage);
            inputBytes += passageBytes;
            offset += 1;
          }
          if (passages.length === 0)
            throw new DomainValidationError(
              "searchIndexer.provider",
              "cannot accept a Search passage",
            );
          const timeout = AbortSignal.timeout(60_000);
          let embedded: readonly Float32Array[];
          try {
            embedded = await provider.embed({
              purpose: "Document",
              texts: passages.map(({ text }) => text),
              signal: AbortSignal.any([input.signal, timeout]),
            });
          } catch (error) {
            input.signal.throwIfAborted();
            const classifiedErrorId = semanticFailureId(error);
            const errorId =
              classifiedErrorId === "SEARCH_PROVIDER_RESPONSE_INVALID"
                ? "SEARCH_PROVIDER_UNAVAILABLE"
                : classifiedErrorId;
            await this.failSemanticCapture(input, checkpoint, errorId);
            throw error;
          }
          try {
            if (embedded.length !== passages.length)
              throw new DomainValidationError(
                "searchIndexer.provider",
                "returned the wrong number of passage embeddings",
              );
            for (let index = 0; index < passages.length; index += 1) {
              const passage = passages[index];
              const vector = embedded[index];
              if (passage === undefined || vector === undefined)
                throw new DomainValidationError(
                  "searchIndexer.provider",
                  "returned no passage embedding",
                );
              vectors.push({
                passageId: passage.passageId,
                passageOrdinal: passage.ordinal,
                vector,
              });
            }
          } catch (error) {
            input.signal.throwIfAborted();
            await this.failSemanticCapture(input, checkpoint, semanticFailureId(error));
            throw error;
          }
        }
        try {
          const materializations = buildSemanticMaterializations({
            document: row.document,
            providerIdentityHash: identityHash,
            embeddings: vectors,
          });
          const currentJob = await this.dependencies.repository.loadSearchIndexJob(
            input.vaultId,
            input.jobId,
          );
          if (
            currentJob === undefined ||
            currentJob.state !== "Running" ||
            currentJob.leaseOwner !== input.owner
          )
            throw new DomainValidationError("searchIndexer", "lost its semantic indexing lease");
          const committedAt = this.dependencies.now();
          job = {
            ...currentJob,
            stage: "Semantic",
            completedCaptures: currentJob.completedCaptures + 1,
            updatedAt: committedAt,
          };
          await this.dependencies.repository.commitSemanticCapture({
            keyring: input.keyring,
            ...materializations,
            job,
            checkpoint: {
              ...checkpoint,
              semanticState: "Committed",
              attemptCount: checkpoint.attemptCount + 1,
              updatedAt: committedAt,
            },
          });
        } catch (error) {
          input.signal.throwIfAborted();
          if (
            error instanceof DomainValidationError &&
            error.message.includes("lost its semantic indexing lease")
          )
            throw error;
          await this.failSemanticCapture(input, checkpoint, semanticFailureId(error));
          throw error;
        }
        await this.dependencies.onCommitted();
      }
    }
    job = await this.dependencies.repository.completeSearchIndexJob(
      input.vaultId,
      input.jobId,
      input.owner,
      this.dependencies.now(),
    );
    return this.result(job);
  }

  private async failSemanticCapture(
    input: RunSearchKeywordIndexerInput,
    checkpoint: SearchIndexCheckpointV1,
    errorId: string,
  ): Promise<void> {
    const failedAt = this.dependencies.now();
    const retryAt =
      errorId === "SEARCH_PROVIDER_UNAVAILABLE"
        ? new Date(new Date(failedAt).valueOf() + 300_000).toISOString()
        : undefined;
    await this.dependencies.repository.failSearchIndexCapture?.({
      vaultId: input.vaultId,
      jobId: input.jobId,
      bundleId: checkpoint.bundleId,
      owner: input.owner,
      stage: "Semantic",
      errorId,
      now: failedAt,
      ...(retryAt === undefined ? {} : { retryAt }),
    });
  }

  private async wait(
    input: RunSearchKeywordIndexerInput,
    state: SearchIndexWaitState,
  ): Promise<SearchIndexJobV1> {
    return this.dependencies.repository.releaseSearchIndexLease(
      input.vaultId,
      input.jobId,
      input.owner,
      state,
      this.dependencies.now(),
    );
  }

  private result(job: SearchIndexJobV1): SearchKeywordIndexerResult {
    return {
      state: job.state,
      completedCaptures: job.completedCaptures,
      totalCaptures: job.totalCaptures,
    };
  }
}

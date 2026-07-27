import type { SearchIndexCheckpointV1, SearchIndexJobV1 } from "../../drivers/indexeddb/schema";
import type {
  BeginKeywordGenerationInput,
  IndexedDbSearchRepository,
} from "../../drivers/indexeddb/search-repository";
import type { VaultKeyring } from "../vault/keyring";
import type { DiscoveredSearchCapture } from "./library-source";
import { createKeywordStatistics } from "./statistics";

export interface SearchDiscoveryRepository {
  latestSearchIndexJob(vaultId: string): Promise<SearchIndexJobV1 | undefined>;
  beginKeywordGeneration(input: BeginKeywordGenerationInput): Promise<void>;
  listSearchIndexCheckpoints(
    vaultId: string,
    jobId: string,
  ): Promise<readonly SearchIndexCheckpointV1[]>;
  appendSearchIndexCheckpoint(
    vaultId: string,
    jobId: string,
    checkpoint: SearchIndexCheckpointV1,
    now: string,
  ): Promise<SearchIndexJobV1>;
  finishSearchIndexDiscovery(
    vaultId: string,
    jobId: string,
    now: string,
  ): Promise<SearchIndexJobV1>;
}

export interface SearchDiscoverySource {
  discover(signal: AbortSignal, skip?: ReadonlySet<string>): AsyncIterable<DiscoveredSearchCapture>;
}

interface SearchIndexDiscoveryDependencies {
  readonly repository: SearchDiscoveryRepository;
  readonly source: SearchDiscoverySource;
  readonly now: () => string;
  readonly uuid: () => string;
}

export interface RunSearchIndexDiscoveryInput {
  readonly vaultId: string;
  readonly keyring: VaultKeyring;
  readonly providerIdentityHash?: string;
  readonly force: boolean;
  readonly signal: AbortSignal;
}

export class SearchIndexDiscovery {
  constructor(private readonly dependencies: SearchIndexDiscoveryDependencies) {}

  async run(input: RunSearchIndexDiscoveryInput): Promise<SearchIndexJobV1> {
    input.signal.throwIfAborted();
    let job = input.force
      ? undefined
      : await this.dependencies.repository.latestSearchIndexJob(input.vaultId);
    if (job === undefined) {
      const createdAt = this.dependencies.now();
      const jobId = this.dependencies.uuid();
      const generationId = this.dependencies.uuid();
      const statistics = createKeywordStatistics(generationId);
      job = {
        version: 1,
        jobId,
        vaultId: input.vaultId,
        state: "Created",
        stage: "Discover",
        projectionGeneration: `${generationId}:0`,
        ...(input.providerIdentityHash === undefined
          ? {}
          : { providerIdentityHash: input.providerIdentityHash }),
        completedCaptures: 0,
        totalCaptures: 0,
        failedCaptures: 0,
        createdAt,
        updatedAt: createdAt,
      };
      await this.dependencies.repository.beginKeywordGeneration({
        keyring: input.keyring,
        vaultId: input.vaultId,
        statistics,
        job,
      });
    }
    if (job.stage !== "Discover") return job;

    const existing = await this.dependencies.repository.listSearchIndexCheckpoints(
      input.vaultId,
      job.jobId,
    );
    const skip = new Set(existing.map(({ bundleId }) => bundleId));
    for await (const capture of this.dependencies.source.discover(input.signal, skip)) {
      input.signal.throwIfAborted();
      const now = this.dependencies.now();
      job = await this.dependencies.repository.appendSearchIndexCheckpoint(
        input.vaultId,
        job.jobId,
        {
          version: 1,
          vaultId: input.vaultId,
          jobId: job.jobId,
          bundleId: capture.bundleId,
          sourceRevision: capture.sourceRevision,
          keywordState: "Pending",
          semanticState: input.providerIdentityHash === undefined ? "NotConfigured" : "Pending",
          attemptCount: 0,
          updatedAt: now,
        },
        now,
      );
    }
    return this.dependencies.repository.finishSearchIndexDiscovery(
      input.vaultId,
      job.jobId,
      this.dependencies.now(),
    );
  }
}

export type SearchDiscoveryIndexedDbRepository = Pick<
  IndexedDbSearchRepository,
  | "latestSearchIndexJob"
  | "beginKeywordGeneration"
  | "listSearchIndexCheckpoints"
  | "appendSearchIndexCheckpoint"
  | "finishSearchIndexDiscovery"
>;

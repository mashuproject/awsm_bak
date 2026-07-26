import type {
  StoredAccountVaultV1,
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  SynchronizationJobV1,
} from "../../drivers/indexeddb/schema";
import type { AtomicStaleDiscard } from "../../drivers/indexeddb/workspace-repository";
import type { ArtifactStore } from "../artifact";
import { LibraryProjectionRebuilder } from "../library/rebuild";
import type { VaultRecordsV1 } from "../vault";
import { encryptWorkspaceVaultName } from "../vault";
import type { VaultKeyring } from "../vault/keyring";
import { type RemoteReplicaDownloader, verifyPreparedRemoteReplica } from "./download";

interface DiscardAccountStore {
  latestSynchronizationJob(): Promise<SynchronizationJobV1 | undefined>;
  loadAccountVault(): Promise<StoredAccountVaultV1 | undefined>;
  saveSynchronizationJob(job: SynchronizationJobV1): Promise<void>;
}

interface DiscardSource {
  listStoredEvents(): Promise<readonly StoredEvent[]>;
  listStoredObjects(): Promise<readonly StoredObjectV1[]>;
  getVaultGeneration(generationId: string): Promise<StoredVaultGenerationV1 | undefined>;
}

interface DiscardWorkspace {
  load(): Promise<
    | {
        readonly metadata: { readonly workspaceId: string };
        readonly nameCacheKey: CryptoKey;
      }
    | undefined
  >;
  commitStaleDiscard(input: AtomicStaleDiscard): Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

export interface StaleDiscardFaults {
  prepareServerReplacement(): Promise<void>;
  serverReplacementPrepared(): Promise<void>;
  beforeActivation(): Promise<void>;
  afterActivation(): Promise<void>;
}

const noStaleDiscardFaults: StaleDiscardFaults = {
  prepareServerReplacement: () => Promise.resolve(),
  serverReplacementPrepared: () => Promise.resolve(),
  beforeActivation: () => Promise.resolve(),
  afterActivation: () => Promise.resolve(),
};

export class StaleReplicaDiscardService {
  constructor(
    private readonly accounts: DiscardAccountStore,
    private readonly workspace: DiscardWorkspace,
    private readonly source: DiscardSource,
    private readonly originalRecords: VaultRecordsV1,
    private readonly originalKeyring: VaultKeyring,
    private readonly downloader: Pick<RemoteReplicaDownloader, "prepare">,
    private readonly artifacts: ArtifactStore,
    private readonly faults: StaleDiscardFaults = noStaleDiscardFaults,
  ) {}

  async execute(now = new Date().toISOString()): Promise<void> {
    const conflictJob = await this.accounts.latestSynchronizationJob();
    const registration = await this.accounts.loadAccountVault();
    const staleGenerationId = this.originalRecords.head.generationId;
    if (
      conflictJob?.state !== "Conflict" ||
      conflictJob.vaultId !== this.originalRecords.metadata.vaultId ||
      conflictJob.generationId === undefined ||
      conflictJob.generationNumber === undefined ||
      registration?.vaultId !== conflictJob.vaultId ||
      registration.remoteGenerationId !== conflictJob.generationId
    )
      throw integrity("Stale Replica discard context is unavailable");
    const vaultId = conflictJob.vaultId;
    let job: SynchronizationJobV1 = {
      ...conflictJob,
      state: "Running",
      stage: "PrepareServerReplacement",
      updatedAt: now,
    };
    await this.accounts.saveSynchronizationJob(job);
    await this.faults.prepareServerReplacement();
    let preparedArtifactIds: readonly string[] = [];
    let committed = false;
    try {
      const [events, objects, generation] = await Promise.all([
        this.source.listStoredEvents(),
        this.source.listStoredObjects(),
        this.source.getVaultGeneration(staleGenerationId),
      ]);
      if (generation === undefined) throw integrity("Stale Generation is unavailable");
      const prepared = await this.downloader.prepare(
        { ...job, stage: "DownloadRecords" },
        this.originalKeyring,
        { generation, events, objects },
        undefined,
        async (objectId) => {
          preparedArtifactIds = [...preparedArtifactIds, objectId].toSorted();
          job = { ...job, preparedArtifactObjectIds: preparedArtifactIds, updatedAt: now };
          await this.accounts.saveSynchronizationJob(job);
        },
      );
      preparedArtifactIds = prepared.preparedArtifactObjectIds;
      job = { ...job, preparedArtifactObjectIds: preparedArtifactIds, updatedAt: now };
      await this.accounts.saveSynchronizationJob(job);
      await this.faults.serverReplacementPrepared();
      const remote = await verifyPreparedRemoteReplica({
        vaultId,
        prepared,
        keyring: this.originalKeyring,
        artifacts: this.artifacts,
      });
      const remoteObjects = new Map(remote.objects.map((object) => [object.objectId, object]));
      const projections = await new LibraryProjectionRebuilder(
        {
          listStoredEvents: () => Promise.resolve(remote.events),
          getStoredObject: (objectId) => Promise.resolve(remoteObjects.get(objectId)),
          replaceLibraryProjections: () => Promise.resolve(),
        },
        this.originalKeyring,
        vaultId,
        this.artifacts,
      ).prepare(new AbortController().signal);
      const workspace = await this.workspace.load();
      if (workspace === undefined) throw integrity("Workspace is unavailable");
      const remoteNameCache = await encryptWorkspaceVaultName({
        key: workspace.nameCacheKey,
        workspaceId: workspace.metadata.workspaceId,
        vaultId,
        sourceEventId: projections.vaultNameProjection.sourceEventId,
        name: remote.currentVaultName,
      });
      job = { ...job, stage: "ActivateServerReplacement", updatedAt: now };
      await this.accounts.saveSynchronizationJob(job);
      await this.faults.beforeActivation();
      await this.workspace.commitStaleDiscard({
        job,
        expectedStaleGenerationId: staleGenerationId,
        registration,
        originalRecords: this.originalRecords,
        remoteGeneration: remote.generation,
        remoteHead: remote.head,
        remoteEvents: remote.events,
        remoteObjects: remote.objects,
        remoteLibraryProjections: projections.itemProjections,
        remoteCollectionProjection: projections.collectionProjection,
        remoteVaultNameProjection: projections.vaultNameProjection,
        remoteNameCache,
      });
      committed = true;
      await this.faults.afterActivation();
      await this.artifacts
        .reconcile(
          vaultId,
          new Set(
            remote.objects
              .filter((object) => object.objectType === "Artifact")
              .map((object) => object.objectId),
          ),
        )
        .catch(() => undefined);
    } catch (error) {
      if (!committed) {
        const { preparedArtifactObjectIds: _preparedArtifactObjectIds, ...retryable } = job;
        await this.accounts.saveSynchronizationJob({
          ...retryable,
          state: "Conflict",
          stage: "Checkpoint",
          updatedAt: new Date().toISOString(),
        });
      }
      throw error;
    } finally {
      if (!committed)
        await Promise.all(
          preparedArtifactIds.map((objectId) =>
            this.artifacts.remove(vaultId, objectId).catch(() => undefined),
          ),
        );
    }
  }
}

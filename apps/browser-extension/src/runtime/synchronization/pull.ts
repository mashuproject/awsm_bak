import type {
  StoredAccountVaultV1,
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
  SynchronizationJobV1,
} from "../../drivers/indexeddb/schema";
import type { AtomicRemoteReconciliation } from "../../drivers/indexeddb/workspace-repository";
import type { ArtifactStore } from "../artifact";
import { noRuntimeFaultCheckpoint, type RuntimeFaultCheckpoint } from "../fault-checkpoint";
import { LibraryProjectionRebuilder } from "../library/rebuild";
import { encryptWorkspaceVaultName } from "../vault";
import type { VaultKeyring } from "../vault/keyring";
import { type RemoteReplicaDownloader, verifyPreparedRemoteReplica } from "./download";
import { openPullArtifact } from "./pull-artifact";

interface PullAccountStore {
  latestSynchronizationJob(): Promise<SynchronizationJobV1 | undefined>;
  loadAccountVault(): Promise<StoredAccountVaultV1 | undefined>;
}

interface PullSource {
  listStoredEvents(): Promise<readonly StoredEvent[]>;
  listStoredObjects(): Promise<readonly StoredObjectV1[]>;
  getVaultGeneration(generationId: string): Promise<StoredVaultGenerationV1 | undefined>;
  getVaultHead(): Promise<StoredVaultHeadV1 | undefined>;
}

interface PullWorkspaceStore {
  load(): Promise<
    | {
        readonly metadata: { readonly workspaceId: string };
        readonly nameCacheKey: CryptoKey;
      }
    | undefined
  >;
  commitRemoteReconciliation(input: AtomicRemoteReconciliation): Promise<void>;
}

interface PullTransport {
  request(
    method: string,
    path: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

interface PullArtifactAvailability {
  isArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<boolean>;
}

interface PullRemoteArtifacts {
  openEncrypted(input: {
    readonly vaultId: string;
    readonly object: import("../../drivers/indexeddb/schema").StoredArtifactObjectV1;
    readonly generationId: string;
  }): Promise<ReadableStream<Uint8Array>>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw integrity("Change page is invalid");
  return value as Record<string, unknown>;
}

function cursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw integrity("Change cursor is invalid");
  return value;
}

export class IncrementalPullRunner {
  constructor(
    private readonly accounts: PullAccountStore,
    private readonly source: PullSource,
    private readonly workspace: PullWorkspaceStore,
    private readonly artifacts: ArtifactStore,
    private readonly transport: PullTransport,
    private readonly downloader: Pick<RemoteReplicaDownloader, "prepare">,
    private readonly faultCheckpoint: RuntimeFaultCheckpoint = noRuntimeFaultCheckpoint,
    private readonly signal?: AbortSignal,
    private readonly availability?: PullArtifactAvailability,
    private readonly remoteArtifacts?: PullRemoteArtifacts,
  ) {}

  async run(keyring: VaultKeyring, now = new Date().toISOString()): Promise<boolean> {
    const job = await this.accounts.latestSynchronizationJob();
    const registration = await this.accounts.loadAccountVault();
    if (
      job?.stage !== "FetchChanges" ||
      job.vaultId === undefined ||
      job.generationId === undefined ||
      job.generationNumber === undefined ||
      registration === undefined
    )
      return false;
    if (
      registration.vaultId !== job.vaultId ||
      registration.remoteGenerationId !== job.generationId ||
      registration.remoteGenerationNumber !== job.generationNumber
    )
      throw integrity("Pull Account/Vault context differs");
    const scopedVaultId = job.vaultId;
    const scopedGenerationId = job.generationId;
    const snapshotCursor = await this.fetchChangeFence(
      job.vaultId,
      job.generationId,
      registration.deliveryCursor,
    );
    const [generation, localHead, events, objects] = await Promise.all([
      this.source.getVaultGeneration(job.generationId),
      this.source.getVaultHead(),
      this.source.listStoredEvents(),
      this.source.listStoredObjects(),
    ]);
    if (generation === undefined || localHead === undefined)
      throw integrity("Local Generation authority is unavailable");
    const prepared = await this.downloader.prepare(
      { ...job, state: "Running", stage: "DownloadRecords", updatedAt: now },
      keyring,
      { generation, events, objects },
    );
    let committed = false;
    try {
      const verified = await verifyPreparedRemoteReplica({
        vaultId: scopedVaultId,
        prepared,
        keyring,
        artifacts: this.artifacts,
        ...(this.availability === undefined || this.remoteArtifacts === undefined
          ? {}
          : {
              openArtifact: this.pullArtifactOpener(
                scopedVaultId,
                scopedGenerationId,
                this.availability,
                this.remoteArtifacts,
              ),
            }),
      });
      const allObjects = new Map(verified.objects.map((entry) => [entry.objectId, entry]));
      const projections = await new LibraryProjectionRebuilder(
        {
          listStoredEvents: () => Promise.resolve(verified.events),
          getStoredObject: (objectId) => Promise.resolve(allObjects.get(objectId)),
          replaceLibraryProjections: () => Promise.resolve(),
        },
        keyring,
        job.vaultId,
        this.artifacts,
      ).prepare(new AbortController().signal);
      const workspace = await this.workspace.load();
      if (workspace === undefined) throw integrity("Workspace is unavailable");
      const nameCache = await encryptWorkspaceVaultName({
        key: workspace.nameCacheKey,
        workspaceId: workspace.metadata.workspaceId,
        vaultId: job.vaultId,
        sourceEventId: projections.vaultNameProjection.sourceEventId,
        name: verified.currentVaultName,
      });
      await this.faultCheckpoint.reach("synchronization:before-reconciliation-commit", this.signal);
      await this.workspace.commitRemoteReconciliation({
        expectedGenerationId: job.generationId,
        expectedDeliveryCursor: registration.deliveryCursor,
        expectedLocalHead: localHead,
        registration: { ...registration, deliveryCursor: snapshotCursor },
        job: { ...job, snapshotCursor, updatedAt: now },
        head: verified.head,
        events: verified.events,
        objects: verified.objects,
        libraryProjections: projections.itemProjections,
        collectionProjection: projections.collectionProjection,
        vaultNameProjection: projections.vaultNameProjection,
        nameCache,
        installedArtifactObjectIds: prepared.preparedArtifactObjectIds,
      });
      committed = true;
      return true;
    } finally {
      if (!committed)
        await Promise.all(
          prepared.preparedArtifactObjectIds.map((objectId) =>
            this.artifacts.remove(job.vaultId as string, objectId).catch(() => undefined),
          ),
        );
    }
  }

  private pullArtifactOpener(
    vaultId: string,
    generationId: string,
    availability: PullArtifactAvailability,
    remoteArtifacts: PullRemoteArtifacts,
  ): (
    object: import("../../drivers/indexeddb/schema").StoredArtifactObjectV1,
  ) => Promise<ReadableStream<Uint8Array>> {
    return (object) =>
      openPullArtifact({ vaultId, object, generationId }, availability, {
        local: (value) => this.artifacts.openEncrypted(value.vaultId, value.object.objectId),
        remote: (value) => remoteArtifacts.openEncrypted(value),
      });
  }

  private async fetchChangeFence(
    vaultId: string,
    generationId: string,
    after: number,
  ): Promise<number> {
    let next = after;
    let snapshot: number | undefined;
    for (;;) {
      const response = object(
        (
          await this.transport.request(
            "GET",
            `/api/vaults/${vaultId}/changes?after=${next}&limit=100&generationId=${generationId}${snapshot === undefined ? "" : `&snapshot=${snapshot}`}`,
          )
        ).body,
      );
      if (response.generationId !== generationId || !Array.isArray(response.changes))
        throw integrity("Change page Generation differs");
      const pageSnapshot = cursor(response.snapshotCursor);
      snapshot ??= pageSnapshot;
      if (pageSnapshot !== snapshot) throw integrity("Change snapshot changed between pages");
      let prior = next;
      for (const value of response.changes) {
        const change = object(value);
        const current = cursor(change.cursor);
        if (current <= prior || current > snapshot) throw integrity("Changes are not ordered");
        prior = current;
      }
      const reportedNext = cursor(response.nextCursor);
      if (reportedNext !== prior) throw integrity("Change page cursor differs");
      next = reportedNext;
      if (response.hasMore === false) return snapshot;
      if (response.hasMore !== true || response.changes.length === 0)
        throw integrity("Change page cannot advance");
    }
  }
}

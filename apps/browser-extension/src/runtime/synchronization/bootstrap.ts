import { wipe } from "../../crypto/sodium";
import type { LoadedDeviceAuthority } from "../../drivers/indexeddb/device-repository";
import type { StoredAccountVaultV1, SynchronizationJobV1 } from "../../drivers/indexeddb/schema";
import type { AtomicRemoteBootstrap } from "../../drivers/indexeddb/workspace-repository";
import type { ArtifactStore } from "../artifact";
import { prepareReplicaDeviceCredentials } from "../import/credentials";
import { LibraryProjectionRebuilder } from "../library/rebuild";
import { encryptWorkspaceVaultName } from "../vault";
import { importVaultKeyring } from "../vault/keyring";
import { type RemoteReplicaDownloader, verifyPreparedRemoteReplica } from "./download";

interface BootstrapAccountStore {
  latestSynchronizationJob(): Promise<SynchronizationJobV1 | undefined>;
  loadAccountVault(): Promise<StoredAccountVaultV1 | undefined>;
  saveSynchronizationJob(job: SynchronizationJobV1): Promise<void>;
}

interface BootstrapDeviceStore {
  loadDeviceAuthority(vaultId: string): Promise<LoadedDeviceAuthority | undefined>;
}

interface BootstrapWorkspaceStore {
  load(): Promise<
    | {
        readonly metadata: { readonly workspaceId: string };
        readonly nameCacheKey: CryptoKey;
      }
    | undefined
  >;
  commitRemoteBootstrap(input: AtomicRemoteBootstrap): Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

export class RemoteBootstrapRunner {
  constructor(
    private readonly accounts: BootstrapAccountStore,
    private readonly devices: BootstrapDeviceStore,
    private readonly workspace: BootstrapWorkspaceStore,
    private readonly artifacts: ArtifactStore,
    private readonly downloader: Pick<RemoteReplicaDownloader, "prepare">,
  ) {}

  async run(now = new Date().toISOString()): Promise<string | undefined> {
    let job = await this.accounts.latestSynchronizationJob();
    if (job?.stage !== "DownloadRecords" || job.vaultId === undefined) return undefined;
    const vaultId = job.vaultId;
    const registration = await this.accounts.loadAccountVault();
    if (
      registration === undefined ||
      registration.accountId !== job.accountId ||
      registration.vaultId !== job.vaultId ||
      registration.activeKeyEpochId === undefined
    )
      throw integrity("Remote bootstrap Account context changed");
    let rawRootKey: Uint8Array | undefined;
    let authority: LoadedDeviceAuthority | undefined;
    let preparedArtifactIds: readonly string[] = [];
    let committed = false;
    try {
      authority = await this.devices.loadDeviceAuthority(vaultId);
      const activeEpoch = authority?.keyEpochs.find(
        (epoch) => epoch.keyEpochId === registration.activeKeyEpochId,
      );
      if (
        authority === undefined ||
        authority.accountId !== job.accountId ||
        authority.vaultId !== vaultId ||
        activeEpoch === undefined
      )
        throw integrity("Remote bootstrap Device authority is unavailable");
      rawRootKey = activeEpoch.rootKey;
      const keyring = await importVaultKeyring(
        registration.activeKeyEpochId,
        authority.keyEpochs.map((epoch) => ({
          ...epoch,
          rootKey: Uint8Array.from(epoch.rootKey),
        })),
      );
      const prepared = await this.downloader.prepare(job, keyring);
      preparedArtifactIds = prepared.preparedArtifactObjectIds;
      const verified = await verifyPreparedRemoteReplica({
        vaultId: job.vaultId,
        prepared,
        keyring,
        artifacts: this.artifacts,
      });
      const records = await prepareReplicaDeviceCredentials({
        vaultId: job.vaultId,
        vaultCreatedAt: verified.vaultCreatedAt,
        generation: verified.generation,
        head: verified.head,
        rawRootKey,
        keyEpochId: activeEpoch.keyEpochId,
        deviceId: authority.identity.deviceId,
        manuallyLocked: false,
      });
      const objects = new Map(verified.objects.map((object) => [object.objectId, object]));
      const projections = await new LibraryProjectionRebuilder(
        {
          listStoredEvents: () => Promise.resolve(verified.events),
          getStoredObject: (objectId) => Promise.resolve(objects.get(objectId)),
          replaceLibraryProjections: () => Promise.resolve(),
        },
        keyring,
        job.vaultId,
        this.artifacts,
      ).prepare(new AbortController().signal);
      const workspace = await this.workspace.load();
      if (workspace === undefined) throw integrity("Workspace is not initialized");
      const nameCache = await encryptWorkspaceVaultName({
        key: workspace.nameCacheKey,
        workspaceId: workspace.metadata.workspaceId,
        vaultId: job.vaultId,
        sourceEventId: projections.vaultNameProjection.sourceEventId,
        name: verified.currentVaultName,
      });
      job = { ...job, state: "Running", stage: "ActivateLocal", updatedAt: now };
      await this.accounts.saveSynchronizationJob(job);
      await this.workspace.commitRemoteBootstrap({
        job,
        records,
        events: verified.events,
        objects: verified.objects,
        libraryProjections: projections.itemProjections,
        collectionProjection: projections.collectionProjection,
        vaultNameProjection: projections.vaultNameProjection,
        nameCache,
        preparedArtifactObjectIds: preparedArtifactIds,
      });
      committed = true;
      return job.vaultId;
    } finally {
      if (authority !== undefined)
        await Promise.all([
          wipe(authority.identity.signingSecretKey),
          wipe(authority.identity.wrappingSecretKey),
          ...authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
        ]);
      else if (rawRootKey !== undefined) await wipe(rawRootKey);
      if (!committed)
        await Promise.all(
          preparedArtifactIds.map((objectId) =>
            this.artifacts.remove(vaultId, objectId).catch(() => undefined),
          ),
        );
    }
  }
}

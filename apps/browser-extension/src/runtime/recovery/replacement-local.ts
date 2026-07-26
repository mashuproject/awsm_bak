import type {
  StoredEvent,
  StoredObjectV1,
  StoredVaultHeadV1,
  StoredVaultNameProjectionV1,
  VaultReplacementJobV1,
} from "../../drivers/indexeddb/schema";
import type { VaultRecordsV1 } from "../vault/contracts";
import { importVaultRootKey, VaultKeyring } from "../vault/keyring";
import { decryptVaultNameProjection } from "../vault/name-crypto";
import {
  encryptWorkspaceVaultName,
  type WorkspaceVaultNameCacheV1,
} from "../vault/workspace-name-cache";
import type { RestartedReplacementGraph } from "./replacement-runner";

interface ReplacementLocalWorkspace {
  load(): Promise<
    | {
        readonly metadata: {
          readonly workspaceId: string;
        };
        readonly nameCacheKey: CryptoKey;
      }
    | undefined
  >;
  hasStagedVaultReplacement(input: {
    readonly sourceVaultId: string;
    readonly targetVaultId: string;
    readonly jobId: string;
  }): Promise<boolean>;
}

interface ReplacementLocalVaults {
  load(vaultId: string): Promise<VaultRecordsV1 | undefined>;
}

interface ReplacementLocalSource {
  getVaultHead(): Promise<StoredVaultHeadV1 | undefined>;
  listStoredEvents(): Promise<readonly StoredEvent[]>;
  listStoredObjects(): Promise<readonly StoredObjectV1[]>;
  getVaultNameProjection(): Promise<StoredVaultNameProjectionV1 | undefined>;
  close(): void;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.join("\n") === right.join("\n");
}

export class VaultReplacementLocalState {
  constructor(
    private readonly workspace: ReplacementLocalWorkspace,
    private readonly vaults: ReplacementLocalVaults,
    private readonly source: (vaultId: string) => ReplacementLocalSource,
    private readonly accessToken: (vaultId: string) => Promise<string>,
  ) {}

  hasStagedVaultReplacement(input: {
    readonly sourceVaultId: string;
    readonly targetVaultId: string;
    readonly jobId: string;
  }): Promise<boolean> {
    return this.workspace.hasStagedVaultReplacement(input);
  }

  async loadStagedGraph(
    job: VaultReplacementJobV1,
    rootKey: Uint8Array,
  ): Promise<RestartedReplacementGraph> {
    const loaded = await this.loadTarget(job, rootKey);
    try {
      return {
        target: {
          records: loaded.records,
          keyring: loaded.keyring,
          name: loaded.name,
        },
        replacement: {
          generation: loaded.records.generation,
          head: loaded.head,
          events: loaded.events,
          objects: loaded.objects,
        },
      };
    } finally {
      loaded.source.close();
    }
  }

  async loadReplacementNameCache(
    job: VaultReplacementJobV1,
    rootKey: Uint8Array,
  ): Promise<WorkspaceVaultNameCacheV1> {
    const [workspace, loaded] = await Promise.all([
      this.workspace.load(),
      this.loadTarget(job, rootKey),
    ]);
    try {
      if (workspace === undefined) throw integrity("Replacement Workspace is unavailable.");
      return encryptWorkspaceVaultName({
        key: workspace.nameCacheKey,
        workspaceId: workspace.metadata.workspaceId,
        vaultId: loaded.records.metadata.vaultId,
        sourceEventId: loaded.nameProjection.sourceEventId,
        name: loaded.name,
      });
    } finally {
      loaded.source.close();
    }
  }

  loadReplacementAccessToken(job: VaultReplacementJobV1): Promise<string> {
    if (job.targetVaultId === undefined)
      throw integrity("Replacement Vault identity is unavailable.");
    return this.accessToken(job.targetVaultId);
  }

  private async loadTarget(
    job: VaultReplacementJobV1,
    rootKey: Uint8Array,
  ): Promise<{
    readonly source: ReplacementLocalSource;
    readonly records: VaultRecordsV1;
    readonly head: StoredVaultHeadV1;
    readonly events: readonly StoredEvent[];
    readonly objects: readonly StoredObjectV1[];
    readonly nameProjection: StoredVaultNameProjectionV1;
    readonly keyring: VaultKeyring;
    readonly name: string;
  }> {
    if (
      job.targetVaultId === undefined ||
      job.targetKeyEpochId === undefined ||
      job.targetGenerationId === undefined ||
      job.targetGenerationNumber === undefined
    )
      throw integrity("Replacement target authority is incomplete.");
    const source = this.source(job.targetVaultId);
    try {
      const [records, head, events, objects, nameProjection] = await Promise.all([
        this.vaults.load(job.targetVaultId),
        source.getVaultHead(),
        source.listStoredEvents(),
        source.listStoredObjects(),
        source.getVaultNameProjection(),
      ]);
      if (
        records === undefined ||
        head === undefined ||
        nameProjection === undefined ||
        records.metadata.vaultId !== job.targetVaultId ||
        records.metadata.activeKeyEpochId !== job.targetKeyEpochId ||
        records.generation.generationId !== job.targetGenerationId ||
        records.generation.generationNumber !== job.targetGenerationNumber ||
        head.generationId !== job.targetGenerationId ||
        head.generationNumber !== job.targetGenerationNumber ||
        !sameIds(head.appendedObjectIds, objects.map((object) => object.objectId).toSorted()) ||
        !sameIds(head.appendedEventIds, events.map((event) => event.eventId).toSorted())
      )
        throw integrity("Staged replacement graph is inconsistent.");
      const keyring = new VaultKeyring(job.targetKeyEpochId, [
        {
          keyEpochId: job.targetKeyEpochId,
          ordinal: 0,
          rootKey: await importVaultRootKey(rootKey),
        },
      ]);
      const name = (await decryptVaultNameProjection(keyring, nameProjection)).name;
      return {
        source,
        records,
        head,
        events,
        objects,
        nameProjection,
        keyring,
        name,
      };
    } catch (error) {
      source.close();
      throw error;
    }
  }
}

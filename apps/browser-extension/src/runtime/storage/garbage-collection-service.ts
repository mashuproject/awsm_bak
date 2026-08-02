import type { Identifier } from "../../domain/canonical/identifiers";
import { decodeVaultObject, type VaultObject } from "../../domain/canonical/object";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalReplayService } from "../projection/canonical-replay";
import {
  loadReplicaGarbageCollectionInventory,
  type ReplicaGarbageCollectionInventory,
} from "./garbage-collection-inventory";
import {
  type GarbageCollectionCompactItem,
  planReplicaGarbageCollection,
} from "./garbage-collection-plan";
import {
  collectReplicaGarbageCollectionReachability,
  type ReplicaGarbageCollectionReachabilityInput,
} from "./garbage-collection-reachability";

type VaultRecord = AuthenticatedVaultEvent | VaultBaseline;

type CollectReachability = (
  input: ReplicaGarbageCollectionReachabilityInput,
) => ReturnType<typeof collectReplicaGarbageCollectionReachability>;

interface CanonicalReplicaGarbageCollectionDependencies {
  readonly replays: CanonicalReplayService;
  readonly collectReachability?: CollectReachability;
  readonly loadInventory?: typeof loadReplicaGarbageCollectionInventory;
}

export interface CanonicalReplicaGarbageCollectionOutcome {
  readonly removedCompactItemCount: number;
  readonly removedResolutionCount: number;
  readonly removedEpochSecretCount: number;
  readonly deferredArtifactCount: number;
  readonly deferredArtifactStorageItemIds: readonly Identifier<"StorageItem">[];
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function decodeRecord(bytes: Uint8Array): VaultRecord {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Garbage Collection Record is not a map");
  if (value.get(6) === 1) return decodeVaultEvent(bytes);
  if (value.get(6) === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Garbage Collection Record kind is unsupported");
}

function compactNamespace(kind: GarbageCollectionCompactItem["kind"]) {
  switch (kind) {
    case 1:
      return NAMESPACES.vaultRecord.key;
    case 2:
      return NAMESPACES.keyEnvelope.key;
    case 3:
      return NAMESPACES.vaultObject.key;
    case 4:
      return NAMESPACES.featureManifest.key;
  }
}

export class CanonicalReplicaGarbageCollectionService {
  private readonly collectReachability: CollectReachability;
  private readonly loadInventory: typeof loadReplicaGarbageCollectionInventory;

  constructor(private readonly dependencies: CanonicalReplicaGarbageCollectionDependencies) {
    this.collectReachability =
      dependencies.collectReachability ?? collectReplicaGarbageCollectionReachability;
    this.loadInventory = dependencies.loadInventory ?? loadReplicaGarbageCollectionInventory;
  }

  async collect(vaultId: Identifier<"Vault">): Promise<CanonicalReplicaGarbageCollectionOutcome> {
    const replay = await this.dependencies.replays.replay(vaultId);
    const { vault } = replay;
    same(vault.replicaState.vaultId, vaultId, "Garbage Collection Vault ID");
    if (vault.replicaState.garbageCollectionFences.length > 0) {
      throw Object.assign(new Error("Garbage Collection is fenced by an active local workflow."), {
        id: "GARBAGE_COLLECTION_FENCED",
      });
    }

    const reachability = await this.collectReachability(
      this.reachabilityInput(vaultId, replay.vault),
    );
    const inventory: ReplicaGarbageCollectionInventory = await this.loadInventory(
      this.dependencies.replays.vaults,
      vault,
    );
    const plan = planReplicaGarbageCollection({
      currentKeyEpochId: vault.replicaState.currentKeyEpochId,
      reachability,
      ...inventory,
    });
    const vaultKey = identifierStorageKey(vaultId);
    const deletedItems = [
      ...plan.deleteCompactItems.map((item) => ({
        namespace: compactNamespace(item.kind),
        scopeKey: vaultKey,
        itemKey: identifierStorageKey(item.logicalId as Identifier<"VaultRecord">),
      })),
      ...plan.deleteResolutions.map((resolution) => ({
        namespace: NAMESPACES.logicalResolution.key,
        scopeKey: vaultKey,
        itemKey: `${resolution.kind}:${identifierStorageKey(
          resolution.logicalId as Identifier<"VaultRecord">,
        )}`,
      })),
      ...plan.deleteEpochSecretIds.map((epochId) => ({
        namespace: NAMESPACES.epochSecret.key,
        scopeKey: vaultKey,
        itemKey: identifierStorageKey(epochId),
      })),
    ];
    if (deletedItems.length > 0) {
      await this.dependencies.replays.vaults.storage.commitReplicaMutation({
        realm: this.dependencies.replays.vaults.realm,
        expectedReplicaState: vault.replicaStateStorageBytes,
        nextReplicaState: {
          namespace: NAMESPACES.replicaState.key,
          scopeKey: vaultKey,
          itemKey: "current",
          bytes: vault.replicaStateStorageBytes,
        },
        deletedItems,
      });
    }
    return {
      removedCompactItemCount: plan.deleteCompactItems.length,
      removedResolutionCount: plan.deleteResolutions.length,
      removedEpochSecretCount: plan.deleteEpochSecretIds.length,
      deferredArtifactCount: plan.artifactCleanupStorageItemIds.length,
      deferredArtifactStorageItemIds: plan.artifactCleanupStorageItemIds,
    };
  }

  private reachabilityInput(
    vaultId: Identifier<"Vault">,
    vault: Awaited<ReturnType<CanonicalReplayService["replay"]>>["vault"],
  ): ReplicaGarbageCollectionReachabilityInput {
    const records = new Map<string, VaultRecord>();
    const objects = new Map<string, VaultObject>();
    const loadRecord = async (id: Identifier<"VaultRecord">): Promise<VaultRecord> => {
      const itemKey = key(id);
      const cached = records.get(itemKey);
      if (cached !== undefined) return cached;
      const opened = await this.dependencies.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 1,
        logicalId: id,
        namespace: NAMESPACES.vaultRecord.key,
        payloadType: 1,
      });
      const record = decodeRecord(opened.payloadBytes);
      same(record.recordId, id, "Garbage Collection Record ID");
      records.set(itemKey, record);
      return record;
    };
    const loadObject = async (id: Identifier<"VaultObject">): Promise<VaultObject> => {
      const itemKey = key(id);
      const cached = objects.get(itemKey);
      if (cached !== undefined) return cached;
      const opened = await this.dependencies.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 3,
        logicalId: id,
        namespace: NAMESPACES.vaultObject.key,
        payloadType: 2,
      });
      const object = decodeVaultObject(opened.payloadBytes);
      same(object.objectId, id, "Garbage Collection Object ID");
      objects.set(itemKey, object);
      return object;
    };
    return {
      vaultId,
      generationId: vault.replicaState.generationId,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      baselineId: vault.replicaState.baselineId,
      causalFrontier: vault.replicaState.causalFrontier,
      authorityFrontier: vault.replicaState.authorityFrontier,
      continuityRecordIds: vault.replicaState.continuityRecordIds,
      preservationRoots: vault.replicaState.preservationRoots,
      adopted: vault.replicaState.adoption !== null,
      loadRecord,
      loadObject,
      loadFeatureManifest: async (id) =>
        (
          await this.dependencies.replays.vaults.openResolvedCompactItem({
            vault,
            kind: 4,
            logicalId: id,
            namespace: NAMESPACES.featureManifest.key,
            payloadType: 3,
          })
        ).payloadBytes,
    };
  }
}

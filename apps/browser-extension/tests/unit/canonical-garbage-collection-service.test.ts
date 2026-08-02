import { describe, expect, it, vi } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import {
  identifierStorageKey,
  type ReplicaMutationCommit,
} from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { CanonicalReplicaGarbageCollectionService } from "../../src/runtime/storage/garbage-collection-service";
import type { LogicalResolution } from "../../src/runtime/vault/canonical-local-state";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function resolution(
  vaultId: ReturnType<typeof filled<"Vault">>,
  kind: LogicalResolution["kind"],
  logicalId: Uint8Array,
  storageByte: number,
  epochByte: number,
): LogicalResolution {
  return {
    vaultId,
    kind,
    logicalId,
    storageItemId: filled("StorageItem", storageByte),
    keyEpochId: filled("KeyEpoch", epochByte),
    availability: 1,
  };
}

function fixture(fenced = false) {
  const vaultId = filled("Vault", 1);
  const currentRecord = filled("VaultRecord", 2);
  const predecessorRecord = filled("VaultRecord", 3);
  const currentArtifact = filled("Artifact", 4);
  const predecessorArtifact = filled("Artifact", 5);
  const activeEpoch = filled("KeyEpoch", 6);
  const oldEpoch = filled("KeyEpoch", 7);
  const replicaStateStorageBytes = Uint8Array.of(8, 9);
  const commitReplicaMutation = vi.fn(async (_input: ReplicaMutationCommit) => undefined);
  const vault = {
    replicaState: {
      vaultId,
      generationId: filled("Generation", 10),
      baselineId: currentRecord,
      causalFrontier: [currentRecord],
      authorityFrontier: [currentRecord],
      continuityRecordIds: [currentRecord],
      preservationRoots: [],
      garbageCollectionFences: fenced ? [new Uint8Array(32).fill(11)] : [],
      adoption: { vacuumEventRecordId: currentRecord },
      currentKeyEpochId: activeEpoch,
      requiredFeatureSetId: filled("RequiredFeatureSet", 12),
    },
    replicaStateStorageBytes,
  };
  const replays = {
    replay: vi.fn(async () => ({ vault })),
    vaults: {
      realm: NORMAL_STORAGE_REALM,
      storage: { commitReplicaMutation },
    },
  };
  const collectReachability = vi.fn(async () => ({
    typedLogicalRoots: [],
    recordIds: [currentRecord],
    vaultObjectIds: [],
    keyEnvelopeIds: [],
    featureManifestIds: [],
    artifactIds: [currentArtifact],
  }));
  const loadInventory = vi.fn(async () => ({
    resolutions: [
      resolution(vaultId, 1, currentRecord, 13, 6),
      resolution(vaultId, 1, predecessorRecord, 14, 7),
      resolution(vaultId, 5, currentArtifact, 15, 6),
      resolution(vaultId, 5, predecessorArtifact, 16, 6),
    ],
    compactItems: [
      { kind: 1 as const, logicalId: currentRecord },
      { kind: 1 as const, logicalId: predecessorRecord },
    ],
    epochSecretIds: [activeEpoch, oldEpoch],
  }));
  const service = new CanonicalReplicaGarbageCollectionService({
    replays: replays as never,
    collectReachability,
    loadInventory,
  });
  return {
    service,
    vaultId,
    predecessorRecord,
    oldEpoch,
    replicaStateStorageBytes,
    commitReplicaMutation,
    collectReachability,
    loadInventory,
  };
}

describe("canonical Replica Garbage Collection service", () => {
  it("commits compact reclamation against the exact prior Replica Safety State", async () => {
    const subject = fixture();

    const outcome = await subject.service.collect(subject.vaultId);

    expect(outcome).toMatchObject({
      removedCompactItemCount: 1,
      removedResolutionCount: 1,
      removedEpochSecretCount: 1,
      deferredArtifactCount: 1,
    });
    expect(subject.commitReplicaMutation).toHaveBeenCalledOnce();
    const commit = subject.commitReplicaMutation.mock.calls[0]?.[0];
    const vaultKey = identifierStorageKey(subject.vaultId);
    expect(commit).toMatchObject({
      realm: NORMAL_STORAGE_REALM,
      expectedReplicaState: subject.replicaStateStorageBytes,
      nextReplicaState: {
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultKey,
        itemKey: "current",
        bytes: subject.replicaStateStorageBytes,
      },
    });
    expect(commit?.deletedItems).toEqual(
      expect.arrayContaining([
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(subject.predecessorRecord),
        },
        {
          namespace: NAMESPACES.logicalResolution.key,
          scopeKey: vaultKey,
          itemKey: `1:${identifierStorageKey(subject.predecessorRecord)}`,
        },
        {
          namespace: NAMESPACES.epochSecret.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(subject.oldEpoch),
        },
      ]),
    );
  });

  it("does not trace or mutate while a Garbage Collection fence is active", async () => {
    const subject = fixture(true);

    await expect(subject.service.collect(subject.vaultId)).rejects.toMatchObject({
      id: "GARBAGE_COLLECTION_FENCED",
    });
    expect(subject.collectReachability).not.toHaveBeenCalled();
    expect(subject.loadInventory).not.toHaveBeenCalled();
    expect(subject.commitReplicaMutation).not.toHaveBeenCalled();
  });
});

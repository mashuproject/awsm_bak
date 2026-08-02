import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { planReplicaGarbageCollection } from "../../src/runtime/storage/garbage-collection-plan";
import type { LogicalResolution } from "../../src/runtime/vault/canonical-local-state";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function resolution(
  kind: LogicalResolution["kind"],
  logicalId: Uint8Array,
  storageByte: number,
  epochByte: number,
): LogicalResolution {
  return {
    vaultId: filled("Vault", 1),
    kind,
    logicalId,
    storageItemId: filled("StorageItem", storageByte),
    keyEpochId: filled("KeyEpoch", epochByte),
    availability: 1,
  };
}

function key(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

describe("canonical Replica Garbage Collection plan", () => {
  it("separates atomic compact deletion from resumable Artifact cleanup", () => {
    const currentRecord = filled("VaultRecord", 2);
    const predecessorRecord = filled("VaultRecord", 3);
    const currentObject = filled("VaultObject", 4);
    const predecessorObject = filled("VaultObject", 5);
    const currentArtifact = filled("Artifact", 6);
    const predecessorArtifact = filled("Artifact", 7);
    const activeEpoch = filled("KeyEpoch", 8);
    const historicalEpoch = filled("KeyEpoch", 9);
    const obsoleteEpoch = filled("KeyEpoch", 10);
    const resolutions = [
      resolution(1, currentRecord, 11, 8),
      resolution(1, predecessorRecord, 12, 10),
      resolution(3, currentObject, 13, 9),
      resolution(3, predecessorObject, 14, 10),
      resolution(5, currentArtifact, 15, 9),
      resolution(5, predecessorArtifact, 16, 9),
    ];

    const plan = planReplicaGarbageCollection({
      currentKeyEpochId: activeEpoch,
      reachability: {
        typedLogicalRoots: [],
        recordIds: [currentRecord],
        vaultObjectIds: [currentObject],
        keyEnvelopeIds: [],
        featureManifestIds: [],
        artifactIds: [currentArtifact],
      },
      resolutions,
      compactItems: [
        { kind: 1, logicalId: currentRecord },
        { kind: 1, logicalId: predecessorRecord },
        { kind: 3, logicalId: currentObject },
        { kind: 3, logicalId: predecessorObject },
      ],
      epochSecretIds: [activeEpoch, historicalEpoch, obsoleteEpoch],
    });

    expect(plan.deleteCompactItems.map(({ logicalId }) => key(logicalId))).toEqual(
      expect.arrayContaining([key(predecessorRecord), key(predecessorObject)]),
    );
    expect(plan.deleteResolutions.map(({ logicalId }) => key(logicalId))).toEqual(
      expect.arrayContaining([key(predecessorRecord), key(predecessorObject)]),
    );
    expect(plan.deleteResolutions.map(({ logicalId }) => key(logicalId))).not.toContain(
      key(predecessorArtifact),
    );
    expect(plan.artifactCleanupStorageItemIds).toEqual([resolutions[5]?.storageItemId]);
    expect(plan.deleteEpochSecretIds.map(key)).toEqual([key(obsoleteEpoch)]);
    expect(plan.retainedArtifactStorageItemIds.map(key)).toEqual([
      key(resolutions[4]?.storageItemId as Uint8Array),
    ]);
  });

  it("fails closed when a reachable logical item has no resolution", () => {
    expect(() =>
      planReplicaGarbageCollection({
        currentKeyEpochId: filled("KeyEpoch", 8),
        reachability: {
          typedLogicalRoots: [],
          recordIds: [filled("VaultRecord", 2)],
          vaultObjectIds: [],
          keyEnvelopeIds: [],
          featureManifestIds: [],
          artifactIds: [],
        },
        resolutions: [],
        compactItems: [],
        epochSecretIds: [filled("KeyEpoch", 8)],
      }),
    ).toThrow(/reachable logical item has no local resolution/u);
  });

  it("never cleans a physically deduplicated Artifact wrapper retained by another logical item", () => {
    const retainedArtifact = filled("Artifact", 20);
    const unreachableArtifact = filled("Artifact", 21);
    const sharedStorageItemId = filled("StorageItem", 22);
    const activeEpoch = filled("KeyEpoch", 8);
    const base = resolution(5, retainedArtifact, 22, 8);
    const resolutions = [
      base,
      { ...resolution(5, unreachableArtifact, 22, 8), storageItemId: sharedStorageItemId },
    ];

    const plan = planReplicaGarbageCollection({
      currentKeyEpochId: activeEpoch,
      reachability: {
        typedLogicalRoots: [],
        recordIds: [],
        vaultObjectIds: [],
        keyEnvelopeIds: [],
        featureManifestIds: [],
        artifactIds: [retainedArtifact],
      },
      resolutions,
      compactItems: [],
      epochSecretIds: [activeEpoch],
    });

    expect(plan.deleteResolutions).toEqual([]);
    expect(plan.artifactCleanupStorageItemIds).toEqual([]);
    expect(plan.retainedArtifactStorageItemIds).toEqual([sharedStorageItemId]);
  });
});

import type { Identifier } from "../../domain/canonical/identifiers";
import type { CompleteExportReachability } from "../complete-export/reachability";
import type { LogicalResolution, LogicalResolutionKind } from "../vault/canonical-local-state";

export interface GarbageCollectionCompactItem {
  readonly kind: Exclude<LogicalResolutionKind, 5>;
  readonly logicalId: Uint8Array;
}

export interface ReplicaGarbageCollectionPlanInput {
  readonly currentKeyEpochId: Identifier<"KeyEpoch">;
  readonly reachability: CompleteExportReachability;
  readonly resolutions: readonly LogicalResolution[];
  readonly compactItems: readonly GarbageCollectionCompactItem[];
  readonly epochSecretIds: readonly Identifier<"KeyEpoch">[];
}

export interface ReplicaGarbageCollectionPlan {
  readonly deleteCompactItems: readonly GarbageCollectionCompactItem[];
  readonly deleteResolutions: readonly LogicalResolution[];
  readonly deleteEpochSecretIds: readonly Identifier<"KeyEpoch">[];
  readonly artifactCleanupStorageItemIds: readonly Identifier<"StorageItem">[];
  readonly retainedArtifactStorageItemIds: readonly Identifier<"StorageItem">[];
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function logicalKey(kind: LogicalResolutionKind, logicalId: Uint8Array): string {
  return `${kind}:${key(logicalId)}`;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function sortLogical<Kind extends { readonly kind: number; readonly logicalId: Uint8Array }>(
  values: readonly Kind[],
): readonly Kind[] {
  return [...values].toSorted(
    (left, right) => left.kind - right.kind || compareBytes(left.logicalId, right.logicalId),
  );
}

function uniqueIds<Kind extends Uint8Array>(
  values: readonly Kind[],
  field: string,
): readonly Kind[] {
  const unique = new Map<string, Kind>();
  for (const value of values) {
    const itemKey = key(value);
    if (unique.has(itemKey)) throw new TypeError(`${field} contains a duplicate identity`);
    unique.set(itemKey, value);
  }
  return [...unique.values()].toSorted(compareBytes);
}

function deduplicatedIds<Kind extends Uint8Array>(values: readonly Kind[]): readonly Kind[] {
  return [...new Map(values.map((value) => [key(value), value])).values()].toSorted(compareBytes);
}

export function planReplicaGarbageCollection(
  input: ReplicaGarbageCollectionPlanInput,
): ReplicaGarbageCollectionPlan {
  const reachable = new Set<string>();
  const addReachable = (kind: LogicalResolutionKind, values: readonly Uint8Array[]): void => {
    for (const value of values) reachable.add(logicalKey(kind, value));
  };
  addReachable(1, input.reachability.recordIds);
  addReachable(2, input.reachability.keyEnvelopeIds);
  addReachable(3, input.reachability.vaultObjectIds);
  addReachable(4, input.reachability.featureManifestIds);
  addReachable(5, input.reachability.artifactIds);

  const resolutions = new Map<string, LogicalResolution>();
  for (const resolution of input.resolutions) {
    const itemKey = logicalKey(resolution.kind, resolution.logicalId);
    if (resolutions.has(itemKey)) {
      throw new TypeError("Replica Garbage Collection resolutions contain a duplicate identity");
    }
    resolutions.set(itemKey, resolution);
  }
  for (const itemKey of reachable) {
    if (!resolutions.has(itemKey)) {
      throw new TypeError("A reachable logical item has no local resolution");
    }
  }

  const retainedResolutions = [...resolutions.entries()]
    .filter(([itemKey]) => reachable.has(itemKey))
    .map(([, resolution]) => resolution);
  const deferredArtifactResolutions = [...resolutions.entries()]
    .filter(([itemKey, resolution]) => !reachable.has(itemKey) && resolution.kind === 5)
    .map(([, resolution]) => resolution);
  const deleteResolutions = sortLogical(
    [...resolutions.entries()]
      .filter(([itemKey, resolution]) => !reachable.has(itemKey) && resolution.kind !== 5)
      .map(([, resolution]) => resolution),
  );

  const compactIdentities = new Set<string>();
  for (const item of input.compactItems) {
    const itemKey = logicalKey(item.kind, item.logicalId);
    if (compactIdentities.has(itemKey)) {
      throw new TypeError("Replica Garbage Collection compact inventory contains a duplicate");
    }
    compactIdentities.add(itemKey);
  }
  const deleteCompactItems = sortLogical(
    input.compactItems.filter((item) => !reachable.has(logicalKey(item.kind, item.logicalId))),
  );

  const epochSecretIds = uniqueIds(input.epochSecretIds, "Key Epoch Secret inventory");
  const retainedEpochKeys = new Set<string>([key(input.currentKeyEpochId)]);
  for (const resolution of [...retainedResolutions, ...deferredArtifactResolutions]) {
    retainedEpochKeys.add(key(resolution.keyEpochId));
  }
  for (const epochKey of retainedEpochKeys) {
    if (!epochSecretIds.some((epochId) => key(epochId) === epochKey)) {
      throw new TypeError("A retained representation has no local Key Epoch Secret");
    }
  }

  const retainedArtifacts = retainedResolutions.filter(({ kind }) => kind === 5);
  const retainedArtifactStorageItemIds = deduplicatedIds(
    retainedArtifacts.map(({ storageItemId }) => storageItemId),
  );
  const retainedArtifactStorageKeys = new Set(retainedArtifactStorageItemIds.map(key));
  return {
    deleteCompactItems,
    deleteResolutions,
    deleteEpochSecretIds: epochSecretIds.filter((epochId) => !retainedEpochKeys.has(key(epochId))),
    artifactCleanupStorageItemIds: deduplicatedIds(
      deferredArtifactResolutions
        .map(({ storageItemId }) => storageItemId)
        .filter((storageItemId) => !retainedArtifactStorageKeys.has(key(storageItemId))),
    ),
    retainedArtifactStorageItemIds,
  };
}

import { DEPENDENCY_TYPES, type TypedDependency } from "../../domain/canonical/dependencies";
import {
  decodeFeatureManifest,
  type FeatureManifest,
  featureManifestId,
  requiredFeatureSetId,
} from "../../domain/canonical/features";
import type { Identifier } from "../../domain/canonical/identifiers";
import { ARTIFACT_OBJECT, artifactId, type VaultObject } from "../../domain/canonical/object";
import type { AuthenticatedVaultEvent, VaultBaseline } from "../../domain/canonical/record";
import { bytesEqual } from "../../domain/hash";

const MAX_REACHABLE_ITEMS = 1_000_000;

type VaultRecord = AuthenticatedVaultEvent | VaultBaseline;
type TraversalMode = 1 | 2;

export interface CompleteExportReachabilityInput {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly baselineId: Identifier<"VaultRecord">;
  readonly causalFrontier: readonly Identifier<"VaultRecord">[];
  readonly authorityFrontier: readonly Identifier<"VaultRecord">[];
  readonly loadRecord: (id: Identifier<"VaultRecord">) => Promise<VaultRecord | undefined>;
  readonly loadObject: (id: Identifier<"VaultObject">) => Promise<VaultObject | undefined>;
  readonly loadFeatureManifest?: (
    id: Identifier<"FeatureManifest">,
  ) => Promise<Uint8Array | undefined>;
}

export interface CompleteExportReachability {
  readonly typedLogicalRoots: readonly TypedDependency[];
  readonly recordIds: readonly Identifier<"VaultRecord">[];
  readonly vaultObjectIds: readonly Identifier<"VaultObject">[];
  readonly keyEnvelopeIds: readonly Identifier<"KeyEnvelope">[];
  readonly featureManifestIds: readonly Identifier<"FeatureManifest">[];
  readonly artifactIds: readonly Identifier<"Artifact">[];
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function sorted<Kind extends Parameters<typeof key>[0]>(values: Iterable<Kind>): readonly Kind[] {
  return [...values].toSorted(compareBytes);
}

function isEvent(record: VaultRecord): record is AuthenticatedVaultEvent {
  return "signature" in record;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

export async function collectCompleteExportReachability(
  input: CompleteExportReachabilityInput,
): Promise<CompleteExportReachability> {
  if (input.causalFrontier.length === 0 || input.authorityFrontier.length === 0) {
    throw new TypeError("Complete Export requires nonempty accepted Frontiers");
  }
  const records = new Map<string, Identifier<"VaultRecord">>();
  const objects = new Map<string, Identifier<"VaultObject">>();
  const keyEnvelopes = new Map<string, Identifier<"KeyEnvelope">>();
  const features = new Map<string, Identifier<"FeatureManifest">>();
  const artifacts = new Map<string, Identifier<"Artifact">>();
  const recordModes = new Map<string, TraversalMode>();
  const recordQueue: { readonly id: Identifier<"VaultRecord">; readonly mode: TraversalMode }[] = [
    { id: input.baselineId, mode: 1 },
    ...input.authorityFrontier.map((id) => ({ id, mode: 1 as const })),
    ...input.causalFrontier.map((id) => ({ id, mode: 2 as const })),
  ];
  const objectQueue: Identifier<"VaultObject">[] = [];
  const featureQueue: Identifier<"FeatureManifest">[] = [];

  const count = (): number =>
    records.size + objects.size + keyEnvelopes.size + features.size + artifacts.size;
  const assertBound = (): void => {
    if (count() > MAX_REACHABLE_ITEMS) {
      throw new RangeError("Complete Export reachability exceeds its item bound");
    }
  };
  const addObject = (id: Uint8Array): void => {
    const typed = id as Identifier<"VaultObject">;
    const itemKey = key(typed);
    if (!objects.has(itemKey)) objectQueue.push(typed);
  };
  const addDependency = (dependency: TypedDependency): void => {
    switch (dependency.type) {
      case DEPENDENCY_TYPES.VaultRecord:
      case DEPENDENCY_TYPES.VaultBaseline:
        recordQueue.push({ id: dependency.id as Identifier<"VaultRecord">, mode: 1 });
        return;
      case DEPENDENCY_TYPES.VaultObject:
      case DEPENDENCY_TYPES.BundleDescriptorObject:
      case DEPENDENCY_TYPES.ArtifactObject:
      case DEPENDENCY_TYPES.NoteContentObject:
        addObject(dependency.id);
        return;
      case DEPENDENCY_TYPES.KeyEnvelope: {
        const id = dependency.id as Identifier<"KeyEnvelope">;
        keyEnvelopes.set(key(id), id);
        return;
      }
      case DEPENDENCY_TYPES.FeatureManifest: {
        const id = dependency.id as Identifier<"FeatureManifest">;
        if (!features.has(key(id))) featureQueue.push(id);
      }
    }
  };

  while (recordQueue.length > 0) {
    const next = recordQueue.shift();
    if (next === undefined) break;
    const recordKey = key(next.id);
    const previousMode = recordModes.get(recordKey);
    if (previousMode !== undefined && previousMode >= next.mode) continue;
    const record = await input.loadRecord(next.id);
    if (record === undefined) {
      throw new TypeError("A reachable Vault Record is unavailable");
    }
    same(record.recordId, next.id, "Reachable Vault Record ID");
    same(record.vaultId, input.vaultId, "Reachable Vault Record Vault ID");
    if (next.mode === 2) {
      same(record.generationId, input.generationId, "Reachable causal Record selected Generation");
    }
    same(
      record.requiredFeatureSetId,
      input.requiredFeatureSetId,
      "Reachable Vault Record Required Feature Set",
    );
    records.set(recordKey, next.id);
    recordModes.set(recordKey, next.mode);
    assertBound();
    for (const dependency of record.dependencies) addDependency(dependency);
    if (isEvent(record)) {
      for (const authorityParent of record.authorityParentRecordIds) {
        recordQueue.push({ id: authorityParent, mode: 1 });
      }
      if (next.mode === 2) {
        for (const parent of record.parentRecordIds) {
          recordQueue.push({ id: parent, mode: 2 });
        }
      }
    }
  }

  while (objectQueue.length > 0) {
    const id = objectQueue.shift();
    if (id === undefined) break;
    const objectKey = key(id);
    if (objects.has(objectKey)) continue;
    const object = await input.loadObject(id);
    if (object === undefined) throw new TypeError("A reachable Vault Object is unavailable");
    same(object.objectId, id, "Reachable Vault Object ID");
    same(object.vaultId, input.vaultId, "Reachable Vault Object Vault ID");
    same(
      object.requiredFeatureSetId,
      input.requiredFeatureSetId,
      "Reachable Vault Object Required Feature Set",
    );
    objects.set(objectKey, id);
    assertBound();
    for (const referencedId of object.referencedObjectIds) addObject(referencedId);
    if (object.objectType === ARTIFACT_OBJECT) {
      const id = artifactId(object);
      artifacts.set(key(id), id);
    }
  }

  const loadedFeatureManifests: FeatureManifest[] = [];
  while (featureQueue.length > 0) {
    const id = featureQueue.shift();
    if (id === undefined) break;
    const featureKey = key(id);
    if (features.has(featureKey)) continue;
    const bytes = await input.loadFeatureManifest?.(id);
    if (bytes === undefined) throw new TypeError("A reachable Feature Manifest is unavailable");
    same(featureManifestId(bytes), id, "Reachable Feature Manifest ID");
    const manifest = decodeFeatureManifest(bytes);
    features.set(featureKey, id);
    loadedFeatureManifests.push(manifest);
    assertBound();
    for (const requiredId of manifest.requiredManifestIds) {
      if (!features.has(key(requiredId))) featureQueue.push(requiredId);
    }
  }
  same(
    requiredFeatureSetId(loadedFeatureManifests),
    input.requiredFeatureSetId,
    "Complete Export Required Feature Set",
  );

  const typedLogicalRoots: TypedDependency[] = [
    ...sorted(input.causalFrontier).map((id) => ({
      type: DEPENDENCY_TYPES.VaultRecord,
      id,
    })),
    { type: DEPENDENCY_TYPES.VaultBaseline, id: input.baselineId },
  ];
  return {
    typedLogicalRoots,
    recordIds: sorted(records.values()),
    vaultObjectIds: sorted(objects.values()),
    keyEnvelopeIds: sorted(keyEnvelopes.values()),
    featureManifestIds: sorted(features.values()),
    artifactIds: sorted(artifacts.values()),
  };
}

import type { Identifier } from "../../domain/canonical/identifiers";
import type { AuthenticatedVaultEvent, VaultBaseline } from "../../domain/canonical/record";
import { bytesEqual } from "../../domain/hash";
import {
  type CompleteExportReachability,
  collectCompleteExportReachability,
} from "../complete-export/reachability";

type VaultRecord = AuthenticatedVaultEvent | VaultBaseline;

export interface ReplicaGarbageCollectionReachabilityInput {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly baselineId: Identifier<"VaultRecord">;
  readonly causalFrontier: readonly Identifier<"VaultRecord">[];
  readonly authorityFrontier: readonly Identifier<"VaultRecord">[];
  readonly continuityRecordIds: readonly Identifier<"VaultRecord">[];
  readonly preservationRoots: readonly Identifier<"VaultRecord">[];
  readonly adopted: boolean;
  readonly loadRecord: (id: Identifier<"VaultRecord">) => Promise<VaultRecord | undefined>;
  readonly loadObject: Parameters<typeof collectCompleteExportReachability>[0]["loadObject"];
  readonly loadFeatureManifest?: Parameters<
    typeof collectCompleteExportReachability
  >[0]["loadFeatureManifest"];
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

function mergeIds<Kind extends Uint8Array>(groups: readonly (readonly Kind[])[]): readonly Kind[] {
  const values = new Map<string, Kind>();
  for (const group of groups) {
    for (const value of group) values.set(key(value), value);
  }
  return [...values.values()].toSorted(compareBytes);
}

/**
 * Traces semantic roots for one local Replica without treating Vacuum's historical commitments as
 * live predecessor reachability. The caller still has to authenticate every loaded item and fence
 * the final deletion against the exact prior Replica Safety State.
 */
export async function collectReplicaGarbageCollectionReachability(
  input: ReplicaGarbageCollectionReachabilityInput,
): Promise<CompleteExportReachability> {
  if (input.continuityRecordIds.length === 0) {
    throw new TypeError("Replica Garbage Collection requires a nonempty Continuity Proof");
  }
  const active = await collectCompleteExportReachability({
    vaultId: input.vaultId,
    generationId: input.generationId,
    requiredFeatureSetId: input.requiredFeatureSetId,
    baselineId: input.baselineId,
    causalFrontier: input.causalFrontier,
    authorityFrontier: input.authorityFrontier,
    loadRecord: input.loadRecord,
    loadObject: input.loadObject,
    ...(input.loadFeatureManifest === undefined
      ? {}
      : { loadFeatureManifest: input.loadFeatureManifest }),
    omitGenesisBaselineDependency: input.adopted,
  });
  for (const recordId of input.continuityRecordIds) {
    if (!active.recordIds.some((candidate) => bytesEqual(candidate, recordId))) {
      throw new TypeError("Replica Garbage Collection trace omits a Continuity Record");
    }
  }

  const preserved: CompleteExportReachability[] = [];
  for (const root of input.preservationRoots) {
    const record = await input.loadRecord(root);
    if (record === undefined) {
      throw new TypeError("A Replica Garbage Collection preservation root is unavailable");
    }
    preserved.push(
      await collectCompleteExportReachability({
        vaultId: input.vaultId,
        generationId: record.generationId,
        requiredFeatureSetId: record.requiredFeatureSetId,
        baselineId: root,
        causalFrontier: [root],
        authorityFrontier: [root],
        loadRecord: input.loadRecord,
        loadObject: input.loadObject,
        ...(input.loadFeatureManifest === undefined
          ? {}
          : { loadFeatureManifest: input.loadFeatureManifest }),
      }),
    );
  }

  const closures = [active, ...preserved];
  return {
    typedLogicalRoots: active.typedLogicalRoots,
    recordIds: mergeIds(closures.map(({ recordIds }) => recordIds)),
    vaultObjectIds: mergeIds(closures.map(({ vaultObjectIds }) => vaultObjectIds)),
    keyEnvelopeIds: mergeIds(closures.map(({ keyEnvelopeIds }) => keyEnvelopeIds)),
    featureManifestIds: mergeIds(closures.map(({ featureManifestIds }) => featureManifestIds)),
    artifactIds: mergeIds(closures.map(({ artifactIds }) => artifactIds)),
  };
}

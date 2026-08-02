import { sealCompactItem } from "../../crypto/compact";
import { type Identifier, randomIdentifier } from "../../domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  BUNDLE_DESCRIPTOR_OBJECT,
  NOTE_CONTENT_OBJECT,
  type VaultObject,
} from "../../domain/canonical/object";
import { bytesEqual } from "../../domain/hash";
import type { OpaqueEnvelope } from "../../storage/opaque-envelope";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../artifact/canonical-store";
import type { ReplayedCanonicalVault } from "../projection/canonical-replay";
import {
  type PreparedCanonicalVaultCreation,
  prepareCanonicalVaultCreation,
  wipePreparedCanonicalVaultCreation,
} from "./canonical-create";
import {
  type BuiltForkContentCheckpoint,
  buildForkContentCheckpoint,
  type ForkIdentifierKind,
  prepareForkArtifactRepresentation,
  rebuildForkVaultObject,
} from "./canonical-fork-content";
import type { LogicalResolution } from "./canonical-local-state";
import { deriveForkContentState } from "./canonical-vacuum-content-checkpoint";

export interface PreparedCanonicalForkObject {
  readonly source: VaultObject;
  readonly destination: VaultObject;
  readonly envelope: OpaqueEnvelope;
}

export interface PreparedCanonicalForkArtifact {
  readonly sourceObject: VaultObject;
  readonly destinationObject: VaultObject;
  readonly representation: PreparedArtifactRepresentation;
}

export interface PreparedCanonicalFork {
  readonly sourceVaultId: Identifier<"Vault">;
  readonly sourceGenerationId: Identifier<"Generation">;
  readonly sourceFrontier: readonly Identifier<"VaultRecord">[];
  readonly content: BuiltForkContentCheckpoint;
  readonly creation: PreparedCanonicalVaultCreation;
  readonly objects: readonly PreparedCanonicalForkObject[];
  readonly artifacts: readonly PreparedCanonicalForkArtifact[];
}

function key(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unique(
  values: readonly Identifier<"VaultObject">[],
): readonly Identifier<"VaultObject">[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

export async function prepareCanonicalFork(input: {
  readonly replay: ReplayedCanonicalVault;
  readonly artifactStore: CanonicalArtifactStore;
  readonly assertedAt: number | bigint;
  readonly openObject: (objectId: Identifier<"VaultObject">) => Promise<VaultObject>;
  readonly readArtifactResolution: (
    artifactId: Identifier<"Artifact">,
  ) => Promise<LogicalResolution>;
  readonly destinationVaultId?: Identifier<"Vault">;
}): Promise<PreparedCanonicalFork> {
  if (
    !bytesEqual(
      input.replay.vault.replicaState.requiredFeatureSetId,
      input.replay.authority.requiredFeatureSetId,
    ) ||
    input.replay.authority.featureSetConflict !== null
  ) {
    throw new TypeError("Fork source Required Feature Set is not unambiguous");
  }
  const state = deriveForkContentState(input.replay);
  const destinationVaultId = input.destinationVaultId ?? randomIdentifier("Vault");
  if (bytesEqual(destinationVaultId, input.replay.vault.replicaState.vaultId)) {
    throw new TypeError("Fork destination Vault ID must be fresh");
  }
  const mappedIds = new Map<string, Identifier<ForkIdentifierKind>>();
  const mappedObjectIds = new Map<string, Identifier<"VaultObject">>();
  const mapIdentifier = <Kind extends ForkIdentifierKind>(
    kind: Kind,
    source: Uint8Array,
  ): Identifier<Kind> => {
    if (kind === "VaultObject") {
      const mapped = mappedObjectIds.get(key(source));
      if (mapped === undefined) throw new TypeError("Fork Object identity has not been rebuilt");
      return mapped as Identifier<Kind>;
    }
    const sourceKey = `${kind}:${key(source)}`;
    const existing = mappedIds.get(sourceKey);
    if (existing !== undefined) return existing as Identifier<Kind>;
    const destination = randomIdentifier(kind);
    mappedIds.set(sourceKey, destination);
    return destination;
  };
  const openExactObject = async (objectId: Identifier<"VaultObject">): Promise<VaultObject> => {
    const object = await input.openObject(objectId);
    if (
      !bytesEqual(object.objectId, objectId) ||
      !bytesEqual(object.vaultId, input.replay.vault.replicaState.vaultId) ||
      !bytesEqual(object.requiredFeatureSetId, input.replay.vault.replicaState.requiredFeatureSetId)
    ) {
      throw new TypeError("Fork source Object belongs to another authenticated context");
    }
    return object;
  };
  const descriptorObjects = await Promise.all(
    unique(state.captures.map(({ descriptorObjectId }) => descriptorObjectId)).map(openExactObject),
  );
  if (descriptorObjects.some(({ objectType }) => objectType !== BUNDLE_DESCRIPTOR_OBJECT)) {
    throw new TypeError("Fork Capture dependency is not a Bundle Descriptor Object");
  }
  const noteObjectIds = unique(
    state.notes.flatMap(({ versions }) =>
      versions.flatMap(({ contentObjectId, restoreContentObjectId }) => [
        ...(contentObjectId === null ? [] : [contentObjectId]),
        ...(restoreContentObjectId === null ? [] : [restoreContentObjectId]),
      ]),
    ),
  );
  const noteObjects = await Promise.all(noteObjectIds.map(openExactObject));
  if (noteObjects.some(({ objectType }) => objectType !== NOTE_CONTENT_OBJECT)) {
    throw new TypeError("Fork Note dependency is not a Note Content Object");
  }
  const artifactObjects = await Promise.all(
    unique(descriptorObjects.flatMap(({ referencedObjectIds }) => referencedObjectIds)).map(
      openExactObject,
    ),
  );
  if (artifactObjects.some(({ objectType }) => objectType !== ARTIFACT_OBJECT)) {
    throw new TypeError("Fork Descriptor dependency is not an Artifact Object");
  }

  const rebuiltPairs: { readonly source: VaultObject; readonly destination: VaultObject }[] = [];
  const rebuildLeaf = (source: VaultObject) => {
    const destination = rebuildForkVaultObject({
      source,
      destinationVaultId,
      requiredFeatureSetId: input.replay.vault.replicaState.requiredFeatureSetId,
      mapIdentifier: () => {
        throw new TypeError("Fork leaf Object unexpectedly contains a mapped identity");
      },
    });
    mappedObjectIds.set(key(source.objectId), destination.objectId);
    rebuiltPairs.push({ source, destination });
  };
  for (const source of artifactObjects) rebuildLeaf(source);
  for (const source of noteObjects) rebuildLeaf(source);
  for (const source of descriptorObjects) {
    const destination = rebuildForkVaultObject({
      source,
      destinationVaultId,
      requiredFeatureSetId: input.replay.vault.replicaState.requiredFeatureSetId,
      mapIdentifier,
    });
    mappedObjectIds.set(key(source.objectId), destination.objectId);
    rebuiltPairs.push({ source, destination });
  }
  const content = buildForkContentCheckpoint(state, { mapIdentifier });
  const creation = await prepareCanonicalVaultCreation({
    label: content.state.vaultLabel.value,
    assertedAt: input.assertedAt,
    initialContent: content.content,
    featureManifests: input.replay.authority.featureManifests.map(({ manifest }) => manifest),
    deterministic: { ids: { vaultId: destinationVaultId } },
  });
  const artifacts: PreparedCanonicalForkArtifact[] = [];
  try {
    const objects = await Promise.all(
      rebuiltPairs.map(
        async ({ source, destination }): Promise<PreparedCanonicalForkObject> => ({
          source,
          destination,
          envelope: await sealCompactItem({
            vaultId: destinationVaultId,
            keyEpochId: creation.secrets.keyEpoch.id,
            keyEpochKey: creation.secrets.keyEpoch.key,
            payloadType: 2,
            payloadBytes: destination.bytes,
          }),
        }),
      ),
    );
    for (const sourceObject of artifactObjects) {
      const destinationObject = rebuiltPairs.find(
        ({ source }) => source === sourceObject,
      )?.destination;
      if (destinationObject === undefined) throw new TypeError("Fork Artifact mapping is absent");
      const sourceArtifactId = artifactId(sourceObject);
      const resolution = await input.readArtifactResolution(sourceArtifactId);
      if (
        resolution.kind !== 5 ||
        resolution.availability !== 1 ||
        !bytesEqual(resolution.logicalId, sourceArtifactId) ||
        !bytesEqual(resolution.vaultId, input.replay.vault.replicaState.vaultId) ||
        !bytesEqual(resolution.keyEpochId, input.replay.vault.epochSecret.keyEpochId)
      ) {
        throw new TypeError("Fork source Artifact is not verified locally in the readable Epoch");
      }
      artifacts.push({
        sourceObject,
        destinationObject,
        representation: await prepareForkArtifactRepresentation({
          sourceStore: input.artifactStore,
          destinationStore: input.artifactStore,
          sourceStorageItemId: resolution.storageItemId,
          sourceObject,
          sourceKeyEpochId: input.replay.vault.epochSecret.keyEpochId,
          sourceKeyEpochKey: input.replay.vault.epochSecret.key,
          destinationObject,
          destinationKeyEpochId: creation.secrets.keyEpoch.id,
          destinationKeyEpochKey: creation.secrets.keyEpoch.key,
        }),
      });
    }
    return {
      sourceVaultId: input.replay.vault.replicaState.vaultId,
      sourceGenerationId: input.replay.vault.replicaState.generationId,
      sourceFrontier: input.replay.vault.replicaState.causalFrontier,
      content,
      creation,
      objects,
      artifacts,
    };
  } catch (error) {
    await Promise.all(
      artifacts.map(({ representation }) => representation.discard().catch(() => undefined)),
    );
    await wipePreparedCanonicalVaultCreation(creation);
    throw error;
  }
}

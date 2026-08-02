import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import type { CanonicalGarbageCollectionFence } from "../vault/canonical-local-state";

export function assertArtifactStorageItemNotGarbageCollectionFenced(
  fences: readonly CanonicalGarbageCollectionFence[],
  artifactId: Identifier<"Artifact">,
  storageItemId: Identifier<"StorageItem">,
): void {
  if (
    !fences.some(
      (fence) =>
        bytesEqual(fence.artifactId, artifactId) || bytesEqual(fence.storageItemId, storageItemId),
    )
  ) {
    return;
  }
  throw Object.assign(
    new Error("The Artifact representation is being reclaimed by local Garbage Collection."),
    { id: "ARTIFACT_REPRESENTATION_GARBAGE_COLLECTION_FENCED" },
  );
}

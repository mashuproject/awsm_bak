import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { assertArtifactStorageItemNotGarbageCollectionFenced } from "../../src/runtime/storage/garbage-collection-fence";

function storageItem(byte: number) {
  return identifier("StorageItem", new Uint8Array(32).fill(byte));
}

function artifact(byte: number) {
  return identifier("Artifact", new Uint8Array(32).fill(byte));
}

describe("canonical Artifact Garbage Collection fences", () => {
  it("blocks only the exact opaque representation being physically deleted", () => {
    const fences = [
      { artifactId: artifact(1), storageItemId: storageItem(2) },
      { artifactId: artifact(3), storageItemId: storageItem(4) },
    ];

    expect(() =>
      assertArtifactStorageItemNotGarbageCollectionFenced(fences, artifact(5), storageItem(6)),
    ).not.toThrow();
    expect(() =>
      assertArtifactStorageItemNotGarbageCollectionFenced(fences, artifact(1), storageItem(6)),
    ).toThrow(expect.objectContaining({ id: "ARTIFACT_REPRESENTATION_GARBAGE_COLLECTION_FENCED" }));
    expect(() =>
      assertArtifactStorageItemNotGarbageCollectionFenced(fences, artifact(5), storageItem(4)),
    ).toThrow(expect.objectContaining({ id: "ARTIFACT_REPRESENTATION_GARBAGE_COLLECTION_FENCED" }));
  });
});

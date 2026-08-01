import { describe, expect, it } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { canonicalSet } from "../../src/domain/canonical/value";
import {
  type CanonicalLibraryProjection,
  decodeCanonicalLibraryProjection,
  encodeCanonicalLibraryProjection,
} from "../../src/runtime/library/canonical-projection";

describe("canonical Library Projection codec", () => {
  it("retains every Collection merge conflict subject and candidate Cause", () => {
    const value = {
      vaultId: randomIdentifier("Vault"),
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [],
      folders: [],
      conflicts: [
        {
          kind: "CollectionMerge",
          reason: "MultipleDestinations",
          subjectCollectionIds: canonicalSet([randomIdentifier("Collection")]),
          candidateRecordIds: canonicalSet(
            Array.from({ length: 10 }, () => randomIdentifier("VaultRecord")),
          ),
        },
      ],
    } as unknown as CanonicalLibraryProjection;

    expect(decodeCanonicalLibraryProjection(encodeCanonicalLibraryProjection(value))).toEqual(
      value,
    );
  });

  it("round-trips Folder hierarchy, Collection placement, and every cycle candidate", () => {
    const folderId = randomIdentifier("Folder");
    const parentFolderId = randomIdentifier("Folder");
    const collectionId = randomIdentifier("Collection");
    const value = {
      vaultId: randomIdentifier("Vault"),
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [
        {
          collectionId,
          explicitTitle: null,
          title: "Collection",
          tailBundleId: null,
          activeCaptureCount: 0,
          redirectedTo: null,
          folderId,
        },
      ],
      folders: [
        {
          folderId,
          name: "Child",
          parentFolderId,
          effectiveParentFolderId: parentFolderId,
          lifecycle: 1,
        },
        {
          folderId: parentFolderId,
          name: "Parent",
          parentFolderId: null,
          effectiveParentFolderId: null,
          lifecycle: 1,
        },
      ],
      conflicts: [
        {
          kind: "Folder",
          subjectFolderIds: canonicalSet([folderId, parentFolderId]),
          candidateRecordIds: canonicalSet(
            Array.from({ length: 10 }, () => randomIdentifier("VaultRecord")),
          ),
        },
      ],
    } as unknown as CanonicalLibraryProjection;

    expect(decodeCanonicalLibraryProjection(encodeCanonicalLibraryProjection(value))).toEqual(
      value,
    );
  });
});

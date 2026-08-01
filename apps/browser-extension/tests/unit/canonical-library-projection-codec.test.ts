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
      tags: [],
      tagAssignments: [],
      notes: [],
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
      tags: [],
      tagAssignments: [],
      notes: [],
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

  it("round-trips duplicate-named Tags and dormant observed assignments", () => {
    const firstTagId = randomIdentifier("Tag");
    const secondTagId = randomIdentifier("Tag");
    const assignmentId = randomIdentifier("TagAssignment");
    const collectionId = randomIdentifier("Collection");
    const value = {
      vaultId: randomIdentifier("Vault"),
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [],
      folders: [],
      tags: [
        { tagId: firstTagId, name: "same", lifecycle: 2, redirectedTo: null },
        { tagId: secondTagId, name: "same", lifecycle: 1, redirectedTo: null },
      ],
      tagAssignments: [
        {
          assignmentId,
          assignedCauseId: randomIdentifier("VaultRecord"),
          tagId: firstTagId,
          effectiveTagId: firstTagId,
          targetKind: 1,
          targetId: collectionId,
          active: false,
        },
      ],
      notes: [],
      conflicts: [],
    } as unknown as CanonicalLibraryProjection;

    expect(decodeCanonicalLibraryProjection(encodeCanonicalLibraryProjection(value))).toEqual(
      value,
    );
  });

  it("round-trips a complete current Note revision and historical attribution", () => {
    const vaultId = randomIdentifier("Vault");
    const noteId = randomIdentifier("Note");
    const collectionId = randomIdentifier("Collection");
    const value = {
      vaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [
        {
          noteId,
          targetKind: 1,
          targetId: collectionId,
          state: 1,
          versions: [
            {
              headCauseId: randomIdentifier("VaultRecord"),
              contentObjectId: randomIdentifier("VaultObject"),
              title: "Context",
              body: "A complete **Note**.",
              bodyDialect: "awsm.note.commonmark",
              originVaultId: vaultId,
              memberId: randomIdentifier("Member"),
              clientCredentialId: randomIdentifier("ClientCredential"),
              assertedAt: 42,
            },
          ],
        },
      ],
      conflicts: [],
    } as unknown as CanonicalLibraryProjection;

    expect(decodeCanonicalLibraryProjection(encodeCanonicalLibraryProjection(value))).toEqual(
      value,
    );
  });
});

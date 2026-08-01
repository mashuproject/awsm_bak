import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { canonicalMap } from "../../src/domain/canonical/value";
import {
  reduceCanonicalCollectionFolders,
  reduceCanonicalFolders,
} from "../../src/runtime/library/canonical-folder-projection";
import { reduceCanonicalNotes } from "../../src/runtime/library/canonical-note-projection";
import { selectCanonicalCollectionTail } from "../../src/runtime/library/canonical-projection";
import { reduceCanonicalTags } from "../../src/runtime/library/canonical-tag-projection";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";
import {
  buildVacuumContentCheckpoint,
  type CanonicalVacuumContentState,
} from "../../src/runtime/vault/canonical-vacuum-content-checkpoint";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

describe("canonical successor Baseline projection", () => {
  it("preserves a checkpointed effective Collection Tail while membership is unchanged", () => {
    const baselineId = filled("VaultRecord", 101);
    const firstCause = filled("VaultRecord", 255);
    const secondCause = filled("VaultRecord", 1);
    const firstBundleId = filled("Bundle", 102);
    const secondBundleId = filled("Bundle", 103);
    const graph = new CausalGraph();
    graph.addBaseline(baselineId, [firstCause, secondCause]);
    const candidates = [
      { bundleId: firstBundleId, registrationRecordId: firstCause },
      { bundleId: secondBundleId, registrationRecordId: secondCause },
    ];

    expect(
      selectCanonicalCollectionTail({
        candidates,
        checkpointActiveBundleIds: [firstBundleId, secondBundleId],
        checkpointTailBundleId: firstBundleId,
        graph,
      }),
    ).toEqual(candidates[0]);
  });

  it("initializes organization and Note reducers from Baseline Causes", () => {
    const vaultId = filled("Vault", 1);
    const baselineId = filled("VaultRecord", 2);
    const folderId = filled("Folder", 3);
    const collectionId = filled("Collection", 4);
    const tagId = filled("Tag", 5);
    const assignmentId = filled("TagAssignment", 6);
    const noteId = filled("Note", 7);
    const noteContentObjectId = filled("VaultObject", 8);
    const folderCause = filled("VaultRecord", 9);
    const collectionFolderCause = filled("VaultRecord", 10);
    const tagCause = filled("VaultRecord", 11);
    const assignmentCause = filled("VaultRecord", 12);
    const noteCause = filled("VaultRecord", 13);
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: "Vault", headCauseIds: [filled("VaultRecord", 14)] },
      credentialLabels: [],
      captures: [],
      collections: [
        {
          collectionId,
          explicitTitle: "Collection",
          titleHeadCauseIds: [filled("VaultRecord", 15)],
          folderId,
          folderHeadCauseIds: [collectionFolderCause],
          activeRedirect: null,
          intrinsicTail: null,
          effectiveTail: null,
        },
      ],
      folders: [
        {
          folderId,
          name: "Sources",
          nameHeadCauseIds: [folderCause],
          parentFolderId: null,
          parentHeadCauseIds: [folderCause],
          lifecycle: 1,
          lifecycleHeadCauseIds: [folderCause],
        },
      ],
      tags: [
        {
          tagId,
          name: "Reviewed",
          nameHeadCauseIds: [tagCause],
          activeRedirect: null,
          lifecycle: 1,
          lifecycleHeadCauseIds: [tagCause],
        },
      ],
      tagAssignments: [
        {
          assignmentId,
          assignedCauseId: assignmentCause,
          tagId,
          targetKind: 1,
          targetId: collectionId,
        },
      ],
      notes: [
        {
          noteId,
          targetKind: 1,
          targetId: collectionId,
          state: 1,
          versions: [
            {
              headCauseId: noteCause,
              contentObjectId: noteContentObjectId,
              restoreContentObjectId: null,
              attribution: {
                originVaultId: vaultId,
                memberId: filled("Member", 16),
                clientCredentialId: filled("ClientCredential", 17),
                assertedAt: 18,
              },
            },
          ],
        },
      ],
      activeConflicts: [],
    };
    const built = buildVacuumContentCheckpoint(state, {
      createCause: (sourceCauseId) => identifier("BaselineCause", sourceCauseId),
    });
    const graph = new CausalGraph();
    graph.addBaseline(
      baselineId,
      built.causeMapping.map(({ baselineCauseId }) => identifier("VaultRecord", baselineCauseId)),
    );
    const replay = {
      vault: {
        baseline: {
          body: canonicalMap([
            [0, 1],
            [1, 2],
            [2, built.checkpoint],
            [3, canonicalMap([])],
            [4, canonicalMap([[0, 1]])],
            [5, null],
          ]),
        },
      },
      graph,
      events: [],
    } as unknown as ReplayedCanonicalVault;

    const folders = reduceCanonicalFolders(replay);
    expect(folders.folders).toEqual([
      expect.objectContaining({ folderId, name: "Sources", nameHeadCauseIds: [folderCause] }),
    ]);
    expect(reduceCanonicalCollectionFolders(replay, folders)).toEqual([
      {
        collectionId,
        assignedFolderId: folderId,
        headCauseIds: [collectionFolderCause],
        effectiveFolderId: folderId,
      },
    ]);
    expect(reduceCanonicalTags(replay)).toMatchObject({
      tags: [{ tagId, name: "Reviewed" }],
      assignments: [{ assignmentId, assignedCauseId: assignmentCause }],
    });
    expect(reduceCanonicalNotes(replay)).toMatchObject({
      notes: [
        {
          noteId,
          versions: [{ headCauseId: noteCause, contentObjectId: noteContentObjectId }],
        },
      ],
    });
  });
});

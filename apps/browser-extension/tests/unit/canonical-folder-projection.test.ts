import { describe, expect, it } from "vitest";

import { type Identifier, randomIdentifier } from "../../src/domain/canonical/identifiers";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import {
  reduceCanonicalCollectionFolders,
  reduceCanonicalFolders,
} from "../../src/runtime/library/canonical-folder-projection";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";
import { emptyCanonicalReplayVault } from "../helpers/canonical-replay";

function event(
  type: number,
  recordId: Identifier<"VaultRecord">,
  body: ReturnType<typeof canonicalMap>,
) {
  return { family: 2, type, recordId, body } as const;
}

describe("canonical Folder projection", () => {
  it("derives names, lifecycle, and nearest active ancestry without mutating placements", () => {
    const genesis = randomIdentifier("VaultRecord");
    const parentCreated = randomIdentifier("VaultRecord");
    const childCreated = randomIdentifier("VaultRecord");
    const childRenamed = randomIdentifier("VaultRecord");
    const parentDeleted = randomIdentifier("VaultRecord");
    const parentId = randomIdentifier("Folder");
    const childId = randomIdentifier("Folder");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(parentCreated, [genesis]);
    graph.add(childCreated, [parentCreated]);
    graph.add(childRenamed, [childCreated]);
    graph.add(parentDeleted, [childCreated]);
    const replay = {
      ...emptyCanonicalReplayVault,
      graph,
      events: [
        event(
          12,
          parentCreated,
          canonicalMap([
            [0, parentId],
            [1, "Parent"],
            [2, null],
          ]),
        ),
        event(
          12,
          childCreated,
          canonicalMap([
            [0, childId],
            [1, "Child"],
            [2, parentId],
          ]),
        ),
        event(
          13,
          childRenamed,
          canonicalMap([
            [0, childId],
            [1, "Renamed"],
          ]),
        ),
        event(15, parentDeleted, canonicalMap([[0, parentId]])),
      ],
    } as unknown as ReplayedCanonicalVault;

    const reduced = reduceCanonicalFolders(replay);
    expect(reduced.conflicts).toEqual([]);
    expect(reduced.folders).toHaveLength(2);
    const parent = reduced.folders.find(
      (folder) => identifierStorageKey(folder.folderId) === identifierStorageKey(parentId),
    );
    const child = reduced.folders.find(
      (folder) => identifierStorageKey(folder.folderId) === identifierStorageKey(childId),
    );
    expect(parent).toMatchObject({ name: "Parent", parentFolderId: null, lifecycle: 2 });
    expect(child).toMatchObject({
      name: "Renamed",
      parentFolderId: parentId,
      effectiveParentFolderId: null,
      lifecycle: 1,
    });
  });

  it("retains a concurrent cycle until an exact complete Resolution replaces it", () => {
    const genesis = randomIdentifier("VaultRecord");
    const firstCreated = randomIdentifier("VaultRecord");
    const secondCreated = randomIdentifier("VaultRecord");
    const firstMoved = randomIdentifier("VaultRecord");
    const secondMoved = randomIdentifier("VaultRecord");
    const resolved = randomIdentifier("VaultRecord");
    const firstFolderId = randomIdentifier("Folder");
    const secondFolderId = randomIdentifier("Folder");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(firstCreated, [genesis]);
    graph.add(secondCreated, [firstCreated]);
    graph.add(firstMoved, [secondCreated]);
    graph.add(secondMoved, [secondCreated]);
    graph.add(resolved, [firstMoved, secondMoved]);
    const conflictingEvents = [
      event(
        12,
        firstCreated,
        canonicalMap([
          [0, firstFolderId],
          [1, "First"],
          [2, null],
        ]),
      ),
      event(
        12,
        secondCreated,
        canonicalMap([
          [0, secondFolderId],
          [1, "Second"],
          [2, null],
        ]),
      ),
      event(
        14,
        firstMoved,
        canonicalMap([
          [0, firstFolderId],
          [1, secondFolderId],
        ]),
      ),
      event(
        14,
        secondMoved,
        canonicalMap([
          [0, secondFolderId],
          [1, firstFolderId],
        ]),
      ),
    ];
    const conflict = reduceCanonicalFolders({
      ...emptyCanonicalReplayVault,
      graph,
      events: conflictingEvents,
    } as unknown as ReplayedCanonicalVault);
    expect(conflict.conflicts).toEqual([
      {
        kind: "Folder",
        subjectFolderIds: canonicalSet([firstFolderId, secondFolderId]),
        candidateRecordIds: canonicalSet([firstMoved, secondMoved]),
      },
    ]);

    const resolution = event(
      17,
      resolved,
      canonicalMap([
        [0, canonicalSet([firstMoved, secondMoved])],
        [
          1,
          canonicalSet([
            canonicalMap([
              [0, firstFolderId],
              [1, null],
            ]),
            canonicalMap([
              [0, secondFolderId],
              [1, firstFolderId],
            ]),
          ]),
        ],
      ]),
    );
    const converged = reduceCanonicalFolders({
      ...emptyCanonicalReplayVault,
      graph,
      events: [...conflictingEvents, resolution],
    } as unknown as ReplayedCanonicalVault);
    expect(converged.conflicts).toEqual([]);
    expect(
      converged.folders.find(
        ({ folderId }) => identifierStorageKey(folderId) === identifierStorageKey(firstFolderId),
      ),
    ).toMatchObject({ parentFolderId: null });
    expect(
      converged.folders.find(
        ({ folderId }) => identifierStorageKey(folderId) === identifierStorageKey(secondFolderId),
      ),
    ).toMatchObject({ parentFolderId: firstFolderId });
  });

  it("rejects a Folder Resolution that omits one current cycle Cause", () => {
    const genesis = randomIdentifier("VaultRecord");
    const firstCreated = randomIdentifier("VaultRecord");
    const secondCreated = randomIdentifier("VaultRecord");
    const firstMoved = randomIdentifier("VaultRecord");
    const secondMoved = randomIdentifier("VaultRecord");
    const resolved = randomIdentifier("VaultRecord");
    const firstFolderId = randomIdentifier("Folder");
    const secondFolderId = randomIdentifier("Folder");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(firstCreated, [genesis]);
    graph.add(secondCreated, [firstCreated]);
    graph.add(firstMoved, [secondCreated]);
    graph.add(secondMoved, [secondCreated]);
    graph.add(resolved, [firstMoved, secondMoved]);
    const replay = {
      ...emptyCanonicalReplayVault,
      graph,
      events: [
        event(
          12,
          firstCreated,
          canonicalMap([
            [0, firstFolderId],
            [1, "First"],
            [2, null],
          ]),
        ),
        event(
          12,
          secondCreated,
          canonicalMap([
            [0, secondFolderId],
            [1, "Second"],
            [2, null],
          ]),
        ),
        event(
          14,
          firstMoved,
          canonicalMap([
            [0, firstFolderId],
            [1, secondFolderId],
          ]),
        ),
        event(
          14,
          secondMoved,
          canonicalMap([
            [0, secondFolderId],
            [1, firstFolderId],
          ]),
        ),
        event(
          17,
          resolved,
          canonicalMap([
            [0, canonicalSet([firstMoved])],
            [
              1,
              [
                canonicalMap([
                  [0, firstFolderId],
                  [1, null],
                ]),
              ],
            ],
          ]),
        ),
      ],
    } as unknown as ReplayedCanonicalVault;

    expect(() => reduceCanonicalFolders(replay)).toThrow(/exact current Folder Conflict/u);
  });

  it("presents a Collection at the nearest active ancestor of its deleted Folder", () => {
    const genesis = randomIdentifier("VaultRecord");
    const grandparentCreated = randomIdentifier("VaultRecord");
    const parentCreated = randomIdentifier("VaultRecord");
    const parentDeleted = randomIdentifier("VaultRecord");
    const collectionPlaced = randomIdentifier("VaultRecord");
    const grandparentId = randomIdentifier("Folder");
    const parentId = randomIdentifier("Folder");
    const collectionId = randomIdentifier("Collection");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(grandparentCreated, [genesis]);
    graph.add(parentCreated, [grandparentCreated]);
    graph.add(parentDeleted, [parentCreated]);
    graph.add(collectionPlaced, [parentDeleted]);
    const replay = {
      ...emptyCanonicalReplayVault,
      graph,
      events: [
        event(
          12,
          grandparentCreated,
          canonicalMap([
            [0, grandparentId],
            [1, "Grandparent"],
            [2, null],
          ]),
        ),
        event(
          12,
          parentCreated,
          canonicalMap([
            [0, parentId],
            [1, "Parent"],
            [2, grandparentId],
          ]),
        ),
        event(15, parentDeleted, canonicalMap([[0, parentId]])),
        event(
          11,
          collectionPlaced,
          canonicalMap([
            [0, collectionId],
            [1, parentId],
          ]),
        ),
      ],
    } as unknown as ReplayedCanonicalVault;
    const folders = reduceCanonicalFolders(replay);

    expect(reduceCanonicalCollectionFolders(replay, folders)).toEqual([
      {
        collectionId,
        assignedFolderId: parentId,
        headCauseIds: [collectionPlaced],
        effectiveFolderId: grandparentId,
      },
    ]);
  });

  it("includes every structural dependent whose ancestry enters a Folder cycle", () => {
    const genesis = randomIdentifier("VaultRecord");
    const firstCreated = randomIdentifier("VaultRecord");
    const secondCreated = randomIdentifier("VaultRecord");
    const dependentCreated = randomIdentifier("VaultRecord");
    const firstMoved = randomIdentifier("VaultRecord");
    const secondMoved = randomIdentifier("VaultRecord");
    const dependentMoved = randomIdentifier("VaultRecord");
    const firstFolderId = randomIdentifier("Folder");
    const secondFolderId = randomIdentifier("Folder");
    const dependentFolderId = randomIdentifier("Folder");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(firstCreated, [genesis]);
    graph.add(secondCreated, [firstCreated]);
    graph.add(dependentCreated, [secondCreated]);
    graph.add(firstMoved, [dependentCreated]);
    graph.add(secondMoved, [dependentCreated]);
    graph.add(dependentMoved, [dependentCreated]);
    const replay = {
      ...emptyCanonicalReplayVault,
      graph,
      events: [
        event(
          12,
          firstCreated,
          canonicalMap([
            [0, firstFolderId],
            [1, "First"],
            [2, null],
          ]),
        ),
        event(
          12,
          secondCreated,
          canonicalMap([
            [0, secondFolderId],
            [1, "Second"],
            [2, null],
          ]),
        ),
        event(
          12,
          dependentCreated,
          canonicalMap([
            [0, dependentFolderId],
            [1, "Dependent"],
            [2, null],
          ]),
        ),
        event(
          14,
          firstMoved,
          canonicalMap([
            [0, firstFolderId],
            [1, secondFolderId],
          ]),
        ),
        event(
          14,
          secondMoved,
          canonicalMap([
            [0, secondFolderId],
            [1, firstFolderId],
          ]),
        ),
        event(
          14,
          dependentMoved,
          canonicalMap([
            [0, dependentFolderId],
            [1, firstFolderId],
          ]),
        ),
      ],
    } as unknown as ReplayedCanonicalVault;

    expect(reduceCanonicalFolders(replay).conflicts).toEqual([
      {
        kind: "Folder",
        subjectFolderIds: canonicalSet([firstFolderId, secondFolderId, dependentFolderId]),
        candidateRecordIds: canonicalSet([firstMoved, secondMoved, dependentMoved]),
      },
    ]);
  });

  it("includes every placement controlled by a multi-Folder Resolution Cause", () => {
    const genesis = randomIdentifier("VaultRecord");
    const firstCreated = randomIdentifier("VaultRecord");
    const secondCreated = randomIdentifier("VaultRecord");
    const thirdCreated = randomIdentifier("VaultRecord");
    const firstMoved = randomIdentifier("VaultRecord");
    const secondMoved = randomIdentifier("VaultRecord");
    const thirdMoved = randomIdentifier("VaultRecord");
    const firstResolution = randomIdentifier("VaultRecord");
    const laterMove = randomIdentifier("VaultRecord");
    const firstFolderId = randomIdentifier("Folder");
    const secondFolderId = randomIdentifier("Folder");
    const thirdFolderId = randomIdentifier("Folder");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(firstCreated, [genesis]);
    graph.add(secondCreated, [firstCreated]);
    graph.add(thirdCreated, [secondCreated]);
    graph.add(firstMoved, [thirdCreated]);
    graph.add(secondMoved, [thirdCreated]);
    graph.add(thirdMoved, [thirdCreated]);
    graph.add(firstResolution, [firstMoved, secondMoved, thirdMoved]);
    graph.add(laterMove, [firstResolution]);
    const replay = {
      ...emptyCanonicalReplayVault,
      graph,
      events: [
        event(
          12,
          firstCreated,
          canonicalMap([
            [0, firstFolderId],
            [1, "First"],
            [2, null],
          ]),
        ),
        event(
          12,
          secondCreated,
          canonicalMap([
            [0, secondFolderId],
            [1, "Second"],
            [2, null],
          ]),
        ),
        event(
          12,
          thirdCreated,
          canonicalMap([
            [0, thirdFolderId],
            [1, "Third"],
            [2, null],
          ]),
        ),
        event(
          14,
          firstMoved,
          canonicalMap([
            [0, firstFolderId],
            [1, secondFolderId],
          ]),
        ),
        event(
          14,
          secondMoved,
          canonicalMap([
            [0, secondFolderId],
            [1, firstFolderId],
          ]),
        ),
        event(
          14,
          thirdMoved,
          canonicalMap([
            [0, thirdFolderId],
            [1, firstFolderId],
          ]),
        ),
        event(
          17,
          firstResolution,
          canonicalMap([
            [0, canonicalSet([firstMoved, secondMoved, thirdMoved])],
            [
              1,
              canonicalSet([
                canonicalMap([
                  [0, firstFolderId],
                  [1, null],
                ]),
                canonicalMap([
                  [0, secondFolderId],
                  [1, firstFolderId],
                ]),
                canonicalMap([
                  [0, thirdFolderId],
                  [1, null],
                ]),
              ]),
            ],
          ]),
        ),
        event(
          14,
          laterMove,
          canonicalMap([
            [0, firstFolderId],
            [1, secondFolderId],
          ]),
        ),
      ],
    } as unknown as ReplayedCanonicalVault;

    expect(reduceCanonicalFolders(replay).conflicts).toEqual([
      {
        kind: "Folder",
        subjectFolderIds: canonicalSet([firstFolderId, secondFolderId, thirdFolderId]),
        candidateRecordIds: canonicalSet([firstResolution, laterMove]),
      },
    ]);
  });
});

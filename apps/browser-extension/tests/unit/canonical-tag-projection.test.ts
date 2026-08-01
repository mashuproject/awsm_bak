import { describe, expect, it } from "vitest";

import { type Identifier, randomIdentifier } from "../../src/domain/canonical/identifiers";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { reduceCanonicalTags } from "../../src/runtime/library/canonical-tag-projection";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";

function event(
  type: number,
  recordId: Identifier<"VaultRecord">,
  body: ReturnType<typeof canonicalMap>,
) {
  return { family: 2, type, recordId, body } as const;
}

function target(kind: 1 | 2, id: Identifier<"Collection"> | Identifier<"Bundle">) {
  return canonicalMap([
    [0, kind],
    [1, id],
  ]);
}

describe("canonical Tag projection", () => {
  it("removes only observed assignment Causes while a concurrent unseen assignment survives", () => {
    const genesis = randomIdentifier("VaultRecord");
    const tagCreated = randomIdentifier("VaultRecord");
    const firstAssigned = randomIdentifier("VaultRecord");
    const secondAssigned = randomIdentifier("VaultRecord");
    const firstRemoved = randomIdentifier("VaultRecord");
    const tagId = randomIdentifier("Tag");
    const firstAssignmentId = randomIdentifier("TagAssignment");
    const secondAssignmentId = randomIdentifier("TagAssignment");
    const collectionId = randomIdentifier("Collection");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(tagCreated, [genesis]);
    graph.add(firstAssigned, [tagCreated]);
    graph.add(secondAssigned, [tagCreated]);
    graph.add(firstRemoved, [firstAssigned]);
    const replay = {
      graph,
      events: [
        event(
          18,
          tagCreated,
          canonicalMap([
            [0, tagId],
            [1, "Research"],
          ]),
        ),
        event(
          20,
          firstAssigned,
          canonicalMap([
            [0, firstAssignmentId],
            [1, tagId],
            [2, target(1, collectionId)],
          ]),
        ),
        event(
          20,
          secondAssigned,
          canonicalMap([
            [0, secondAssignmentId],
            [1, tagId],
            [2, target(1, collectionId)],
          ]),
        ),
        event(21, firstRemoved, canonicalMap([[0, canonicalSet([firstAssigned])]])),
      ],
    } as unknown as ReplayedCanonicalVault;

    const projection = reduceCanonicalTags(replay);

    expect(projection.tags).toEqual([
      { tagId, name: "Research", lifecycle: 1, redirectedTo: null },
    ]);
    expect(projection.assignments).toEqual([
      {
        assignmentId: secondAssignmentId,
        assignedCauseId: secondAssigned,
        tagId,
        effectiveTagId: tagId,
        targetKind: 1,
        targetId: collectionId,
        active: true,
      },
    ]);
    expect(projection.conflicts).toEqual([]);
  });

  it("keeps assignments dormant through delete and reactivates them on restore", () => {
    const genesis = randomIdentifier("VaultRecord");
    const tagCreated = randomIdentifier("VaultRecord");
    const assigned = randomIdentifier("VaultRecord");
    const renamed = randomIdentifier("VaultRecord");
    const deleted = randomIdentifier("VaultRecord");
    const restored = randomIdentifier("VaultRecord");
    const tagId = randomIdentifier("Tag");
    const assignmentId = randomIdentifier("TagAssignment");
    const bundleId = randomIdentifier("Bundle");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(tagCreated, [genesis]);
    graph.add(assigned, [tagCreated]);
    graph.add(renamed, [assigned]);
    graph.add(deleted, [renamed]);
    graph.add(restored, [deleted]);
    const prefix = [
      event(
        18,
        tagCreated,
        canonicalMap([
          [0, tagId],
          [1, "Inbox"],
        ]),
      ),
      event(
        20,
        assigned,
        canonicalMap([
          [0, assignmentId],
          [1, tagId],
          [2, target(2, bundleId)],
        ]),
      ),
      event(
        19,
        renamed,
        canonicalMap([
          [0, tagId],
          [1, "Saved"],
        ]),
      ),
      event(22, deleted, canonicalMap([[0, tagId]])),
    ];

    const dormant = reduceCanonicalTags({
      graph,
      events: prefix,
    } as unknown as ReplayedCanonicalVault);
    expect(dormant.tags[0]).toMatchObject({ name: "Saved", lifecycle: 2 });
    expect(dormant.assignments[0]).toMatchObject({ active: false });

    const active = reduceCanonicalTags({
      graph,
      events: [...prefix, event(23, restored, canonicalMap([[0, tagId]]))],
    } as unknown as ReplayedCanonicalVault);
    expect(active.tags[0]).toMatchObject({ lifecycle: 1 });
    expect(active.assignments[0]).toMatchObject({ active: true });
  });

  it("rejects a removal that mixes relations or names an already inactive assignment", () => {
    const genesis = randomIdentifier("VaultRecord");
    const tagCreated = randomIdentifier("VaultRecord");
    const firstAssigned = randomIdentifier("VaultRecord");
    const secondAssigned = randomIdentifier("VaultRecord");
    const removed = randomIdentifier("VaultRecord");
    const repeated = randomIdentifier("VaultRecord");
    const tagId = randomIdentifier("Tag");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(tagCreated, [genesis]);
    graph.add(firstAssigned, [tagCreated]);
    graph.add(secondAssigned, [firstAssigned]);
    graph.add(removed, [secondAssigned]);
    graph.add(repeated, [removed]);
    const prefix = [
      event(
        18,
        tagCreated,
        canonicalMap([
          [0, tagId],
          [1, "Tag"],
        ]),
      ),
      event(
        20,
        firstAssigned,
        canonicalMap([
          [0, randomIdentifier("TagAssignment")],
          [1, tagId],
          [2, target(1, randomIdentifier("Collection"))],
        ]),
      ),
      event(
        20,
        secondAssigned,
        canonicalMap([
          [0, randomIdentifier("TagAssignment")],
          [1, tagId],
          [2, target(2, randomIdentifier("Bundle"))],
        ]),
      ),
    ];
    expect(() =>
      reduceCanonicalTags({
        graph,
        events: [
          ...prefix,
          event(21, removed, canonicalMap([[0, canonicalSet([firstAssigned, secondAssigned])]])),
        ],
      } as unknown as ReplayedCanonicalVault),
    ).toThrow(/exact Tag relation/u);

    expect(() =>
      reduceCanonicalTags({
        graph,
        events: [
          ...prefix,
          event(21, removed, canonicalMap([[0, canonicalSet([firstAssigned])]])),
          event(21, repeated, canonicalMap([[0, canonicalSet([firstAssigned])]])),
        ],
      } as unknown as ReplayedCanonicalVault),
    ).toThrow(/already inactive/u);
  });

  it("fails closed on Administrator-only Tag governance until authority replay validates it", () => {
    const genesis = randomIdentifier("VaultRecord");
    const tagCreated = randomIdentifier("VaultRecord");
    const tagsMerged = randomIdentifier("VaultRecord");
    const sourceTagId = randomIdentifier("Tag");
    const destinationTagId = randomIdentifier("Tag");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(tagCreated, [genesis]);
    graph.add(tagsMerged, [tagCreated]);

    expect(() =>
      reduceCanonicalTags({
        graph,
        events: [
          event(
            18,
            tagCreated,
            canonicalMap([
              [0, sourceTagId],
              [1, "Source"],
            ]),
          ),
          event(
            24,
            tagsMerged,
            canonicalMap([
              [0, canonicalSet([sourceTagId])],
              [1, destinationTagId],
            ]),
          ),
        ],
      } as unknown as ReplayedCanonicalVault),
    ).toThrow(/authority replay/u);
  });
});

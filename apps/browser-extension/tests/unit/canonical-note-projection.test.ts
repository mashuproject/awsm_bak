import { describe, expect, it } from "vitest";

import { type Identifier, randomIdentifier } from "../../src/domain/canonical/identifiers";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { reduceCanonicalNotes } from "../../src/runtime/library/canonical-note-projection";
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

describe("canonical Note projection", () => {
  it("retains an N-way revision conflict until one exact Resolution keeps and splits versions", () => {
    const genesis = randomIdentifier("VaultRecord");
    const created = randomIdentifier("VaultRecord");
    const firstRevised = randomIdentifier("VaultRecord");
    const secondRevised = randomIdentifier("VaultRecord");
    const resolved = randomIdentifier("VaultRecord");
    const noteId = randomIdentifier("Note");
    const splitNoteId = randomIdentifier("Note");
    const collectionId = randomIdentifier("Collection");
    const initialContentId = randomIdentifier("VaultObject");
    const firstContentId = randomIdentifier("VaultObject");
    const secondContentId = randomIdentifier("VaultObject");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(created, [genesis]);
    graph.add(firstRevised, [created]);
    graph.add(secondRevised, [created]);
    graph.add(resolved, [firstRevised, secondRevised]);
    const prefix = [
      event(
        27,
        created,
        canonicalMap([
          [0, noteId],
          [1, target(1, collectionId)],
          [2, initialContentId],
        ]),
      ),
      event(
        28,
        firstRevised,
        canonicalMap([
          [0, noteId],
          [1, canonicalSet([created])],
          [2, firstContentId],
        ]),
      ),
      event(
        28,
        secondRevised,
        canonicalMap([
          [0, noteId],
          [1, canonicalSet([created])],
          [2, secondContentId],
        ]),
      ),
    ];

    const conflicted = reduceCanonicalNotes({
      graph,
      events: prefix,
    } as unknown as ReplayedCanonicalVault);
    expect(conflicted.notes).toEqual([
      {
        noteId,
        targetKind: 1,
        targetId: collectionId,
        state: 3,
        versions: [
          { headCauseId: firstRevised, contentObjectId: firstContentId },
          { headCauseId: secondRevised, contentObjectId: secondContentId },
        ].toSorted((left, right) =>
          Buffer.from(left.headCauseId).compare(Buffer.from(right.headCauseId)),
        ),
      },
    ]);
    expect(conflicted.conflicts[0]).toMatchObject({
      kind: "Note",
      noteId,
      candidateRecordIds: conflicted.notes[0]?.versions.map(({ headCauseId }) => headCauseId),
    });

    const replacement = reduceCanonicalNotes({
      graph,
      events: [
        ...prefix,
        event(
          31,
          resolved,
          canonicalMap([
            [0, noteId],
            [1, canonicalSet([firstRevised, secondRevised])],
            [2, firstContentId],
            [
              3,
              [
                canonicalMap([
                  [0, splitNoteId],
                  [1, secondContentId],
                ]),
              ],
            ],
          ]),
        ),
      ],
    } as unknown as ReplayedCanonicalVault);
    expect(replacement.conflicts).toEqual([]);
    expect(replacement.notes).toEqual(
      [
        {
          noteId,
          targetKind: 1,
          targetId: collectionId,
          state: 1,
          versions: [{ headCauseId: resolved, contentObjectId: firstContentId }],
        },
        {
          noteId: splitNoteId,
          targetKind: 1,
          targetId: collectionId,
          state: 1,
          versions: [{ headCauseId: resolved, contentObjectId: secondContentId }],
        },
      ].toSorted((left, right) => Buffer.from(left.noteId).compare(Buffer.from(right.noteId))),
    );
  });

  it("converges concurrent deletions and restores their one displaced revision", () => {
    const genesis = randomIdentifier("VaultRecord");
    const created = randomIdentifier("VaultRecord");
    const firstDeleted = randomIdentifier("VaultRecord");
    const secondDeleted = randomIdentifier("VaultRecord");
    const restored = randomIdentifier("VaultRecord");
    const noteId = randomIdentifier("Note");
    const bundleId = randomIdentifier("Bundle");
    const contentId = randomIdentifier("VaultObject");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(created, [genesis]);
    graph.add(firstDeleted, [created]);
    graph.add(secondDeleted, [created]);
    graph.add(restored, [firstDeleted, secondDeleted]);
    const prefix = [
      event(
        27,
        created,
        canonicalMap([
          [0, noteId],
          [1, target(2, bundleId)],
          [2, contentId],
        ]),
      ),
      event(
        29,
        firstDeleted,
        canonicalMap([
          [0, noteId],
          [1, canonicalSet([created])],
        ]),
      ),
      event(
        29,
        secondDeleted,
        canonicalMap([
          [0, noteId],
          [1, canonicalSet([created])],
        ]),
      ),
    ];
    const deleted = reduceCanonicalNotes({
      graph,
      events: prefix,
    } as unknown as ReplayedCanonicalVault);
    expect(deleted.notes[0]).toMatchObject({ state: 2 });
    expect(deleted.notes[0]?.versions).toHaveLength(2);

    const active = reduceCanonicalNotes({
      graph,
      events: [
        ...prefix,
        event(
          30,
          restored,
          canonicalMap([
            [0, noteId],
            [1, canonicalSet([firstDeleted, secondDeleted])],
          ]),
        ),
      ],
    } as unknown as ReplayedCanonicalVault);
    expect(active.notes[0]).toMatchObject({
      state: 1,
      versions: [{ headCauseId: restored, contentObjectId: contentId }],
    });
  });

  it("rejects stale partial head sets and edits while a Note is conflicted", () => {
    const genesis = randomIdentifier("VaultRecord");
    const created = randomIdentifier("VaultRecord");
    const firstRevised = randomIdentifier("VaultRecord");
    const secondRevised = randomIdentifier("VaultRecord");
    const attempted = randomIdentifier("VaultRecord");
    const noteId = randomIdentifier("Note");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(created, [genesis]);
    graph.add(firstRevised, [created]);
    graph.add(secondRevised, [created]);
    graph.add(attempted, [firstRevised, secondRevised]);
    const prefix = [
      event(
        27,
        created,
        canonicalMap([
          [0, noteId],
          [1, target(1, randomIdentifier("Collection"))],
          [2, randomIdentifier("VaultObject")],
        ]),
      ),
      event(
        28,
        firstRevised,
        canonicalMap([
          [0, noteId],
          [1, canonicalSet([created])],
          [2, randomIdentifier("VaultObject")],
        ]),
      ),
      event(
        28,
        secondRevised,
        canonicalMap([
          [0, noteId],
          [1, canonicalSet([created])],
          [2, randomIdentifier("VaultObject")],
        ]),
      ),
    ];

    expect(() =>
      reduceCanonicalNotes({
        graph,
        events: [
          ...prefix,
          event(
            31,
            attempted,
            canonicalMap([
              [0, noteId],
              [1, canonicalSet([firstRevised])],
              [2, null],
              [3, []],
            ]),
          ),
        ],
      } as unknown as ReplayedCanonicalVault),
    ).toThrow(/exact current Note Conflict/u);

    expect(() =>
      reduceCanonicalNotes({
        graph,
        events: [
          ...prefix,
          event(
            28,
            attempted,
            canonicalMap([
              [0, noteId],
              [1, canonicalSet([firstRevised, secondRevised])],
              [2, randomIdentifier("VaultObject")],
            ]),
          ),
        ],
      } as unknown as ReplayedCanonicalVault),
    ).toThrow(/conflicted Note/u);
  });
});

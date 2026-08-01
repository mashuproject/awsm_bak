import type { Identifier } from "../../domain/canonical/identifiers";
import {
  type AdditiveFact,
  type NoteHead,
  reduceAdditiveUnion,
  reduceNoteHeads,
} from "../../domain/canonical/reducers";
import {
  arrayValue,
  exactMap,
  identifierValue,
  mapValue,
  nullable,
  oneOfCodes,
  signedInteger,
} from "../../domain/canonical/schema";
import { canonicalMap, canonicalSet } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { type ReplayedCanonicalVault, replayEventMemberId } from "../projection/canonical-replay";

interface NoteIdentityFact extends AdditiveFact {
  readonly noteId: Identifier<"Note">;
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
}

interface NoteVersionFact extends NoteHead {
  readonly noteId: Identifier<"Note">;
  readonly value: Identifier<"VaultObject"> | null;
  readonly restoreContentObjectId: Identifier<"VaultObject"> | null;
  readonly originVaultId: Identifier<"Vault">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
}

export interface CanonicalProjectedNoteVersion {
  readonly headCauseId: Identifier<"VaultRecord">;
  readonly contentObjectId: Identifier<"VaultObject"> | null;
  readonly restoreContentObjectId: Identifier<"VaultObject"> | null;
  readonly originVaultId: Identifier<"Vault">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
}

export interface CanonicalProjectedNote {
  readonly noteId: Identifier<"Note">;
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
  readonly state: 1 | 2 | 3;
  readonly versions: readonly CanonicalProjectedNoteVersion[];
}

export interface CanonicalNoteConflict {
  readonly kind: "Note";
  readonly noteId: Identifier<"Note">;
  readonly candidateRecordIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalNoteProjection {
  readonly notes: readonly CanonicalProjectedNote[];
  readonly conflicts: readonly CanonicalNoteConflict[];
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareIds(left: Uint8Array, right: Uint8Array): number {
  return key(left).localeCompare(key(right));
}

function sameIdSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  const leftKeys = new Set(left.map(key));
  return leftKeys.size === right.length && right.every((value) => leftKeys.has(key(value)));
}

function typedTarget(value: Parameters<typeof exactMap>[0]): {
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
} {
  const target = exactMap(value, [0, 1], "Note target");
  const targetKind = oneOfCodes(mapValue(target, 0), [1, 2] as const, "Note target kind");
  return {
    targetKind,
    targetId:
      targetKind === 1
        ? identifierValue(mapValue(target, 1), "Collection")
        : identifierValue(mapValue(target, 1), "Bundle"),
  };
}

export function reduceCanonicalNotes(replay: ReplayedCanonicalVault): CanonicalNoteProjection {
  const identities: NoteIdentityFact[] = [];
  const versions: NoteVersionFact[] = [];
  const eventAttribution = (event: ReplayedCanonicalVault["events"][number]) => ({
    originVaultId: replay.vault.replicaState.vaultId,
    memberId: replayEventMemberId(replay, event),
    clientCredentialId: event.signerCredentialId,
    assertedAt: event.assertedAt,
  });

  const baselineBody = exactMap(
    replay.vault.baseline.body,
    [0, 1, 2, 3, 4, 5],
    "Vault Baseline body",
  );
  const baselineContent = exactMap(
    mapValue(baselineBody, 2),
    [...Array(10).keys()],
    "Content checkpoint",
  );
  for (const [index, entry] of arrayValue(
    mapValue(baselineContent, 8),
    "Checkpointed Notes",
  ).entries()) {
    const note = exactMap(entry, [0, 1, 2, 3], `Checkpointed Note ${index}`);
    const noteId = identifierValue(mapValue(note, 0), "Note");
    const target = typedTarget(mapValue(note, 1));
    const checkpointedVersions = arrayValue(mapValue(note, 3), "Checkpointed Note versions").map(
      (versionValue, versionIndex) => {
        const version = exactMap(
          versionValue,
          [0, 1, 2, 3],
          `Checkpointed Note ${index} version ${versionIndex}`,
        );
        return {
          causeId: identifierValue(mapValue(version, 0), "VaultRecord"),
          contentObjectId: nullable(mapValue(version, 1), (objectId) =>
            identifierValue(objectId, "VaultObject"),
          ),
          restoreContentObjectId: nullable(mapValue(version, 2), (objectId) =>
            identifierValue(objectId, "VaultObject"),
          ),
          attribution: (() => {
            const value = exactMap(mapValue(version, 3), [0, 1, 2, 3], "Note attribution");
            return {
              originVaultId: identifierValue(mapValue(value, 0), "Vault"),
              memberId: identifierValue(mapValue(value, 1), "Member"),
              clientCredentialId: identifierValue(mapValue(value, 2), "ClientCredential"),
              assertedAt: signedInteger(mapValue(value, 3), "Note assertedAt"),
            };
          })(),
        };
      },
    );
    const identityCause = checkpointedVersions[0]?.causeId;
    if (identityCause === undefined) throw new TypeError("Checkpointed Note has no identity Cause");
    identities.push({
      entityId: noteId,
      causeId: identityCause,
      authenticatedValue: canonicalMap([
        [0, target.targetKind],
        [1, target.targetId],
      ]),
      noteId,
      ...target,
    });
    for (const version of checkpointedVersions) {
      versions.push({
        noteId,
        causeId: version.causeId,
        kind: version.contentObjectId === null ? "deletion" : "revision",
        value: version.contentObjectId,
        restoreContentObjectId:
          version.contentObjectId === null
            ? version.restoreContentObjectId
            : version.contentObjectId,
        ...version.attribution,
      });
    }
  }

  const identityBefore = (
    noteId: Identifier<"Note">,
    eventId: Identifier<"VaultRecord">,
  ): NoteIdentityFact => {
    const candidates = identities.filter(
      (fact) => bytesEqual(fact.noteId, noteId) && replay.graph.isAncestor(fact.causeId, eventId),
    );
    const reduced = reduceAdditiveUnion(candidates);
    if (reduced.collisions.length > 0) {
      throw new TypeError("Note identity collision requires quarantine");
    }
    const accepted = candidates.find((candidate) =>
      reduced.facts.some((fact) => bytesEqual(fact.causeId, candidate.causeId)),
    );
    if (accepted === undefined) throw new TypeError("Note Event targets an unknown Note");
    return accepted;
  };

  const stateBefore = (noteId: Identifier<"Note">, eventId: Identifier<"VaultRecord">) =>
    reduceNoteHeads(
      versions.filter(
        (fact) => bytesEqual(fact.noteId, noteId) && replay.graph.isAncestor(fact.causeId, eventId),
      ),
      replay.graph,
    );

  const observedHeadIds = (value: Parameters<typeof arrayValue>[0], field: string) =>
    arrayValue(value, field).map((entry) => identifierValue(entry, "VaultRecord"));

  const requireExactHeads = (
    observed: readonly Identifier<"VaultRecord">[],
    current: ReturnType<typeof reduceNoteHeads>,
    field: string,
  ): void => {
    if (
      !sameIdSet(
        current.heads.map(({ causeId }) => causeId),
        observed,
      )
    ) {
      throw new TypeError(`${field} does not name the exact current Note heads`);
    }
  };

  for (const event of replay.events) {
    if (event.family !== 2) continue;
    if (event.type === 27) {
      const body = exactMap(event.body, [0, 1, 2], "Note Created body");
      const noteId = identifierValue(mapValue(body, 0), "Note");
      if (
        identities.some(
          (fact) =>
            bytesEqual(fact.noteId, noteId) &&
            replay.graph.isAncestor(fact.causeId, event.recordId),
        )
      ) {
        throw new TypeError("Note Created repeats an observed Note identity");
      }
      const target = typedTarget(mapValue(body, 1));
      const contentObjectId = identifierValue(mapValue(body, 2), "VaultObject");
      identities.push({
        entityId: noteId,
        causeId: event.recordId,
        authenticatedValue: canonicalMap([
          [0, target.targetKind],
          [1, target.targetId],
        ]),
        noteId,
        ...target,
      });
      versions.push({
        noteId,
        causeId: event.recordId,
        kind: "revision",
        value: contentObjectId,
        restoreContentObjectId: contentObjectId,
        ...eventAttribution(event),
      });
      continue;
    }
    if (event.type === 28) {
      const body = exactMap(event.body, [0, 1, 2], "Note Revised body");
      const noteId = identifierValue(mapValue(body, 0), "Note");
      identityBefore(noteId, event.recordId);
      const current = stateBefore(noteId, event.recordId);
      if (current.state === "conflict") throw new TypeError("Cannot edit a conflicted Note");
      if (current.state !== "active") throw new TypeError("Only an Active Note can be revised");
      requireExactHeads(
        observedHeadIds(mapValue(body, 1), "Superseded Note revision Cause IDs"),
        current,
        "Note revision",
      );
      const contentObjectId = identifierValue(mapValue(body, 2), "VaultObject");
      versions.push({
        noteId,
        causeId: event.recordId,
        kind: "revision",
        value: contentObjectId,
        restoreContentObjectId: contentObjectId,
        ...eventAttribution(event),
      });
      continue;
    }
    if (event.type === 29) {
      const body = exactMap(event.body, [0, 1], "Note Deleted body");
      const noteId = identifierValue(mapValue(body, 0), "Note");
      identityBefore(noteId, event.recordId);
      const current = stateBefore(noteId, event.recordId);
      if (current.state === "conflict") throw new TypeError("Cannot delete a conflicted Note");
      if (current.state !== "active") throw new TypeError("Only an Active Note can be deleted");
      requireExactHeads(
        observedHeadIds(mapValue(body, 1), "Observed Note head Cause IDs"),
        current,
        "Note deletion",
      );
      const displaced = current.heads[0]?.value;
      if (!(displaced instanceof Uint8Array)) {
        throw new TypeError("Note deletion does not displace one revision");
      }
      versions.push({
        noteId,
        causeId: event.recordId,
        kind: "deletion",
        value: null,
        restoreContentObjectId: identifierValue(displaced, "VaultObject"),
        ...eventAttribution(event),
      });
      continue;
    }
    if (event.type === 30) {
      const body = exactMap(event.body, [0, 1], "Note Restored body");
      const noteId = identifierValue(mapValue(body, 0), "Note");
      identityBefore(noteId, event.recordId);
      const current = stateBefore(noteId, event.recordId);
      if (current.state !== "deleted") throw new TypeError("Only a Deleted Note can be restored");
      requireExactHeads(
        observedHeadIds(mapValue(body, 1), "Observed Note head Cause IDs"),
        current,
        "Note restoration",
      );
      const deletionFacts = current.heads.map((head) =>
        versions.find(
          (candidate) =>
            bytesEqual(candidate.noteId, noteId) && bytesEqual(candidate.causeId, head.causeId),
        ),
      );
      const restoredContentId = deletionFacts[0]?.restoreContentObjectId ?? null;
      if (
        restoredContentId === null ||
        deletionFacts.some(
          (fact) =>
            fact?.restoreContentObjectId === null ||
            fact?.restoreContentObjectId === undefined ||
            !bytesEqual(fact.restoreContentObjectId, restoredContentId),
        )
      ) {
        throw new TypeError("Note restoration has no single displaced revision");
      }
      versions.push({
        noteId,
        causeId: event.recordId,
        kind: "revision",
        value: restoredContentId,
        restoreContentObjectId: restoredContentId,
        ...eventAttribution(event),
      });
      continue;
    }
    if (event.type !== 31) continue;

    const body = exactMap(event.body, [0, 1, 2, 3], "Note Conflict Resolution body");
    const noteId = identifierValue(mapValue(body, 0), "Note");
    const identity = identityBefore(noteId, event.recordId);
    const current = stateBefore(noteId, event.recordId);
    const conflictingHeadCauseIds = observedHeadIds(
      mapValue(body, 1),
      "Conflicting Note head Cause IDs",
    );
    if (
      current.state !== "conflict" ||
      !sameIdSet(
        current.heads.map(({ causeId }) => causeId),
        conflictingHeadCauseIds,
      )
    ) {
      throw new TypeError("Note Resolution does not name one exact current Note Conflict");
    }
    const retainedOriginalContentId = nullable(mapValue(body, 2), (value) =>
      identifierValue(value, "VaultObject"),
    );
    versions.push({
      noteId,
      causeId: event.recordId,
      kind: retainedOriginalContentId === null ? "deletion" : "revision",
      value: retainedOriginalContentId,
      restoreContentObjectId: retainedOriginalContentId,
      ...eventAttribution(event),
    });
    const splitNoteIds = new Set<string>();
    for (const [index, value] of arrayValue(mapValue(body, 3), "Split Notes").entries()) {
      const split = exactMap(value, [0, 1], `Split Note ${index}`);
      const splitNoteId = identifierValue(mapValue(split, 0), "Note");
      if (bytesEqual(splitNoteId, noteId) || splitNoteIds.has(key(splitNoteId))) {
        throw new TypeError("Note Resolution split IDs must be fresh and unique");
      }
      splitNoteIds.add(key(splitNoteId));
      const contentObjectId = identifierValue(mapValue(split, 1), "VaultObject");
      identities.push({
        entityId: splitNoteId,
        causeId: event.recordId,
        authenticatedValue: canonicalMap([
          [0, identity.targetKind],
          [1, identity.targetId],
        ]),
        noteId: splitNoteId,
        targetKind: identity.targetKind,
        targetId: identity.targetId,
      });
      versions.push({
        noteId: splitNoteId,
        causeId: event.recordId,
        kind: "revision",
        value: contentObjectId,
        restoreContentObjectId: contentObjectId,
        ...eventAttribution(event),
      });
    }
  }

  const identityReduction = reduceAdditiveUnion(identities);
  if (identityReduction.collisions.length > 0) {
    throw new TypeError("Note identity collision requires quarantine");
  }
  const notes = identityReduction.facts
    .map(({ entityId }): CanonicalProjectedNote => {
      const noteId = identifierValue(entityId, "Note");
      const identity = identities.find((candidate) => bytesEqual(candidate.noteId, noteId));
      if (identity === undefined) throw new TypeError("Note identity is unavailable");
      const reduced = reduceNoteHeads(
        versions.filter((candidate) => bytesEqual(candidate.noteId, noteId)),
        replay.graph,
      );
      if (reduced.state === "absent") throw new TypeError("Note identity has no version");
      const state = reduced.state === "active" ? 1 : reduced.state === "deleted" ? 2 : 3;
      return {
        noteId,
        targetKind: identity.targetKind,
        targetId: identity.targetId,
        state,
        versions: reduced.heads.map(({ causeId, value }) => ({
          headCauseId: causeId,
          contentObjectId: value === null ? null : identifierValue(value, "VaultObject"),
          ...(() => {
            const fact = versions.find(
              (candidate) =>
                bytesEqual(candidate.noteId, noteId) && bytesEqual(candidate.causeId, causeId),
            );
            if (fact === undefined) throw new TypeError("Note head attribution is unavailable");
            return {
              restoreContentObjectId: fact.restoreContentObjectId,
              originVaultId: fact.originVaultId,
              memberId: fact.memberId,
              clientCredentialId: fact.clientCredentialId,
              assertedAt: fact.assertedAt,
            };
          })(),
        })),
      };
    })
    .toSorted((left, right) => compareIds(left.noteId, right.noteId));
  return {
    notes,
    conflicts: notes.flatMap((note): readonly CanonicalNoteConflict[] =>
      note.state === 3
        ? [
            {
              kind: "Note",
              noteId: note.noteId,
              candidateRecordIds: canonicalSet(note.versions.map(({ headCauseId }) => headCauseId)),
            },
          ]
        : [],
    ),
  };
}

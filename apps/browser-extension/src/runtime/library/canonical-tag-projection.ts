import type { Identifier } from "../../domain/canonical/identifiers";
import {
  type AdditiveFact,
  type CausalCandidate,
  type ObservedAssignment,
  type ObservedRemoval,
  reduceAdditiveUnion,
  reduceCausalScalar,
  reduceObservedRemove,
} from "../../domain/canonical/reducers";
import {
  arrayValue,
  exactMap,
  identifierValue,
  mapValue,
  oneOfCodes,
  textValue,
} from "../../domain/canonical/schema";
import { canonicalMap } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type { ReplayedCanonicalVault } from "../projection/canonical-replay";

interface TagNameFact extends CausalCandidate<string> {
  readonly tagId: Identifier<"Tag">;
}

interface TagLifecycleFact extends CausalCandidate<1 | 2> {
  readonly tagId: Identifier<"Tag">;
}

interface TagAssignmentFact extends ObservedAssignment<Identifier<"Tag">>, AdditiveFact {
  readonly assignmentId: Identifier<"TagAssignment">;
  readonly tagId: Identifier<"Tag">;
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
  readonly authenticatedValue: ReturnType<typeof canonicalMap>;
}

export interface CanonicalProjectedTag {
  readonly tagId: Identifier<"Tag">;
  readonly name: string;
  readonly nameHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly lifecycle: 1 | 2;
  readonly lifecycleHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly redirectedTo: Identifier<"Tag"> | null;
}

export interface CanonicalProjectedTagAssignment {
  readonly assignmentId: Identifier<"TagAssignment">;
  readonly assignedCauseId: Identifier<"VaultRecord">;
  readonly tagId: Identifier<"Tag">;
  readonly effectiveTagId: Identifier<"Tag">;
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
  readonly active: boolean;
}

export interface CanonicalTagProjection {
  readonly tags: readonly CanonicalProjectedTag[];
  readonly assignments: readonly CanonicalProjectedTagAssignment[];
  readonly conflicts: readonly [];
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareIds(left: Uint8Array, right: Uint8Array): number {
  return key(left).localeCompare(key(right));
}

function relationKey(
  tagId: Identifier<"Tag">,
  targetKind: 1 | 2,
  targetId: Identifier<"Collection"> | Identifier<"Bundle">,
): string {
  return `${key(tagId)}:${targetKind}:${key(targetId)}`;
}

export function reduceCanonicalTags(replay: ReplayedCanonicalVault): CanonicalTagProjection {
  const identities: AdditiveFact[] = [];
  const knownTags = new Map<string, Identifier<"Tag">>();
  const names: TagNameFact[] = [];
  const lifecycles: TagLifecycleFact[] = [];
  const assignments: TagAssignmentFact[] = [];
  const removals: ObservedRemoval[] = [];

  const requireTag = (tagId: Identifier<"Tag">, field: string): void => {
    if (!knownTags.has(key(tagId))) throw new TypeError(`${field} is not a known Tag`);
  };

  for (const event of replay.events) {
    if (event.family !== 2) continue;
    if (event.type === 24 || event.type === 25 || event.type === 26) {
      throw new TypeError("Tag governance projection requires authority replay");
    }
    if (event.type === 18) {
      const body = exactMap(event.body, [0, 1], "Tag Created body");
      const tagId = identifierValue(mapValue(body, 0), "Tag");
      const name = textValue(mapValue(body, 1), "Tag name", { maxUtf8Bytes: 1_024 });
      knownTags.set(key(tagId), tagId);
      identities.push({
        entityId: tagId,
        causeId: event.recordId,
        authenticatedValue: canonicalMap([[0, name]]),
      });
      names.push({ tagId, causeId: event.recordId, value: name });
      lifecycles.push({ tagId, causeId: event.recordId, value: 1 });
      continue;
    }
    if (event.type === 19) {
      const body = exactMap(event.body, [0, 1], "Tag Renamed body");
      const tagId = identifierValue(mapValue(body, 0), "Tag");
      requireTag(tagId, "Renamed Tag");
      names.push({
        tagId,
        causeId: event.recordId,
        value: textValue(mapValue(body, 1), "Tag name", { maxUtf8Bytes: 1_024 }),
      });
      continue;
    }
    if (event.type === 20) {
      const body = exactMap(event.body, [0, 1, 2], "Tag Assigned body");
      const assignmentId = identifierValue(mapValue(body, 0), "TagAssignment");
      const tagId = identifierValue(mapValue(body, 1), "Tag");
      requireTag(tagId, "Assigned Tag");
      const target = exactMap(mapValue(body, 2), [0, 1], "Tag target");
      const targetKind = oneOfCodes(mapValue(target, 0), [1, 2] as const, "Tag target kind");
      const targetId =
        targetKind === 1
          ? identifierValue(mapValue(target, 1), "Collection")
          : identifierValue(mapValue(target, 1), "Bundle");
      assignments.push({
        assignmentId,
        entityId: assignmentId,
        causeId: event.recordId,
        value: tagId,
        tagId,
        targetKind,
        targetId,
        relationKey: relationKey(tagId, targetKind, targetId),
        authenticatedValue: canonicalMap([
          [0, tagId],
          [1, targetKind],
          [2, targetId],
        ]),
      });
      continue;
    }
    if (event.type === 21) {
      const body = exactMap(event.body, [0], "Tag Removed body");
      const observedAssignmentCauseIds = arrayValue(
        mapValue(body, 0),
        "Tag Assignment Cause IDs",
      ).map((value) => identifierValue(value, "VaultRecord"));
      const observed = observedAssignmentCauseIds.map((causeId) => {
        const assignment = assignments.find((candidate) => bytesEqual(candidate.causeId, causeId));
        if (assignment === undefined)
          throw new TypeError("Tag removal names an unknown assignment");
        return assignment;
      });
      const exactRelation = observed[0]?.relationKey;
      if (
        exactRelation === undefined ||
        observed.some((assignment) => assignment.relationKey !== exactRelation)
      ) {
        throw new TypeError("Tag removal must name one exact Tag relation");
      }
      removals.push({
        causeId: event.recordId,
        relationKey: exactRelation,
        observedAssignmentCauseIds,
      });
      continue;
    }
    if (event.type === 22 || event.type === 23) {
      const body = exactMap(
        event.body,
        [0],
        event.type === 22 ? "Tag Deleted body" : "Tag Restored body",
      );
      const tagId = identifierValue(mapValue(body, 0), "Tag");
      requireTag(tagId, "Tag lifecycle target");
      lifecycles.push({ tagId, causeId: event.recordId, value: event.type === 22 ? 2 : 1 });
    }
  }

  const identityReduction = reduceAdditiveUnion(identities);
  if (identityReduction.collisions.length > 0) {
    throw new TypeError("Tag identity collision requires quarantine");
  }
  const assignmentReduction = reduceAdditiveUnion(assignments);
  if (assignmentReduction.collisions.length > 0) {
    throw new TypeError("Tag Assignment identity collision requires quarantine");
  }
  const acceptedAssignmentCauses = new Set(
    assignmentReduction.facts.map(({ causeId }) => key(causeId)),
  );
  const activeAssignments = reduceObservedRemove(
    assignments.filter((assignment) => acceptedAssignmentCauses.has(key(assignment.causeId))),
    removals,
    replay.graph,
  ) as readonly TagAssignmentFact[];
  const lifecycleFactByTag = new Map(
    [...knownTags.values()].map((tagId) => [
      key(tagId),
      reduceCausalScalar(
        lifecycles.filter((fact) => bytesEqual(fact.tagId, tagId)),
        replay.graph,
      ) as TagLifecycleFact | null,
    ]),
  );
  const tags = identityReduction.facts
    .map(({ entityId }): CanonicalProjectedTag => {
      const tagId = identifierValue(entityId, "Tag");
      const nameFact = reduceCausalScalar(
        names.filter((fact) => bytesEqual(fact.tagId, tagId)),
        replay.graph,
      ) as TagNameFact | null;
      const lifecycleFact = lifecycleFactByTag.get(key(tagId)) ?? null;
      if (nameFact === null || lifecycleFact === null) {
        throw new TypeError("Tag identity has incomplete scalar state");
      }
      return {
        tagId,
        name: nameFact.value,
        nameHeadCauseIds: [nameFact.causeId],
        lifecycle: lifecycleFact.value,
        lifecycleHeadCauseIds: [lifecycleFact.causeId],
        redirectedTo: null,
      };
    })
    .toSorted((left, right) => compareIds(left.tagId, right.tagId));
  return {
    tags,
    assignments: activeAssignments
      .map(
        (assignment): CanonicalProjectedTagAssignment => ({
          assignmentId: assignment.assignmentId,
          assignedCauseId: assignment.causeId,
          tagId: assignment.tagId,
          effectiveTagId: assignment.tagId,
          targetKind: assignment.targetKind,
          targetId: assignment.targetId,
          active: lifecycleFactByTag.get(key(assignment.tagId))?.value === 1,
        }),
      )
      .toSorted((left, right) => compareIds(left.assignmentId, right.assignmentId)),
    conflicts: [],
  };
}

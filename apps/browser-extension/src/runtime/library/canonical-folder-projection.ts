import type { Identifier } from "../../domain/canonical/identifiers";
import {
  type AdditiveFact,
  type CausalCandidate,
  type DirectedEdge,
  type DirectedGraphReduction,
  type GraphConflict,
  reduceAdditiveUnion,
  reduceCausalScalar,
  reduceDirectedGraph,
} from "../../domain/canonical/reducers";
import {
  arrayValue,
  exactMap,
  identifierValue,
  mapValue,
  nullable,
  textValue,
} from "../../domain/canonical/schema";
import { canonicalMap, canonicalSet } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type { ReplayedCanonicalVault } from "../projection/canonical-replay";

interface FolderNameFact extends CausalCandidate<string> {
  readonly folderId: Identifier<"Folder">;
}

interface FolderParentFact extends CausalCandidate<Identifier<"Folder"> | null> {
  readonly folderId: Identifier<"Folder">;
}

interface FolderLifecycleFact extends CausalCandidate<1 | 2> {
  readonly folderId: Identifier<"Folder">;
}

export interface CanonicalProjectedFolder {
  readonly folderId: Identifier<"Folder">;
  readonly name: string;
  readonly parentFolderId: Identifier<"Folder"> | null;
  readonly effectiveParentFolderId: Identifier<"Folder"> | null;
  readonly lifecycle: 1 | 2;
}

export interface CanonicalFolderConflict {
  readonly kind: "Folder";
  readonly subjectFolderIds: readonly Identifier<"Folder">[];
  readonly candidateRecordIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalFolderProjection {
  readonly folders: readonly CanonicalProjectedFolder[];
  readonly conflicts: readonly CanonicalFolderConflict[];
}

export interface CanonicalCollectionFolderPlacement {
  readonly collectionId: Identifier<"Collection">;
  readonly assignedFolderId: Identifier<"Folder"> | null;
  readonly effectiveFolderId: Identifier<"Folder"> | null;
}

interface CollectionFolderFact extends CausalCandidate<Identifier<"Folder"> | null> {
  readonly collectionId: Identifier<"Collection">;
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareIds(left: Uint8Array, right: Uint8Array): number {
  return key(left).localeCompare(key(right));
}

function uniqueRecordIds(
  values: readonly Identifier<"VaultRecord">[],
): readonly Identifier<"VaultRecord">[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function sameIdSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  const leftKeys = new Set(left.map(key));
  return leftKeys.size === right.length && right.every((value) => leftKeys.has(key(value)));
}

function edgeKey(edge: DirectedEdge): string {
  return `${key(edge.sourceId)}:${key(edge.destinationId)}:${key(edge.causeId)}`;
}

function reduceFolderParentGraph(
  edges: readonly DirectedEdge[],
  selected: readonly FolderParentFact[],
  replay: ReplayedCanonicalVault,
): DirectedGraphReduction {
  const reduced = reduceDirectedGraph(edges, replay.graph);
  const conflicts: GraphConflict[] = reduced.conflicts.map((conflict) => {
    const subjectKeys = new Set(conflict.subjectIds.map(key));
    const candidates = new Map(
      conflict.candidates.map((candidate) => [edgeKey(candidate), candidate]),
    );
    const causeKeys = new Set(conflict.candidates.map(({ causeId }) => key(causeId)));
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of reduced.edges) {
        if (!subjectKeys.has(key(edge.destinationId)) || subjectKeys.has(key(edge.sourceId))) {
          continue;
        }
        subjectKeys.add(key(edge.sourceId));
        candidates.set(edgeKey(edge), edge);
        causeKeys.add(key(edge.causeId));
        changed = true;
      }
      for (const fact of selected) {
        if (!causeKeys.has(key(fact.causeId)) || subjectKeys.has(key(fact.folderId))) continue;
        subjectKeys.add(key(fact.folderId));
        if (fact.value !== null) {
          const edge = edges.find(
            (candidate) =>
              bytesEqual(candidate.sourceId, fact.folderId) &&
              bytesEqual(candidate.causeId, fact.causeId),
          );
          if (edge !== undefined) candidates.set(edgeKey(edge), edge);
        }
        changed = true;
      }
    }
    return {
      ...conflict,
      subjectIds: selected
        .map(({ folderId }) => folderId)
        .filter(
          (folderId, index, values) =>
            subjectKeys.has(key(folderId)) &&
            values.findIndex((candidate) => bytesEqual(candidate, folderId)) === index,
        ),
      candidates: [...candidates.values()],
    };
  });
  const conflictedEdges = new Set(conflicts.flatMap(({ candidates }) => candidates.map(edgeKey)));
  return {
    edges: reduced.edges.filter((edge) => !conflictedEdges.has(edgeKey(edge))),
    conflicts,
  };
}

export function reduceCanonicalFolders(replay: ReplayedCanonicalVault): CanonicalFolderProjection {
  const identities: AdditiveFact[] = [];
  const knownFolders = new Map<string, Identifier<"Folder">>();
  const nameFacts: FolderNameFact[] = [];
  const parentFacts: FolderParentFact[] = [];
  const lifecycleFacts: FolderLifecycleFact[] = [];
  const inactiveParentCauses = new Set<string>();

  const requireKnown = (folderId: Identifier<"Folder">, field: string): void => {
    if (!knownFolders.has(key(folderId))) throw new TypeError(`${field} is not a known Folder`);
  };
  const activeParentFacts = (): readonly FolderParentFact[] =>
    parentFacts.filter((fact) => !inactiveParentCauses.has(key(fact.causeId)));
  const hierarchy = () => {
    const selected = [...knownFolders.values()].flatMap((folderId) => {
      const fact = reduceCausalScalar(
        activeParentFacts().filter((candidate) => bytesEqual(candidate.folderId, folderId)),
        replay.graph,
      ) as FolderParentFact | null;
      return fact === null ? [] : [fact];
    });
    const edges: DirectedEdge[] = selected.flatMap((fact) =>
      fact.value === null
        ? []
        : [{ sourceId: fact.folderId, destinationId: fact.value, causeId: fact.causeId }],
    );
    return { selected, reduction: reduceFolderParentGraph(edges, selected, replay) };
  };

  for (const event of replay.events) {
    if (event.family !== 2) continue;
    if (event.type === 12) {
      const body = exactMap(event.body, [0, 1, 2], "Folder Created body");
      const folderId = identifierValue(mapValue(body, 0), "Folder");
      const name = textValue(mapValue(body, 1), "Folder name", { maxUtf8Bytes: 1_024 });
      const parentFolderId = nullable(mapValue(body, 2), (value) =>
        identifierValue(value, "Folder"),
      );
      if (parentFolderId !== null) {
        requireKnown(parentFolderId, "Created Folder parent");
        if (bytesEqual(folderId, parentFolderId)) {
          throw new TypeError("A Folder cannot be its own parent");
        }
      }
      knownFolders.set(key(folderId), folderId);
      identities.push({
        entityId: folderId,
        causeId: event.recordId,
        authenticatedValue: canonicalMap([
          [0, name],
          [1, parentFolderId],
        ]),
      });
      nameFacts.push({ folderId, causeId: event.recordId, value: name });
      parentFacts.push({ folderId, causeId: event.recordId, value: parentFolderId });
      lifecycleFacts.push({ folderId, causeId: event.recordId, value: 1 });
      continue;
    }
    if (event.type === 13) {
      const body = exactMap(event.body, [0, 1], "Folder Renamed body");
      const folderId = identifierValue(mapValue(body, 0), "Folder");
      requireKnown(folderId, "Renamed Folder");
      nameFacts.push({
        folderId,
        causeId: event.recordId,
        value: textValue(mapValue(body, 1), "Folder name", { maxUtf8Bytes: 1_024 }),
      });
      continue;
    }
    if (event.type === 14) {
      const body = exactMap(event.body, [0, 1], "Folder Parent Placement body");
      const folderId = identifierValue(mapValue(body, 0), "Folder");
      const parentFolderId = nullable(mapValue(body, 1), (value) =>
        identifierValue(value, "Folder"),
      );
      requireKnown(folderId, "Placed Folder");
      if (parentFolderId !== null) {
        requireKnown(parentFolderId, "Folder parent");
        if (bytesEqual(folderId, parentFolderId)) {
          throw new TypeError("A Folder cannot be its own parent");
        }
      }
      parentFacts.push({ folderId, causeId: event.recordId, value: parentFolderId });
      continue;
    }
    if (event.type === 15 || event.type === 16) {
      const body = exactMap(
        event.body,
        [0],
        event.type === 15 ? "Folder Deleted body" : "Folder Restored body",
      );
      const folderId = identifierValue(mapValue(body, 0), "Folder");
      requireKnown(folderId, "Folder lifecycle target");
      lifecycleFacts.push({
        folderId,
        causeId: event.recordId,
        value: event.type === 15 ? 2 : 1,
      });
      continue;
    }
    if (event.type !== 17) continue;

    const body = exactMap(event.body, [0, 1], "Folder Conflict Resolution body");
    const resolvedIds = arrayValue(mapValue(body, 0), "Conflicting Folder Cause IDs").map((value) =>
      identifierValue(value, "VaultRecord"),
    );
    const current = hierarchy();
    const touched = current.reduction.conflicts.filter((conflict) =>
      conflict.candidates.some((candidate) =>
        resolvedIds.some((resolvedId) => bytesEqual(candidate.causeId, resolvedId)),
      ),
    );
    if (
      touched.length === 0 ||
      touched.some(
        (conflict) =>
          !sameIdSet(
            uniqueRecordIds(conflict.candidates.map(({ causeId }) => causeId)),
            resolvedIds,
          ),
      )
    ) {
      throw new TypeError("Folder Resolution does not name one exact current Folder Conflict");
    }
    const affectedFolderIds = new Map<string, Identifier<"Folder">>();
    for (const causeId of resolvedIds) {
      const facts = activeParentFacts().filter((fact) => bytesEqual(fact.causeId, causeId));
      if (
        facts.length === 0 ||
        !facts.every((fact) => replay.graph.isAncestor(fact.causeId, event.recordId))
      ) {
        throw new TypeError("Folder Resolution does not observe every named placement Cause");
      }
      for (const fact of facts) affectedFolderIds.set(key(fact.folderId), fact.folderId);
      inactiveParentCauses.add(key(causeId));
    }
    const replacements = arrayValue(mapValue(body, 1), "Resolved Folder placements").map(
      (entry, index): FolderParentFact => {
        const placement = exactMap(entry, [0, 1], `Resolved Folder placement ${index}`);
        const folderId = identifierValue(mapValue(placement, 0), "Folder");
        const parentFolderId = nullable(mapValue(placement, 1), (value) =>
          identifierValue(value, "Folder"),
        );
        requireKnown(folderId, "Resolved Folder");
        if (parentFolderId !== null) {
          requireKnown(parentFolderId, "Resolved Folder parent");
          if (bytesEqual(folderId, parentFolderId)) {
            throw new TypeError("A Folder cannot be its own parent");
          }
        }
        return { folderId, causeId: event.recordId, value: parentFolderId };
      },
    );
    if (
      new Set(replacements.map(({ folderId }) => key(folderId))).size !== replacements.length ||
      !sameIdSet(
        replacements.map(({ folderId }) => folderId),
        [...affectedFolderIds.values()],
      )
    ) {
      throw new TypeError("Folder Resolution does not replace every affected Folder placement");
    }
    parentFacts.push(...replacements);
    const replacement = hierarchy();
    if (
      replacement.reduction.conflicts.some(
        (conflict) =>
          conflict.candidates.some(({ causeId }) => bytesEqual(causeId, event.recordId)) ||
          conflict.subjectIds.some((folderId) => affectedFolderIds.has(key(folderId))),
      )
    ) {
      throw new TypeError("Folder Resolution does not establish one acyclic replacement forest");
    }
  }

  const identityReduction = reduceAdditiveUnion(identities);
  if (identityReduction.collisions.length > 0) {
    throw new TypeError("Folder identity collision requires explicit conflict handling");
  }
  const finalHierarchy = hierarchy();
  const conflictedFolders = new Set(
    finalHierarchy.reduction.conflicts.flatMap(({ subjectIds }) => subjectIds.map(key)),
  );
  const parentByFolder = new Map(
    finalHierarchy.reduction.edges.map((edge) => [
      key(edge.sourceId),
      identifierValue(edge.destinationId, "Folder"),
    ]),
  );
  const lifecycleByFolder = new Map(
    [...knownFolders.values()].map((folderId) => [
      key(folderId),
      reduceCausalScalar(
        lifecycleFacts.filter((fact) => bytesEqual(fact.folderId, folderId)),
        replay.graph,
      )?.value ?? 1,
    ]),
  );
  const nearestActiveParent = (folderId: Identifier<"Folder">): Identifier<"Folder"> | null => {
    let current = parentByFolder.get(key(folderId));
    while (current !== undefined) {
      if (lifecycleByFolder.get(key(current)) === 1) return current;
      current = parentByFolder.get(key(current));
    }
    return null;
  };
  const folders = identityReduction.facts
    .map(({ entityId }): CanonicalProjectedFolder => {
      const folderId = identifierValue(entityId, "Folder");
      const name = reduceCausalScalar(
        nameFacts.filter((fact) => bytesEqual(fact.folderId, folderId)),
        replay.graph,
      )?.value;
      if (name === undefined) throw new TypeError("Folder identity has no name fact");
      return {
        folderId,
        name,
        parentFolderId: conflictedFolders.has(key(folderId))
          ? null
          : (parentByFolder.get(key(folderId)) ?? null),
        effectiveParentFolderId: conflictedFolders.has(key(folderId))
          ? null
          : nearestActiveParent(folderId),
        lifecycle: lifecycleByFolder.get(key(folderId)) ?? 1,
      };
    })
    .toSorted((left, right) => compareIds(left.folderId, right.folderId));
  return {
    folders,
    conflicts: finalHierarchy.reduction.conflicts.map((conflict) => ({
      kind: "Folder",
      subjectFolderIds: canonicalSet(
        conflict.subjectIds.map((folderId) => identifierValue(folderId, "Folder")),
      ),
      candidateRecordIds: canonicalSet(
        uniqueRecordIds(conflict.candidates.map(({ causeId }) => causeId)),
      ),
    })),
  };
}

export function reduceCanonicalCollectionFolders(
  replay: ReplayedCanonicalVault,
  folderProjection: CanonicalFolderProjection,
): readonly CanonicalCollectionFolderPlacement[] {
  const facts = replay.events.flatMap((event): readonly CollectionFolderFact[] => {
    if (event.family !== 2 || event.type !== 11) return [];
    const body = exactMap(event.body, [0, 1], "Collection Folder Placement body");
    return [
      {
        collectionId: identifierValue(mapValue(body, 0), "Collection"),
        causeId: event.recordId,
        value: nullable(mapValue(body, 1), (value) => identifierValue(value, "Folder")),
      },
    ];
  });
  const foldersById = new Map(
    folderProjection.folders.map((folder) => [key(folder.folderId), folder]),
  );
  const collections = new Map(facts.map((fact) => [key(fact.collectionId), fact.collectionId]));
  return [...collections.values()]
    .map((collectionId): CanonicalCollectionFolderPlacement => {
      const selected = reduceCausalScalar(
        facts.filter((fact) => bytesEqual(fact.collectionId, collectionId)),
        replay.graph,
      ) as CollectionFolderFact | null;
      const assignedFolderId = selected?.value ?? null;
      if (assignedFolderId === null) {
        return { collectionId, assignedFolderId: null, effectiveFolderId: null };
      }
      const folder = foldersById.get(key(assignedFolderId));
      if (folder === undefined) {
        throw new TypeError("Collection placement names an unknown Folder");
      }
      return {
        collectionId,
        assignedFolderId,
        effectiveFolderId:
          folder.lifecycle === 1 ? folder.folderId : folder.effectiveParentFolderId,
      };
    })
    .toSorted((left, right) => compareIds(left.collectionId, right.collectionId));
}

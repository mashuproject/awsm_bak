import type { Identifier } from "../../domain/canonical/identifiers";
import {
  artifactId,
  decodeVaultObject,
  NOTE_CONTENT_OBJECT,
  type VaultObject,
} from "../../domain/canonical/object";
import {
  type CausalGraph,
  type DirectedEdge,
  reduceCausalScalar,
  reduceDirectedGraph,
} from "../../domain/canonical/reducers";
import {
  arrayValue,
  booleanValue,
  canonicalSetValue,
  exactCode,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nullable,
  oneOfCodes,
  signedInteger,
  textValue,
} from "../../domain/canonical/schema";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import {
  CanonicalReplayService,
  type ReplayedCanonicalVault,
  replayEventMemberId,
} from "../projection/canonical-replay";
import {
  canonicalLocalStorageContext,
  openWrappedLocalState,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import type {
  CanonicalVaultService,
  PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";
import {
  type CanonicalFolderConflict,
  type CanonicalProjectedFolder,
  reduceCanonicalCollectionFolders,
  reduceCanonicalFolders,
} from "./canonical-folder-projection";
import { reduceCanonicalNotes } from "./canonical-note-projection";
import {
  type CanonicalProjectedTag,
  type CanonicalProjectedTagAssignment,
  reduceCanonicalTags,
} from "./canonical-tag-projection";

const LIBRARY_PROJECTION_FORMAT = 1 as const;

export interface CanonicalLibraryCapture {
  readonly bundleId: Identifier<"Bundle">;
  readonly descriptorObjectId: Identifier<"VaultObject">;
  readonly assignedCollectionId: Identifier<"Collection">;
  readonly currentCollectionId: Identifier<"Collection">;
  readonly effectiveCollectionId: Identifier<"Collection">;
  readonly registrationRecordId: Identifier<"VaultRecord">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
  readonly capturedAt: number | bigint;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly profile: string;
  readonly adapter: string;
  readonly artifactObjectId: Identifier<"VaultObject">;
  readonly artifactId: Identifier<"Artifact">;
  readonly artifactStorageItemId: Identifier<"StorageItem">;
  readonly artifactAvailableLocally: boolean;
  readonly lifecycle: 1 | 2;
}

export interface CanonicalLibraryCollection {
  readonly collectionId: Identifier<"Collection">;
  readonly explicitTitle: string | null;
  readonly title: string;
  readonly tailBundleId: Identifier<"Bundle"> | null;
  readonly activeCaptureCount: number;
  readonly redirectedTo: Identifier<"Collection"> | null;
  readonly folderId: Identifier<"Folder"> | null;
}

export interface CanonicalLibraryNoteVersion {
  readonly headCauseId: Identifier<"VaultRecord">;
  readonly contentObjectId: Identifier<"VaultObject"> | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly bodyDialect: "awsm.note.commonmark" | null;
  readonly originVaultId: Identifier<"Vault">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
}

export interface CanonicalLibraryNote {
  readonly noteId: Identifier<"Note">;
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
  readonly state: 1 | 2 | 3;
  readonly versions: readonly CanonicalLibraryNoteVersion[];
}

export interface CanonicalCaptureIdentityConflict {
  readonly kind: "CaptureIdentity";
  readonly bundleId: Identifier<"Bundle">;
  readonly registrationRecordIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalCollectionMergeConflict {
  readonly kind: "CollectionMerge";
  readonly reason: "MultipleDestinations" | "Cycle";
  readonly subjectCollectionIds: readonly Identifier<"Collection">[];
  readonly candidateRecordIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalNoteConflict {
  readonly kind: "Note";
  readonly noteId: Identifier<"Note">;
  readonly candidateRecordIds: readonly Identifier<"VaultRecord">[];
}

export type CanonicalLibraryConflict =
  | CanonicalCaptureIdentityConflict
  | CanonicalCollectionMergeConflict
  | CanonicalFolderConflict
  | CanonicalNoteConflict;

export interface CanonicalLibraryProjection {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly frontier: readonly Identifier<"VaultRecord">[];
  readonly captures: readonly CanonicalLibraryCapture[];
  readonly collections: readonly CanonicalLibraryCollection[];
  readonly folders: readonly CanonicalProjectedFolder[];
  readonly tags: readonly CanonicalProjectedTag[];
  readonly tagAssignments: readonly CanonicalProjectedTagAssignment[];
  readonly notes: readonly CanonicalLibraryNote[];
  readonly conflicts: readonly CanonicalLibraryConflict[];
}

interface RegistrationFact {
  readonly bundleId: Identifier<"Bundle">;
  readonly descriptorObjectId: Identifier<"VaultObject">;
  readonly assignedCollectionId: Identifier<"Collection">;
  readonly registrationRecordId: Identifier<"VaultRecord">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
  readonly lifecycle: 1 | 2;
}

interface CaptureLifecycleFact {
  readonly bundleId: Identifier<"Bundle">;
  readonly causeId: Identifier<"VaultRecord">;
  readonly value: 1 | 2;
}

interface CapturePlacementFact {
  readonly bundleId: Identifier<"Bundle">;
  readonly causeId: Identifier<"VaultRecord">;
  readonly value: Identifier<"Collection">;
}

interface CollectionTitleFact {
  readonly collectionId: Identifier<"Collection">;
  readonly causeId: Identifier<"VaultRecord">;
  readonly value: string | null;
}

interface CollectionRedirectFact {
  readonly causeId: Identifier<"VaultRecord">;
  readonly edges: readonly DirectedEdge[];
}

interface CollectionTailCandidate {
  readonly bundleId: Identifier<"Bundle">;
  readonly registrationRecordId: Identifier<"VaultRecord">;
}

export function selectCanonicalCollectionTail<T extends CollectionTailCandidate>(input: {
  readonly candidates: readonly T[];
  readonly checkpointActiveBundleIds: readonly Identifier<"Bundle">[];
  readonly checkpointTailBundleId: Identifier<"Bundle"> | null;
  readonly graph: CausalGraph;
}): T | undefined {
  const currentIds = new Set(input.candidates.map(({ bundleId }) => key(bundleId)));
  const checkpointMembershipUnchanged =
    currentIds.size === input.checkpointActiveBundleIds.length &&
    input.checkpointActiveBundleIds.every((bundleId) => currentIds.has(key(bundleId)));
  if (checkpointMembershipUnchanged && input.checkpointTailBundleId !== null) {
    const checkpointTail = input.candidates.find(({ bundleId }) =>
      bytesEqual(bundleId, input.checkpointTailBundleId as Identifier<"Bundle">),
    );
    if (checkpointTail === undefined) {
      throw new TypeError("Checkpointed Collection Tail is not an active Capture");
    }
    return checkpointTail;
  }
  return input.candidates.toSorted((left, right) => {
    if (input.graph.isAncestor(left.registrationRecordId, right.registrationRecordId)) return 1;
    if (input.graph.isAncestor(right.registrationRecordId, left.registrationRecordId)) return -1;
    return compareBytes(right.registrationRecordId, left.registrationRecordId);
  })[0];
}

function baselineContentCheckpoint(vault: PersistedOpenedCanonicalVault) {
  const body = exactMap(vault.baseline.body, [0, 1, 2, 3, 4, 5], "Vault Baseline body");
  return exactMap(mapValue(body, 2), [...Array(10).keys()], "Content checkpoint");
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, index) => [index, value] as const));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return key(left).localeCompare(key(right));
}

function compareInteger(left: number | bigint, right: number | bigint): number {
  const a = typeof left === "bigint" ? left : BigInt(left);
  const b = typeof right === "bigint" ? right : BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function baselineRegistrations(vault: PersistedOpenedCanonicalVault): readonly RegistrationFact[] {
  const content = baselineContentCheckpoint(vault);
  return arrayValue(mapValue(content, 3), "Checkpointed Captures").map((entry, index) => {
    const capture = exactMap(entry, [...Array(8).keys()], `Checkpointed Capture ${index}`);
    const attribution = exactMap(
      mapValue(capture, 7),
      [0, 1, 2, 3],
      `Checkpointed Capture ${index} attribution`,
    );
    return {
      bundleId: identifierValue(mapValue(capture, 0), "Bundle"),
      descriptorObjectId: identifierValue(mapValue(capture, 1), "VaultObject"),
      assignedCollectionId: identifierValue(mapValue(capture, 2), "Collection"),
      registrationRecordId: identifierValue(mapValue(capture, 6), "VaultRecord"),
      memberId: identifierValue(mapValue(attribution, 1), "Member"),
      clientCredentialId: identifierValue(mapValue(attribution, 2), "ClientCredential"),
      assertedAt: signedInteger(mapValue(attribution, 3), "Capture attribution assertedAt"),
      lifecycle: oneOfCodes(mapValue(capture, 4), [1, 2] as const, "Capture lifecycle"),
    };
  });
}

function baselineCaptureLifecycles(
  vault: PersistedOpenedCanonicalVault,
): readonly CaptureLifecycleFact[] {
  return arrayValue(mapValue(baselineContentCheckpoint(vault), 3), "Checkpointed Captures").flatMap(
    (entry, index): readonly CaptureLifecycleFact[] => {
      const capture = exactMap(entry, [...Array(8).keys()], `Checkpointed Capture ${index}`);
      const bundleId = identifierValue(mapValue(capture, 0), "Bundle");
      const value = oneOfCodes(mapValue(capture, 4), [1, 2] as const, "Capture lifecycle");
      return idSetValue(mapValue(capture, 5), "VaultRecord", "Capture lifecycle Cause IDs", {
        nonempty: true,
      }).map((causeId) => ({ bundleId, causeId, value }));
    },
  );
}

function baselineCapturePlacements(
  vault: PersistedOpenedCanonicalVault,
): readonly CapturePlacementFact[] {
  return arrayValue(mapValue(baselineContentCheckpoint(vault), 3), "Checkpointed Captures").flatMap(
    (entry, index): readonly CapturePlacementFact[] => {
      const capture = exactMap(entry, [...Array(8).keys()], `Checkpointed Capture ${index}`);
      const bundleId = identifierValue(mapValue(capture, 0), "Bundle");
      const value = identifierValue(mapValue(capture, 2), "Collection");
      return idSetValue(mapValue(capture, 3), "VaultRecord", "Capture assignment Cause IDs", {
        nonempty: true,
      }).map((causeId) => ({ bundleId, causeId, value }));
    },
  );
}

function baselineCollectionTitles(
  vault: PersistedOpenedCanonicalVault,
): readonly CollectionTitleFact[] {
  return arrayValue(
    mapValue(baselineContentCheckpoint(vault), 4),
    "Checkpointed Collections",
  ).flatMap((entry, index): readonly CollectionTitleFact[] => {
    const collection = exactMap(entry, [...Array(8).keys()], `Checkpointed Collection ${index}`);
    const collectionId = identifierValue(mapValue(collection, 0), "Collection");
    const value = nullable(mapValue(collection, 1), (title) =>
      textValue(title, "Collection title", { maxUtf8Bytes: 1_024 }),
    );
    return idSetValue(mapValue(collection, 2), "VaultRecord", "Collection title Cause IDs").map(
      (causeId) => ({ collectionId, causeId, value }),
    );
  });
}

function baselineEffectiveCollectionState(vault: PersistedOpenedCanonicalVault): ReadonlyMap<
  string,
  {
    readonly activeBundleIds: readonly Identifier<"Bundle">[];
    readonly tailBundleId: Identifier<"Bundle"> | null;
  }
> {
  const content = baselineContentCheckpoint(vault);
  const redirects: DirectedEdge[] = [];
  const state = new Map<
    string,
    {
      collectionId: Identifier<"Collection">;
      activeBundleIds: Identifier<"Bundle">[];
      tailBundleId: Identifier<"Bundle"> | null;
    }
  >();
  for (const [index, entry] of arrayValue(
    mapValue(content, 4),
    "Checkpointed Collections",
  ).entries()) {
    const collection = exactMap(entry, [...Array(8).keys()], `Checkpointed Collection ${index}`);
    const collectionId = identifierValue(mapValue(collection, 0), "Collection");
    const activeRedirect = nullable(mapValue(collection, 5), (value) => {
      const redirect = exactMap(value, [0, 1], "Checkpointed Collection redirect");
      return {
        destinationId: identifierValue(mapValue(redirect, 0), "Collection"),
        causeId: identifierValue(mapValue(redirect, 1), "VaultRecord"),
      };
    });
    if (activeRedirect !== null) {
      redirects.push({
        sourceId: collectionId,
        destinationId: activeRedirect.destinationId,
        causeId: activeRedirect.causeId,
      });
    }
    const tailBundleId = nullable(mapValue(collection, 7), (value) => {
      const tail = exactMap(value, [0, 1], "Checkpointed effective Collection Tail");
      return identifierValue(mapValue(tail, 0), "Bundle");
    });
    state.set(key(collectionId), { collectionId, activeBundleIds: [], tailBundleId });
  }
  for (const [index, entry] of arrayValue(
    mapValue(content, 3),
    "Checkpointed Captures",
  ).entries()) {
    const capture = exactMap(entry, [...Array(8).keys()], `Checkpointed Capture ${index}`);
    if (oneOfCodes(mapValue(capture, 4), [1, 2] as const, "Capture lifecycle") !== 1) continue;
    const bundleId = identifierValue(mapValue(capture, 0), "Bundle");
    const assignedCollectionId = identifierValue(mapValue(capture, 2), "Collection");
    const effectiveCollectionId = resolveCollectionRedirect(assignedCollectionId, redirects);
    const current = state.get(key(effectiveCollectionId));
    if (current === undefined) {
      state.set(key(effectiveCollectionId), {
        collectionId: effectiveCollectionId,
        activeBundleIds: [bundleId],
        tailBundleId: null,
      });
    } else {
      current.activeBundleIds.push(bundleId);
    }
  }
  return new Map(
    [...state].map(([stateKey, value]) => [
      stateKey,
      { activeBundleIds: value.activeBundleIds, tailBundleId: value.tailBundleId },
    ]),
  );
}

function eventRegistrations(replay: ReplayedCanonicalVault): readonly RegistrationFact[] {
  return replay.events.flatMap((event) => {
    if (event.family !== 2 || event.type !== 3) return [];
    const body = exactMap(event.body, [0, 1, 2], "Bundle Registered body");
    return [
      {
        bundleId: identifierValue(mapValue(body, 0), "Bundle"),
        descriptorObjectId: identifierValue(mapValue(body, 1), "VaultObject"),
        assignedCollectionId: identifierValue(mapValue(body, 2), "Collection"),
        registrationRecordId: event.recordId,
        memberId: replayEventMemberId(replay, event),
        clientCredentialId: event.signerCredentialId,
        assertedAt: event.assertedAt,
        lifecycle: 1 as const,
      },
    ];
  });
}

function eventCaptureLifecycles(replay: ReplayedCanonicalVault): readonly CaptureLifecycleFact[] {
  return replay.events.flatMap((event): readonly CaptureLifecycleFact[] => {
    if (event.family !== 2) return [];
    if (event.type === 3) {
      const body = exactMap(event.body, [0, 1, 2], "Bundle Registered body");
      return [
        {
          bundleId: identifierValue(mapValue(body, 0), "Bundle"),
          causeId: event.recordId,
          value: 1,
        },
      ];
    }
    if (event.type !== 4 && event.type !== 5) return [];
    const body = exactMap(
      event.body,
      [0],
      event.type === 4 ? "Captures Deleted body" : "Captures Restored body",
    );
    return arrayValue(mapValue(body, 0), "Capture lifecycle Bundle IDs").map((bundleId) => ({
      bundleId: identifierValue(bundleId, "Bundle"),
      causeId: event.recordId,
      value: event.type === 4 ? (2 as const) : (1 as const),
    }));
  });
}

function eventCapturePlacements(replay: ReplayedCanonicalVault): readonly CapturePlacementFact[] {
  return replay.events.flatMap((event): readonly CapturePlacementFact[] => {
    if (event.family !== 2) return [];
    if (event.type === 3) {
      const body = exactMap(event.body, [0, 1, 2], "Bundle Registered body");
      return [
        {
          bundleId: identifierValue(mapValue(body, 0), "Bundle"),
          causeId: event.recordId,
          value: identifierValue(mapValue(body, 2), "Collection"),
        },
      ];
    }
    if (event.type !== 6) return [];
    const body = exactMap(event.body, [0, 1], "Captures Moved body");
    return arrayValue(mapValue(body, 0), "Capture moves").map((entry, index) => {
      const move = exactMap(entry, [0, 1, 2], `Capture move ${index}`);
      return {
        bundleId: identifierValue(mapValue(move, 0), "Bundle"),
        causeId: event.recordId,
        value: identifierValue(mapValue(move, 2), "Collection"),
      };
    });
  });
}

function eventCollectionTitles(replay: ReplayedCanonicalVault): readonly CollectionTitleFact[] {
  return replay.events.flatMap((event): readonly CollectionTitleFact[] => {
    if (event.family !== 2 || event.type !== 7) return [];
    const body = exactMap(event.body, [0, 1], "Collection Title body");
    return [
      {
        collectionId: identifierValue(mapValue(body, 0), "Collection"),
        causeId: event.recordId,
        value: nullable(mapValue(body, 1), (value) => textValue(value, "Collection title")),
      },
    ];
  });
}

function uniqueRecordIds(
  values: readonly Identifier<"VaultRecord">[],
): readonly Identifier<"VaultRecord">[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function sameRecordIdSet(
  left: readonly Identifier<"VaultRecord">[],
  right: readonly Identifier<"VaultRecord">[],
): boolean {
  const leftKeys = new Set(left.map(key));
  return leftKeys.size === right.length && right.every((value) => leftKeys.has(key(value)));
}

export function reduceCollectionRedirects(replay: ReplayedCanonicalVault) {
  const facts = new Map<string, CollectionRedirectFact>();
  const inactive = new Set<string>();
  const activeEdges = (): readonly DirectedEdge[] =>
    [...facts.values()]
      .filter((fact) => !inactive.has(key(fact.causeId)))
      .flatMap(({ edges }) => edges);
  for (const [index, entry] of arrayValue(
    mapValue(baselineContentCheckpoint(replay.vault), 4),
    "Checkpointed Collections",
  ).entries()) {
    const collection = exactMap(entry, [...Array(8).keys()], `Checkpointed Collection ${index}`);
    const sourceId = identifierValue(mapValue(collection, 0), "Collection");
    const redirect = nullable(mapValue(collection, 5), (redirectValue) => {
      const value = exactMap(redirectValue, [0, 1], "Collection redirect");
      return {
        destinationId: identifierValue(mapValue(value, 0), "Collection"),
        causeId: identifierValue(mapValue(value, 1), "VaultRecord"),
      };
    });
    if (redirect !== null) {
      const fact = facts.get(key(redirect.causeId));
      const edge = { sourceId, destinationId: redirect.destinationId, causeId: redirect.causeId };
      facts.set(key(redirect.causeId), {
        causeId: redirect.causeId,
        edges: [...(fact?.edges ?? []), edge],
      });
    }
  }
  for (const [index, entry] of arrayValue(
    mapValue(baselineContentCheckpoint(replay.vault), 9),
    "Checkpointed Content Conflicts",
  ).entries()) {
    const conflict = exactMap(entry, [0, 1, 2], `Checkpointed Content Conflict ${index}`);
    const kind = oneOfCodes(
      mapValue(conflict, 0),
      [1, 2, 3, 4] as const,
      "Checkpointed Content Conflict kind",
    );
    if (kind !== 1) continue;
    for (const [candidateIndex, candidateValue] of arrayValue(
      mapValue(conflict, 2),
      "Checkpointed Collection Conflict candidates",
    ).entries()) {
      const candidate = exactMap(
        candidateValue,
        [0, 1],
        `Checkpointed Collection Conflict candidate ${candidateIndex}`,
      );
      const causeId = identifierValue(mapValue(candidate, 0), "VaultRecord");
      const state = exactMap(mapValue(candidate, 1), [0], "Collection Conflict candidate state");
      const edges = arrayValue(mapValue(state, 0), "Collection Conflict candidate redirects").map(
        (redirectValue) => {
          const redirect = exactMap(redirectValue, [0, 1], "Collection Conflict redirect");
          return {
            sourceId: identifierValue(mapValue(redirect, 0), "Collection"),
            destinationId: identifierValue(mapValue(redirect, 1), "Collection"),
            causeId,
          };
        },
      );
      const existing = facts.get(key(causeId));
      if (existing !== undefined) {
        const expected = new Set(
          existing.edges.map((edge) => `${key(edge.sourceId)}:${key(edge.destinationId)}`),
        );
        if (
          expected.size !== edges.length ||
          edges.some((edge) => !expected.has(`${key(edge.sourceId)}:${key(edge.destinationId)}`))
        ) {
          throw new TypeError("One Collection Conflict Cause has inconsistent candidate state");
        }
        continue;
      }
      facts.set(key(causeId), { causeId, edges });
    }
  }
  for (const event of replay.events) {
    if (event.family !== 2) continue;
    if (event.type === 8) {
      const body = exactMap(event.body, [0, 1], "Collections Merged body");
      const destinationId = identifierValue(mapValue(body, 1), "Collection");
      const edges = arrayValue(mapValue(body, 0), "Source Collection IDs").map((source) => ({
        sourceId: identifierValue(source, "Collection"),
        destinationId,
        causeId: event.recordId,
      }));
      facts.set(key(event.recordId), { causeId: event.recordId, edges });
    } else if (event.type === 9) {
      const body = exactMap(event.body, [0], "Collection Merge Reverted body");
      const revertedId = identifierValue(mapValue(body, 0), "VaultRecord");
      const reverted = facts.get(key(revertedId));
      if (reverted === undefined || !replay.graph.isAncestor(reverted.causeId, event.recordId)) {
        throw new TypeError("Collection merge reversion does not name an observed redirect fact");
      }
      inactive.add(key(revertedId));
    } else if (event.type === 10) {
      const body = exactMap(event.body, [0, 1], "Collection Merge Conflict Resolution body");
      const resolvedIds = arrayValue(mapValue(body, 0), "Conflicting Collection Cause IDs").map(
        (resolvedId) => identifierValue(resolvedId, "VaultRecord"),
      );
      const current = reduceDirectedGraph(activeEdges(), replay.graph);
      const touchedConflicts = current.conflicts.filter((conflict) =>
        conflict.candidates.some((candidate) =>
          resolvedIds.some((resolvedId) => bytesEqual(candidate.causeId, resolvedId)),
        ),
      );
      if (
        touchedConflicts.length === 0 ||
        touchedConflicts.some(
          (conflict) =>
            !sameRecordIdSet(
              uniqueRecordIds(conflict.candidates.map(({ causeId }) => causeId)),
              resolvedIds,
            ),
        )
      ) {
        throw new TypeError(
          "Collection resolution does not name one exact current conflict Cause set",
        );
      }
      const affectedSources = new Set<string>();
      for (const causeId of resolvedIds) {
        const resolved = facts.get(key(causeId));
        if (
          resolved === undefined ||
          inactive.has(key(causeId)) ||
          !replay.graph.isAncestor(resolved.causeId, event.recordId)
        ) {
          throw new TypeError("Collection resolution does not observe every named redirect fact");
        }
        for (const edge of resolved.edges) affectedSources.add(key(edge.sourceId));
        inactive.add(key(causeId));
      }
      const replacementSources = new Set<string>();
      const edges = arrayValue(mapValue(body, 1), "Resolved Collection redirects").map((entry) => {
        const redirect = exactMap(entry, [0, 1], "Resolved Collection redirect");
        const sourceId = identifierValue(mapValue(redirect, 0), "Collection");
        const destinationId = identifierValue(mapValue(redirect, 1), "Collection");
        const sourceKey = key(sourceId);
        if (
          !affectedSources.has(sourceKey) ||
          replacementSources.has(sourceKey) ||
          bytesEqual(sourceId, destinationId)
        ) {
          throw new TypeError(
            "Collection resolution redirects do not exactly replace the affected identity set",
          );
        }
        replacementSources.add(sourceKey);
        return {
          sourceId,
          destinationId,
          causeId: event.recordId,
        };
      });
      facts.set(key(event.recordId), { causeId: event.recordId, edges });
      const replacement = reduceDirectedGraph(activeEdges(), replay.graph);
      if (
        replacement.conflicts.some(
          (conflict) =>
            conflict.candidates.some(({ causeId }) => bytesEqual(causeId, event.recordId)) ||
            conflict.subjectIds.some((subjectId) => affectedSources.has(key(subjectId))),
        )
      ) {
        throw new TypeError("Collection resolution does not establish one valid replacement graph");
      }
    }
  }
  const reduction = reduceDirectedGraph(activeEdges(), replay.graph);
  return {
    ...reduction,
    checkpointConflicts: reduction.conflicts.map((conflict) => {
      const causeIds = uniqueRecordIds(conflict.candidates.map(({ causeId }) => causeId));
      return {
        kind: 1 as const,
        subjectIds: canonicalSet(
          conflict.subjectIds.map((subjectId) => identifierValue(subjectId, "Collection")),
        ),
        candidates: causeIds
          .map((headCauseId) => {
            const fact = facts.get(key(headCauseId));
            if (fact === undefined) {
              throw new TypeError("Collection Conflict candidate state is unavailable");
            }
            return {
              headCauseId,
              redirects: fact.edges
                .map((edge) => ({
                  sourceId: identifierValue(edge.sourceId, "Collection"),
                  destinationId: identifierValue(edge.destinationId, "Collection"),
                }))
                .toSorted(
                  (left, right) =>
                    compareBytes(left.sourceId, right.sourceId) ||
                    compareBytes(left.destinationId, right.destinationId),
                ),
            };
          })
          .toSorted((left, right) => compareBytes(left.headCauseId, right.headCauseId)),
      };
    }),
  };
}

function resolveCollectionRedirect(
  collectionId: Identifier<"Collection">,
  edges: readonly DirectedEdge[],
): Identifier<"Collection"> {
  const bySource = new Map(edges.map((edge) => [key(edge.sourceId), edge.destinationId]));
  let current = collectionId;
  const seen = new Set<string>();
  while (bySource.has(key(current))) {
    if (seen.has(key(current)))
      throw new TypeError("Effective Collection redirects contain a cycle");
    seen.add(key(current));
    current = bySource.get(key(current)) as Identifier<"Collection">;
  }
  return current;
}

function selectRegistrations(facts: readonly RegistrationFact[]): {
  readonly accepted: readonly RegistrationFact[];
  readonly conflicts: readonly CanonicalCaptureIdentityConflict[];
} {
  const grouped = new Map<string, RegistrationFact[]>();
  for (const fact of facts)
    grouped.set(key(fact.bundleId), [...(grouped.get(key(fact.bundleId)) ?? []), fact]);
  const accepted: RegistrationFact[] = [];
  const conflicts: CanonicalCaptureIdentityConflict[] = [];
  for (const candidates of grouped.values()) {
    const first = candidates[0] as RegistrationFact;
    if (
      candidates.every(
        (candidate) =>
          bytesEqual(candidate.descriptorObjectId, first.descriptorObjectId) &&
          bytesEqual(candidate.assignedCollectionId, first.assignedCollectionId),
      )
    ) {
      accepted.push(
        [...candidates].sort((left, right) =>
          compareBytes(left.registrationRecordId, right.registrationRecordId),
        )[0] as RegistrationFact,
      );
    } else {
      conflicts.push({
        kind: "CaptureIdentity",
        bundleId: first.bundleId,
        registrationRecordIds: canonicalSet(
          candidates.map(({ registrationRecordId }) => registrationRecordId),
        ),
      });
    }
  }
  return {
    accepted: accepted.toSorted((left, right) => compareBytes(left.bundleId, right.bundleId)),
    conflicts: conflicts.toSorted((left, right) => compareBytes(left.bundleId, right.bundleId)),
  };
}

function descriptorFields(object: VaultObject): {
  readonly bundleId: Identifier<"Bundle">;
  readonly capturedAt: number | bigint;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly profile: string;
  readonly adapter: string;
  readonly primaryArtifactObjectId: Identifier<"VaultObject">;
} {
  if (object.objectType !== 1) throw new TypeError("Bundle dependency is not a Descriptor Object");
  const body = exactMap(object.body, [...Array(12).keys()], "Bundle Descriptor body");
  const references = arrayValue(mapValue(body, 9), "Artifact references").map((entry, index) => {
    const reference = exactMap(entry, [0, 1], `Artifact reference ${index}`);
    return {
      objectId: identifierValue(mapValue(reference, 0), "VaultObject"),
      role: textValue(mapValue(reference, 1), `Artifact reference ${index} role`),
    };
  });
  const primary = references.find(({ role }) => role === "awsm.artifact.primary");
  if (primary === undefined) throw new TypeError("Bundle Descriptor has no primary Artifact");
  return {
    bundleId: identifierValue(mapValue(body, 1), "Bundle"),
    capturedAt: signedInteger(mapValue(body, 2), "Capture capturedAt"),
    originalUrl: textValue(mapValue(body, 3), "Capture original URL"),
    finalUrl: textValue(mapValue(body, 4), "Capture final URL"),
    profile: textValue(mapValue(body, 5), "Capture profile"),
    adapter: textValue(mapValue(body, 6), "Capture adapter"),
    title: nullable(mapValue(body, 8), (value) => textValue(value, "Capture title")),
    primaryArtifactObjectId: primary.objectId,
  };
}

function noteContentFields(object: VaultObject): {
  readonly title: string | null;
  readonly body: string;
  readonly bodyDialect: "awsm.note.commonmark";
} {
  if (object.objectType !== NOTE_CONTENT_OBJECT) {
    throw new TypeError("Note dependency is not a Note Content Object");
  }
  const body = exactMap(object.body, [0, 1, 2, 3], "Note Content Object body");
  exactCode(mapValue(body, 0), 1, "Note Content format");
  const bodyDialect = mapValue(body, 3);
  if (bodyDialect !== "awsm.note.commonmark") {
    throw new TypeError("Note Content Object has an unknown body dialect");
  }
  return {
    title: nullable(mapValue(body, 1), (value) =>
      textValue(value, "Note title", { maxUtf8Bytes: 1_024 }),
    ),
    body: textValue(mapValue(body, 2), "Note body", { allowLineFeed: true, allowEmpty: true }),
    bodyDialect,
  };
}

export class CanonicalLibraryProjectionService {
  readonly replay: CanonicalReplayService;

  constructor(
    readonly vaults: CanonicalVaultService,
    readonly artifacts: CanonicalArtifactStore,
  ) {
    this.replay = new CanonicalReplayService(vaults);
  }

  async load(vaultId: Identifier<"Vault">): Promise<CanonicalLibraryProjection> {
    const vault = await this.vaults.openVault(vaultId);
    const cached = await this.readCache(vault);
    if (cached !== undefined) return cached;
    const projection = await this.rebuildOpened(vault);
    await this.writeCache(vault, projection);
    return projection;
  }

  async rebuildOpened(vault: PersistedOpenedCanonicalVault): Promise<CanonicalLibraryProjection> {
    const replay = await this.replay.replayOpened(vault);
    const selected = selectRegistrations([
      ...baselineRegistrations(vault),
      ...eventRegistrations(replay),
    ]);
    const lifecycleFacts = [...baselineCaptureLifecycles(vault), ...eventCaptureLifecycles(replay)];
    const placementFacts = [...baselineCapturePlacements(vault), ...eventCapturePlacements(replay)];
    const titleFacts = [...baselineCollectionTitles(vault), ...eventCollectionTitles(replay)];
    const baselineCollectionState = baselineEffectiveCollectionState(vault);
    const redirectReduction = reduceCollectionRedirects(replay);
    const folderProjection = reduceCanonicalFolders(replay);
    const collectionFolderPlacements = reduceCanonicalCollectionFolders(replay, folderProjection);
    const tagProjection = reduceCanonicalTags(replay);
    const noteProjection = reduceCanonicalNotes(replay);
    const redirectEdges = redirectReduction.edges;
    const objectCache = new Map<string, VaultObject>();
    const loadObject = async (objectId: Identifier<"VaultObject">): Promise<VaultObject> => {
      const objectKey = key(objectId);
      const cached = objectCache.get(objectKey);
      if (cached !== undefined) return cached;
      const object = decodeVaultObject(
        (
          await this.vaults.openResolvedCompactItem({
            vault,
            kind: 3,
            logicalId: objectId,
            namespace: NAMESPACES.vaultObject.key,
            payloadType: 2,
          })
        ).payloadBytes,
      );
      if (
        !bytesEqual(object.objectId, objectId) ||
        !bytesEqual(object.vaultId, vault.replicaState.vaultId) ||
        !bytesEqual(object.requiredFeatureSetId, vault.replicaState.requiredFeatureSetId)
      ) {
        throw new TypeError("Resolved Vault Object belongs to another authoritative context");
      }
      objectCache.set(objectKey, object);
      for (const referencedId of object.referencedObjectIds) await loadObject(referencedId);
      return object;
    };
    const captures = await Promise.all(
      selected.accepted.map(async (registration): Promise<CanonicalLibraryCapture> => {
        const descriptor = await loadObject(registration.descriptorObjectId);
        const fields = descriptorFields(descriptor);
        if (!bytesEqual(fields.bundleId, registration.bundleId)) {
          throw new TypeError("Bundle registration and Descriptor IDs do not match");
        }
        const artifactObject = await loadObject(fields.primaryArtifactObjectId);
        const logicalArtifactId = artifactId(artifactObject);
        const resolution = await this.vaults.readLogicalResolution({
          vault,
          kind: 5,
          logicalId: logicalArtifactId,
        });
        const available =
          resolution.availability === 1 && (await this.artifacts.has(resolution.storageItemId));
        const lifecycle = reduceCausalScalar(
          lifecycleFacts.filter((fact) => bytesEqual(fact.bundleId, registration.bundleId)),
          replay.graph,
        );
        const placement = reduceCausalScalar(
          placementFacts.filter((fact) => bytesEqual(fact.bundleId, registration.bundleId)),
          replay.graph,
        );
        return {
          ...registration,
          lifecycle: lifecycle?.value ?? registration.lifecycle,
          currentCollectionId: placement?.value ?? registration.assignedCollectionId,
          effectiveCollectionId: resolveCollectionRedirect(
            placement?.value ?? registration.assignedCollectionId,
            redirectEdges,
          ),
          capturedAt: fields.capturedAt,
          originalUrl: fields.originalUrl,
          finalUrl: fields.finalUrl,
          title: fields.title,
          profile: fields.profile,
          adapter: fields.adapter,
          artifactObjectId: artifactObject.objectId,
          artifactId: logicalArtifactId,
          artifactStorageItemId: resolution.storageItemId,
          artifactAvailableLocally: available,
        };
      }),
    );
    captures.sort((left, right) => {
      if (replay.graph.isAncestor(left.registrationRecordId, right.registrationRecordId)) return -1;
      if (replay.graph.isAncestor(right.registrationRecordId, left.registrationRecordId)) return 1;
      return (
        compareInteger(left.capturedAt, right.capturedAt) ||
        compareBytes(left.registrationRecordId, right.registrationRecordId)
      );
    });
    const collectionIds = new Map<string, Identifier<"Collection">>();
    for (const entry of arrayValue(
      mapValue(baselineContentCheckpoint(vault), 4),
      "Checkpointed Collections",
    )) {
      const collection = exactMap(entry, [...Array(8).keys()], "Checkpointed Collection");
      const collectionId = identifierValue(mapValue(collection, 0), "Collection");
      collectionIds.set(key(collectionId), collectionId);
    }
    for (const capture of captures) {
      collectionIds.set(key(capture.assignedCollectionId), capture.assignedCollectionId);
      collectionIds.set(key(capture.currentCollectionId), capture.currentCollectionId);
      collectionIds.set(key(capture.effectiveCollectionId), capture.effectiveCollectionId);
    }
    for (const title of titleFacts) collectionIds.set(key(title.collectionId), title.collectionId);
    for (const placement of collectionFolderPlacements) {
      collectionIds.set(key(placement.collectionId), placement.collectionId);
    }
    for (const edge of redirectEdges) {
      collectionIds.set(key(edge.sourceId), edge.sourceId as Identifier<"Collection">);
      collectionIds.set(key(edge.destinationId), edge.destinationId as Identifier<"Collection">);
    }
    const collections = [...collectionIds.values()]
      .map((collectionId): CanonicalLibraryCollection => {
        const active = captures.filter(
          (capture) =>
            capture.lifecycle === 1 && bytesEqual(capture.effectiveCollectionId, collectionId),
        );
        const checkpoint = baselineCollectionState.get(key(collectionId));
        const tail = selectCanonicalCollectionTail({
          candidates: active,
          checkpointActiveBundleIds: checkpoint?.activeBundleIds ?? [],
          checkpointTailBundleId: checkpoint?.tailBundleId ?? null,
          graph: replay.graph,
        });
        const explicitTitle = reduceCausalScalar(
          titleFacts.filter((fact) => bytesEqual(fact.collectionId, collectionId)),
          replay.graph,
        )?.value;
        const folderId =
          collectionFolderPlacements.find((placement) =>
            bytesEqual(placement.collectionId, collectionId),
          )?.effectiveFolderId ?? null;
        return {
          collectionId,
          explicitTitle: explicitTitle ?? null,
          title: explicitTitle ?? tail?.title ?? tail?.finalUrl ?? "Empty Collection",
          tailBundleId: tail?.bundleId ?? null,
          activeCaptureCount: active.length,
          redirectedTo: bytesEqual(
            resolveCollectionRedirect(collectionId, redirectEdges),
            collectionId,
          )
            ? null
            : resolveCollectionRedirect(collectionId, redirectEdges),
          folderId,
        };
      })
      .toSorted((left, right) => compareBytes(left.collectionId, right.collectionId));
    const notes = await Promise.all(
      noteProjection.notes.map(async (note): Promise<CanonicalLibraryNote> => {
        const targetExists =
          note.targetKind === 1
            ? collections.some((collection) => bytesEqual(collection.collectionId, note.targetId))
            : captures.some((capture) => bytesEqual(capture.bundleId, note.targetId));
        if (!targetExists) throw new TypeError("Note target is not in the Vault");
        return {
          ...note,
          versions: await Promise.all(
            note.versions.map(async (version): Promise<CanonicalLibraryNoteVersion> => {
              if (version.contentObjectId === null) {
                return {
                  ...version,
                  title: null,
                  body: null,
                  bodyDialect: null,
                };
              }
              return {
                ...version,
                ...noteContentFields(await loadObject(version.contentObjectId)),
              };
            }),
          ),
        };
      }),
    );
    return {
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      frontier: vault.replicaState.causalFrontier,
      captures,
      collections,
      folders: folderProjection.folders,
      tags: tagProjection.tags,
      tagAssignments: tagProjection.assignments,
      notes,
      conflicts: [
        ...selected.conflicts,
        ...redirectReduction.conflicts.map(
          (conflict): CanonicalCollectionMergeConflict => ({
            kind: "CollectionMerge",
            reason: conflict.kind === "cycle" ? "Cycle" : "MultipleDestinations",
            subjectCollectionIds: canonicalSet(
              conflict.subjectIds.map((id) => identifierValue(id, "Collection")),
            ),
            candidateRecordIds: canonicalSet(
              uniqueRecordIds(conflict.candidates.map(({ causeId }) => causeId)),
            ),
          }),
        ),
        ...folderProjection.conflicts,
        ...noteProjection.conflicts,
      ],
    };
  }

  private async readCache(
    vault: PersistedOpenedCanonicalVault,
  ): Promise<CanonicalLibraryProjection | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.libraryProjection.key,
      scopeKey: identifierStorageKey(vault.replicaState.vaultId),
      itemKey: "current",
    });
    if (bytes === undefined) return undefined;
    try {
      const projection = decodeCanonicalLibraryProjection(
        await openWrappedLocalState({
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.library-projection",
          vaultId: vault.replicaState.vaultId,
          identity: vault.replicaState.generationId,
          wrappedBytes: bytes,
        }),
      );
      return bytesEqual(projection.vaultId, vault.replicaState.vaultId) &&
        bytesEqual(projection.generationId, vault.replicaState.generationId) &&
        sameIdSet(projection.frontier, vault.replicaState.causalFrontier)
        ? projection
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(
    vault: PersistedOpenedCanonicalVault,
    projection: CanonicalLibraryProjection,
  ): Promise<void> {
    await this.vaults.storage.putMutable(
      this.vaults.realm,
      await prepareWrappedLocalStateItem({
        namespace: NAMESPACES.libraryProjection.key,
        scopeKey: identifierStorageKey(vault.replicaState.vaultId),
        itemKey: "current",
        wrappingKey: vault.installationWrappingKey,
        domain: "awsm.local.library-projection",
        context: canonicalLocalStorageContext(
          vault.replicaState.vaultId,
          vault.replicaState.generationId,
        ),
        bytes: encodeCanonicalLibraryProjection(projection),
      }),
    );
  }
}

function sameIdSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return (
    left.length === right.length &&
    new Set(left.map(key)).size === left.length &&
    right.every((id) => left.some((candidate) => bytesEqual(candidate, id)))
  );
}

export function encodeCanonicalLibraryProjection(value: CanonicalLibraryProjection): Uint8Array {
  return encodeCanonicalValue(
    indexedMap(
      LIBRARY_PROJECTION_FORMAT,
      value.vaultId,
      value.generationId,
      canonicalSet(value.frontier),
      value.captures.map((capture) =>
        indexedMap(
          capture.bundleId,
          capture.descriptorObjectId,
          capture.assignedCollectionId,
          capture.currentCollectionId,
          capture.effectiveCollectionId,
          capture.registrationRecordId,
          capture.memberId,
          capture.clientCredentialId,
          capture.assertedAt,
          capture.capturedAt,
          capture.originalUrl,
          capture.finalUrl,
          capture.title,
          capture.profile,
          capture.adapter,
          capture.artifactObjectId,
          capture.artifactId,
          capture.artifactStorageItemId,
          capture.artifactAvailableLocally,
          capture.lifecycle,
        ),
      ),
      value.conflicts.map((conflict) =>
        conflict.kind === "CaptureIdentity"
          ? indexedMap(1, conflict.bundleId, canonicalSet(conflict.registrationRecordIds))
          : conflict.kind === "CollectionMerge"
            ? indexedMap(
                2,
                conflict.reason === "Cycle" ? 2 : 1,
                canonicalSet(conflict.subjectCollectionIds),
                canonicalSet(conflict.candidateRecordIds),
              )
            : conflict.kind === "Folder"
              ? indexedMap(
                  3,
                  canonicalSet(conflict.subjectFolderIds),
                  canonicalSet(conflict.candidateRecordIds),
                )
              : indexedMap(4, conflict.noteId, canonicalSet(conflict.candidateRecordIds)),
      ),
      value.collections.map((collection) =>
        indexedMap(
          collection.collectionId,
          collection.explicitTitle,
          collection.title,
          collection.tailBundleId,
          collection.activeCaptureCount,
          collection.redirectedTo,
          collection.folderId,
        ),
      ),
      value.folders.map((folder) =>
        indexedMap(
          folder.folderId,
          folder.name,
          canonicalSet(folder.nameHeadCauseIds),
          folder.parentFolderId,
          canonicalSet(folder.parentHeadCauseIds),
          folder.effectiveParentFolderId,
          folder.lifecycle,
          canonicalSet(folder.lifecycleHeadCauseIds),
        ),
      ),
      value.tags.map((tag) =>
        indexedMap(
          tag.tagId,
          tag.name,
          canonicalSet(tag.nameHeadCauseIds),
          tag.lifecycle,
          canonicalSet(tag.lifecycleHeadCauseIds),
          tag.redirectedTo,
        ),
      ),
      value.tagAssignments.map((assignment) =>
        indexedMap(
          assignment.assignmentId,
          assignment.assignedCauseId,
          assignment.tagId,
          assignment.effectiveTagId,
          assignment.targetKind,
          assignment.targetId,
          assignment.active,
        ),
      ),
      value.notes.map((note) =>
        indexedMap(
          note.noteId,
          note.targetKind,
          note.targetId,
          note.state,
          note.versions.map((version) =>
            indexedMap(
              version.headCauseId,
              version.contentObjectId,
              version.title,
              version.body,
              version.bodyDialect,
              version.originVaultId,
              version.memberId,
              version.clientCredentialId,
              version.assertedAt,
            ),
          ),
        ),
      ),
    ),
  );
}

export function decodeCanonicalLibraryProjection(bytes: Uint8Array): CanonicalLibraryProjection {
  const map = exactMap(decodeCanonicalValue(bytes), [...Array(11).keys()], "Library Projection");
  exactCode(mapValue(map, 0), LIBRARY_PROJECTION_FORMAT, "Library Projection format");
  const capturesValue = mapValue(map, 4);
  if (!Array.isArray(capturesValue)) throw new TypeError("Library captures must be an array");
  const captures = capturesValue.map((entry, index): CanonicalLibraryCapture => {
    const capture = exactMap(entry, [...Array(20).keys()], `Library Capture ${index}`);
    return {
      bundleId: identifierValue(mapValue(capture, 0), "Bundle"),
      descriptorObjectId: identifierValue(mapValue(capture, 1), "VaultObject"),
      assignedCollectionId: identifierValue(mapValue(capture, 2), "Collection"),
      currentCollectionId: identifierValue(mapValue(capture, 3), "Collection"),
      effectiveCollectionId: identifierValue(mapValue(capture, 4), "Collection"),
      registrationRecordId: identifierValue(mapValue(capture, 5), "VaultRecord"),
      memberId: identifierValue(mapValue(capture, 6), "Member"),
      clientCredentialId: identifierValue(mapValue(capture, 7), "ClientCredential"),
      assertedAt: signedInteger(mapValue(capture, 8), "Registration assertedAt"),
      capturedAt: signedInteger(mapValue(capture, 9), "Capture capturedAt"),
      originalUrl: textValue(mapValue(capture, 10), "Capture original URL"),
      finalUrl: textValue(mapValue(capture, 11), "Capture final URL"),
      title: nullable(mapValue(capture, 12), (value) => textValue(value, "Capture title")),
      profile: textValue(mapValue(capture, 13), "Capture profile"),
      adapter: textValue(mapValue(capture, 14), "Capture adapter"),
      artifactObjectId: identifierValue(mapValue(capture, 15), "VaultObject"),
      artifactId: identifierValue(mapValue(capture, 16), "Artifact"),
      artifactStorageItemId: identifierValue(mapValue(capture, 17), "StorageItem"),
      artifactAvailableLocally: booleanValue(mapValue(capture, 18), "Artifact availability"),
      lifecycle: oneOfCodes(mapValue(capture, 19), [1, 2] as const, "Capture lifecycle"),
    };
  });
  const conflictsValue = mapValue(map, 5);
  if (!Array.isArray(conflictsValue)) throw new TypeError("Library conflicts must be an array");
  const value: CanonicalLibraryProjection = {
    vaultId: identifierValue(mapValue(map, 1), "Vault"),
    generationId: identifierValue(mapValue(map, 2), "Generation"),
    frontier: canonicalSetValue(mapValue(map, 3), "Projection Frontier", (id) =>
      identifierValue(id, "VaultRecord"),
    ),
    captures,
    collections: arrayValue(mapValue(map, 6), "Library collections").map((entry, index) => {
      const collection = exactMap(entry, [0, 1, 2, 3, 4, 5, 6], `Library Collection ${index}`);
      const activeCaptureCount = signedInteger(mapValue(collection, 4), "Active Capture count");
      if (typeof activeCaptureCount !== "number" || activeCaptureCount < 0) {
        throw new TypeError("Active Capture count must be a nonnegative safe integer");
      }
      return {
        collectionId: identifierValue(mapValue(collection, 0), "Collection"),
        explicitTitle: nullable(mapValue(collection, 1), (value) =>
          textValue(value, "Collection explicit title"),
        ),
        title: textValue(mapValue(collection, 2), "Collection title"),
        tailBundleId: nullable(mapValue(collection, 3), (value) =>
          identifierValue(value, "Bundle"),
        ),
        activeCaptureCount,
        redirectedTo: nullable(mapValue(collection, 5), (value) =>
          identifierValue(value, "Collection"),
        ),
        folderId: nullable(mapValue(collection, 6), (value) => identifierValue(value, "Folder")),
      };
    }),
    folders: arrayValue(mapValue(map, 7), "Library folders").map((entry, index) => {
      const folder = exactMap(entry, [...Array(8).keys()], `Library Folder ${index}`);
      return {
        folderId: identifierValue(mapValue(folder, 0), "Folder"),
        name: textValue(mapValue(folder, 1), "Folder name", { maxUtf8Bytes: 1_024 }),
        nameHeadCauseIds: idSetValue(mapValue(folder, 2), "VaultRecord", "Folder name heads", {
          nonempty: true,
        }),
        parentFolderId: nullable(mapValue(folder, 3), (value) => identifierValue(value, "Folder")),
        parentHeadCauseIds: idSetValue(mapValue(folder, 4), "VaultRecord", "Folder parent heads"),
        effectiveParentFolderId: nullable(mapValue(folder, 5), (value) =>
          identifierValue(value, "Folder"),
        ),
        lifecycle: oneOfCodes(mapValue(folder, 6), [1, 2] as const, "Folder lifecycle"),
        lifecycleHeadCauseIds: idSetValue(
          mapValue(folder, 7),
          "VaultRecord",
          "Folder lifecycle heads",
          { nonempty: true },
        ),
      };
    }),
    tags: arrayValue(mapValue(map, 8), "Library Tags").map((entry, index) => {
      const tag = exactMap(entry, [0, 1, 2, 3, 4, 5], `Library Tag ${index}`);
      return {
        tagId: identifierValue(mapValue(tag, 0), "Tag"),
        name: textValue(mapValue(tag, 1), "Tag name", { maxUtf8Bytes: 1_024 }),
        nameHeadCauseIds: idSetValue(mapValue(tag, 2), "VaultRecord", "Tag name heads", {
          nonempty: true,
        }),
        lifecycle: oneOfCodes(mapValue(tag, 3), [1, 2] as const, "Tag lifecycle"),
        lifecycleHeadCauseIds: idSetValue(mapValue(tag, 4), "VaultRecord", "Tag lifecycle heads", {
          nonempty: true,
        }),
        redirectedTo: nullable(mapValue(tag, 5), (value) => identifierValue(value, "Tag")),
      };
    }),
    tagAssignments: arrayValue(mapValue(map, 9), "Library Tag Assignments").map((entry, index) => {
      const assignment = exactMap(entry, [0, 1, 2, 3, 4, 5, 6], `Tag Assignment ${index}`);
      const targetKind = oneOfCodes(mapValue(assignment, 4), [1, 2] as const, "Tag target kind");
      return {
        assignmentId: identifierValue(mapValue(assignment, 0), "TagAssignment"),
        assignedCauseId: identifierValue(mapValue(assignment, 1), "VaultRecord"),
        tagId: identifierValue(mapValue(assignment, 2), "Tag"),
        effectiveTagId: identifierValue(mapValue(assignment, 3), "Tag"),
        targetKind,
        targetId:
          targetKind === 1
            ? identifierValue(mapValue(assignment, 5), "Collection")
            : identifierValue(mapValue(assignment, 5), "Bundle"),
        active: booleanValue(mapValue(assignment, 6), "Tag Assignment activity"),
      };
    }),
    notes: arrayValue(mapValue(map, 10), "Library Notes").map((entry, index) => {
      const note = exactMap(entry, [0, 1, 2, 3, 4], `Library Note ${index}`);
      const targetKind = oneOfCodes(mapValue(note, 1), [1, 2] as const, "Note target kind");
      const state = oneOfCodes(mapValue(note, 3), [1, 2, 3] as const, "Note state");
      const versions = arrayValue(mapValue(note, 4), "Note versions").map((value, versionIndex) => {
        const version = exactMap(
          value,
          [...Array(9).keys()],
          `Library Note ${index} version ${versionIndex}`,
        );
        const contentObjectId = nullable(mapValue(version, 1), (contentId) =>
          identifierValue(contentId, "VaultObject"),
        );
        const title = nullable(mapValue(version, 2), (text) =>
          textValue(text, "Note title", { maxUtf8Bytes: 1_024 }),
        );
        const body = nullable(mapValue(version, 3), (text) =>
          textValue(text, "Note body", { allowLineFeed: true, allowEmpty: true }),
        );
        const bodyDialect = nullable(mapValue(version, 4), (dialect) => {
          if (dialect !== "awsm.note.commonmark") {
            throw new TypeError("Library Note has an unknown body dialect");
          }
          return "awsm.note.commonmark" as const;
        });
        if (
          (contentObjectId === null && (title !== null || body !== null || bodyDialect !== null)) ||
          (contentObjectId !== null && (body === null || bodyDialect === null))
        ) {
          throw new TypeError("Library Note version content fields are inconsistent");
        }
        return {
          headCauseId: identifierValue(mapValue(version, 0), "VaultRecord"),
          contentObjectId,
          title,
          body,
          bodyDialect,
          originVaultId: identifierValue(mapValue(version, 5), "Vault"),
          memberId: identifierValue(mapValue(version, 6), "Member"),
          clientCredentialId: identifierValue(mapValue(version, 7), "ClientCredential"),
          assertedAt: signedInteger(mapValue(version, 8), "Note asserted timestamp"),
        };
      });
      if (
        versions.length === 0 ||
        (state === 1 && (versions.length !== 1 || versions[0]?.contentObjectId === null)) ||
        (state === 2 && versions.some(({ contentObjectId }) => contentObjectId !== null)) ||
        (state === 3 && versions.length < 2)
      ) {
        throw new TypeError("Library Note state and versions are inconsistent");
      }
      return {
        noteId: identifierValue(mapValue(note, 0), "Note"),
        targetKind,
        targetId:
          targetKind === 1
            ? identifierValue(mapValue(note, 2), "Collection")
            : identifierValue(mapValue(note, 2), "Bundle"),
        state,
        versions,
      };
    }),
    conflicts: conflictsValue.map((entry, index): CanonicalLibraryConflict => {
      if (!(entry instanceof Map)) throw new TypeError(`Library conflict ${index} must be a map`);
      const kind = oneOfCodes(mapValue(entry, 0), [1, 2, 3, 4] as const, "Library conflict kind");
      if (kind === 1) {
        const conflict = exactMap(entry, [0, 1, 2], `Capture identity conflict ${index}`);
        return {
          kind: "CaptureIdentity",
          bundleId: identifierValue(mapValue(conflict, 1), "Bundle"),
          registrationRecordIds: canonicalSetValue(
            mapValue(conflict, 2),
            "Conflicting registration IDs",
            (id) => identifierValue(id, "VaultRecord"),
            { nonempty: true },
          ),
        };
      }
      if (kind === 3) {
        const conflict = exactMap(entry, [0, 1, 2], `Folder conflict ${index}`);
        return {
          kind: "Folder",
          subjectFolderIds: canonicalSetValue(
            mapValue(conflict, 1),
            "Conflicting Folder IDs",
            (id) => identifierValue(id, "Folder"),
            { nonempty: true },
          ),
          candidateRecordIds: canonicalSetValue(
            mapValue(conflict, 2),
            "Conflicting Folder Cause IDs",
            (id) => identifierValue(id, "VaultRecord"),
            { nonempty: true },
          ),
        };
      }
      if (kind === 4) {
        const conflict = exactMap(entry, [0, 1, 2], `Note conflict ${index}`);
        return {
          kind: "Note",
          noteId: identifierValue(mapValue(conflict, 1), "Note"),
          candidateRecordIds: canonicalSetValue(
            mapValue(conflict, 2),
            "Conflicting Note Cause IDs",
            (id) => identifierValue(id, "VaultRecord"),
            { nonempty: true },
          ),
        };
      }
      const conflict = exactMap(entry, [0, 1, 2, 3], `Collection merge conflict ${index}`);
      const reason = oneOfCodes(
        mapValue(conflict, 1),
        [1, 2] as const,
        "Collection conflict reason",
      );
      return {
        kind: "CollectionMerge",
        reason: reason === 2 ? "Cycle" : "MultipleDestinations",
        subjectCollectionIds: canonicalSetValue(
          mapValue(conflict, 2),
          "Conflicting Collection IDs",
          (id) => identifierValue(id, "Collection"),
          { nonempty: true },
        ),
        candidateRecordIds: canonicalSetValue(
          mapValue(conflict, 3),
          "Conflicting Collection Cause IDs",
          (id) => identifierValue(id, "VaultRecord"),
          { nonempty: true },
        ),
      };
    }),
  };
  if (!bytesEqual(encodeCanonicalLibraryProjection(value), bytes)) {
    throw new TypeError("Library Projection bytes are not canonical");
  }
  return value;
}

import { sha256 } from "@noble/hashes/sha2.js";

import { openCompactItem, sealCompactItem } from "../../crypto/compact";
import { DEPENDENCY_TYPES, type TypedDependency } from "../../domain/canonical/dependencies";
import { advisoryExtensions } from "../../domain/canonical/features";
import { type Identifier, identifier, randomIdentifier } from "../../domain/canonical/identifiers";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  encodeVaultBaseline,
  signVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { reduceCausalScalar } from "../../domain/canonical/reducers";
import {
  arrayValue,
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
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type { OpaqueEnvelope } from "../../storage/opaque-envelope";
import {
  reduceCanonicalCollectionFolders,
  reduceCanonicalFolders,
} from "../library/canonical-folder-projection";
import { reduceCanonicalNotes } from "../library/canonical-note-projection";
import { reduceCollectionRedirects } from "../library/canonical-projection";
import { reduceCanonicalTags } from "../library/canonical-tag-projection";
import type { ReplayedCanonicalVault } from "../projection/canonical-replay";
import type { CanonicalReplicaState } from "./canonical-local-state";

export interface CanonicalCheckpointAttribution {
  readonly originVaultId: Identifier<"Vault">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
}

export interface CanonicalCheckpointTail {
  readonly bundleId: Identifier<"Bundle">;
  readonly registrationCauseId: Identifier<"VaultRecord">;
}

export interface CanonicalVacuumCaptureState {
  readonly bundleId: Identifier<"Bundle">;
  readonly descriptorObjectId: Identifier<"VaultObject">;
  readonly assignedCollectionId: Identifier<"Collection">;
  readonly assignmentHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly lifecycle: 1 | 2;
  readonly lifecycleHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly registrationCauseId: Identifier<"VaultRecord">;
  readonly attribution: CanonicalCheckpointAttribution;
}

export interface CanonicalVacuumCollectionState {
  readonly collectionId: Identifier<"Collection">;
  readonly explicitTitle: string | null;
  readonly titleHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly folderId: Identifier<"Folder"> | null;
  readonly folderHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly activeRedirect: {
    readonly destinationCollectionId: Identifier<"Collection">;
    readonly controllingCauseId: Identifier<"VaultRecord">;
  } | null;
  readonly intrinsicTail: CanonicalCheckpointTail | null;
  readonly effectiveTail: CanonicalCheckpointTail | null;
}

export interface CanonicalVacuumFolderState {
  readonly folderId: Identifier<"Folder">;
  readonly name: string;
  readonly nameHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly parentFolderId: Identifier<"Folder"> | null;
  readonly parentHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly lifecycle: 1 | 2;
  readonly lifecycleHeadCauseIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalVacuumTagState {
  readonly tagId: Identifier<"Tag">;
  readonly name: string;
  readonly nameHeadCauseIds: readonly Identifier<"VaultRecord">[];
  readonly activeRedirect: {
    readonly destinationTagId: Identifier<"Tag">;
    readonly controllingCauseId: Identifier<"VaultRecord">;
  } | null;
  readonly lifecycle: 1 | 2;
  readonly lifecycleHeadCauseIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalVacuumTagAssignmentState {
  readonly assignmentId: Identifier<"TagAssignment">;
  readonly assignedCauseId: Identifier<"VaultRecord">;
  readonly tagId: Identifier<"Tag">;
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
}

export interface CanonicalVacuumNoteVersionState {
  readonly headCauseId: Identifier<"VaultRecord">;
  readonly contentObjectId: Identifier<"VaultObject"> | null;
  readonly restoreContentObjectId: Identifier<"VaultObject"> | null;
  readonly attribution: CanonicalCheckpointAttribution;
}

export interface CanonicalVacuumNoteState {
  readonly noteId: Identifier<"Note">;
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
  readonly state: 1 | 2 | 3;
  readonly versions: readonly CanonicalVacuumNoteVersionState[];
}

export type CanonicalVacuumConflictState =
  | {
      readonly kind: 1;
      readonly subjectIds: readonly Identifier<"Collection">[];
      readonly candidates: readonly {
        readonly headCauseId: Identifier<"VaultRecord">;
        readonly redirects: readonly {
          readonly sourceId: Identifier<"Collection">;
          readonly destinationId: Identifier<"Collection">;
        }[];
      }[];
    }
  | {
      readonly kind: 2;
      readonly subjectIds: readonly Identifier<"Folder">[];
      readonly candidates: readonly {
        readonly headCauseId: Identifier<"VaultRecord">;
        readonly placements: readonly {
          readonly folderId: Identifier<"Folder">;
          readonly parentFolderId: Identifier<"Folder"> | null;
        }[];
      }[];
    }
  | {
      readonly kind: 3;
      readonly subjectIds: readonly Identifier<"Tag">[];
      readonly candidates: readonly {
        readonly headCauseId: Identifier<"VaultRecord">;
        readonly redirects: readonly {
          readonly sourceId: Identifier<"Tag">;
          readonly destinationId: Identifier<"Tag">;
        }[];
      }[];
    }
  | {
      readonly kind: 4;
      readonly subjectIds: readonly Identifier<"Note">[];
      readonly candidates: readonly {
        readonly headCauseId: Identifier<"VaultRecord">;
        readonly noteId: Identifier<"Note">;
        readonly contentObjectId: Identifier<"VaultObject"> | null;
      }[];
    };

export interface CanonicalVacuumContentState {
  readonly vaultLabel: {
    readonly value: string | null;
    readonly headCauseIds: readonly Identifier<"VaultRecord">[];
  };
  readonly credentialLabels: readonly {
    readonly clientCredentialId: Identifier<"ClientCredential">;
    readonly value: string | null;
    readonly headCauseIds: readonly Identifier<"VaultRecord">[];
  }[];
  readonly captures: readonly CanonicalVacuumCaptureState[];
  readonly collections: readonly CanonicalVacuumCollectionState[];
  readonly folders: readonly CanonicalVacuumFolderState[];
  readonly tags: readonly CanonicalVacuumTagState[];
  readonly tagAssignments: readonly CanonicalVacuumTagAssignmentState[];
  readonly notes: readonly CanonicalVacuumNoteState[];
  readonly activeConflicts: readonly CanonicalVacuumConflictState[];
}

export interface CanonicalVacuumCauseMapping {
  readonly sourceCauseId: Identifier<"VaultRecord">;
  readonly baselineCauseId: Identifier<"BaselineCause">;
}

export interface CanonicalVacuumOmission {
  readonly kind: 1 | 2 | 3;
  readonly logicalId: Uint8Array;
}

export interface BuiltVacuumContentCheckpoint {
  readonly checkpoint: ReadonlyMap<number, CanonicalValue>;
  readonly causeMapping: readonly CanonicalVacuumCauseMapping[];
  readonly dependencies: readonly TypedDependency[];
  readonly omissions: readonly CanonicalVacuumOmission[];
}

export interface PreparedInitialAuthorityVacuumSuccessorBaseline {
  readonly contentState: CanonicalVacuumContentState;
  readonly content: BuiltVacuumContentCheckpoint;
  readonly baseline: VaultBaseline;
  readonly baselineEnvelope: OpaqueEnvelope;
  readonly predecessorStateDigest: Uint8Array;
  readonly successorStateDigest: Uint8Array;
  readonly omissionDigest: Uint8Array;
  readonly omissionCheckpoint: ReadonlyMap<number, CanonicalValue>;
}

export interface PreparedInitialAuthorityVacuum {
  readonly successor: PreparedInitialAuthorityVacuumSuccessorBaseline;
  readonly event: AuthenticatedVaultEvent;
  readonly eventEnvelope: OpaqueEnvelope;
  readonly continuityRecordIds: readonly Identifier<"VaultRecord">[];
  readonly adoptedReplicaState: CanonicalReplicaState;
}

interface CaptureHeadState extends CanonicalVacuumCaptureState {
  readonly currentCollectionId: Identifier<"Collection">;
}

function indexedMap(...values: readonly CanonicalValue[]): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap(values.map((value, index) => [index, value] as const));
}

function key(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return key(left).localeCompare(key(right));
}

function canonicalDependencies(values: readonly TypedDependency[]): readonly TypedDependency[] {
  const unique = new Map<string, TypedDependency>();
  for (const value of values) unique.set(`${value.type}:${key(value.id)}`, value);
  return [...unique.values()].toSorted(
    (left, right) => left.type - right.type || compareBytes(left.id, right.id),
  );
}

function attribution(value: CanonicalCheckpointAttribution): CanonicalValue {
  return indexedMap(
    value.originVaultId,
    value.memberId,
    value.clientCredentialId,
    value.assertedAt,
  );
}

function target(kind: 1 | 2, id: Identifier<"Collection"> | Identifier<"Bundle">): CanonicalValue {
  return indexedMap(kind, id);
}

function baselineInitialContent(replay: ReplayedCanonicalVault): {
  readonly vaultLabel: CanonicalVacuumContentState["vaultLabel"];
  readonly credentialLabels: CanonicalVacuumContentState["credentialLabels"];
} {
  const body = exactMap(replay.vault.baseline.body, [0, 1, 2, 3, 4, 5], "Vault Baseline body");
  exactCode(mapValue(body, 1), 1, "Initial Vacuum source Baseline kind");
  const content = exactMap(mapValue(body, 2), [...Array(10).keys()], "Content checkpoint");
  for (const [field, name] of [
    [3, "Captures"],
    [4, "Collections"],
    [5, "Folders"],
    [6, "Tags"],
    [7, "Tag assignments"],
    [8, "Notes"],
    [9, "Content Conflicts"],
  ] as const) {
    if (arrayValue(mapValue(content, field), `Initial Baseline ${name}`).length !== 0) {
      throw new TypeError("This Vacuum slice requires an Initial Baseline without Content state");
    }
  }
  const label = exactMap(mapValue(content, 1), [0, 1], "Checkpointed Vault label");
  return {
    vaultLabel: {
      value: nullable(mapValue(label, 0), (value) =>
        textValue(value, "Checkpointed Vault label", { maxUtf8Bytes: 1_024 }),
      ),
      headCauseIds: idSetValue(mapValue(label, 1), "VaultRecord", "Vault label Cause IDs"),
    },
    credentialLabels: arrayValue(mapValue(content, 2), "Checkpointed Credential labels").map(
      (entry, index) => {
        const labelEntry = exactMap(entry, [0, 1, 2], `Credential label ${index}`);
        return {
          clientCredentialId: identifierValue(mapValue(labelEntry, 0), "ClientCredential"),
          value: nullable(mapValue(labelEntry, 1), (value) =>
            textValue(value, "Credential label", { maxUtf8Bytes: 1_024 }),
          ),
          headCauseIds: idSetValue(
            mapValue(labelEntry, 2),
            "VaultRecord",
            "Credential label Cause IDs",
          ),
        };
      },
    ),
  };
}

export function deriveInitialAuthorityVacuumContentState(
  replay: ReplayedCanonicalVault,
): CanonicalVacuumContentState {
  if (replay.vault.replicaState.lifecycle !== 1) {
    throw new TypeError("Closed Vaults cannot be Vacuumed");
  }
  const initial = baselineInitialContent(replay);
  const labels: {
    readonly causeId: Identifier<"VaultRecord">;
    readonly value: string | null;
  }[] = [];
  const credentialLabels: {
    readonly clientCredentialId: Identifier<"ClientCredential">;
    readonly causeId: Identifier<"VaultRecord">;
    readonly value: string | null;
  }[] = [];
  const registrations: {
    readonly bundleId: Identifier<"Bundle">;
    readonly descriptorObjectId: Identifier<"VaultObject">;
    readonly assignedCollectionId: Identifier<"Collection">;
    readonly causeId: Identifier<"VaultRecord">;
    readonly attribution: CanonicalCheckpointAttribution;
  }[] = [];
  const lifecycleFacts: {
    readonly bundleId: Identifier<"Bundle">;
    readonly causeId: Identifier<"VaultRecord">;
    readonly value: 1 | 2;
  }[] = [];
  const placementFacts: {
    readonly bundleId: Identifier<"Bundle">;
    readonly causeId: Identifier<"VaultRecord">;
    readonly value: Identifier<"Collection">;
  }[] = [];
  const titleFacts: {
    readonly collectionId: Identifier<"Collection">;
    readonly causeId: Identifier<"VaultRecord">;
    readonly value: string | null;
  }[] = [];

  for (const event of replay.events) {
    if (event.family !== 2) continue;
    if (event.type > 7) continue;
    if (event.type === 1) {
      const body = exactMap(event.body, [0], "Vault Label body");
      labels.push({
        causeId: event.recordId,
        value: nullable(mapValue(body, 0), (value) =>
          textValue(value, "Vault label", { maxUtf8Bytes: 1_024 }),
        ),
      });
      continue;
    }
    if (event.type === 2) {
      const body = exactMap(event.body, [0, 1], "Client Credential Label body");
      credentialLabels.push({
        clientCredentialId: identifierValue(mapValue(body, 0), "ClientCredential"),
        causeId: event.recordId,
        value: nullable(mapValue(body, 1), (value) =>
          textValue(value, "Client Credential label", { maxUtf8Bytes: 1_024 }),
        ),
      });
      continue;
    }
    if (event.type === 3) {
      const body = exactMap(event.body, [0, 1, 2], "Bundle Registered body");
      const bundleId = identifierValue(mapValue(body, 0), "Bundle");
      const assignedCollectionId = identifierValue(mapValue(body, 2), "Collection");
      registrations.push({
        bundleId,
        descriptorObjectId: identifierValue(mapValue(body, 1), "VaultObject"),
        assignedCollectionId,
        causeId: event.recordId,
        attribution: {
          originVaultId: replay.vault.replicaState.vaultId,
          memberId: replay.vault.replicaState.memberId,
          clientCredentialId: event.signerCredentialId,
          assertedAt: event.assertedAt,
        },
      });
      lifecycleFacts.push({ bundleId, causeId: event.recordId, value: 1 });
      placementFacts.push({ bundleId, causeId: event.recordId, value: assignedCollectionId });
      continue;
    }
    if (event.type === 4 || event.type === 5) {
      const body = exactMap(
        event.body,
        [0],
        event.type === 4 ? "Captures Deleted body" : "Captures Restored body",
      );
      for (const value of arrayValue(mapValue(body, 0), "Capture lifecycle Bundle IDs")) {
        lifecycleFacts.push({
          bundleId: identifierValue(value, "Bundle"),
          causeId: event.recordId,
          value: event.type === 4 ? 2 : 1,
        });
      }
      continue;
    }
    if (event.type === 6) {
      const body = exactMap(event.body, [0, 1], "Captures Moved body");
      for (const [index, value] of arrayValue(mapValue(body, 0), "Capture moves").entries()) {
        const move = exactMap(value, [0, 1, 2], `Capture move ${index}`);
        placementFacts.push({
          bundleId: identifierValue(mapValue(move, 0), "Bundle"),
          causeId: event.recordId,
          value: identifierValue(mapValue(move, 2), "Collection"),
        });
      }
      continue;
    }
    const body = exactMap(event.body, [0, 1], "Collection Title body");
    titleFacts.push({
      collectionId: identifierValue(mapValue(body, 0), "Collection"),
      causeId: event.recordId,
      value: nullable(mapValue(body, 1), (value) =>
        textValue(value, "Collection title", { maxUtf8Bytes: 1_024 }),
      ),
    });
  }

  const registrationsByBundle = new Map<string, typeof registrations>();
  for (const registration of registrations) {
    const bundleKey = key(registration.bundleId);
    registrationsByBundle.set(bundleKey, [
      ...(registrationsByBundle.get(bundleKey) ?? []),
      registration,
    ]);
  }
  const captures: CaptureHeadState[] = [];
  for (const candidates of registrationsByBundle.values()) {
    const first = candidates[0];
    if (
      first === undefined ||
      candidates.some(
        (candidate) =>
          !bytesEqual(candidate.descriptorObjectId, first.descriptorObjectId) ||
          !bytesEqual(candidate.assignedCollectionId, first.assignedCollectionId),
      )
    ) {
      throw new TypeError("Vacuum preflight found a Capture identity conflict");
    }
    const registration = candidates.toSorted((left, right) =>
      compareBytes(left.causeId, right.causeId),
    )[0] as (typeof candidates)[number];
    const lifecycle = reduceCausalScalar(
      lifecycleFacts.filter((fact) => bytesEqual(fact.bundleId, registration.bundleId)),
      replay.graph,
    );
    const placement = reduceCausalScalar(
      placementFacts.filter((fact) => bytesEqual(fact.bundleId, registration.bundleId)),
      replay.graph,
    );
    if (lifecycle === null || placement === null) {
      throw new TypeError("Checkpointed Capture is missing current scalar state");
    }
    captures.push({
      bundleId: registration.bundleId,
      descriptorObjectId: registration.descriptorObjectId,
      assignedCollectionId: placement.value,
      assignmentHeadCauseIds: [placement.causeId],
      lifecycle: lifecycle.value,
      lifecycleHeadCauseIds: [lifecycle.causeId],
      registrationCauseId: registration.causeId,
      attribution: registration.attribution,
      currentCollectionId: placement.value,
    });
  }
  captures.sort((left, right) => compareBytes(left.bundleId, right.bundleId));

  const redirects = reduceCollectionRedirects(replay);
  const folderProjection = reduceCanonicalFolders(replay);
  const collectionFolders = reduceCanonicalCollectionFolders(replay, folderProjection);
  const tagProjection = reduceCanonicalTags(replay);
  const noteProjection = reduceCanonicalNotes(replay);
  if (
    redirects.conflicts.length > 0 ||
    folderProjection.conflicts.length > 0 ||
    noteProjection.conflicts.length > 0
  ) {
    throw new TypeError("Vacuum preflight requires every active Content Conflict to be resolved");
  }
  const redirectDestination = (sourceId: Identifier<"Collection">): Identifier<"Collection"> => {
    const destination = redirects.edges.find((edge) => bytesEqual(edge.sourceId, sourceId));
    return destination === undefined
      ? sourceId
      : redirectDestination(identifierValue(destination.destinationId, "Collection"));
  };
  const collectionIds = new Map<string, Identifier<"Collection">>();
  for (const registration of registrations) {
    collectionIds.set(key(registration.assignedCollectionId), registration.assignedCollectionId);
  }
  for (const capture of captures) {
    collectionIds.set(key(capture.currentCollectionId), capture.currentCollectionId);
  }
  for (const title of titleFacts) collectionIds.set(key(title.collectionId), title.collectionId);
  for (const placement of collectionFolders) {
    collectionIds.set(key(placement.collectionId), placement.collectionId);
  }
  for (const edge of redirects.edges) {
    const sourceId = identifierValue(edge.sourceId, "Collection");
    const destinationId = identifierValue(edge.destinationId, "Collection");
    collectionIds.set(key(sourceId), sourceId);
    collectionIds.set(key(destinationId), destinationId);
  }
  const selectTail = (eligible: readonly CaptureHeadState[]): CaptureHeadState | undefined =>
    eligible.toSorted((left, right) => {
      if (replay.graph.isAncestor(left.registrationCauseId, right.registrationCauseId)) return 1;
      if (replay.graph.isAncestor(right.registrationCauseId, left.registrationCauseId)) return -1;
      return compareBytes(left.registrationCauseId, right.registrationCauseId);
    })[0];
  const collections = [...collectionIds.values()]
    .map((collectionId): CanonicalVacuumCollectionState => {
      const title = reduceCausalScalar(
        titleFacts.filter((fact) => bytesEqual(fact.collectionId, collectionId)),
        replay.graph,
      );
      const intrinsic = selectTail(
        captures.filter(
          (capture) =>
            capture.lifecycle === 1 && bytesEqual(capture.assignedCollectionId, collectionId),
        ),
      );
      const effective = selectTail(
        captures.filter(
          (capture) =>
            capture.lifecycle === 1 &&
            bytesEqual(redirectDestination(capture.currentCollectionId), collectionId),
        ),
      );
      const folder = collectionFolders.find((placement) =>
        bytesEqual(placement.collectionId, collectionId),
      );
      const redirect = redirects.edges.find((edge) => bytesEqual(edge.sourceId, collectionId));
      return {
        collectionId,
        explicitTitle: title?.value ?? null,
        titleHeadCauseIds: title === null ? [] : [title.causeId],
        folderId: folder?.assignedFolderId ?? null,
        folderHeadCauseIds: folder?.headCauseIds ?? [],
        activeRedirect:
          redirect === undefined
            ? null
            : {
                destinationCollectionId: identifierValue(redirect.destinationId, "Collection"),
                controllingCauseId: redirect.causeId,
              },
        intrinsicTail:
          intrinsic === undefined
            ? null
            : { bundleId: intrinsic.bundleId, registrationCauseId: intrinsic.registrationCauseId },
        effectiveTail:
          effective === undefined
            ? null
            : { bundleId: effective.bundleId, registrationCauseId: effective.registrationCauseId },
      };
    })
    .toSorted((left, right) => compareBytes(left.collectionId, right.collectionId));

  const currentLabel = reduceCausalScalar(labels, replay.graph);
  const credentialIds = new Map<string, Identifier<"ClientCredential">>();
  for (const label of initial.credentialLabels) {
    credentialIds.set(key(label.clientCredentialId), label.clientCredentialId);
  }
  for (const label of credentialLabels) {
    credentialIds.set(key(label.clientCredentialId), label.clientCredentialId);
  }
  return {
    vaultLabel:
      currentLabel === null
        ? initial.vaultLabel
        : { value: currentLabel.value, headCauseIds: [currentLabel.causeId] },
    credentialLabels: [...credentialIds.values()]
      .map((clientCredentialId) => {
        const current = reduceCausalScalar(
          credentialLabels.filter((label) =>
            bytesEqual(label.clientCredentialId, clientCredentialId),
          ),
          replay.graph,
        );
        const baseline = initial.credentialLabels.find((label) =>
          bytesEqual(label.clientCredentialId, clientCredentialId),
        );
        if (current !== null) {
          return {
            clientCredentialId,
            value: current.value,
            headCauseIds: [current.causeId],
          };
        }
        if (baseline === undefined) {
          throw new TypeError("Credential label identity has no current state");
        }
        return baseline;
      })
      .toSorted((left, right) => compareBytes(left.clientCredentialId, right.clientCredentialId)),
    captures,
    collections,
    folders: folderProjection.folders.map((folder) => ({
      folderId: folder.folderId,
      name: folder.name,
      nameHeadCauseIds: folder.nameHeadCauseIds,
      parentFolderId: folder.parentFolderId,
      parentHeadCauseIds: folder.parentHeadCauseIds,
      lifecycle: folder.lifecycle,
      lifecycleHeadCauseIds: folder.lifecycleHeadCauseIds,
    })),
    tags: tagProjection.tags.map((tag) => ({
      tagId: tag.tagId,
      name: tag.name,
      nameHeadCauseIds: tag.nameHeadCauseIds,
      activeRedirect: null,
      lifecycle: tag.lifecycle,
      lifecycleHeadCauseIds: tag.lifecycleHeadCauseIds,
    })),
    tagAssignments: tagProjection.assignments.map((assignment) => ({
      assignmentId: assignment.assignmentId,
      assignedCauseId: assignment.assignedCauseId,
      tagId: assignment.tagId,
      targetKind: assignment.targetKind,
      targetId: assignment.targetId,
    })),
    notes: noteProjection.notes.map((note) => ({
      noteId: note.noteId,
      targetKind: note.targetKind,
      targetId: note.targetId,
      state: note.state,
      versions: note.versions.map((version) => ({
        headCauseId: version.headCauseId,
        contentObjectId: version.contentObjectId,
        restoreContentObjectId:
          version.contentObjectId === null ? version.restoreContentObjectId : null,
        attribution: {
          originVaultId: version.originVaultId,
          memberId: version.memberId,
          clientCredentialId: version.clientCredentialId,
          assertedAt: version.assertedAt,
        },
      })),
    })),
    activeConflicts: [],
  };
}

function decodeAttribution(value: CanonicalValue, field: string): CanonicalCheckpointAttribution {
  const map = exactMap(value, [0, 1, 2, 3], field);
  return {
    originVaultId: identifierValue(mapValue(map, 0), "Vault", `${field} origin Vault ID`),
    memberId: identifierValue(mapValue(map, 1), "Member", `${field} Member ID`),
    clientCredentialId: identifierValue(
      mapValue(map, 2),
      "ClientCredential",
      `${field} Client Credential ID`,
    ),
    assertedAt: signedInteger(mapValue(map, 3), `${field} assertedAt`),
  };
}

function decodeTarget(
  value: CanonicalValue,
  field: string,
): {
  readonly targetKind: 1 | 2;
  readonly targetId: Identifier<"Collection"> | Identifier<"Bundle">;
} {
  const map = exactMap(value, [0, 1], field);
  const targetKind = oneOfCodes(mapValue(map, 0), [1, 2] as const, `${field} kind`);
  return {
    targetKind,
    targetId:
      targetKind === 1
        ? identifierValue(mapValue(map, 1), "Collection", `${field} Collection ID`)
        : identifierValue(mapValue(map, 1), "Bundle", `${field} Bundle ID`),
  };
}

function decodeTail(value: CanonicalValue, field: string): CanonicalCheckpointTail | null {
  return nullable(value, (entry) => {
    const map = exactMap(entry, [0, 1], field);
    return {
      bundleId: identifierValue(mapValue(map, 0), "Bundle", `${field} Bundle ID`),
      registrationCauseId: identifierValue(
        mapValue(map, 1),
        "VaultRecord",
        `${field} registration Cause ID`,
      ),
    };
  });
}

export function decodeVacuumContentCheckpoint(value: CanonicalValue): CanonicalVacuumContentState {
  const checkpoint = exactMap(value, [...Array(10).keys()], "Vacuum Content checkpoint");
  exactCode(mapValue(checkpoint, 0), 1, "Content checkpoint format");
  const label = exactMap(mapValue(checkpoint, 1), [0, 1], "Checkpointed Vault label");
  const credentialLabels = arrayValue(
    mapValue(checkpoint, 2),
    "Checkpointed Credential labels",
  ).map((entry, index) => {
    const map = exactMap(entry, [0, 1, 2], `Credential label ${index}`);
    return {
      clientCredentialId: identifierValue(mapValue(map, 0), "ClientCredential"),
      value: nullable(mapValue(map, 1), (labelValue) =>
        textValue(labelValue, "Credential label", { maxUtf8Bytes: 1_024 }),
      ),
      headCauseIds: idSetValue(mapValue(map, 2), "VaultRecord", "Credential label heads", {
        nonempty: true,
      }),
    };
  });
  const captures = arrayValue(mapValue(checkpoint, 3), "Checkpointed Captures").map(
    (entry, index): CanonicalVacuumCaptureState => {
      const map = exactMap(entry, [...Array(8).keys()], `Checkpointed Capture ${index}`);
      return {
        bundleId: identifierValue(mapValue(map, 0), "Bundle"),
        descriptorObjectId: identifierValue(mapValue(map, 1), "VaultObject"),
        assignedCollectionId: identifierValue(mapValue(map, 2), "Collection"),
        assignmentHeadCauseIds: idSetValue(
          mapValue(map, 3),
          "VaultRecord",
          "Capture assignment heads",
          { nonempty: true },
        ),
        lifecycle: oneOfCodes(mapValue(map, 4), [1, 2] as const, "Capture lifecycle"),
        lifecycleHeadCauseIds: idSetValue(
          mapValue(map, 5),
          "VaultRecord",
          "Capture lifecycle heads",
          { nonempty: true },
        ),
        registrationCauseId: identifierValue(mapValue(map, 6), "VaultRecord"),
        attribution: decodeAttribution(mapValue(map, 7), "Capture attribution"),
      };
    },
  );
  const collections = arrayValue(mapValue(checkpoint, 4), "Checkpointed Collections").map(
    (entry, index): CanonicalVacuumCollectionState => {
      const map = exactMap(entry, [...Array(8).keys()], `Checkpointed Collection ${index}`);
      const activeRedirect = nullable(mapValue(map, 5), (redirectValue) => {
        const redirect = exactMap(redirectValue, [0, 1], "Collection redirect");
        return {
          destinationCollectionId: identifierValue(mapValue(redirect, 0), "Collection"),
          controllingCauseId: identifierValue(mapValue(redirect, 1), "VaultRecord"),
        };
      });
      return {
        collectionId: identifierValue(mapValue(map, 0), "Collection"),
        explicitTitle: nullable(mapValue(map, 1), (title) =>
          textValue(title, "Collection title", { maxUtf8Bytes: 1_024 }),
        ),
        titleHeadCauseIds: idSetValue(mapValue(map, 2), "VaultRecord", "Collection title heads"),
        folderId: nullable(mapValue(map, 3), (folderId) => identifierValue(folderId, "Folder")),
        folderHeadCauseIds: idSetValue(mapValue(map, 4), "VaultRecord", "Collection Folder heads"),
        activeRedirect,
        intrinsicTail: decodeTail(mapValue(map, 6), "Intrinsic Collection tail"),
        effectiveTail: decodeTail(mapValue(map, 7), "Effective Collection tail"),
      };
    },
  );
  const folders = arrayValue(mapValue(checkpoint, 5), "Checkpointed Folders").map(
    (entry, index): CanonicalVacuumFolderState => {
      const map = exactMap(entry, [...Array(7).keys()], `Checkpointed Folder ${index}`);
      return {
        folderId: identifierValue(mapValue(map, 0), "Folder"),
        name: textValue(mapValue(map, 1), "Folder name", { maxUtf8Bytes: 1_024 }),
        nameHeadCauseIds: idSetValue(mapValue(map, 2), "VaultRecord", "Folder name heads", {
          nonempty: true,
        }),
        parentFolderId: nullable(mapValue(map, 3), (parentId) =>
          identifierValue(parentId, "Folder"),
        ),
        parentHeadCauseIds: idSetValue(mapValue(map, 4), "VaultRecord", "Folder parent heads"),
        lifecycle: oneOfCodes(mapValue(map, 5), [1, 2] as const, "Folder lifecycle"),
        lifecycleHeadCauseIds: idSetValue(
          mapValue(map, 6),
          "VaultRecord",
          "Folder lifecycle heads",
          { nonempty: true },
        ),
      };
    },
  );
  const tags = arrayValue(mapValue(checkpoint, 6), "Checkpointed Tags").map(
    (entry, index): CanonicalVacuumTagState => {
      const map = exactMap(entry, [...Array(6).keys()], `Checkpointed Tag ${index}`);
      const activeRedirect = nullable(mapValue(map, 3), (redirectValue) => {
        const redirect = exactMap(redirectValue, [0, 1], "Tag redirect");
        return {
          destinationTagId: identifierValue(mapValue(redirect, 0), "Tag"),
          controllingCauseId: identifierValue(mapValue(redirect, 1), "VaultRecord"),
        };
      });
      return {
        tagId: identifierValue(mapValue(map, 0), "Tag"),
        name: textValue(mapValue(map, 1), "Tag name", { maxUtf8Bytes: 1_024 }),
        nameHeadCauseIds: idSetValue(mapValue(map, 2), "VaultRecord", "Tag name heads", {
          nonempty: true,
        }),
        activeRedirect,
        lifecycle: oneOfCodes(mapValue(map, 4), [1, 2] as const, "Tag lifecycle"),
        lifecycleHeadCauseIds: idSetValue(mapValue(map, 5), "VaultRecord", "Tag lifecycle heads", {
          nonempty: true,
        }),
      };
    },
  );
  const tagAssignments = arrayValue(mapValue(checkpoint, 7), "Checkpointed Tag assignments").map(
    (entry, index): CanonicalVacuumTagAssignmentState => {
      const map = exactMap(entry, [0, 1, 2, 3], `Checkpointed Tag assignment ${index}`);
      const decodedTarget = decodeTarget(mapValue(map, 3), "Tag assignment target");
      return {
        assignmentId: identifierValue(mapValue(map, 0), "TagAssignment"),
        assignedCauseId: identifierValue(mapValue(map, 1), "VaultRecord"),
        tagId: identifierValue(mapValue(map, 2), "Tag"),
        ...decodedTarget,
      };
    },
  );
  const notes = arrayValue(mapValue(checkpoint, 8), "Checkpointed Notes").map(
    (entry, index): CanonicalVacuumNoteState => {
      const map = exactMap(entry, [0, 1, 2, 3], `Checkpointed Note ${index}`);
      const decodedTarget = decodeTarget(mapValue(map, 1), "Note target");
      return {
        noteId: identifierValue(mapValue(map, 0), "Note"),
        ...decodedTarget,
        state: oneOfCodes(mapValue(map, 2), [1, 2, 3] as const, "Note state"),
        versions: arrayValue(mapValue(map, 3), "Note versions").map(
          (versionValue, versionIndex) => {
            const version = exactMap(versionValue, [0, 1, 2, 3], `Note version ${versionIndex}`);
            return {
              headCauseId: identifierValue(mapValue(version, 0), "VaultRecord"),
              contentObjectId: nullable(mapValue(version, 1), (objectId) =>
                identifierValue(objectId, "VaultObject"),
              ),
              restoreContentObjectId: nullable(mapValue(version, 2), (objectId) =>
                identifierValue(objectId, "VaultObject"),
              ),
              attribution: decodeAttribution(mapValue(version, 3), "Note attribution"),
            };
          },
        ),
      };
    },
  );
  const activeConflicts = arrayValue(mapValue(checkpoint, 9), "Checkpointed Content Conflicts").map(
    (entry, index): CanonicalVacuumConflictState => {
      const map = exactMap(entry, [0, 1, 2], `Content Conflict ${index}`);
      const kind = oneOfCodes(mapValue(map, 0), [1, 2, 3, 4] as const, "Conflict kind");
      const candidates = arrayValue(mapValue(map, 2), "Conflict candidates");
      if (kind === 1) {
        return {
          kind,
          subjectIds: idSetValue(mapValue(map, 1), "Collection", "Conflict subjects", {
            nonempty: true,
          }),
          candidates: candidates.map((candidateValue) => {
            const candidate = exactMap(candidateValue, [0, 1], "Conflict candidate");
            const state = exactMap(mapValue(candidate, 1), [0], "Redirect candidate state");
            return {
              headCauseId: identifierValue(mapValue(candidate, 0), "VaultRecord"),
              redirects: arrayValue(mapValue(state, 0), "Conflict redirects").map(
                (redirectValue) => {
                  const redirect = exactMap(redirectValue, [0, 1], "Conflict redirect");
                  return {
                    sourceId: identifierValue(mapValue(redirect, 0), "Collection"),
                    destinationId: identifierValue(mapValue(redirect, 1), "Collection"),
                  };
                },
              ),
            };
          }),
        };
      }
      if (kind === 3) {
        return {
          kind,
          subjectIds: idSetValue(mapValue(map, 1), "Tag", "Conflict subjects", {
            nonempty: true,
          }),
          candidates: candidates.map((candidateValue) => {
            const candidate = exactMap(candidateValue, [0, 1], "Conflict candidate");
            const state = exactMap(mapValue(candidate, 1), [0], "Redirect candidate state");
            return {
              headCauseId: identifierValue(mapValue(candidate, 0), "VaultRecord"),
              redirects: arrayValue(mapValue(state, 0), "Conflict redirects").map(
                (redirectValue) => {
                  const redirect = exactMap(redirectValue, [0, 1], "Conflict redirect");
                  return {
                    sourceId: identifierValue(mapValue(redirect, 0), "Tag"),
                    destinationId: identifierValue(mapValue(redirect, 1), "Tag"),
                  };
                },
              ),
            };
          }),
        };
      }
      if (kind === 2) {
        return {
          kind,
          subjectIds: idSetValue(mapValue(map, 1), "Folder", "Folder Conflict subjects", {
            nonempty: true,
          }),
          candidates: candidates.map((candidateValue) => {
            const candidate = exactMap(candidateValue, [0, 1], "Folder Conflict candidate");
            const state = exactMap(mapValue(candidate, 1), [0], "Folder candidate state");
            return {
              headCauseId: identifierValue(mapValue(candidate, 0), "VaultRecord"),
              placements: arrayValue(mapValue(state, 0), "Conflict Folder placements").map(
                (placementValue) => {
                  const placement = exactMap(placementValue, [0, 1], "Conflict Folder placement");
                  return {
                    folderId: identifierValue(mapValue(placement, 0), "Folder"),
                    parentFolderId: nullable(mapValue(placement, 1), (parentId) =>
                      identifierValue(parentId, "Folder"),
                    ),
                  };
                },
              ),
            };
          }),
        };
      }
      return {
        kind,
        subjectIds: idSetValue(mapValue(map, 1), "Note", "Note Conflict subjects", {
          nonempty: true,
        }),
        candidates: candidates.map((candidateValue) => {
          const candidate = exactMap(candidateValue, [0, 1], "Note Conflict candidate");
          const state = exactMap(mapValue(candidate, 1), [0, 1], "Note candidate state");
          return {
            headCauseId: identifierValue(mapValue(candidate, 0), "VaultRecord"),
            noteId: identifierValue(mapValue(state, 0), "Note"),
            contentObjectId: nullable(mapValue(state, 1), (objectId) =>
              identifierValue(objectId, "VaultObject"),
            ),
          };
        }),
      };
    },
  );
  return {
    vaultLabel: {
      value: nullable(mapValue(label, 0), (labelValue) =>
        textValue(labelValue, "Vault label", { maxUtf8Bytes: 1_024 }),
      ),
      headCauseIds: idSetValue(mapValue(label, 1), "VaultRecord", "Vault label heads"),
    },
    credentialLabels,
    captures,
    collections,
    folders,
    tags,
    tagAssignments,
    notes,
    activeConflicts,
  };
}

function stateDigest(
  domain: "awsm:vacuum-predecessor-state:v1" | "awsm:vacuum-successor-state:v1",
  content: CanonicalValue,
  authority: CanonicalValue,
  lifecycle: CanonicalValue,
): Uint8Array {
  return sha256(
    transcript(domain, [encodeCanonicalValue(indexedMap(content, authority, lifecycle))]),
  );
}

function omissionCheckpoint(
  omissions: readonly CanonicalVacuumOmission[],
): ReadonlyMap<number, CanonicalValue> {
  return indexedMap(
    1,
    canonicalSet(
      omissions.map((omission) =>
        indexedMap(omission.kind, omission.logicalId, omission.kind === 1 ? 1 : 2),
      ),
    ),
  );
}

export async function prepareInitialAuthorityVacuumSuccessorBaseline(input: {
  readonly replay: ReplayedCanonicalVault;
  readonly successorGenerationId: Identifier<"Generation">;
  readonly createCause?: (sourceCauseId: Identifier<"VaultRecord">) => Identifier<"BaselineCause">;
  readonly protectionParameters?: Uint8Array;
}): Promise<PreparedInitialAuthorityVacuumSuccessorBaseline> {
  const { replay } = input;
  if (bytesEqual(input.successorGenerationId, replay.vault.replicaState.generationId)) {
    throw new TypeError("Vacuum successor Generation ID must be fresh");
  }
  const contentState = deriveInitialAuthorityVacuumContentState(replay);
  const predecessorContent = buildVacuumContentCheckpoint(contentState, {
    createCause: (sourceCauseId) => identifier("BaselineCause", sourceCauseId),
  });
  const content = buildVacuumContentCheckpoint(contentState, {
    ...(input.createCause === undefined ? {} : { createCause: input.createCause }),
  });
  const predecessorBody = exactMap(
    replay.vault.baseline.body,
    [0, 1, 2, 3, 4, 5],
    "Initial Baseline body",
  );
  const authority = mapValue(predecessorBody, 3);
  const lifecycle = mapValue(predecessorBody, 4);
  const authorityDependencies = replay.vault.baseline.dependencies;
  if (authorityDependencies.some(({ type }) => type !== DEPENDENCY_TYPES.KeyEnvelope)) {
    throw new TypeError("Initial authority checkpoint has unsupported dependencies");
  }
  const predecessorStateDigest = stateDigest(
    "awsm:vacuum-predecessor-state:v1",
    predecessorContent.checkpoint,
    authority,
    lifecycle,
  );
  const successorStateDigest = stateDigest(
    "awsm:vacuum-successor-state:v1",
    content.checkpoint,
    authority,
    lifecycle,
  );
  const omission = omissionCheckpoint(content.omissions);
  const omissionDigest = sha256(
    transcript("awsm:vacuum-omission:v1", [encodeCanonicalValue(omission)]),
  );
  const baseline = encodeVaultBaseline({
    vaultId: replay.vault.replicaState.vaultId,
    generationId: input.successorGenerationId,
    dependencies: canonicalDependencies([...content.dependencies, ...authorityDependencies]),
    requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
    extensions: advisoryExtensions([]),
    body: indexedMap(
      1,
      2,
      content.checkpoint,
      authority,
      lifecycle,
      indexedMap(
        replay.vault.replicaState.generationId,
        canonicalSet(replay.vault.replicaState.causalFrontier),
        predecessorStateDigest,
      ),
    ),
  });
  const successorBody = exactMap(baseline.body, [0, 1, 2, 3, 4, 5], "Successor Baseline body");
  const decodedContent = decodeVacuumContentCheckpoint(mapValue(successorBody, 2));
  const independentlyRebuiltContent = buildVacuumContentCheckpoint(decodedContent, {
    createCause: (causeId) => identifier("BaselineCause", causeId),
  });
  if (
    !bytesEqual(
      encodeCanonicalValue(independentlyRebuiltContent.checkpoint),
      encodeCanonicalValue(content.checkpoint),
    ) ||
    independentlyRebuiltContent.dependencies.length !== content.dependencies.length ||
    independentlyRebuiltContent.dependencies.some(
      (dependency, index) =>
        dependency.type !== content.dependencies[index]?.type ||
        !bytesEqual(dependency.id, content.dependencies[index]?.id ?? new Uint8Array()),
    )
  ) {
    throw new TypeError("Vacuum successor Baseline does not independently replay equivalently");
  }
  const baselineEnvelope = await sealCompactItem({
    vaultId: replay.vault.replicaState.vaultId,
    keyEpochId: replay.vault.epochSecret.keyEpochId,
    keyEpochKey: replay.vault.epochSecret.key,
    payloadType: 1,
    payloadBytes: baseline.bytes,
    ...(input.protectionParameters === undefined
      ? {}
      : { protectionParameters: input.protectionParameters }),
  });
  const opened = await openCompactItem({
    vaultId: replay.vault.replicaState.vaultId,
    keyEpochId: replay.vault.epochSecret.keyEpochId,
    keyEpochKey: replay.vault.epochSecret.key,
    envelopeBytes: baselineEnvelope.bytes,
  });
  if (!bytesEqual(decodeVaultBaseline(opened.payloadBytes).recordId, baseline.recordId)) {
    throw new TypeError("Vacuum successor Baseline protection changed its Record identity");
  }
  return {
    contentState,
    content,
    baseline,
    baselineEnvelope,
    predecessorStateDigest,
    successorStateDigest,
    omissionDigest,
    omissionCheckpoint: omission,
  };
}

export async function prepareInitialAuthorityVacuum(input: {
  readonly replay: ReplayedCanonicalVault;
  readonly successorGenerationId: Identifier<"Generation">;
  readonly assertedAt: number | bigint;
  readonly createCause?: (sourceCauseId: Identifier<"VaultRecord">) => Identifier<"BaselineCause">;
  readonly baselineProtectionParameters?: Uint8Array;
  readonly eventProtectionParameters?: Uint8Array;
}): Promise<PreparedInitialAuthorityVacuum> {
  const successor = await prepareInitialAuthorityVacuumSuccessorBaseline({
    replay: input.replay,
    successorGenerationId: input.successorGenerationId,
    ...(input.createCause === undefined ? {} : { createCause: input.createCause }),
    ...(input.baselineProtectionParameters === undefined
      ? {}
      : { protectionParameters: input.baselineProtectionParameters }),
  });
  const { vault } = input.replay;
  const event = await signVaultEvent(
    {
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      parentRecordIds: vault.replicaState.causalFrontier,
      authorityParentRecordIds: vault.replicaState.authorityFrontier,
      dependencies: [{ type: DEPENDENCY_TYPES.VaultBaseline, id: successor.baseline.recordId }],
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 3,
      type: 1,
      signerCredentialId: vault.clientSecret.clientCredentialId,
      assertedAt: input.assertedAt,
      body: indexedMap(
        vault.replicaState.generationId,
        canonicalSet(vault.replicaState.causalFrontier),
        input.successorGenerationId,
        successor.baseline.recordId,
        successor.predecessorStateDigest,
        successor.successorStateDigest,
        successor.omissionDigest,
      ),
    },
    vault.clientSecret.signingSecretKey,
  );
  const eventEnvelope = await sealCompactItem({
    vaultId: vault.replicaState.vaultId,
    keyEpochId: vault.epochSecret.keyEpochId,
    keyEpochKey: vault.epochSecret.key,
    payloadType: 1,
    payloadBytes: event.bytes,
    ...(input.eventProtectionParameters === undefined
      ? {}
      : { protectionParameters: input.eventProtectionParameters }),
  });
  const opened = await openCompactItem({
    vaultId: vault.replicaState.vaultId,
    keyEpochId: vault.epochSecret.keyEpochId,
    keyEpochKey: vault.epochSecret.key,
    envelopeBytes: eventEnvelope.bytes,
  });
  if (!bytesEqual(opened.payloadBytes, event.bytes)) {
    throw new TypeError("Vacuum Event protection changed its authenticated bytes");
  }
  const continuityRecordIds = canonicalSet([
    ...vault.replicaState.continuityRecordIds,
    event.recordId,
  ]);
  return {
    successor,
    event,
    eventEnvelope,
    continuityRecordIds,
    adoptedReplicaState: {
      ...vault.replicaState,
      generationId: input.successorGenerationId,
      causalFrontier: [successor.baseline.recordId],
      authorityFrontier: [event.recordId],
      continuityRecordIds,
      baselineId: successor.baseline.recordId,
      lifecycle: 1,
      adoption: { vacuumEventRecordId: event.recordId },
    },
  };
}

export function buildVacuumContentCheckpoint(
  state: CanonicalVacuumContentState,
  options: {
    readonly createCause?: (
      sourceCauseId: Identifier<"VaultRecord">,
    ) => Identifier<"BaselineCause">;
  } = {},
): BuiltVacuumContentCheckpoint {
  const causeBySource = new Map<string, CanonicalVacuumCauseMapping>();
  const sourceByMappedCause = new Map<string, string>();
  const mapCause = (sourceCauseId: Identifier<"VaultRecord">): Identifier<"BaselineCause"> => {
    const sourceKey = key(sourceCauseId);
    const existing = causeBySource.get(sourceKey);
    if (existing !== undefined) return existing.baselineCauseId;
    const baselineCauseId =
      options.createCause?.(sourceCauseId) ?? randomIdentifier("BaselineCause");
    const mappedKey = key(baselineCauseId);
    const otherSource = sourceByMappedCause.get(mappedKey);
    if (otherSource !== undefined && otherSource !== sourceKey) {
      throw new TypeError("Distinct predecessor causes cannot share one Baseline Cause");
    }
    sourceByMappedCause.set(mappedKey, sourceKey);
    causeBySource.set(sourceKey, { sourceCauseId, baselineCauseId });
    return baselineCauseId;
  };
  const mapCauses = (values: readonly Identifier<"VaultRecord">[]) =>
    canonicalSet(values.map(mapCause));
  const tail = (value: CanonicalCheckpointTail | null): CanonicalValue =>
    value === null ? null : indexedMap(value.bundleId, mapCause(value.registrationCauseId));

  const deletedBundles = new Set(
    state.captures.filter(({ lifecycle }) => lifecycle === 2).map(({ bundleId }) => key(bundleId)),
  );
  const retainedCaptures = state.captures.filter(({ lifecycle }) => lifecycle === 1);
  const retainedAssignments = state.tagAssignments.filter(
    ({ targetKind, targetId }) => targetKind !== 2 || !deletedBundles.has(key(targetId)),
  );
  const retainedNotes = state.notes.filter(
    ({ targetKind, targetId }) => targetKind !== 2 || !deletedBundles.has(key(targetId)),
  );
  const omissions: CanonicalVacuumOmission[] = [
    ...state.captures
      .filter(({ lifecycle }) => lifecycle === 2)
      .map(({ bundleId }) => ({ kind: 1 as const, logicalId: bundleId })),
    ...state.tagAssignments
      .filter(({ targetKind, targetId }) => targetKind === 2 && deletedBundles.has(key(targetId)))
      .map(({ assignmentId }) => ({ kind: 2 as const, logicalId: assignmentId })),
    ...state.notes
      .filter(({ targetKind, targetId }) => targetKind === 2 && deletedBundles.has(key(targetId)))
      .map(({ noteId }) => ({ kind: 3 as const, logicalId: noteId })),
  ].toSorted(
    (left, right) => left.kind - right.kind || compareBytes(left.logicalId, right.logicalId),
  );

  const captures = retainedCaptures.map((capture) =>
    indexedMap(
      capture.bundleId,
      capture.descriptorObjectId,
      capture.assignedCollectionId,
      mapCauses(capture.assignmentHeadCauseIds),
      capture.lifecycle,
      mapCauses(capture.lifecycleHeadCauseIds),
      mapCause(capture.registrationCauseId),
      attribution(capture.attribution),
    ),
  );
  const collections = state.collections.map((collection) =>
    indexedMap(
      collection.collectionId,
      collection.explicitTitle,
      mapCauses(collection.titleHeadCauseIds),
      collection.folderId,
      mapCauses(collection.folderHeadCauseIds),
      collection.activeRedirect === null
        ? null
        : indexedMap(
            collection.activeRedirect.destinationCollectionId,
            mapCause(collection.activeRedirect.controllingCauseId),
          ),
      tail(collection.intrinsicTail),
      tail(collection.effectiveTail),
    ),
  );
  const folders = state.folders.map((folder) =>
    indexedMap(
      folder.folderId,
      folder.name,
      mapCauses(folder.nameHeadCauseIds),
      folder.parentFolderId,
      mapCauses(folder.parentHeadCauseIds),
      folder.lifecycle,
      mapCauses(folder.lifecycleHeadCauseIds),
    ),
  );
  const tags = state.tags.map((tag) =>
    indexedMap(
      tag.tagId,
      tag.name,
      mapCauses(tag.nameHeadCauseIds),
      tag.activeRedirect === null
        ? null
        : indexedMap(
            tag.activeRedirect.destinationTagId,
            mapCause(tag.activeRedirect.controllingCauseId),
          ),
      tag.lifecycle,
      mapCauses(tag.lifecycleHeadCauseIds),
    ),
  );
  const tagAssignments = retainedAssignments.map((assignment) =>
    indexedMap(
      assignment.assignmentId,
      mapCause(assignment.assignedCauseId),
      assignment.tagId,
      target(assignment.targetKind, assignment.targetId),
    ),
  );
  const notes = retainedNotes.map((note) =>
    indexedMap(
      note.noteId,
      target(note.targetKind, note.targetId),
      note.state,
      canonicalSet(
        note.versions.map((version) =>
          indexedMap(
            mapCause(version.headCauseId),
            version.contentObjectId,
            version.restoreContentObjectId,
            attribution(version.attribution),
          ),
        ),
      ),
    ),
  );
  const activeConflicts = state.activeConflicts.map((conflict) => {
    let candidates: readonly ReadonlyMap<number, CanonicalValue>[];
    let subjectIds: readonly Uint8Array[];
    switch (conflict.kind) {
      case 1:
      case 3:
        candidates = conflict.candidates.map((candidate) =>
          indexedMap(
            mapCause(candidate.headCauseId),
            indexedMap(
              canonicalSet(
                candidate.redirects.map((redirect) =>
                  indexedMap(redirect.sourceId, redirect.destinationId),
                ),
              ),
            ),
          ),
        );
        subjectIds = conflict.subjectIds;
        break;
      case 2:
        candidates = conflict.candidates.map((candidate) =>
          indexedMap(
            mapCause(candidate.headCauseId),
            indexedMap(
              canonicalSet(
                candidate.placements.map((placement) =>
                  indexedMap(placement.folderId, placement.parentFolderId),
                ),
              ),
            ),
          ),
        );
        subjectIds = conflict.subjectIds;
        break;
      case 4:
        candidates = conflict.candidates.map((candidate) =>
          indexedMap(
            mapCause(candidate.headCauseId),
            indexedMap(candidate.noteId, candidate.contentObjectId),
          ),
        );
        subjectIds = conflict.subjectIds;
        break;
    }
    return indexedMap(conflict.kind, canonicalSet(subjectIds), canonicalSet(candidates));
  });

  const dependencies = canonicalDependencies([
    ...retainedCaptures.map(({ descriptorObjectId }) => ({
      type: DEPENDENCY_TYPES.BundleDescriptorObject,
      id: descriptorObjectId,
    })),
    ...retainedNotes.flatMap(({ versions }) =>
      versions.flatMap(({ contentObjectId, restoreContentObjectId }) => {
        const requiredObjectId = contentObjectId ?? restoreContentObjectId;
        return requiredObjectId === null
          ? []
          : [{ type: DEPENDENCY_TYPES.NoteContentObject, id: requiredObjectId }];
      }),
    ),
  ]);
  const checkpoint = indexedMap(
    1,
    indexedMap(state.vaultLabel.value, mapCauses(state.vaultLabel.headCauseIds)),
    canonicalSet(
      state.credentialLabels.map((entry) =>
        indexedMap(entry.clientCredentialId, entry.value, mapCauses(entry.headCauseIds)),
      ),
    ),
    canonicalSet(captures),
    canonicalSet(collections),
    canonicalSet(folders),
    canonicalSet(tags),
    canonicalSet(tagAssignments),
    canonicalSet(notes),
    canonicalSet(activeConflicts),
  );
  // Force canonical encodability here so random Cause generation never escapes through a malformed
  // state shape and later appears to fail inside Baseline construction.
  encodeCanonicalValue(checkpoint);
  return {
    checkpoint,
    causeMapping: [...causeBySource.values()].toSorted((left, right) =>
      compareBytes(left.sourceCauseId, right.sourceCauseId),
    ),
    dependencies,
    omissions,
  };
}

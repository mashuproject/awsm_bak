import type { CanonicalApplicationRequest } from "../app/canonical-application";
import type {
  CanonicalClientArtifactHydrationSummary,
  CanonicalClientCollection,
  CanonicalClientFolder,
  CanonicalClientHostedReplicaAttachmentCandidate,
  CanonicalClientLibraryConflict,
  CanonicalClientLibraryItem,
  CanonicalClientNote,
  CanonicalClientRemoteMaterializationSummary,
  CanonicalClientRemotePullSummary,
  CanonicalClientRemoteRetirementSummary,
  CanonicalClientRemoteSummary,
  CanonicalClientSearchResult,
  CanonicalClientState,
  CanonicalClientTag,
  CanonicalClientTagAssignment,
  CanonicalClientVaultSummary,
} from "../runtime/client/canonical-runtime";
import type { CanonicalPopupClient } from "./canonical-popup-controller";

export class CanonicalPopupApplicationClientError extends Error {
  readonly id: string;

  constructor(id: string, message: string) {
    super(message);
    this.name = "CanonicalPopupApplicationClientError";
    this.id = id;
  }
}

export interface CanonicalPopupApplicationTransport {
  request(request: CanonicalApplicationRequest): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

export interface CanonicalClientSearchCoverage {
  readonly eligibleCaptures: number;
  readonly indexedCaptures: number;
  readonly unavailableHeavyContent: number;
  readonly failedCaptures: number;
}

interface CanonicalClientEventResult {
  readonly eventRecordId: string;
}

export interface CanonicalPopupApplicationClient extends CanonicalPopupClient {
  beginVaultCreation(input: {
    readonly expectedVaultId: string | null;
    readonly label: string | null;
  }): Promise<{ readonly setupId: string; readonly recoveryPhrase: string }>;
  confirmVaultCreation(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{ readonly vaultId: string }>;
  cancelVaultCreation(setupId: string): Promise<void>;
  beginVaultFork(expectedVaultId: string): Promise<{
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }>;
  confirmVaultFork(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{ readonly vaultId: string }>;
  cancelVaultFork(setupId: string): Promise<void>;
  recoverMember(input: {
    readonly expectedVaultId: string;
    readonly recoveryPhrase: string;
  }): Promise<{
    readonly memberId: string;
    readonly clientCredentialId: string;
    readonly eventRecordId: string;
  }>;
  recoverHostedMember(input: {
    readonly endpoint: string;
    readonly username: string;
    readonly password: string;
    readonly recoveryPhrase: string;
  }): Promise<{
    readonly vaultId: string;
    readonly memberId: string;
    readonly clientCredentialId: string;
    readonly eventRecordId: string;
  }>;
  beginRecoveryPhraseReplacement(expectedVaultId: string): Promise<{
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }>;
  confirmRecoveryPhraseReplacement(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{
    readonly recoveryCredentialId: string;
    readonly revision: number;
    readonly eventRecordId: string;
  }>;
  cancelRecoveryPhraseReplacement(setupId: string): Promise<void>;
  selectVault(input: {
    readonly expectedVaultId: string | null;
    readonly vaultId: string;
  }): Promise<CanonicalClientState>;
  captureActivePage(input: {
    readonly expectedVaultId: string;
    readonly tabId?: number;
  }): Promise<{ readonly bundleId: string }>;
  closeVault(expectedVaultId: string): Promise<{ readonly eventRecordId: string }>;
  vacuumVault(expectedVaultId: string): Promise<{
    readonly predecessorGenerationId: string;
    readonly successorGenerationId: string;
    readonly vacuumEventRecordId: string;
    readonly successorBaselineId: string;
  }>;
  listRemotes(expectedVaultId: string): Promise<readonly CanonicalClientRemoteSummary[]>;
  renameRemote(input: {
    readonly expectedVaultId: string;
    readonly remoteId: string;
    readonly name: string;
  }): Promise<CanonicalClientRemoteSummary>;
  setRemoteEnabled(input: {
    readonly expectedVaultId: string;
    readonly remoteId: string;
    readonly enabled: boolean;
  }): Promise<CanonicalClientRemoteSummary>;
  retireRemote(input: {
    readonly expectedVaultId: string;
    readonly remoteId: string;
  }): Promise<CanonicalClientRemoteRetirementSummary>;
  createHostedReplica(input: {
    readonly expectedVaultId: string;
    readonly endpoint: string;
    readonly name: string;
    readonly username: string;
    readonly password: string;
  }): Promise<CanonicalClientRemoteSummary>;
  beginHostedReplicaAttachment(input: {
    readonly expectedVaultId: string;
    readonly endpoint: string;
    readonly name: string;
    readonly username: string;
    readonly password: string;
  }): Promise<{
    readonly setupId: string;
    readonly replicas: readonly CanonicalClientHostedReplicaAttachmentCandidate[];
  }>;
  confirmHostedReplicaAttachment(input: {
    readonly expectedVaultId: string;
    readonly setupId: string;
    readonly replicaHandle: string;
  }): Promise<CanonicalClientRemoteSummary>;
  cancelHostedReplicaAttachment(setupId: string): Promise<void>;
  materializeHostedReplica(input: {
    readonly expectedVaultId: string;
    readonly remoteId: string;
  }): Promise<CanonicalClientRemoteMaterializationSummary>;
  pullHostedReplicas(expectedVaultId: string): Promise<readonly CanonicalClientRemotePullSummary[]>;
  hydrateArtifact(input: {
    readonly expectedVaultId: string;
    readonly artifactId: string;
  }): Promise<CanonicalClientArtifactHydrationSummary>;
  search(input: {
    readonly expectedVaultId: string;
    readonly query: string;
    readonly scope: "Active" | "Deleted";
    readonly hosts: readonly string[];
    readonly collectionIds: readonly string[];
    readonly tagIds: readonly string[];
    readonly capturedFrom?: number;
    readonly capturedBefore?: number;
  }): Promise<readonly CanonicalClientSearchResult[]>;
  searchCoverage(expectedVaultId: string): Promise<CanonicalClientSearchCoverage>;
  listCollections(expectedVaultId: string): Promise<readonly CanonicalClientCollection[]>;
  listFolders(expectedVaultId: string): Promise<readonly CanonicalClientFolder[]>;
  listTags(expectedVaultId: string): Promise<readonly CanonicalClientTag[]>;
  listTagAssignments(expectedVaultId: string): Promise<readonly CanonicalClientTagAssignment[]>;
  listNotes(expectedVaultId: string): Promise<readonly CanonicalClientNote[]>;
  listLibraryConflicts(expectedVaultId: string): Promise<readonly CanonicalClientLibraryConflict[]>;
  createFolder(input: {
    readonly expectedVaultId: string;
    readonly name: string;
    readonly parentFolderId: string | null;
  }): Promise<{ readonly folderId: string } & CanonicalClientEventResult>;
  renameFolder(input: {
    readonly expectedVaultId: string;
    readonly folderId: string;
    readonly name: string;
  }): Promise<CanonicalClientEventResult>;
  placeFolder(input: {
    readonly expectedVaultId: string;
    readonly folderId: string;
    readonly parentFolderId: string | null;
  }): Promise<CanonicalClientEventResult>;
  deleteFolder(input: {
    readonly expectedVaultId: string;
    readonly folderId: string;
  }): Promise<CanonicalClientEventResult>;
  restoreFolder(input: {
    readonly expectedVaultId: string;
    readonly folderId: string;
  }): Promise<CanonicalClientEventResult>;
  placeCollectionInFolder(input: {
    readonly expectedVaultId: string;
    readonly collectionId: string;
    readonly folderId: string | null;
  }): Promise<CanonicalClientEventResult>;
  resolveFolderConflict(input: {
    readonly expectedVaultId: string;
    readonly subjectFolderIds: readonly string[];
    readonly conflictingCauseIds: readonly string[];
    readonly placements: readonly {
      readonly folderId: string;
      readonly parentFolderId: string | null;
    }[];
  }): Promise<CanonicalClientEventResult>;
  setCollectionTitle(input: {
    readonly expectedVaultId: string;
    readonly collectionId: string;
    readonly title: string | null;
  }): Promise<CanonicalClientEventResult>;
  mergeCollections(input: {
    readonly expectedVaultId: string;
    readonly sourceCollectionIds: readonly string[];
    readonly destinationCollectionId: string;
  }): Promise<CanonicalClientEventResult>;
  revertCollectionMerge(input: {
    readonly expectedVaultId: string;
    readonly redirectCauseId: string;
  }): Promise<CanonicalClientEventResult>;
  resolveCollectionMergeConflict(input: {
    readonly expectedVaultId: string;
    readonly subjectCollectionIds: readonly string[];
    readonly conflictingCauseIds: readonly string[];
    readonly redirects: readonly {
      readonly sourceCollectionId: string;
      readonly destinationCollectionId: string;
    }[];
  }): Promise<CanonicalClientEventResult>;
  moveCaptures(input: {
    readonly expectedVaultId: string;
    readonly bundleIds: readonly string[];
    readonly destinationCollectionId: string;
  }): Promise<CanonicalClientEventResult>;
  deleteCaptures(input: {
    readonly expectedVaultId: string;
    readonly bundleIds: readonly string[];
  }): Promise<CanonicalClientEventResult>;
  restoreCaptures(input: {
    readonly expectedVaultId: string;
    readonly bundleIds: readonly string[];
  }): Promise<CanonicalClientEventResult>;
  createTag(input: {
    readonly expectedVaultId: string;
    readonly name: string;
  }): Promise<{ readonly tagId: string } & CanonicalClientEventResult>;
  renameTag(input: {
    readonly expectedVaultId: string;
    readonly tagId: string;
    readonly name: string;
  }): Promise<CanonicalClientEventResult>;
  assignTag(input: {
    readonly expectedVaultId: string;
    readonly tagId: string;
    readonly targetKind: "Collection" | "Capture";
    readonly targetId: string;
  }): Promise<{ readonly assignmentId: string } & CanonicalClientEventResult>;
  removeTagAssignments(input: {
    readonly expectedVaultId: string;
    readonly tagId: string;
    readonly targetKind: "Collection" | "Capture";
    readonly targetId: string;
  }): Promise<CanonicalClientEventResult>;
  deleteTag(input: {
    readonly expectedVaultId: string;
    readonly tagId: string;
  }): Promise<CanonicalClientEventResult>;
  restoreTag(input: {
    readonly expectedVaultId: string;
    readonly tagId: string;
  }): Promise<CanonicalClientEventResult>;
  mergeTags(input: {
    readonly expectedVaultId: string;
    readonly sourceTagIds: readonly string[];
    readonly destinationTagId: string;
  }): Promise<CanonicalClientEventResult>;
  revertTagMerge(input: {
    readonly expectedVaultId: string;
    readonly redirectCauseId: string;
  }): Promise<CanonicalClientEventResult>;
  resolveTagMergeConflict(input: {
    readonly expectedVaultId: string;
    readonly subjectTagIds: readonly string[];
    readonly conflictingCauseIds: readonly string[];
    readonly redirects: readonly {
      readonly sourceTagId: string;
      readonly destinationTagId: string;
    }[];
  }): Promise<CanonicalClientEventResult>;
  createNote(input: {
    readonly expectedVaultId: string;
    readonly targetKind: "Collection" | "Capture";
    readonly targetId: string;
    readonly title: string | null;
    readonly body: string;
  }): Promise<{ readonly noteId: string } & CanonicalClientEventResult>;
  reviseNote(input: {
    readonly expectedVaultId: string;
    readonly noteId: string;
    readonly title: string | null;
    readonly body: string;
  }): Promise<CanonicalClientEventResult>;
  deleteNote(input: {
    readonly expectedVaultId: string;
    readonly noteId: string;
  }): Promise<CanonicalClientEventResult>;
  restoreNote(input: {
    readonly expectedVaultId: string;
    readonly noteId: string;
  }): Promise<CanonicalClientEventResult>;
  resolveNoteConflict(input: {
    readonly expectedVaultId: string;
    readonly noteId: string;
    readonly conflictingCauseIds: readonly string[];
    readonly retainedOriginal: { readonly title: string | null; readonly body: string } | null;
    readonly splitNotes: readonly { readonly title: string | null; readonly body: string }[];
  }): Promise<{ readonly splitNoteIds: readonly string[] } & CanonicalClientEventResult>;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function setupId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeTimestamp(value: unknown): value is number | bigint {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "bigint" && value >= 0n)
  );
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function hostedEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

function protocolError(): CanonicalPopupApplicationClientError {
  return new CanonicalPopupApplicationClientError(
    "APPLICATION_PROTOCOL_INVALID",
    "The local application returned an invalid popup response.",
  );
}

function decodeVaultSummary(value: unknown): CanonicalClientVaultSummary {
  const hasReplicaAvailability = plainRecord(value) && Object.hasOwn(value, "replicaAvailability");
  const hasMissingArtifactCount =
    plainRecord(value) && Object.hasOwn(value, "missingArtifactCount");
  const hasClientCredentialId = plainRecord(value) && Object.hasOwn(value, "clientCredentialId");
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "vaultId",
      "label",
      "lifecycle",
      "access",
      ...(hasReplicaAvailability ? ["replicaAvailability"] : []),
      ...(hasMissingArtifactCount ? ["missingArtifactCount"] : []),
      ...(hasClientCredentialId ? ["clientCredentialId"] : []),
      "selected",
    ]) ||
    !identifier(value.vaultId) ||
    !(value.label === null || typeof value.label === "string") ||
    !(value.lifecycle === "Open" || value.lifecycle === "Closed") ||
    !(value.access === "Authoring" || value.access === "ReadOnly") ||
    (hasReplicaAvailability &&
      value.replicaAvailability !== "Complete" &&
      value.replicaAvailability !== "Sparse" &&
      value.replicaAvailability !== "Unavailable") ||
    (hasMissingArtifactCount &&
      (typeof value.missingArtifactCount !== "number" ||
        !Number.isSafeInteger(value.missingArtifactCount) ||
        value.missingArtifactCount < 0)) ||
    (hasClientCredentialId && !identifier(value.clientCredentialId)) ||
    typeof value.selected !== "boolean"
  ) {
    throw protocolError();
  }
  return {
    vaultId: value.vaultId,
    label: value.label,
    lifecycle: value.lifecycle,
    access: value.access,
    ...(hasReplicaAvailability
      ? { replicaAvailability: value.replicaAvailability as "Complete" | "Sparse" | "Unavailable" }
      : {}),
    ...(hasMissingArtifactCount
      ? { missingArtifactCount: value.missingArtifactCount as number }
      : {}),
    ...(hasClientCredentialId ? { clientCredentialId: value.clientCredentialId as string } : {}),
    selected: value.selected,
  };
}

function decodeState(value: unknown): CanonicalClientState {
  if (
    !plainRecord(value) ||
    ![1, 2, 3].includes(Object.keys(value).length) ||
    !Array.isArray(value.vaults)
  ) {
    throw protocolError();
  }
  const hasSelectedVault = Object.hasOwn(value, "selectedVaultId");
  const hasPendingCreation = Object.hasOwn(value, "pendingVaultCreation");
  const pendingCreation = plainRecord(value.pendingVaultCreation)
    ? value.pendingVaultCreation
    : undefined;
  if (
    !exactKeys(value, [
      "vaults",
      ...(hasSelectedVault ? ["selectedVaultId"] : []),
      ...(hasPendingCreation ? ["pendingVaultCreation"] : []),
    ]) ||
    (hasSelectedVault && !identifier(value.selectedVaultId)) ||
    (hasPendingCreation &&
      (pendingCreation === undefined ||
        !exactKeys(pendingCreation, ["setupId", "expectedVaultId"]) ||
        !setupId(pendingCreation.setupId) ||
        !(pendingCreation.expectedVaultId === null || identifier(pendingCreation.expectedVaultId))))
  ) {
    throw protocolError();
  }
  const vaults = value.vaults.map(decodeVaultSummary);
  if (new Set(vaults.map(({ vaultId }) => vaultId)).size !== vaults.length) throw protocolError();
  const selected = vaults.filter((vault) => vault.selected);
  if (
    selected.length > 1 ||
    (hasSelectedVault &&
      (selected.length !== 1 || selected[0]?.vaultId !== value.selectedVaultId)) ||
    (!hasSelectedVault && selected.length !== 0)
  ) {
    throw protocolError();
  }
  return {
    ...(hasSelectedVault ? { selectedVaultId: value.selectedVaultId as string } : {}),
    ...(pendingCreation === undefined
      ? {}
      : {
          pendingVaultCreation: {
            setupId: pendingCreation.setupId as string,
            expectedVaultId: pendingCreation.expectedVaultId as string | null,
          },
        }),
    vaults,
  };
}

function decodeLibraryItem(value: unknown): CanonicalClientLibraryItem {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "bundleId",
      "collectionId",
      "artifactId",
      "capturedAt",
      "originalUrl",
      "finalUrl",
      "title",
      "availableLocally",
      "lifecycle",
    ]) ||
    !identifier(value.bundleId) ||
    !identifier(value.collectionId) ||
    !identifier(value.artifactId) ||
    !safeTimestamp(value.capturedAt) ||
    !httpUrl(value.originalUrl) ||
    !httpUrl(value.finalUrl) ||
    !(value.title === null || typeof value.title === "string") ||
    typeof value.availableLocally !== "boolean" ||
    !(value.lifecycle === "Active" || value.lifecycle === "Deleted")
  ) {
    throw protocolError();
  }
  return {
    bundleId: value.bundleId,
    collectionId: value.collectionId,
    artifactId: value.artifactId,
    capturedAt: value.capturedAt,
    originalUrl: value.originalUrl,
    finalUrl: value.finalUrl,
    title: value.title,
    availableLocally: value.availableLocally,
    lifecycle: value.lifecycle,
  };
}

function decodeLibrary(value: unknown): readonly CanonicalClientLibraryItem[] {
  if (!Array.isArray(value)) throw protocolError();
  const library = value.map(decodeLibraryItem);
  if (new Set(library.map(({ bundleId }) => bundleId)).size !== library.length)
    throw protocolError();
  return library;
}

function decodeRemoteSummary(value: unknown): CanonicalClientRemoteSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["remoteId", "name", "endpoint", "enabled"]) ||
    !setupId(value.remoteId) ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 256 ||
    !hostedEndpoint(value.endpoint) ||
    typeof value.enabled !== "boolean"
  ) {
    throw protocolError();
  }
  return {
    remoteId: value.remoteId,
    name: value.name,
    endpoint: value.endpoint,
    enabled: value.enabled,
  };
}

function decodeRemotes(value: unknown): readonly CanonicalClientRemoteSummary[] {
  if (!Array.isArray(value)) throw protocolError();
  const remotes = value.map(decodeRemoteSummary);
  if (new Set(remotes.map(({ remoteId }) => remoteId)).size !== remotes.length)
    throw protocolError();
  return remotes;
}

function decodeHostedReplicaAttachment(value: unknown): {
  readonly setupId: string;
  readonly replicas: readonly CanonicalClientHostedReplicaAttachmentCandidate[];
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["setupId", "replicas"]) ||
    !setupId(value.setupId) ||
    !Array.isArray(value.replicas)
  ) {
    throw protocolError();
  }
  const replicas = value.replicas.map((replica) => {
    if (
      !plainRecord(replica) ||
      !exactKeys(replica, ["replicaHandle", "storedBytes"]) ||
      !setupId(replica.replicaHandle) ||
      !nonnegativeInteger(replica.storedBytes)
    ) {
      throw protocolError();
    }
    return { replicaHandle: replica.replicaHandle, storedBytes: replica.storedBytes };
  });
  if (
    replicas.length === 0 ||
    new Set(replicas.map(({ replicaHandle }) => replicaHandle)).size !== replicas.length
  ) {
    throw protocolError();
  }
  return { setupId: value.setupId, replicas };
}

function decodeRemoteRetirement(value: unknown): CanonicalClientRemoteRetirementSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["materializationLedgerCount", "pullJobCount", "quarantinedItemCount"]) ||
    !nonnegativeInteger(value.materializationLedgerCount) ||
    !nonnegativeInteger(value.pullJobCount) ||
    !nonnegativeInteger(value.quarantinedItemCount)
  ) {
    throw protocolError();
  }
  return {
    materializationLedgerCount: value.materializationLedgerCount,
    pullJobCount: value.pullJobCount,
    quarantinedItemCount: value.quarantinedItemCount,
  };
}

function decodeHostedReplicaMaterialization(
  value: unknown,
): CanonicalClientRemoteMaterializationSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "remoteId",
      "materializedCompactItemCount",
      "retriedCompactItemCount",
      "alreadyConfirmedCompactItemCount",
    ]) ||
    !setupId(value.remoteId) ||
    !nonnegativeInteger(value.materializedCompactItemCount) ||
    !nonnegativeInteger(value.retriedCompactItemCount) ||
    !nonnegativeInteger(value.alreadyConfirmedCompactItemCount)
  ) {
    throw protocolError();
  }
  return {
    remoteId: value.remoteId,
    materializedCompactItemCount: value.materializedCompactItemCount,
    retriedCompactItemCount: value.retriedCompactItemCount,
    alreadyConfirmedCompactItemCount: value.alreadyConfirmedCompactItemCount,
  };
}

function decodeHostedReplicaPull(value: unknown): readonly CanonicalClientRemotePullSummary[] {
  if (!Array.isArray(value)) throw protocolError();
  const results = value.map((result) => {
    if (
      !plainRecord(result) ||
      !exactKeys(result, ["remoteId", "status"]) ||
      !setupId(result.remoteId) ||
      typeof result.status !== "string" ||
      !["Disabled", "Failed", "Active", "Completed", "Waiting"].includes(result.status)
    ) {
      throw protocolError();
    }
    return {
      remoteId: result.remoteId,
      status: result.status as CanonicalClientRemotePullSummary["status"],
    };
  });
  if (new Set(results.map(({ remoteId }) => remoteId)).size !== results.length) {
    throw protocolError();
  }
  return results;
}

function decodeArtifactHydration(value: unknown): CanonicalClientArtifactHydrationSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["artifactId", "storageItemId", "remoteId"]) ||
    !identifier(value.artifactId) ||
    !identifier(value.storageItemId) ||
    !(value.remoteId === "local" || setupId(value.remoteId))
  ) {
    throw protocolError();
  }
  return {
    artifactId: value.artifactId,
    storageItemId: value.storageItemId,
    remoteId: value.remoteId,
  };
}

function decodeVaultCreation(value: unknown): {
  readonly setupId: string;
  readonly recoveryPhrase: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["setupId", "recoveryPhrase"]) ||
    typeof value.setupId !== "string" ||
    value.setupId.length < 1 ||
    value.setupId.length > 128 ||
    typeof value.recoveryPhrase !== "string" ||
    value.recoveryPhrase.length < 1 ||
    value.recoveryPhrase.length > 1_024
  ) {
    throw protocolError();
  }
  return { setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
}

function decodeCapture(value: unknown): { readonly bundleId: string } {
  if (!plainRecord(value) || !exactKeys(value, ["bundleId"]) || !identifier(value.bundleId)) {
    throw protocolError();
  }
  return { bundleId: value.bundleId };
}

function decodeVaultCreated(value: unknown): { readonly vaultId: string } {
  if (!plainRecord(value) || !exactKeys(value, ["vaultId"]) || !identifier(value.vaultId)) {
    throw protocolError();
  }
  return { vaultId: value.vaultId };
}

function decodeVaultClosed(value: unknown): { readonly eventRecordId: string } {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["eventRecordId"]) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return { eventRecordId: value.eventRecordId };
}

function decodeVaultVacuumed(value: unknown): {
  readonly predecessorGenerationId: string;
  readonly successorGenerationId: string;
  readonly vacuumEventRecordId: string;
  readonly successorBaselineId: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "predecessorGenerationId",
      "successorGenerationId",
      "successorBaselineId",
      "vacuumEventRecordId",
    ]) ||
    !identifier(value.predecessorGenerationId) ||
    !identifier(value.successorGenerationId) ||
    !identifier(value.vacuumEventRecordId) ||
    !identifier(value.successorBaselineId)
  ) {
    throw protocolError();
  }
  return {
    predecessorGenerationId: value.predecessorGenerationId,
    successorGenerationId: value.successorGenerationId,
    vacuumEventRecordId: value.vacuumEventRecordId,
    successorBaselineId: value.successorBaselineId,
  };
}

function decodeMemberRecovered(value: unknown): {
  readonly memberId: string;
  readonly clientCredentialId: string;
  readonly eventRecordId: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["memberId", "clientCredentialId", "eventRecordId"]) ||
    !identifier(value.memberId) ||
    !identifier(value.clientCredentialId) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return {
    memberId: value.memberId,
    clientCredentialId: value.clientCredentialId,
    eventRecordId: value.eventRecordId,
  };
}

function decodeHostedMemberRecovered(value: unknown): {
  readonly vaultId: string;
  readonly memberId: string;
  readonly clientCredentialId: string;
  readonly eventRecordId: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["vaultId", "memberId", "clientCredentialId", "eventRecordId"]) ||
    !identifier(value.vaultId) ||
    !identifier(value.memberId) ||
    !identifier(value.clientCredentialId) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return {
    vaultId: value.vaultId,
    memberId: value.memberId,
    clientCredentialId: value.clientCredentialId,
    eventRecordId: value.eventRecordId,
  };
}

function decodeRecoveryPhraseReplaced(value: unknown): {
  readonly recoveryCredentialId: string;
  readonly revision: number;
  readonly eventRecordId: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["recoveryCredentialId", "revision", "eventRecordId"]) ||
    !identifier(value.recoveryCredentialId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return {
    recoveryCredentialId: value.recoveryCredentialId,
    revision: value.revision,
    eventRecordId: value.eventRecordId,
  };
}

function decodeEventResult(value: unknown): CanonicalClientEventResult {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["eventRecordId"]) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return { eventRecordId: value.eventRecordId };
}

function decodeCreatedIdentifier(
  value: unknown,
  key: "folderId" | "tagId" | "noteId",
):
  | ({ readonly folderId: string } & CanonicalClientEventResult)
  | ({ readonly tagId: string } & CanonicalClientEventResult)
  | ({ readonly noteId: string } & CanonicalClientEventResult) {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [key, "eventRecordId"]) ||
    !identifier(value[key]) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return { [key]: value[key], eventRecordId: value.eventRecordId } as never;
}

function decodeAssignmentCreated(
  value: unknown,
): { readonly assignmentId: string } & CanonicalClientEventResult {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["assignmentId", "eventRecordId"]) ||
    !identifier(value.assignmentId) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return { assignmentId: value.assignmentId, eventRecordId: value.eventRecordId };
}

function decodeSearchCoverage(value: unknown): CanonicalClientSearchCoverage {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "eligibleCaptures",
      "indexedCaptures",
      "unavailableHeavyContent",
      "failedCaptures",
    ]) ||
    !nonnegativeInteger(value.eligibleCaptures) ||
    !nonnegativeInteger(value.indexedCaptures) ||
    !nonnegativeInteger(value.unavailableHeavyContent) ||
    !nonnegativeInteger(value.failedCaptures)
  ) {
    throw protocolError();
  }
  return {
    eligibleCaptures: value.eligibleCaptures,
    indexedCaptures: value.indexedCaptures,
    unavailableHeavyContent: value.unavailableHeavyContent,
    failedCaptures: value.failedCaptures,
  };
}

function decodeSearchResults(value: unknown): readonly CanonicalClientSearchResult[] {
  if (!Array.isArray(value)) throw protocolError();
  const results = value.map((entry) => {
    if (
      !plainRecord(entry) ||
      !exactKeys(entry, ["kind", "id", "title", "passageId", "snippet", "score"]) ||
      !(entry.kind === "Capture" || entry.kind === "Collection" || entry.kind === "Note") ||
      !identifier(entry.id) ||
      typeof entry.title !== "string" ||
      !identifier(entry.passageId) ||
      typeof entry.snippet !== "string" ||
      typeof entry.score !== "number" ||
      !Number.isFinite(entry.score)
    ) {
      throw protocolError();
    }
    return {
      kind: entry.kind as CanonicalClientSearchResult["kind"],
      id: entry.id,
      title: entry.title,
      passageId: entry.passageId,
      snippet: entry.snippet,
      score: entry.score,
    };
  });
  if (new Set(results.map(({ id }) => id)).size !== results.length) throw protocolError();
  return results;
}

function decodeCollections(value: unknown): readonly CanonicalClientCollection[] {
  if (!Array.isArray(value)) throw protocolError();
  return value.map((entry) => {
    if (
      !plainRecord(entry) ||
      !exactKeys(entry, [
        "collectionId",
        "explicitTitle",
        "title",
        "tailBundleId",
        "activeCaptureCount",
        "redirectedTo",
        "folderId",
      ]) ||
      !identifier(entry.collectionId) ||
      !(entry.explicitTitle === null || typeof entry.explicitTitle === "string") ||
      typeof entry.title !== "string" ||
      !(entry.tailBundleId === null || identifier(entry.tailBundleId)) ||
      !nonnegativeInteger(entry.activeCaptureCount) ||
      !(entry.redirectedTo === null || identifier(entry.redirectedTo)) ||
      !(entry.folderId === null || identifier(entry.folderId))
    ) {
      throw protocolError();
    }
    return {
      collectionId: entry.collectionId,
      explicitTitle: entry.explicitTitle,
      title: entry.title,
      tailBundleId: entry.tailBundleId,
      activeCaptureCount: entry.activeCaptureCount,
      redirectedTo: entry.redirectedTo,
      folderId: entry.folderId,
    };
  });
}

function decodeFolders(value: unknown): readonly CanonicalClientFolder[] {
  if (!Array.isArray(value)) throw protocolError();
  return value.map((entry) => {
    if (
      !plainRecord(entry) ||
      !exactKeys(entry, [
        "folderId",
        "name",
        "parentFolderId",
        "effectiveParentFolderId",
        "lifecycle",
      ]) ||
      !identifier(entry.folderId) ||
      typeof entry.name !== "string" ||
      !(entry.parentFolderId === null || identifier(entry.parentFolderId)) ||
      !(entry.effectiveParentFolderId === null || identifier(entry.effectiveParentFolderId)) ||
      !(entry.lifecycle === "Active" || entry.lifecycle === "Deleted")
    ) {
      throw protocolError();
    }
    return {
      folderId: entry.folderId,
      name: entry.name,
      parentFolderId: entry.parentFolderId,
      effectiveParentFolderId: entry.effectiveParentFolderId,
      lifecycle: entry.lifecycle,
    };
  });
}

function decodeTags(value: unknown): readonly CanonicalClientTag[] {
  if (!Array.isArray(value)) throw protocolError();
  return value.map((entry) => {
    if (
      !plainRecord(entry) ||
      !exactKeys(entry, ["tagId", "name", "lifecycle", "redirectedTo"]) ||
      !identifier(entry.tagId) ||
      typeof entry.name !== "string" ||
      !(entry.lifecycle === "Active" || entry.lifecycle === "Deleted") ||
      !(entry.redirectedTo === null || identifier(entry.redirectedTo))
    ) {
      throw protocolError();
    }
    return {
      tagId: entry.tagId,
      name: entry.name,
      lifecycle: entry.lifecycle,
      redirectedTo: entry.redirectedTo,
    };
  });
}

function decodeTagAssignments(value: unknown): readonly CanonicalClientTagAssignment[] {
  if (!Array.isArray(value)) throw protocolError();
  return value.map((entry) => {
    if (
      !plainRecord(entry) ||
      !exactKeys(entry, [
        "assignmentId",
        "assignedCauseId",
        "tagId",
        "effectiveTagId",
        "targetKind",
        "targetId",
        "active",
      ]) ||
      !identifier(entry.assignmentId) ||
      !identifier(entry.assignedCauseId) ||
      !identifier(entry.tagId) ||
      !identifier(entry.effectiveTagId) ||
      !(entry.targetKind === "Collection" || entry.targetKind === "Capture") ||
      !identifier(entry.targetId) ||
      typeof entry.active !== "boolean"
    ) {
      throw protocolError();
    }
    return {
      assignmentId: entry.assignmentId,
      assignedCauseId: entry.assignedCauseId,
      tagId: entry.tagId,
      effectiveTagId: entry.effectiveTagId,
      targetKind: entry.targetKind,
      targetId: entry.targetId,
      active: entry.active,
    };
  });
}

function decodeNotes(value: unknown): readonly CanonicalClientNote[] {
  if (!Array.isArray(value)) throw protocolError();
  return value.map((entry) => {
    if (
      !plainRecord(entry) ||
      !exactKeys(entry, ["noteId", "targetKind", "targetId", "state", "versions"]) ||
      !identifier(entry.noteId) ||
      !(entry.targetKind === "Collection" || entry.targetKind === "Capture") ||
      !identifier(entry.targetId) ||
      !(entry.state === "Active" || entry.state === "Deleted" || entry.state === "Conflict") ||
      !Array.isArray(entry.versions)
    ) {
      throw protocolError();
    }
    const versions = entry.versions.map((version) => {
      if (
        !plainRecord(version) ||
        !exactKeys(version, [
          "headCauseId",
          "contentObjectId",
          "title",
          "body",
          "bodyDialect",
          "originVaultId",
          "memberId",
          "clientCredentialId",
          "assertedAt",
        ]) ||
        !identifier(version.headCauseId) ||
        !(version.contentObjectId === null || identifier(version.contentObjectId)) ||
        !(version.title === null || typeof version.title === "string") ||
        !(version.body === null || typeof version.body === "string") ||
        !(version.bodyDialect === null || version.bodyDialect === "awsm.note.commonmark") ||
        !identifier(version.originVaultId) ||
        !identifier(version.memberId) ||
        !identifier(version.clientCredentialId) ||
        !safeTimestamp(version.assertedAt)
      ) {
        throw protocolError();
      }
      return {
        headCauseId: version.headCauseId,
        contentObjectId: version.contentObjectId,
        title: version.title,
        body: version.body,
        bodyDialect: version.bodyDialect as "awsm.note.commonmark" | null,
        originVaultId: version.originVaultId,
        memberId: version.memberId,
        clientCredentialId: version.clientCredentialId,
        assertedAt: version.assertedAt,
      };
    });
    return {
      noteId: entry.noteId,
      targetKind: entry.targetKind,
      targetId: entry.targetId,
      state: entry.state,
      versions,
    };
  });
}

function decodeLibraryConflicts(value: unknown): readonly CanonicalClientLibraryConflict[] {
  if (!Array.isArray(value)) throw protocolError();
  return value.map((entry) => {
    if (!plainRecord(entry) || typeof entry.kind !== "string") throw protocolError();
    if (entry.kind === "CaptureIdentity") {
      if (
        !exactKeys(entry, ["kind", "bundleId", "registrationRecordIds"]) ||
        !identifier(entry.bundleId) ||
        !Array.isArray(entry.registrationRecordIds) ||
        !entry.registrationRecordIds.every(identifier)
      )
        throw protocolError();
      return {
        kind: entry.kind,
        bundleId: entry.bundleId,
        registrationRecordIds: entry.registrationRecordIds,
      };
    }
    if (entry.kind === "CollectionMerge") {
      if (
        !exactKeys(entry, ["kind", "reason", "subjectCollectionIds", "candidateRecordIds"]) ||
        !(entry.reason === "MultipleDestinations" || entry.reason === "Cycle") ||
        !Array.isArray(entry.subjectCollectionIds) ||
        !entry.subjectCollectionIds.every(identifier) ||
        !Array.isArray(entry.candidateRecordIds) ||
        !entry.candidateRecordIds.every(identifier)
      )
        throw protocolError();
      return {
        kind: entry.kind,
        reason: entry.reason,
        subjectCollectionIds: entry.subjectCollectionIds,
        candidateRecordIds: entry.candidateRecordIds,
      };
    }
    if (entry.kind === "TagMerge") {
      if (
        !exactKeys(entry, ["kind", "reason", "subjectTagIds", "candidateRecordIds"]) ||
        !(entry.reason === "MultipleDestinations" || entry.reason === "Cycle") ||
        !Array.isArray(entry.subjectTagIds) ||
        !entry.subjectTagIds.every(identifier) ||
        !Array.isArray(entry.candidateRecordIds) ||
        !entry.candidateRecordIds.every(identifier)
      )
        throw protocolError();
      return {
        kind: entry.kind,
        reason: entry.reason,
        subjectTagIds: entry.subjectTagIds,
        candidateRecordIds: entry.candidateRecordIds,
      };
    }
    if (entry.kind === "Folder") {
      if (
        !exactKeys(entry, ["kind", "subjectFolderIds", "candidateRecordIds"]) ||
        !Array.isArray(entry.subjectFolderIds) ||
        !entry.subjectFolderIds.every(identifier) ||
        !Array.isArray(entry.candidateRecordIds) ||
        !entry.candidateRecordIds.every(identifier)
      )
        throw protocolError();
      return {
        kind: entry.kind,
        subjectFolderIds: entry.subjectFolderIds,
        candidateRecordIds: entry.candidateRecordIds,
      };
    }
    if (entry.kind === "Note") {
      if (
        !exactKeys(entry, ["kind", "noteId", "candidateRecordIds"]) ||
        !identifier(entry.noteId) ||
        !Array.isArray(entry.candidateRecordIds) ||
        !entry.candidateRecordIds.every(identifier)
      )
        throw protocolError();
      return {
        kind: entry.kind,
        noteId: entry.noteId,
        candidateRecordIds: entry.candidateRecordIds,
      };
    }
    throw protocolError();
  });
}

function assertNullableVaultId(value: string | null): void {
  if (value !== null && !identifier(value))
    throw new TypeError("Popup expected Vault ID is invalid.");
}

function assertText(value: string, field: string): void {
  if (value.length < 1 || value.length > 1_024) throw new TypeError(`Popup ${field} is invalid.`);
}

function assertIdentifierValue(value: string, field: string): void {
  if (!identifier(value)) throw new TypeError(`Popup ${field} is invalid.`);
}

function assertIdentifierArray(values: readonly string[], field: string): void {
  if (values.some((value) => !identifier(value))) throw new TypeError(`Popup ${field} is invalid.`);
}

function assertNullableIdentifierValue(value: string | null, field: string): void {
  if (value !== null && !identifier(value)) throw new TypeError(`Popup ${field} is invalid.`);
}

function assertContentTarget(input: {
  readonly targetKind: "Collection" | "Capture";
  readonly targetId: string;
}): void {
  assertIdentifierValue(input.targetId, `${input.targetKind} ID`);
}

function assertHostedReplicaSetup(input: {
  readonly expectedVaultId: string;
  readonly endpoint: string;
  readonly name: string;
  readonly username: string;
  readonly password: string;
}): void {
  if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
  if (!hostedEndpoint(input.endpoint))
    throw new TypeError("Popup Hosted Replica endpoint is invalid.");
  if (input.name.length < 1 || input.name.length > 256)
    throw new TypeError("Popup Hosted Replica name is invalid.");
  if (input.username.length < 1 || input.username.length > 256)
    throw new TypeError("Popup Hosted Replica username is invalid.");
  if (input.password.length < 1 || input.password.length > 1_024)
    throw new TypeError("Popup Hosted Replica password is invalid.");
}

function assertHostedMemberRecovery(input: {
  readonly endpoint: string;
  readonly username: string;
  readonly password: string;
  readonly recoveryPhrase: string;
}): void {
  if (!hostedEndpoint(input.endpoint))
    throw new TypeError("Popup Hosted Replica endpoint is invalid.");
  if (input.username.length < 1 || input.username.length > 256)
    throw new TypeError("Popup Hosted Replica username is invalid.");
  if (input.password.length < 1 || input.password.length > 1_024)
    throw new TypeError("Popup Hosted Replica password is invalid.");
  assertText(input.recoveryPhrase, "Recovery Phrase");
}

export function createCanonicalPopupApplicationClient(
  transport: CanonicalPopupApplicationTransport,
): CanonicalPopupApplicationClient {
  return {
    async state(): Promise<CanonicalClientState> {
      return decodeState(await transport.request({ type: "GetState" }));
    },
    async listLibrary(expectedVaultId: string): Promise<readonly CanonicalClientLibraryItem[]> {
      return decodeLibrary(await transport.request({ type: "ListLibrary", expectedVaultId }));
    },
    async listRemotes(expectedVaultId: string): Promise<readonly CanonicalClientRemoteSummary[]> {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeRemotes(await transport.request({ type: "ListRemotes", expectedVaultId }));
    },
    async renameRemote(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!setupId(input.remoteId)) throw new TypeError("Popup Hosted Replica ID is invalid.");
      if (input.name.length < 1 || input.name.length > 256)
        throw new TypeError("Popup Hosted Replica name is invalid.");
      return decodeRemoteSummary(
        await transport.request({
          type: "RenameRemote",
          expectedVaultId: input.expectedVaultId,
          remoteId: input.remoteId,
          name: input.name,
        }),
      );
    },
    async setRemoteEnabled(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!setupId(input.remoteId)) throw new TypeError("Popup Hosted Replica ID is invalid.");
      return decodeRemoteSummary(
        await transport.request({
          type: "SetRemoteEnabled",
          expectedVaultId: input.expectedVaultId,
          remoteId: input.remoteId,
          enabled: input.enabled,
        }),
      );
    },
    async retireRemote(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!setupId(input.remoteId)) throw new TypeError("Popup Hosted Replica ID is invalid.");
      return decodeRemoteRetirement(
        await transport.request({
          type: "RetireRemote",
          expectedVaultId: input.expectedVaultId,
          remoteId: input.remoteId,
        }),
      );
    },
    subscribe(listener: () => void): () => void {
      return transport.subscribe(listener);
    },
    async beginVaultCreation(input) {
      assertNullableVaultId(input.expectedVaultId);
      if (input.label !== null && input.label.length > 1_024)
        throw new TypeError("Popup Vault label is invalid.");
      return decodeVaultCreation(
        await transport.request({
          type: "BeginVaultCreation",
          expectedVaultId: input.expectedVaultId,
          label: input.label,
        }),
      );
    },
    async confirmVaultCreation(input) {
      assertText(input.setupId, "setup ID");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeVaultCreated(
        await transport.request({
          type: "ConfirmVaultCreation",
          setupId: input.setupId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async cancelVaultCreation(setupId) {
      assertText(setupId, "setup ID");
      const value = await transport.request({ type: "CancelVaultCreation", setupId });
      if (value !== null) throw protocolError();
    },
    async beginVaultFork(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultCreation(
        await transport.request({ type: "BeginVaultFork", expectedVaultId }),
      );
    },
    async confirmVaultFork(input) {
      assertText(input.setupId, "setup ID");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeVaultCreated(
        await transport.request({
          type: "ConfirmVaultFork",
          setupId: input.setupId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async cancelVaultFork(setupId) {
      assertText(setupId, "setup ID");
      const value = await transport.request({ type: "CancelVaultFork", setupId });
      if (value !== null) throw protocolError();
    },
    async recoverMember(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeMemberRecovered(
        await transport.request({
          type: "RecoverMember",
          expectedVaultId: input.expectedVaultId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async recoverHostedMember(input) {
      assertHostedMemberRecovery(input);
      return decodeHostedMemberRecovered(
        await transport.request({
          type: "RecoverHostedMember",
          endpoint: input.endpoint,
          username: input.username,
          password: input.password,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async beginRecoveryPhraseReplacement(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultCreation(
        await transport.request({ type: "BeginRecoveryPhraseReplacement", expectedVaultId }),
      );
    },
    async confirmRecoveryPhraseReplacement(input) {
      assertText(input.setupId, "setup ID");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeRecoveryPhraseReplaced(
        await transport.request({
          type: "ConfirmRecoveryPhraseReplacement",
          setupId: input.setupId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async cancelRecoveryPhraseReplacement(setupId) {
      assertText(setupId, "setup ID");
      const value = await transport.request({ type: "CancelRecoveryPhraseReplacement", setupId });
      if (value !== null) throw protocolError();
    },
    async selectVault(input) {
      assertNullableVaultId(input.expectedVaultId);
      if (!identifier(input.vaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeState(
        await transport.request({
          type: "SelectVault",
          expectedVaultId: input.expectedVaultId,
          vaultId: input.vaultId,
        }),
      );
    },
    async captureActivePage(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (input.tabId !== undefined && (!Number.isSafeInteger(input.tabId) || input.tabId < 0)) {
        throw new TypeError("Popup tab ID is invalid.");
      }
      return decodeCapture(
        await transport.request({
          type: "CaptureActivePage",
          expectedVaultId: input.expectedVaultId,
          ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
        }),
      );
    },
    async closeVault(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultClosed(await transport.request({ type: "CloseVault", expectedVaultId }));
    },
    async vacuumVault(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultVacuumed(await transport.request({ type: "VacuumVault", expectedVaultId }));
    },
    async createHostedReplica(input) {
      assertHostedReplicaSetup(input);
      return decodeRemoteSummary(
        await transport.request({
          type: "CreateHostedReplica",
          expectedVaultId: input.expectedVaultId,
          endpoint: input.endpoint,
          name: input.name,
          username: input.username,
          password: input.password,
        }),
      );
    },
    async beginHostedReplicaAttachment(input) {
      assertHostedReplicaSetup(input);
      return decodeHostedReplicaAttachment(
        await transport.request({
          type: "BeginHostedReplicaAttachment",
          expectedVaultId: input.expectedVaultId,
          endpoint: input.endpoint,
          name: input.name,
          username: input.username,
          password: input.password,
        }),
      );
    },
    async confirmHostedReplicaAttachment(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!setupId(input.setupId)) throw new TypeError("Popup Hosted Replica setup ID is invalid.");
      if (!setupId(input.replicaHandle))
        throw new TypeError("Popup Hosted Replica handle is invalid.");
      return decodeRemoteSummary(
        await transport.request({
          type: "ConfirmHostedReplicaAttachment",
          expectedVaultId: input.expectedVaultId,
          setupId: input.setupId,
          replicaHandle: input.replicaHandle,
        }),
      );
    },
    async cancelHostedReplicaAttachment(attachmentSetupId) {
      if (!setupId(attachmentSetupId))
        throw new TypeError("Popup Hosted Replica setup ID is invalid.");
      const value = await transport.request({
        type: "CancelHostedReplicaAttachment",
        setupId: attachmentSetupId,
      });
      if (value !== null) throw protocolError();
    },
    async materializeHostedReplica(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!setupId(input.remoteId)) throw new TypeError("Popup Hosted Replica ID is invalid.");
      return decodeHostedReplicaMaterialization(
        await transport.request({
          type: "MaterializeHostedReplica",
          expectedVaultId: input.expectedVaultId,
          remoteId: input.remoteId,
        }),
      );
    },
    async pullHostedReplicas(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeHostedReplicaPull(
        await transport.request({ type: "PullHostedReplicas", expectedVaultId }),
      );
    },
    async hydrateArtifact(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!identifier(input.artifactId)) throw new TypeError("Popup Artifact ID is invalid.");
      return decodeArtifactHydration(
        await transport.request({
          type: "HydrateArtifact",
          expectedVaultId: input.expectedVaultId,
          artifactId: input.artifactId,
        }),
      );
    },
    async search(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.collectionIds, "Collection IDs");
      assertIdentifierArray(input.tagIds, "Tag IDs");
      if (input.capturedFrom !== undefined && !nonnegativeInteger(input.capturedFrom)) {
        throw new TypeError("Popup Search lower bound is invalid.");
      }
      if (input.capturedBefore !== undefined && !nonnegativeInteger(input.capturedBefore)) {
        throw new TypeError("Popup Search upper bound is invalid.");
      }
      return decodeSearchResults(await transport.request({ type: "Search", ...input }));
    },
    async searchCoverage(expectedVaultId) {
      assertIdentifierValue(expectedVaultId, "Vault ID");
      return decodeSearchCoverage(
        await transport.request({ type: "SearchCoverage", expectedVaultId }),
      );
    },
    async listCollections(expectedVaultId) {
      assertIdentifierValue(expectedVaultId, "Vault ID");
      return decodeCollections(
        await transport.request({ type: "ListCollections", expectedVaultId }),
      );
    },
    async listFolders(expectedVaultId) {
      assertIdentifierValue(expectedVaultId, "Vault ID");
      return decodeFolders(await transport.request({ type: "ListFolders", expectedVaultId }));
    },
    async listTags(expectedVaultId) {
      assertIdentifierValue(expectedVaultId, "Vault ID");
      return decodeTags(await transport.request({ type: "ListTags", expectedVaultId }));
    },
    async listTagAssignments(expectedVaultId) {
      assertIdentifierValue(expectedVaultId, "Vault ID");
      return decodeTagAssignments(
        await transport.request({ type: "ListTagAssignments", expectedVaultId }),
      );
    },
    async listNotes(expectedVaultId) {
      assertIdentifierValue(expectedVaultId, "Vault ID");
      return decodeNotes(await transport.request({ type: "ListNotes", expectedVaultId }));
    },
    async listLibraryConflicts(expectedVaultId) {
      assertIdentifierValue(expectedVaultId, "Vault ID");
      return decodeLibraryConflicts(
        await transport.request({ type: "ListLibraryConflicts", expectedVaultId }),
      );
    },
    async createFolder(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertText(input.name, "Folder name");
      assertNullableIdentifierValue(input.parentFolderId, "parent Folder ID");
      return decodeCreatedIdentifier(
        await transport.request({ type: "CreateFolder", ...input }),
        "folderId",
      ) as { readonly folderId: string } & CanonicalClientEventResult;
    },
    async renameFolder(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.folderId, "Folder ID");
      assertText(input.name, "Folder name");
      return decodeEventResult(await transport.request({ type: "RenameFolder", ...input }));
    },
    async placeFolder(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.folderId, "Folder ID");
      assertNullableIdentifierValue(input.parentFolderId, "parent Folder ID");
      return decodeEventResult(await transport.request({ type: "PlaceFolder", ...input }));
    },
    async deleteFolder(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.folderId, "Folder ID");
      return decodeEventResult(await transport.request({ type: "DeleteFolder", ...input }));
    },
    async restoreFolder(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.folderId, "Folder ID");
      return decodeEventResult(await transport.request({ type: "RestoreFolder", ...input }));
    },
    async placeCollectionInFolder(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.collectionId, "Collection ID");
      assertNullableIdentifierValue(input.folderId, "Folder ID");
      return decodeEventResult(
        await transport.request({ type: "PlaceCollectionInFolder", ...input }),
      );
    },
    async resolveFolderConflict(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.subjectFolderIds, "Folder conflict subjects");
      assertIdentifierArray(input.conflictingCauseIds, "Folder conflict Causes");
      for (const placement of input.placements) {
        assertIdentifierValue(placement.folderId, "Folder ID");
        assertNullableIdentifierValue(placement.parentFolderId, "parent Folder ID");
      }
      return decodeEventResult(
        await transport.request({ type: "ResolveFolderConflict", ...input }),
      );
    },
    async setCollectionTitle(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.collectionId, "Collection ID");
      if (input.title !== null) assertText(input.title, "Collection title");
      return decodeEventResult(await transport.request({ type: "SetCollectionTitle", ...input }));
    },
    async mergeCollections(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.sourceCollectionIds, "Collection IDs");
      assertIdentifierValue(input.destinationCollectionId, "destination Collection ID");
      return decodeEventResult(await transport.request({ type: "MergeCollections", ...input }));
    },
    async revertCollectionMerge(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.redirectCauseId, "redirect Cause ID");
      return decodeEventResult(
        await transport.request({ type: "RevertCollectionMerge", ...input }),
      );
    },
    async resolveCollectionMergeConflict(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.subjectCollectionIds, "Collection conflict subjects");
      assertIdentifierArray(input.conflictingCauseIds, "Collection conflict Causes");
      for (const redirect of input.redirects) {
        assertIdentifierValue(redirect.sourceCollectionId, "source Collection ID");
        assertIdentifierValue(redirect.destinationCollectionId, "destination Collection ID");
      }
      return decodeEventResult(
        await transport.request({ type: "ResolveCollectionMergeConflict", ...input }),
      );
    },
    async moveCaptures(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.bundleIds, "Capture IDs");
      assertIdentifierValue(input.destinationCollectionId, "destination Collection ID");
      return decodeEventResult(await transport.request({ type: "MoveCaptures", ...input }));
    },
    async deleteCaptures(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.bundleIds, "Capture IDs");
      return decodeEventResult(await transport.request({ type: "DeleteCaptures", ...input }));
    },
    async restoreCaptures(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.bundleIds, "Capture IDs");
      return decodeEventResult(await transport.request({ type: "RestoreCaptures", ...input }));
    },
    async createTag(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertText(input.name, "Tag name");
      return decodeCreatedIdentifier(
        await transport.request({ type: "CreateTag", ...input }),
        "tagId",
      ) as { readonly tagId: string } & CanonicalClientEventResult;
    },
    async renameTag(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.tagId, "Tag ID");
      assertText(input.name, "Tag name");
      return decodeEventResult(await transport.request({ type: "RenameTag", ...input }));
    },
    async assignTag(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.tagId, "Tag ID");
      assertContentTarget(input);
      return decodeAssignmentCreated(await transport.request({ type: "AssignTag", ...input }));
    },
    async removeTagAssignments(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.tagId, "Tag ID");
      assertContentTarget(input);
      return decodeEventResult(await transport.request({ type: "RemoveTagAssignments", ...input }));
    },
    async deleteTag(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.tagId, "Tag ID");
      return decodeEventResult(await transport.request({ type: "DeleteTag", ...input }));
    },
    async restoreTag(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.tagId, "Tag ID");
      return decodeEventResult(await transport.request({ type: "RestoreTag", ...input }));
    },
    async mergeTags(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.sourceTagIds, "Tag IDs");
      assertIdentifierValue(input.destinationTagId, "destination Tag ID");
      return decodeEventResult(await transport.request({ type: "MergeTags", ...input }));
    },
    async revertTagMerge(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.redirectCauseId, "redirect Cause ID");
      return decodeEventResult(await transport.request({ type: "RevertTagMerge", ...input }));
    },
    async resolveTagMergeConflict(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierArray(input.subjectTagIds, "Tag conflict subjects");
      assertIdentifierArray(input.conflictingCauseIds, "Tag conflict Causes");
      for (const redirect of input.redirects) {
        assertIdentifierValue(redirect.sourceTagId, "source Tag ID");
        assertIdentifierValue(redirect.destinationTagId, "destination Tag ID");
      }
      return decodeEventResult(
        await transport.request({ type: "ResolveTagMergeConflict", ...input }),
      );
    },
    async createNote(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertContentTarget(input);
      if (input.title !== null) assertText(input.title, "Note title");
      assertText(input.body, "Note body");
      return decodeCreatedIdentifier(
        await transport.request({ type: "CreateNote", ...input }),
        "noteId",
      ) as { readonly noteId: string } & CanonicalClientEventResult;
    },
    async reviseNote(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.noteId, "Note ID");
      if (input.title !== null) assertText(input.title, "Note title");
      assertText(input.body, "Note body");
      return decodeEventResult(await transport.request({ type: "ReviseNote", ...input }));
    },
    async deleteNote(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.noteId, "Note ID");
      return decodeEventResult(await transport.request({ type: "DeleteNote", ...input }));
    },
    async restoreNote(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.noteId, "Note ID");
      return decodeEventResult(await transport.request({ type: "RestoreNote", ...input }));
    },
    async resolveNoteConflict(input) {
      assertIdentifierValue(input.expectedVaultId, "Vault ID");
      assertIdentifierValue(input.noteId, "Note ID");
      assertIdentifierArray(input.conflictingCauseIds, "Note conflict Causes");
      if (input.retainedOriginal !== null) {
        if (input.retainedOriginal.title !== null)
          assertText(input.retainedOriginal.title, "Note title");
        assertText(input.retainedOriginal.body, "Note body");
      }
      for (const splitNote of input.splitNotes) {
        if (splitNote.title !== null) assertText(splitNote.title, "Note title");
        assertText(splitNote.body, "Note body");
      }
      const value = await transport.request({ type: "ResolveNoteConflict", ...input });
      if (
        !plainRecord(value) ||
        !exactKeys(value, ["splitNoteIds", "eventRecordId"]) ||
        !Array.isArray(value.splitNoteIds) ||
        !value.splitNoteIds.every(identifier) ||
        !identifier(value.eventRecordId)
      ) {
        throw protocolError();
      }
      return { splitNoteIds: value.splitNoteIds, eventRecordId: value.eventRecordId };
    },
  };
}

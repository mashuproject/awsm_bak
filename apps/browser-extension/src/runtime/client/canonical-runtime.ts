import { DEPENDENCY_TYPES } from "../../domain/canonical/dependencies";
import { advisoryExtensions } from "../../domain/canonical/features";
import { type Identifier, randomIdentifier } from "../../domain/canonical/identifiers";
import { encodeVaultObject, NOTE_CONTENT_OBJECT } from "../../domain/canonical/object";
import { exactMap, identifierValue, mapValue } from "../../domain/canonical/schema";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import {
  identifierFromStorageKey,
  identifierStorageKey,
} from "../../drivers/indexeddb/canonical-database";
import type {
  CanonicalCaptureCommand,
  CanonicalCaptureService,
} from "../capture/canonical-service";
import { CanonicalContentService } from "../content/canonical-service";
import type {
  CanonicalLibraryNote,
  CanonicalLibraryProjection,
  CanonicalLibraryProjectionService,
} from "../library/canonical-projection";
import { type CanonicalSearchCoverage, CanonicalSearchService } from "../search/canonical-service";
import { type CanonicalForkCeremony, CanonicalForkService } from "../vault/canonical-fork-service";
import { CanonicalLifecycleService } from "../vault/canonical-lifecycle-service";
import { CanonicalMemberRecoveryService } from "../vault/canonical-member-recovery-service";
import {
  type CanonicalRecoveryReplacementCeremony,
  CanonicalRecoveryReplacementService,
} from "../vault/canonical-recovery-replacement-service";
import type {
  CanonicalVaultCreationCeremony,
  CanonicalVaultService,
} from "../vault/canonical-service";
import { CanonicalVacuumService } from "../vault/canonical-vacuum-service";

export interface CanonicalClientVaultSummary {
  readonly vaultId: string;
  readonly label: string | null;
  readonly lifecycle: "Open" | "Closed";
  readonly selected: boolean;
}

export interface CanonicalClientState {
  readonly selectedVaultId?: string;
  readonly pendingVaultCreation?: {
    readonly setupId: string;
    readonly expectedVaultId: string | null;
  };
  readonly vaults: readonly CanonicalClientVaultSummary[];
}

export interface CanonicalClientLibraryItem {
  readonly bundleId: string;
  readonly collectionId: string;
  readonly artifactId: string;
  readonly capturedAt: number | bigint;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly availableLocally: boolean;
  readonly lifecycle: "Active" | "Deleted";
}

export interface CanonicalClientSearchResult {
  readonly kind: "Capture" | "Collection" | "Note";
  readonly id: string;
  readonly title: string;
  readonly passageId: string;
  readonly snippet: string;
  readonly score: number;
}

export interface CanonicalClientCollection {
  readonly collectionId: string;
  readonly explicitTitle: string | null;
  readonly title: string;
  readonly tailBundleId: string | null;
  readonly activeCaptureCount: number;
  readonly redirectedTo: string | null;
  readonly folderId: string | null;
}

export interface CanonicalClientFolder {
  readonly folderId: string;
  readonly name: string;
  readonly parentFolderId: string | null;
  readonly effectiveParentFolderId: string | null;
  readonly lifecycle: "Active" | "Deleted";
}

export interface CanonicalClientTag {
  readonly tagId: string;
  readonly name: string;
  readonly lifecycle: "Active" | "Deleted";
  readonly redirectedTo: string | null;
}

export interface CanonicalClientTagAssignment {
  readonly assignmentId: string;
  readonly assignedCauseId: string;
  readonly tagId: string;
  readonly effectiveTagId: string;
  readonly targetKind: "Collection" | "Capture";
  readonly targetId: string;
  readonly active: boolean;
}

export interface CanonicalClientNoteVersion {
  readonly headCauseId: string;
  readonly contentObjectId: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly bodyDialect: "awsm.note.commonmark" | null;
  readonly originVaultId: string;
  readonly memberId: string;
  readonly clientCredentialId: string;
  readonly assertedAt: number | bigint;
}

export interface CanonicalClientNote {
  readonly noteId: string;
  readonly targetKind: "Collection" | "Capture";
  readonly targetId: string;
  readonly state: "Active" | "Deleted" | "Conflict";
  readonly versions: readonly CanonicalClientNoteVersion[];
}

export type CanonicalClientLibraryConflict =
  | {
      readonly kind: "CaptureIdentity";
      readonly bundleId: string;
      readonly registrationRecordIds: readonly string[];
    }
  | {
      readonly kind: "CollectionMerge";
      readonly reason: "MultipleDestinations" | "Cycle";
      readonly subjectCollectionIds: readonly string[];
      readonly candidateRecordIds: readonly string[];
    }
  | {
      readonly kind: "Folder";
      readonly subjectFolderIds: readonly string[];
      readonly candidateRecordIds: readonly string[];
    }
  | {
      readonly kind: "Note";
      readonly noteId: string;
      readonly candidateRecordIds: readonly string[];
    };

interface PendingVaultCreation {
  readonly expectedVaultId: string | null;
  readonly ceremony: CanonicalVaultCreationCeremony;
}

interface PendingVaultFork {
  readonly expectedVaultId: string;
  readonly ceremony: CanonicalForkCeremony;
}

interface PendingRecoveryReplacement {
  readonly expectedVaultId: string;
  readonly ceremony: CanonicalRecoveryReplacementCeremony;
}

function runtimeError(id: string, message: string): Error {
  return Object.assign(new Error(message), { id });
}

function isErrorId(error: unknown, id: string): boolean {
  return error instanceof Error && "id" in error && error.id === id;
}

function selectedVaultId(state: CanonicalClientState): string | null {
  return state.selectedVaultId ?? null;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function fixedBytesStorageKey(value: Uint8Array): string {
  if (value.byteLength !== 32) throw new TypeError("Client-safe digest must contain 32 bytes.");
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertAcyclicRedirects(redirects: ReadonlyMap<string, string>): void {
  for (const source of redirects.keys()) {
    let current: string | undefined = source;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (seen.has(current)) {
        throw runtimeError(
          "COLLECTION_MERGE_CONFLICT",
          "The Collection redirects would create a cycle.",
        );
      }
      seen.add(current);
      current = redirects.get(current);
    }
  }
}

function assertAcyclicFolderParents(parents: ReadonlyMap<string, string>): void {
  for (const folderId of parents.keys()) {
    let current: string | undefined = folderId;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (seen.has(current)) {
        throw runtimeError("FOLDER_CONFLICT", "The Folder placement would create a cycle.");
      }
      seen.add(current);
      current = parents.get(current);
    }
  }
}

export class CanonicalClientRuntime {
  private readonly pendingVaultCreations = new Map<string, PendingVaultCreation>();
  private readonly pendingVaultForks = new Map<string, PendingVaultFork>();
  private readonly pendingRecoveryReplacements = new Map<string, PendingRecoveryReplacement>();

  constructor(
    readonly vaults: CanonicalVaultService,
    readonly captures: CanonicalCaptureService,
    readonly library: CanonicalLibraryProjectionService,
    private readonly createSetupId: () => string = () => crypto.randomUUID(),
    readonly content: CanonicalContentService = new CanonicalContentService(vaults),
    private readonly createFolderId: () => Identifier<"Folder"> = () => randomIdentifier("Folder"),
    private readonly createTagId: () => Identifier<"Tag"> = () => randomIdentifier("Tag"),
    private readonly createTagAssignmentId: () => Identifier<"TagAssignment"> = () =>
      randomIdentifier("TagAssignment"),
    private readonly createNoteId: () => Identifier<"Note"> = () => randomIdentifier("Note"),
    readonly searchService: Pick<
      CanonicalSearchService,
      "load" | "query"
    > = new CanonicalSearchService(vaults, library),
    readonly lifecycle: Pick<CanonicalLifecycleService, "close"> = new CanonicalLifecycleService(
      vaults,
    ),
    readonly vacuumService: Pick<CanonicalVacuumService, "vacuum"> = new CanonicalVacuumService(
      vaults,
    ),
    readonly forkService: Pick<CanonicalForkService, "begin"> = new CanonicalForkService(
      vaults,
      captures.artifacts,
    ),
    readonly memberRecovery: Pick<
      CanonicalMemberRecoveryService,
      "enroll"
    > = new CanonicalMemberRecoveryService(vaults),
    readonly recoveryReplacement: Pick<
      CanonicalRecoveryReplacementService,
      "begin"
    > = new CanonicalRecoveryReplacementService(vaults),
  ) {}

  async state(): Promise<CanonicalClientState> {
    const [directory, pendingCreation] = await Promise.all([
      this.vaults.listVaults(),
      this.vaults.pendingCreation(),
    ]);
    const selected = directory.filter(({ selected: isSelected }) => isSelected);
    if (selected.length > 1) {
      throw runtimeError(
        "STORAGE_SCHEMA_INVALID",
        "The Installation has more than one selected Vault.",
      );
    }
    return {
      ...(selected[0] === undefined
        ? {}
        : { selectedVaultId: identifierStorageKey(selected[0].vaultId) }),
      ...(pendingCreation === undefined
        ? {}
        : {
            pendingVaultCreation: {
              setupId: pendingCreation.setupId,
              expectedVaultId:
                pendingCreation.expectedVaultId === null
                  ? null
                  : identifierStorageKey(pendingCreation.expectedVaultId),
            },
          }),
      vaults: directory.map((entry) => ({
        vaultId: identifierStorageKey(entry.vaultId),
        label: entry.label,
        lifecycle: entry.lifecycle === 1 ? "Open" : "Closed",
        selected: entry.selected,
      })),
    };
  }

  async beginVaultCreation(input: {
    readonly expectedVaultId: string | null;
    readonly label: string | null;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly setupId: string; readonly recoveryPhrase: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    if ((await this.vaults.pendingCreation()) !== undefined) {
      throw runtimeError(
        "VAULT_CREATION_PENDING",
        "Finish or cancel the existing Vault creation before starting another one.",
      );
    }
    const setupId = this.createSetupId();
    if (this.hasPendingSetup(setupId)) {
      throw runtimeError("VAULT_CREATION_CONFLICT", "The Vault creation setup ID is not unique.");
    }
    const ceremony = await this.vaults.beginCreate({
      setupId,
      expectedVaultId:
        input.expectedVaultId === null
          ? null
          : identifierFromStorageKey("Vault", input.expectedVaultId),
      label: input.label,
      assertedAt: input.assertedAt,
    });
    this.pendingVaultCreations.set(setupId, {
      expectedVaultId: input.expectedVaultId,
      ceremony,
    });
    return { setupId, recoveryPhrase: ceremony.recoveryPhrase };
  }

  async confirmVaultCreation(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{ readonly vaultId: string }> {
    const pending = await this.requirePendingCreation(input.setupId, input.recoveryPhrase);
    await this.assertExpectedVault(pending.expectedVaultId);
    const created = await pending.ceremony.confirm(input.recoveryPhrase);
    this.pendingVaultCreations.delete(input.setupId);
    return { vaultId: identifierStorageKey(created.vaultId) };
  }

  async cancelVaultCreation(setupId: string): Promise<void> {
    const pending = this.pendingVaultCreations.get(setupId);
    if (pending === undefined) {
      await this.vaults.cancelPendingCreate(setupId);
      return;
    }
    await pending.ceremony.cancel();
    this.pendingVaultCreations.delete(setupId);
  }

  async beginVaultFork(input: {
    readonly expectedVaultId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly setupId: string; readonly recoveryPhrase: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    const ceremony = await this.forkService.begin({
      sourceVaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      assertedAt: input.assertedAt,
    });
    const setupId = this.createSetupId();
    if (this.hasPendingSetup(setupId)) {
      await ceremony.cancel();
      throw runtimeError("VAULT_FORK_CONFLICT", "The Fork setup ID is not unique.");
    }
    this.pendingVaultForks.set(setupId, {
      expectedVaultId: input.expectedVaultId,
      ceremony,
    });
    return { setupId, recoveryPhrase: ceremony.recoveryPhrase };
  }

  async confirmVaultFork(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{ readonly vaultId: string }> {
    const pending = this.requirePendingFork(input.setupId);
    await this.assertExpectedVault(pending.expectedVaultId);
    const created = await pending.ceremony.confirm(input.recoveryPhrase);
    this.pendingVaultForks.delete(input.setupId);
    return { vaultId: identifierStorageKey(created.vaultId) };
  }

  async cancelVaultFork(setupId: string): Promise<void> {
    const pending = this.requirePendingFork(setupId);
    this.pendingVaultForks.delete(setupId);
    await pending.ceremony.cancel();
  }

  async recoverMember(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly recoveryPhrase: string;
    readonly assertedAt: number | bigint;
  }): Promise<{
    readonly memberId: string;
    readonly clientCredentialId: string;
    readonly eventRecordId: string;
  }> {
    await this.assertExpectedVault(input.expectedVaultId);
    const outcome = await this.memberRecovery.enroll({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      recoveryPhrase: input.recoveryPhrase,
      assertedAt: input.assertedAt,
    });
    return {
      memberId: identifierStorageKey(outcome.memberId),
      clientCredentialId: identifierStorageKey(outcome.clientCredentialId),
      eventRecordId: identifierStorageKey(outcome.eventRecordId),
    };
  }

  async beginRecoveryPhraseReplacement(input: {
    readonly expectedVaultId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly setupId: string; readonly recoveryPhrase: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    const ceremony = await this.recoveryReplacement.begin({
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      assertedAt: input.assertedAt,
    });
    const setupId = this.createSetupId();
    if (this.hasPendingSetup(setupId)) {
      await ceremony.cancel();
      throw runtimeError(
        "RECOVERY_REPLACEMENT_CONFLICT",
        "The Recovery replacement setup ID is not unique.",
      );
    }
    this.pendingRecoveryReplacements.set(setupId, {
      expectedVaultId: input.expectedVaultId,
      ceremony,
    });
    return { setupId, recoveryPhrase: ceremony.recoveryPhrase };
  }

  async confirmRecoveryPhraseReplacement(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{
    readonly recoveryCredentialId: string;
    readonly revision: number;
    readonly eventRecordId: string;
  }> {
    const pending = this.requirePendingRecoveryReplacement(input.setupId);
    await this.assertExpectedVault(pending.expectedVaultId);
    let replaced: Awaited<ReturnType<CanonicalRecoveryReplacementCeremony["confirm"]>>;
    try {
      replaced = await pending.ceremony.confirm(input.recoveryPhrase);
    } catch (error) {
      if (!isErrorId(error, "RECOVERY_PHRASE_MISMATCH")) {
        this.pendingRecoveryReplacements.delete(input.setupId);
      }
      throw error;
    }
    this.pendingRecoveryReplacements.delete(input.setupId);
    return {
      recoveryCredentialId: identifierStorageKey(replaced.recoveryCredentialId),
      revision: replaced.revision,
      eventRecordId: identifierStorageKey(replaced.eventRecordId),
    };
  }

  async cancelRecoveryPhraseReplacement(setupId: string): Promise<void> {
    const pending = this.requirePendingRecoveryReplacement(setupId);
    this.pendingRecoveryReplacements.delete(setupId);
    await pending.ceremony.cancel();
  }

  async selectVault(input: {
    readonly expectedVaultId: string | null;
    readonly vaultId: string;
  }): Promise<CanonicalClientState> {
    await this.assertExpectedVault(input.expectedVaultId);
    await this.vaults.selectVault(identifierFromStorageKey("Vault", input.vaultId));
    return this.state();
  }

  async capture(
    input: Omit<CanonicalCaptureCommand, "vaultId"> & { readonly expectedVaultId: string },
  ): Promise<{ readonly bundleId: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    const { expectedVaultId, ...command } = input;
    const outcome = await this.captures.execute({
      ...command,
      vaultId: identifierFromStorageKey("Vault", expectedVaultId),
    });
    return { bundleId: identifierStorageKey(outcome.bundleId) };
  }

  async listLibrary(expectedVaultId: string): Promise<readonly CanonicalClientLibraryItem[]> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    return projection.captures.map((capture) => ({
      bundleId: identifierStorageKey(capture.bundleId),
      collectionId: identifierStorageKey(capture.effectiveCollectionId),
      artifactId: identifierStorageKey(capture.artifactId),
      capturedAt: capture.capturedAt,
      originalUrl: capture.originalUrl,
      finalUrl: capture.finalUrl,
      title: capture.title,
      availableLocally: capture.artifactAvailableLocally,
      lifecycle: capture.lifecycle === 1 ? "Active" : "Deleted",
    }));
  }

  async search(input: {
    readonly expectedVaultId: string;
    readonly query: string;
    readonly scope: "Active" | "Deleted";
    readonly hosts: readonly string[];
    readonly collectionIds: readonly string[];
    readonly tagIds: readonly string[];
    readonly capturedFrom?: number | bigint;
    readonly capturedBefore?: number | bigint;
  }): Promise<readonly CanonicalClientSearchResult[]> {
    await this.assertExpectedVault(input.expectedVaultId);
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    const results = await this.searchService.query(vaultId, {
      query: input.query,
      scope: input.scope,
      hosts: input.hosts,
      collectionIds: input.collectionIds.map((id) => identifierFromStorageKey("Collection", id)),
      tagIds: input.tagIds.map((id) => identifierFromStorageKey("Tag", id)),
      ...(input.capturedFrom === undefined ? {} : { capturedFrom: input.capturedFrom }),
      ...(input.capturedBefore === undefined ? {} : { capturedBefore: input.capturedBefore }),
    });
    return results.map((result) => ({
      kind: result.kind,
      id: identifierStorageKey(result.id),
      title: result.title,
      passageId: fixedBytesStorageKey(result.passageId),
      snippet: result.snippet,
      score: result.score,
    }));
  }

  async searchCoverage(expectedVaultId: string): Promise<CanonicalSearchCoverage> {
    await this.assertExpectedVault(expectedVaultId);
    return (await this.searchService.load(identifierFromStorageKey("Vault", expectedVaultId)))
      .coverage;
  }

  async closeVault(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    const outcome = await this.lifecycle.close({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      assertedAt: input.assertedAt,
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async vacuumVault(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{
    readonly predecessorGenerationId: string;
    readonly successorGenerationId: string;
    readonly vacuumEventRecordId: string;
    readonly successorBaselineId: string;
  }> {
    await this.assertExpectedVault(input.expectedVaultId);
    const outcome = await this.vacuumService.vacuum({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      assertedAt: input.assertedAt,
    });
    return {
      predecessorGenerationId: identifierStorageKey(outcome.predecessorGenerationId),
      successorGenerationId: identifierStorageKey(outcome.successorGenerationId),
      vacuumEventRecordId: identifierStorageKey(outcome.vacuumEventRecordId),
      successorBaselineId: identifierStorageKey(outcome.successorBaselineId),
    };
  }

  async listCollections(expectedVaultId: string): Promise<readonly CanonicalClientCollection[]> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    return projection.collections.map((collection) => ({
      collectionId: identifierStorageKey(collection.collectionId),
      explicitTitle: collection.explicitTitle,
      title: collection.title,
      tailBundleId:
        collection.tailBundleId === null ? null : identifierStorageKey(collection.tailBundleId),
      activeCaptureCount: collection.activeCaptureCount,
      redirectedTo:
        collection.redirectedTo === null ? null : identifierStorageKey(collection.redirectedTo),
      folderId: collection.folderId === null ? null : identifierStorageKey(collection.folderId),
    }));
  }

  async listFolders(expectedVaultId: string): Promise<readonly CanonicalClientFolder[]> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    return projection.folders.map((folder) => ({
      folderId: identifierStorageKey(folder.folderId),
      name: folder.name,
      parentFolderId:
        folder.parentFolderId === null ? null : identifierStorageKey(folder.parentFolderId),
      effectiveParentFolderId:
        folder.effectiveParentFolderId === null
          ? null
          : identifierStorageKey(folder.effectiveParentFolderId),
      lifecycle: folder.lifecycle === 1 ? "Active" : "Deleted",
    }));
  }

  async createFolder(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly name: string;
    readonly parentFolderId: string | null;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly folderId: string; readonly eventRecordId: string }> {
    const folders = await this.listFolders(input.expectedVaultId);
    if (
      input.parentFolderId !== null &&
      !folders.some(({ folderId }) => folderId === input.parentFolderId)
    ) {
      throw runtimeError("FOLDER_NOT_FOUND", "The parent Folder is not in the Vault.");
    }
    if (input.parentFolderId !== null) {
      await this.assertFolderHierarchyAvailable(input.expectedVaultId, [input.parentFolderId]);
    }
    const folderId = this.createFolderId();
    if (folders.some((folder) => folder.folderId === identifierStorageKey(folderId))) {
      throw runtimeError("FOLDER_ID_CONFLICT", "The generated Folder ID already exists.");
    }
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId,
      type: 12,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, folderId],
        [1, input.name],
        [
          2,
          input.parentFolderId === null
            ? null
            : identifierFromStorageKey("Folder", input.parentFolderId),
        ],
      ]),
    });
    return {
      folderId: identifierStorageKey(folderId),
      eventRecordId: identifierStorageKey(outcome.eventRecordId),
    };
  }

  async renameFolder(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly folderId: string;
    readonly name: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.requireFolder(input.expectedVaultId, input.folderId);
    return this.executeFolderEvent(
      input,
      13,
      canonicalMap([
        [0, identifierFromStorageKey("Folder", input.folderId)],
        [1, input.name],
      ]),
    );
  }

  async placeFolder(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly folderId: string;
    readonly parentFolderId: string | null;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    const folders = await this.listFolders(input.expectedVaultId);
    if (!folders.some(({ folderId }) => folderId === input.folderId)) {
      throw runtimeError("FOLDER_NOT_FOUND", "The Folder is not in the Vault.");
    }
    if (
      input.parentFolderId !== null &&
      !folders.some(({ folderId }) => folderId === input.parentFolderId)
    ) {
      throw runtimeError("FOLDER_NOT_FOUND", "The parent Folder is not in the Vault.");
    }
    await this.assertFolderHierarchyAvailable(input.expectedVaultId, [
      input.folderId,
      ...(input.parentFolderId === null ? [] : [input.parentFolderId]),
    ]);
    const parents = new Map(
      folders.flatMap(({ folderId, parentFolderId }) =>
        parentFolderId === null ? [] : [[folderId, parentFolderId] as const],
      ),
    );
    if (input.parentFolderId === null) parents.delete(input.folderId);
    else parents.set(input.folderId, input.parentFolderId);
    assertAcyclicFolderParents(parents);
    return this.executeFolderEvent(
      input,
      14,
      canonicalMap([
        [0, identifierFromStorageKey("Folder", input.folderId)],
        [
          1,
          input.parentFolderId === null
            ? null
            : identifierFromStorageKey("Folder", input.parentFolderId),
        ],
      ]),
    );
  }

  async deleteFolder(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly folderId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.requireFolder(input.expectedVaultId, input.folderId);
    return this.executeFolderEvent(
      input,
      15,
      canonicalMap([[0, identifierFromStorageKey("Folder", input.folderId)]]),
    );
  }

  async restoreFolder(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly folderId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.requireFolder(input.expectedVaultId, input.folderId);
    return this.executeFolderEvent(
      input,
      16,
      canonicalMap([[0, identifierFromStorageKey("Folder", input.folderId)]]),
    );
  }

  async placeCollectionInFolder(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly collectionId: string;
    readonly folderId: string | null;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    const [collections, folders] = await Promise.all([
      this.listCollections(input.expectedVaultId),
      this.listFolders(input.expectedVaultId),
    ]);
    if (!collections.some(({ collectionId }) => collectionId === input.collectionId)) {
      throw runtimeError("COLLECTION_NOT_FOUND", "The Collection is not in the Vault.");
    }
    if (input.folderId !== null && !folders.some(({ folderId }) => folderId === input.folderId)) {
      throw runtimeError("FOLDER_NOT_FOUND", "The Folder is not in the Vault.");
    }
    if (input.folderId !== null) {
      await this.assertFolderHierarchyAvailable(input.expectedVaultId, [input.folderId]);
    }
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: 11,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, identifierFromStorageKey("Collection", input.collectionId)],
        [1, input.folderId === null ? null : identifierFromStorageKey("Folder", input.folderId)],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async resolveFolderConflict(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly subjectFolderIds: readonly string[];
    readonly conflictingCauseIds: readonly string[];
    readonly placements: readonly {
      readonly folderId: string;
      readonly parentFolderId: string | null;
    }[];
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    if (
      input.subjectFolderIds.length === 0 ||
      new Set(input.subjectFolderIds).size !== input.subjectFolderIds.length ||
      input.conflictingCauseIds.length === 0 ||
      new Set(input.conflictingCauseIds).size !== input.conflictingCauseIds.length
    ) {
      throw runtimeError(
        "CONTENT_COMMAND_INVALID",
        "Folder conflict identities must be unique and nonempty.",
      );
    }
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    for (const folderId of input.subjectFolderIds) {
      identifierFromStorageKey("Folder", folderId);
    }
    const conflictingCauseIds = input.conflictingCauseIds.map((causeId) =>
      identifierFromStorageKey("VaultRecord", causeId),
    );
    const projection = await this.library.load(vaultId);
    const matching = projection.conflicts.filter(
      (conflict) =>
        conflict.kind === "Folder" &&
        sameStringSet(
          conflict.subjectFolderIds.map(identifierStorageKey),
          input.subjectFolderIds,
        ) &&
        sameStringSet(
          conflict.candidateRecordIds.map(identifierStorageKey),
          input.conflictingCauseIds,
        ),
    );
    if (matching.length !== 1) {
      throw runtimeError(
        "FOLDER_CONFLICT_CHANGED",
        "The Folder Conflict is no longer the exact current Conflict.",
      );
    }
    const affected = new Set(input.subjectFolderIds);
    const known = new Set(projection.folders.map(({ folderId }) => identifierStorageKey(folderId)));
    if (
      input.placements.length !== affected.size ||
      new Set(input.placements.map(({ folderId }) => folderId)).size !== input.placements.length ||
      input.placements.some(({ folderId }) => !affected.has(folderId))
    ) {
      throw runtimeError(
        "CONTENT_COMMAND_INVALID",
        "Folder Resolution must replace every affected Folder exactly once.",
      );
    }
    for (const placement of input.placements) {
      if (
        placement.parentFolderId !== null &&
        (!known.has(placement.parentFolderId) || placement.parentFolderId === placement.folderId)
      ) {
        throw runtimeError(
          "CONTENT_COMMAND_INVALID",
          "Folder Resolution names an invalid parent Folder.",
        );
      }
    }
    const parents = new Map(
      projection.folders.flatMap(({ folderId, parentFolderId }) => {
        const source = identifierStorageKey(folderId);
        return parentFolderId === null || affected.has(source)
          ? []
          : [[source, identifierStorageKey(parentFolderId)] as const];
      }),
    );
    for (const placement of input.placements) {
      if (placement.parentFolderId === null) parents.delete(placement.folderId);
      else parents.set(placement.folderId, placement.parentFolderId);
    }
    assertAcyclicFolderParents(parents);
    const placements = input.placements
      .toSorted((left, right) => left.folderId.localeCompare(right.folderId))
      .map((placement) =>
        canonicalMap([
          [0, identifierFromStorageKey("Folder", placement.folderId)],
          [
            1,
            placement.parentFolderId === null
              ? null
              : identifierFromStorageKey("Folder", placement.parentFolderId),
          ],
        ]),
      );
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId,
      type: 17,
      assertedAt: input.assertedAt,
      expectedCausalFrontier: projection.frontier,
      body: canonicalMap([
        [0, canonicalSet(conflictingCauseIds)],
        [1, placements],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async listTags(expectedVaultId: string): Promise<readonly CanonicalClientTag[]> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    return projection.tags.map((tag) => ({
      tagId: identifierStorageKey(tag.tagId),
      name: tag.name,
      lifecycle: tag.lifecycle === 1 ? "Active" : "Deleted",
      redirectedTo: tag.redirectedTo === null ? null : identifierStorageKey(tag.redirectedTo),
    }));
  }

  async listTagAssignments(
    expectedVaultId: string,
  ): Promise<readonly CanonicalClientTagAssignment[]> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    return projection.tagAssignments.map((assignment) => ({
      assignmentId: identifierStorageKey(assignment.assignmentId),
      assignedCauseId: identifierStorageKey(assignment.assignedCauseId),
      tagId: identifierStorageKey(assignment.tagId),
      effectiveTagId: identifierStorageKey(assignment.effectiveTagId),
      targetKind: assignment.targetKind === 1 ? "Collection" : "Capture",
      targetId: identifierStorageKey(assignment.targetId),
      active: assignment.active,
    }));
  }

  async createTag(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly name: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly tagId: string; readonly eventRecordId: string }> {
    const tags = await this.listTags(input.expectedVaultId);
    const tagId = this.createTagId();
    if (tags.some((tag) => tag.tagId === identifierStorageKey(tagId))) {
      throw runtimeError("TAG_ID_CONFLICT", "The generated Tag ID already exists.");
    }
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: 18,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, tagId],
        [1, input.name],
      ]),
    });
    return {
      tagId: identifierStorageKey(tagId),
      eventRecordId: identifierStorageKey(outcome.eventRecordId),
    };
  }

  async renameTag(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly tagId: string;
    readonly name: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.requireTag(input.expectedVaultId, input.tagId);
    return this.executeTagEvent(
      input,
      19,
      canonicalMap([
        [0, identifierFromStorageKey("Tag", input.tagId)],
        [1, input.name],
      ]),
    );
  }

  async assignTag(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly tagId: string;
    readonly targetKind: "Collection" | "Capture";
    readonly targetId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly assignmentId: string; readonly eventRecordId: string }> {
    await Promise.all([
      this.requireTag(input.expectedVaultId, input.tagId),
      this.requireTagTarget(input.expectedVaultId, input.targetKind, input.targetId),
    ]);
    const assignmentId = this.createTagAssignmentId();
    if (
      (await this.listTagAssignments(input.expectedVaultId)).some(
        (assignment) => assignment.assignmentId === identifierStorageKey(assignmentId),
      )
    ) {
      throw runtimeError(
        "TAG_ASSIGNMENT_ID_CONFLICT",
        "The generated Tag Assignment ID already exists.",
      );
    }
    const targetKind = input.targetKind === "Collection" ? 1 : 2;
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: 20,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, assignmentId],
        [1, identifierFromStorageKey("Tag", input.tagId)],
        [
          2,
          canonicalMap([
            [0, targetKind],
            [
              1,
              identifierFromStorageKey(
                input.targetKind === "Collection" ? "Collection" : "Bundle",
                input.targetId,
              ),
            ],
          ]),
        ],
      ]),
    });
    return {
      assignmentId: identifierStorageKey(assignmentId),
      eventRecordId: identifierStorageKey(outcome.eventRecordId),
    };
  }

  async removeTagAssignments(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly tagId: string;
    readonly targetKind: "Collection" | "Capture";
    readonly targetId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await Promise.all([
      this.requireTag(input.expectedVaultId, input.tagId),
      this.requireTagTarget(input.expectedVaultId, input.targetKind, input.targetId),
    ]);
    const causes = (await this.listTagAssignments(input.expectedVaultId))
      .filter(
        (assignment) =>
          assignment.tagId === input.tagId &&
          assignment.targetKind === input.targetKind &&
          assignment.targetId === input.targetId,
      )
      .map(({ assignedCauseId }) => identifierFromStorageKey("VaultRecord", assignedCauseId));
    if (causes.length === 0) {
      throw runtimeError("TAG_ASSIGNMENT_NOT_FOUND", "The Tag relation has no active assignment.");
    }
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: 21,
      assertedAt: input.assertedAt,
      body: canonicalMap([[0, canonicalSet(causes)]]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async deleteTag(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly tagId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.requireTag(input.expectedVaultId, input.tagId);
    return this.executeTagEvent(
      input,
      22,
      canonicalMap([[0, identifierFromStorageKey("Tag", input.tagId)]]),
    );
  }

  async restoreTag(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly tagId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.requireTag(input.expectedVaultId, input.tagId);
    return this.executeTagEvent(
      input,
      23,
      canonicalMap([[0, identifierFromStorageKey("Tag", input.tagId)]]),
    );
  }

  async createNote(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly targetKind: "Collection" | "Capture";
    readonly targetId: string;
    readonly title: string | null;
    readonly body: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly noteId: string; readonly eventRecordId: string }> {
    await this.requireTagTarget(input.expectedVaultId, input.targetKind, input.targetId);
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    const projection = await this.library.load(vaultId);
    const noteId = this.createNoteId();
    if (projection.notes.some((note) => bytesEqual(note.noteId, noteId))) {
      throw runtimeError("NOTE_ID_CONFLICT", "The generated Note ID already exists.");
    }
    const object = await this.createNoteContentObject(vaultId, input.title, input.body);
    const targetKind = input.targetKind === "Collection" ? 1 : 2;
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId,
      type: 27,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, noteId],
        [
          1,
          canonicalMap([
            [0, targetKind],
            [
              1,
              identifierFromStorageKey(
                input.targetKind === "Collection" ? "Collection" : "Bundle",
                input.targetId,
              ),
            ],
          ]),
        ],
        [2, object.objectId],
      ]),
      dependencies: [{ type: DEPENDENCY_TYPES.NoteContentObject, id: object.objectId }],
      objects: [object],
    });
    return {
      noteId: identifierStorageKey(noteId),
      eventRecordId: identifierStorageKey(outcome.eventRecordId),
    };
  }

  async listNotes(expectedVaultId: string): Promise<readonly CanonicalClientNote[]> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    return projection.notes.map((note) => this.clientNote(note));
  }

  async reviseNote(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly noteId: string;
    readonly title: string | null;
    readonly body: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    const { projection, note } = await this.noteCommandContext(input.expectedVaultId, input.noteId);
    if (note.state !== 1) {
      throw runtimeError("NOTE_NOT_ACTIVE", "Only an Active Note can be revised.");
    }
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    const object = await this.createNoteContentObject(vaultId, input.title, input.body);
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId,
      type: 28,
      assertedAt: input.assertedAt,
      expectedCausalFrontier: projection.frontier,
      body: canonicalMap([
        [0, note.noteId],
        [1, canonicalSet(note.versions.map(({ headCauseId }) => headCauseId))],
        [2, object.objectId],
      ]),
      dependencies: [{ type: DEPENDENCY_TYPES.NoteContentObject, id: object.objectId }],
      objects: [object],
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async deleteNote(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly noteId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    const { projection, note } = await this.noteCommandContext(input.expectedVaultId, input.noteId);
    if (note.state !== 1) {
      throw runtimeError("NOTE_NOT_ACTIVE", "Only an Active Note can be deleted.");
    }
    return this.executeNoteHeadEvent(input, projection.frontier, note, 29);
  }

  async restoreNote(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly noteId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    const { projection, note } = await this.noteCommandContext(input.expectedVaultId, input.noteId);
    if (note.state !== 2) {
      throw runtimeError("NOTE_NOT_DELETED", "Only a Deleted Note can be restored.");
    }
    return this.executeNoteHeadEvent(input, projection.frontier, note, 30);
  }

  async resolveNoteConflict(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly noteId: string;
    readonly conflictingCauseIds: readonly string[];
    readonly retainedOriginal: { readonly title: string | null; readonly body: string } | null;
    readonly splitNotes: readonly { readonly title: string | null; readonly body: string }[];
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly splitNoteIds: readonly string[]; readonly eventRecordId: string }> {
    if (
      input.conflictingCauseIds.length < 2 ||
      new Set(input.conflictingCauseIds).size !== input.conflictingCauseIds.length
    ) {
      throw runtimeError(
        "NOTE_CONFLICT_CHANGED",
        "Note Resolution requires every unique current conflict Cause.",
      );
    }
    const { projection, note } = await this.noteCommandContext(input.expectedVaultId, input.noteId);
    const conflict = projection.conflicts.find(
      (candidate) =>
        candidate.kind === "Note" && identifierStorageKey(candidate.noteId) === input.noteId,
    );
    if (
      note.state !== 3 ||
      conflict?.kind !== "Note" ||
      !sameStringSet(
        conflict.candidateRecordIds.map(identifierStorageKey),
        input.conflictingCauseIds,
      )
    ) {
      throw runtimeError("NOTE_CONFLICT_CHANGED", "The current Note Conflict has changed.");
    }
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    const retainedObject =
      input.retainedOriginal === null
        ? null
        : await this.createNoteContentObject(
            vaultId,
            input.retainedOriginal.title,
            input.retainedOriginal.body,
          );
    const existingNoteIds = new Set(
      projection.notes.map(({ noteId }) => identifierStorageKey(noteId)),
    );
    const split = [] as {
      readonly noteId: Identifier<"Note">;
      readonly object: Awaited<ReturnType<CanonicalClientRuntime["createNoteContentObject"]>>;
    }[];
    for (const content of input.splitNotes) {
      const splitNoteId = this.createNoteId();
      const splitKey = identifierStorageKey(splitNoteId);
      if (
        existingNoteIds.has(splitKey) ||
        split.some(({ noteId }) => bytesEqual(noteId, splitNoteId))
      ) {
        throw runtimeError("NOTE_ID_CONFLICT", "A generated split Note ID already exists.");
      }
      split.push({
        noteId: splitNoteId,
        object: await this.createNoteContentObject(vaultId, content.title, content.body),
      });
    }
    const objects = [
      ...(retainedObject === null ? [] : [retainedObject]),
      ...split.map(({ object }) => object),
    ];
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId,
      type: 31,
      assertedAt: input.assertedAt,
      expectedCausalFrontier: projection.frontier,
      body: canonicalMap([
        [0, note.noteId],
        [
          1,
          canonicalSet(
            input.conflictingCauseIds.map((causeId) =>
              identifierFromStorageKey("VaultRecord", causeId),
            ),
          ),
        ],
        [2, retainedObject?.objectId ?? null],
        [
          3,
          canonicalSet(
            split.map(({ noteId, object }) =>
              canonicalMap([
                [0, noteId],
                [1, object.objectId],
              ]),
            ),
          ),
        ],
      ]),
      dependencies: objects.map(({ objectId }) => ({
        type: DEPENDENCY_TYPES.NoteContentObject,
        id: objectId,
      })),
      objects,
    });
    return {
      splitNoteIds: split.map(({ noteId }) => identifierStorageKey(noteId)),
      eventRecordId: identifierStorageKey(outcome.eventRecordId),
    };
  }

  async listLibraryConflicts(
    expectedVaultId: string,
  ): Promise<readonly CanonicalClientLibraryConflict[]> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    return projection.conflicts.map(
      (conflict): CanonicalClientLibraryConflict =>
        conflict.kind === "CaptureIdentity"
          ? {
              kind: "CaptureIdentity",
              bundleId: identifierStorageKey(conflict.bundleId),
              registrationRecordIds: conflict.registrationRecordIds.map(identifierStorageKey),
            }
          : conflict.kind === "CollectionMerge"
            ? {
                kind: "CollectionMerge",
                reason: conflict.reason,
                subjectCollectionIds: conflict.subjectCollectionIds.map(identifierStorageKey),
                candidateRecordIds: conflict.candidateRecordIds.map(identifierStorageKey),
              }
            : conflict.kind === "Folder"
              ? {
                  kind: "Folder",
                  subjectFolderIds: conflict.subjectFolderIds.map(identifierStorageKey),
                  candidateRecordIds: conflict.candidateRecordIds.map(identifierStorageKey),
                }
              : {
                  kind: "Note",
                  noteId: identifierStorageKey(conflict.noteId),
                  candidateRecordIds: conflict.candidateRecordIds.map(identifierStorageKey),
                },
    );
  }

  async moveCaptures(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly bundleIds: readonly string[];
    readonly destinationCollectionId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    if (input.bundleIds.length === 0 || new Set(input.bundleIds).size !== input.bundleIds.length) {
      throw runtimeError("CONTENT_COMMAND_INVALID", "Capture moves require unique Capture IDs.");
    }
    const captures = await this.listLibrary(input.expectedVaultId);
    const byBundle = new Map(captures.map((capture) => [capture.bundleId, capture]));
    if (input.bundleIds.some((bundleId) => !byBundle.has(bundleId))) {
      throw runtimeError("CAPTURE_NOT_FOUND", "A selected Capture is not in the Vault.");
    }
    const destination = identifierFromStorageKey("Collection", input.destinationCollectionId);
    const moves = [...input.bundleIds].toSorted().map((bundleId) => {
      const capture = byBundle.get(bundleId) as CanonicalClientLibraryItem;
      return canonicalMap([
        [0, identifierFromStorageKey("Bundle", bundleId)],
        [1, identifierFromStorageKey("Collection", capture.collectionId)],
        [2, destination],
      ]);
    });
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: 6,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, moves],
        [1, null],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async setCollectionTitle(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly collectionId: string;
    readonly title: string | null;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    const collections = await this.listCollections(input.expectedVaultId);
    if (!collections.some(({ collectionId }) => collectionId === input.collectionId)) {
      throw runtimeError("COLLECTION_NOT_FOUND", "The Collection is not in the Vault.");
    }
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: 7,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, identifierFromStorageKey("Collection", input.collectionId)],
        [1, input.title],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async mergeCollections(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly sourceCollectionIds: readonly string[];
    readonly destinationCollectionId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    if (
      input.sourceCollectionIds.length === 0 ||
      new Set(input.sourceCollectionIds).size !== input.sourceCollectionIds.length ||
      input.sourceCollectionIds.includes(input.destinationCollectionId)
    ) {
      throw runtimeError("CONTENT_COMMAND_INVALID", "Collection merge identities are invalid.");
    }
    const collections = await this.listCollections(input.expectedVaultId);
    const known = new Set(collections.map(({ collectionId }) => collectionId));
    if (
      !known.has(input.destinationCollectionId) ||
      input.sourceCollectionIds.some((collectionId) => !known.has(collectionId))
    ) {
      throw runtimeError("COLLECTION_NOT_FOUND", "A merged Collection is not in the Vault.");
    }
    const redirects = new Map(
      collections.flatMap(({ collectionId, redirectedTo }) =>
        redirectedTo === null ? [] : [[collectionId, redirectedTo] as const],
      ),
    );
    for (const source of input.sourceCollectionIds)
      redirects.set(source, input.destinationCollectionId);
    for (const source of redirects.keys()) {
      let current: string | undefined = source;
      const seen = new Set<string>();
      while (current !== undefined) {
        if (seen.has(current)) {
          throw runtimeError(
            "COLLECTION_MERGE_CONFLICT",
            "The Collection merge would create a cycle.",
          );
        }
        seen.add(current);
        current = redirects.get(current);
      }
    }
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: 8,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [
          0,
          canonicalSet(
            input.sourceCollectionIds.map((collectionId) =>
              identifierFromStorageKey("Collection", collectionId),
            ),
          ),
        ],
        [1, identifierFromStorageKey("Collection", input.destinationCollectionId)],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async revertCollectionMerge(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly redirectCauseId: string;
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    const causeId = identifierFromStorageKey("VaultRecord", input.redirectCauseId);
    const replay = await this.library.replay.replay(vaultId);
    const target = replay.events.find((event) => bytesEqual(event.recordId, causeId));
    if (target === undefined || target.family !== 2 || (target.type !== 8 && target.type !== 10)) {
      throw runtimeError("CONTENT_COMMAND_INVALID", "The redirect Cause is not reversible.");
    }
    const alreadyReverted = replay.events.some((event) => {
      if (event.family !== 2 || event.type !== 9) return false;
      const body = exactMap(event.body, [0], "Collection Merge Reverted body");
      return bytesEqual(identifierValue(mapValue(body, 0), "VaultRecord"), causeId);
    });
    if (alreadyReverted) {
      throw runtimeError("CONTENT_COMMAND_INVALID", "The Collection redirect is already reverted.");
    }
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId,
      type: 9,
      assertedAt: input.assertedAt,
      body: canonicalMap([[0, causeId]]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async resolveCollectionMergeConflict(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly subjectCollectionIds: readonly string[];
    readonly conflictingCauseIds: readonly string[];
    readonly redirects: readonly {
      readonly sourceCollectionId: string;
      readonly destinationCollectionId: string;
    }[];
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    await this.assertExpectedVault(input.expectedVaultId);
    if (
      input.subjectCollectionIds.length === 0 ||
      new Set(input.subjectCollectionIds).size !== input.subjectCollectionIds.length ||
      input.conflictingCauseIds.length === 0 ||
      new Set(input.conflictingCauseIds).size !== input.conflictingCauseIds.length
    ) {
      throw runtimeError(
        "CONTENT_COMMAND_INVALID",
        "Collection conflict identities must be unique and nonempty.",
      );
    }
    const vaultId = identifierFromStorageKey("Vault", input.expectedVaultId);
    for (const collectionId of input.subjectCollectionIds) {
      identifierFromStorageKey("Collection", collectionId);
    }
    const conflictingCauseIds = input.conflictingCauseIds.map((causeId) =>
      identifierFromStorageKey("VaultRecord", causeId),
    );
    const projection = await this.library.load(vaultId);
    const matchingConflicts = projection.conflicts.filter(
      (conflict) =>
        conflict.kind === "CollectionMerge" &&
        sameStringSet(
          conflict.subjectCollectionIds.map(identifierStorageKey),
          input.subjectCollectionIds,
        ) &&
        sameStringSet(
          conflict.candidateRecordIds.map(identifierStorageKey),
          input.conflictingCauseIds,
        ),
    );
    if (matchingConflicts.length !== 1) {
      throw runtimeError(
        "COLLECTION_MERGE_CONFLICT_CHANGED",
        "The Collection merge Conflict is no longer the exact current Conflict.",
      );
    }

    const affected = new Set(input.subjectCollectionIds);
    const knownCollections = new Set([
      ...projection.collections.map(({ collectionId }) => identifierStorageKey(collectionId)),
      ...input.subjectCollectionIds,
    ]);
    const replacementSources = new Set<string>();
    const replacementRedirects = input.redirects.map((redirect) => {
      if (
        replacementSources.has(redirect.sourceCollectionId) ||
        !affected.has(redirect.sourceCollectionId) ||
        redirect.sourceCollectionId === redirect.destinationCollectionId
      ) {
        throw runtimeError(
          "CONTENT_COMMAND_INVALID",
          "Collection conflict redirects must name each affected source at most once.",
        );
      }
      if (!knownCollections.has(redirect.destinationCollectionId)) {
        throw runtimeError(
          "COLLECTION_NOT_FOUND",
          "A Collection conflict destination is not in the Vault.",
        );
      }
      replacementSources.add(redirect.sourceCollectionId);
      return {
        sourceCollectionId: identifierFromStorageKey("Collection", redirect.sourceCollectionId),
        destinationCollectionId: identifierFromStorageKey(
          "Collection",
          redirect.destinationCollectionId,
        ),
      };
    });
    const effectiveRedirects = new Map(
      projection.collections.flatMap(({ collectionId, redirectedTo }) => {
        const source = identifierStorageKey(collectionId);
        return redirectedTo === null || affected.has(source)
          ? []
          : [[source, identifierStorageKey(redirectedTo)] as const];
      }),
    );
    for (const redirect of input.redirects) {
      effectiveRedirects.set(redirect.sourceCollectionId, redirect.destinationCollectionId);
    }
    assertAcyclicRedirects(effectiveRedirects);

    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId,
      type: 10,
      assertedAt: input.assertedAt,
      expectedCausalFrontier: projection.frontier,
      body: canonicalMap([
        [0, canonicalSet(conflictingCauseIds)],
        [
          1,
          canonicalSet(
            replacementRedirects.map((redirect) =>
              canonicalMap([
                [0, redirect.sourceCollectionId],
                [1, redirect.destinationCollectionId],
              ]),
            ),
          ),
        ],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  async deleteCaptures(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly bundleIds: readonly string[];
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    return this.changeCaptureLifecycle({ ...input, type: 4 });
  }

  async restoreCaptures(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly bundleIds: readonly string[];
    readonly assertedAt: number | bigint;
  }): Promise<{ readonly eventRecordId: string }> {
    return this.changeCaptureLifecycle({ ...input, type: 5 });
  }

  private clientNote(note: CanonicalLibraryNote): CanonicalClientNote {
    return {
      noteId: identifierStorageKey(note.noteId),
      targetKind: note.targetKind === 1 ? "Collection" : "Capture",
      targetId: identifierStorageKey(note.targetId),
      state: note.state === 1 ? "Active" : note.state === 2 ? "Deleted" : "Conflict",
      versions: note.versions.map((version) => ({
        headCauseId: identifierStorageKey(version.headCauseId),
        contentObjectId:
          version.contentObjectId === null ? null : identifierStorageKey(version.contentObjectId),
        title: version.title,
        body: version.body,
        bodyDialect: version.bodyDialect,
        originVaultId: identifierStorageKey(version.originVaultId),
        memberId: identifierStorageKey(version.memberId),
        clientCredentialId: identifierStorageKey(version.clientCredentialId),
        assertedAt: version.assertedAt,
      })),
    };
  }

  private async noteCommandContext(
    expectedVaultId: string,
    noteId: string,
  ): Promise<{
    readonly projection: CanonicalLibraryProjection;
    readonly note: CanonicalLibraryNote;
  }> {
    await this.assertExpectedVault(expectedVaultId);
    const projection = await this.library.load(identifierFromStorageKey("Vault", expectedVaultId));
    const note = projection.notes.find(
      (candidate) => identifierStorageKey(candidate.noteId) === noteId,
    );
    if (note === undefined) throw runtimeError("NOTE_NOT_FOUND", "The Note is not in the Vault.");
    return { projection, note };
  }

  private async createNoteContentObject(
    vaultId: Identifier<"Vault">,
    title: string | null,
    body: string,
  ) {
    const vault = await this.vaults.openVault(vaultId);
    return encodeVaultObject({
      vaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      body: canonicalMap([
        [0, 1],
        [1, title],
        [2, body],
        [3, "awsm.note.commonmark"],
      ]),
      extensions: advisoryExtensions([]),
    });
  }

  private async executeNoteHeadEvent(
    input: {
      readonly expectedVaultId: string;
      readonly commandId: string;
      readonly assertedAt: number | bigint;
    },
    expectedCausalFrontier: readonly Identifier<"VaultRecord">[],
    note: CanonicalLibraryNote,
    type: 29 | 30,
  ): Promise<{ readonly eventRecordId: string }> {
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type,
      assertedAt: input.assertedAt,
      expectedCausalFrontier,
      body: canonicalMap([
        [0, note.noteId],
        [1, canonicalSet(note.versions.map(({ headCauseId }) => headCauseId))],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  private async requireTag(expectedVaultId: string, tagId: string): Promise<CanonicalClientTag> {
    const tag = (await this.listTags(expectedVaultId)).find(
      (candidate) => candidate.tagId === tagId,
    );
    if (tag === undefined) throw runtimeError("TAG_NOT_FOUND", "The Tag is not in the Vault.");
    return tag;
  }

  private async requireTagTarget(
    expectedVaultId: string,
    targetKind: "Collection" | "Capture",
    targetId: string,
  ): Promise<void> {
    const exists =
      targetKind === "Collection"
        ? (await this.listCollections(expectedVaultId)).some(
            (collection) => collection.collectionId === targetId,
          )
        : (await this.listLibrary(expectedVaultId)).some(
            (capture) => capture.bundleId === targetId,
          );
    if (!exists) {
      throw runtimeError(
        targetKind === "Collection" ? "COLLECTION_NOT_FOUND" : "CAPTURE_NOT_FOUND",
        `The Tag target ${targetKind} is not in the Vault.`,
      );
    }
  }

  private async executeTagEvent(
    input: {
      readonly expectedVaultId: string;
      readonly commandId: string;
      readonly assertedAt: number | bigint;
    },
    type: 19 | 22 | 23,
    body: CanonicalValue,
  ): Promise<{ readonly eventRecordId: string }> {
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type,
      assertedAt: input.assertedAt,
      body,
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  private async requireFolder(
    expectedVaultId: string,
    folderId: string,
  ): Promise<CanonicalClientFolder> {
    const folder = (await this.listFolders(expectedVaultId)).find(
      (candidate) => candidate.folderId === folderId,
    );
    if (folder === undefined)
      throw runtimeError("FOLDER_NOT_FOUND", "The Folder is not in the Vault.");
    return folder;
  }

  private async assertFolderHierarchyAvailable(
    expectedVaultId: string,
    folderIds: readonly string[],
  ): Promise<void> {
    const blocked = new Set(
      (await this.listLibraryConflicts(expectedVaultId)).flatMap((conflict) =>
        conflict.kind === "Folder" ? conflict.subjectFolderIds : [],
      ),
    );
    if (folderIds.some((folderId) => blocked.has(folderId))) {
      throw runtimeError(
        "FOLDER_CONFLICT",
        "The Folder hierarchy is in Conflict and requires explicit Resolution.",
      );
    }
  }

  private async executeFolderEvent(
    input: {
      readonly expectedVaultId: string;
      readonly commandId: string;
      readonly assertedAt: number | bigint;
    },
    type: 13 | 14 | 15 | 16,
    body: CanonicalValue,
  ): Promise<{ readonly eventRecordId: string }> {
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type,
      assertedAt: input.assertedAt,
      body,
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }

  private async requirePendingCreation(
    setupId: string,
    recoveryPhrase: string,
  ): Promise<PendingVaultCreation> {
    const pending = this.pendingVaultCreations.get(setupId);
    if (pending !== undefined) return pending;
    const expectedVaultId = await this.vaults.pendingCreationExpectedVault(setupId);
    const expectedVaultIdStorageKey =
      expectedVaultId === null ? null : identifierStorageKey(expectedVaultId);
    await this.assertExpectedVault(expectedVaultIdStorageKey);
    const resumed = {
      expectedVaultId: expectedVaultIdStorageKey,
      ceremony: await this.vaults.resumeCreate({ setupId, recoveryPhrase }),
    };
    this.pendingVaultCreations.set(setupId, resumed);
    return resumed;
  }

  private requirePendingFork(setupId: string): PendingVaultFork {
    const pending = this.pendingVaultForks.get(setupId);
    if (pending === undefined) {
      throw runtimeError("VAULT_FORK_NOT_FOUND", "The Fork ceremony is unavailable.");
    }
    return pending;
  }

  private requirePendingRecoveryReplacement(setupId: string): PendingRecoveryReplacement {
    const pending = this.pendingRecoveryReplacements.get(setupId);
    if (pending === undefined) {
      throw runtimeError(
        "RECOVERY_REPLACEMENT_NOT_FOUND",
        "The Recovery replacement ceremony is unavailable.",
      );
    }
    return pending;
  }

  private hasPendingSetup(setupId: string): boolean {
    return (
      this.pendingVaultCreations.has(setupId) ||
      this.pendingVaultForks.has(setupId) ||
      this.pendingRecoveryReplacements.has(setupId)
    );
  }

  private async assertExpectedVault(expectedVaultId: string | null): Promise<void> {
    const current = selectedVaultId(await this.state());
    if (current !== expectedVaultId) {
      throw runtimeError("VAULT_CONTEXT_CHANGED", "The selected Vault changed.");
    }
  }

  private async changeCaptureLifecycle(input: {
    readonly expectedVaultId: string;
    readonly commandId: string;
    readonly bundleIds: readonly string[];
    readonly assertedAt: number | bigint;
    readonly type: 4 | 5;
  }): Promise<{ readonly eventRecordId: string }> {
    if (input.bundleIds.length === 0 || new Set(input.bundleIds).size !== input.bundleIds.length) {
      throw runtimeError(
        "CONTENT_COMMAND_INVALID",
        "Capture lifecycle changes require unique Capture IDs.",
      );
    }
    const library = await this.listLibrary(input.expectedVaultId);
    const known = new Set(library.map(({ bundleId }) => bundleId));
    if (input.bundleIds.some((bundleId) => !known.has(bundleId))) {
      throw runtimeError("CAPTURE_NOT_FOUND", "A selected Capture is not in the Vault.");
    }
    const outcome = await this.content.execute({
      commandId: input.commandId,
      vaultId: identifierFromStorageKey("Vault", input.expectedVaultId),
      type: input.type,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [
          0,
          canonicalSet(
            input.bundleIds.map((bundleId) => identifierFromStorageKey("Bundle", bundleId)),
          ),
        ],
      ]),
    });
    return { eventRecordId: identifierStorageKey(outcome.eventRecordId) };
  }
}

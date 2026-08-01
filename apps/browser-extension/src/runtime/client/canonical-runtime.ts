import { exactMap, identifierValue, mapValue } from "../../domain/canonical/schema";
import { canonicalMap, canonicalSet } from "../../domain/canonical/value";
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
import type { CanonicalLibraryProjectionService } from "../library/canonical-projection";
import type {
  CanonicalVaultCreationCeremony,
  CanonicalVaultService,
} from "../vault/canonical-service";

export interface CanonicalClientVaultSummary {
  readonly vaultId: string;
  readonly label: string | null;
  readonly selected: boolean;
}

export interface CanonicalClientState {
  readonly selectedVaultId?: string;
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

export interface CanonicalClientCollection {
  readonly collectionId: string;
  readonly explicitTitle: string | null;
  readonly title: string;
  readonly tailBundleId: string | null;
  readonly activeCaptureCount: number;
  readonly redirectedTo: string | null;
}

interface PendingVaultCreation {
  readonly expectedVaultId: string | null;
  readonly ceremony: CanonicalVaultCreationCeremony;
}

function runtimeError(id: string, message: string): Error {
  return Object.assign(new Error(message), { id });
}

function selectedVaultId(state: CanonicalClientState): string | null {
  return state.selectedVaultId ?? null;
}

export class CanonicalClientRuntime {
  private readonly pendingVaultCreations = new Map<string, PendingVaultCreation>();

  constructor(
    readonly vaults: CanonicalVaultService,
    readonly captures: CanonicalCaptureService,
    readonly library: CanonicalLibraryProjectionService,
    private readonly createSetupId: () => string = () => crypto.randomUUID(),
    readonly content: CanonicalContentService = new CanonicalContentService(vaults),
  ) {}

  async state(): Promise<CanonicalClientState> {
    const directory = await this.vaults.listVaults();
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
      vaults: directory.map((entry) => ({
        vaultId: identifierStorageKey(entry.vaultId),
        label: entry.label,
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
    const ceremony = await this.vaults.beginCreate({
      label: input.label,
      assertedAt: input.assertedAt,
    });
    const setupId = this.createSetupId();
    if (this.pendingVaultCreations.has(setupId)) {
      await ceremony.cancel();
      throw runtimeError("VAULT_CREATION_CONFLICT", "The Vault creation setup ID is not unique.");
    }
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
    const pending = this.requirePendingCreation(input.setupId);
    await this.assertExpectedVault(pending.expectedVaultId);
    const created = await pending.ceremony.confirm(input.recoveryPhrase);
    this.pendingVaultCreations.delete(input.setupId);
    return { vaultId: identifierStorageKey(created.vaultId) };
  }

  async cancelVaultCreation(setupId: string): Promise<void> {
    const pending = this.requirePendingCreation(setupId);
    this.pendingVaultCreations.delete(setupId);
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
    }));
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

  private requirePendingCreation(setupId: string): PendingVaultCreation {
    const pending = this.pendingVaultCreations.get(setupId);
    if (pending === undefined) {
      throw runtimeError("VAULT_CREATION_NOT_FOUND", "The Vault creation ceremony is unavailable.");
    }
    return pending;
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

import { type Identifier, randomIdentifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  CanonicalStorageError,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { assertCanonicalCommandId } from "../capture/canonical-outcome";
import { CanonicalReplayService } from "../projection/canonical-replay";
import {
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  encodeLogicalResolution,
  encodeVaultDirectoryEntry,
  prepareWrappedLocalStateItem,
} from "./canonical-local-state";
import type { CanonicalVaultService } from "./canonical-service";
import { prepareVacuum } from "./canonical-vacuum-content-checkpoint";
import {
  type CanonicalVacuumOutcome,
  decodeCanonicalVacuumOutcome,
  encodeCanonicalVacuumOutcome,
} from "./canonical-vacuum-outcome";

const MAX_FRONTIER_RETRIES = 4;

export class CanonicalVacuumService {
  readonly replay: CanonicalReplayService;

  constructor(readonly vaults: CanonicalVaultService) {
    this.replay = new CanonicalReplayService(vaults);
  }

  async vacuum(input: {
    readonly commandId: string;
    readonly vaultId: Identifier<"Vault">;
    readonly assertedAt: number | bigint;
  }): Promise<CanonicalVacuumOutcome> {
    assertCanonicalCommandId(input.commandId);
    const vaultKey = identifierStorageKey(input.vaultId);
    const previous = await this.readOutcome(vaultKey, input.commandId);
    if (previous !== undefined) return this.assertVault(previous, input.vaultId);

    for (let attempt = 0; attempt < MAX_FRONTIER_RETRIES; attempt += 1) {
      const raced = await this.readOutcome(vaultKey, input.commandId);
      if (raced !== undefined) return this.assertVault(raced, input.vaultId);
      const replay = await this.replay.replay(input.vaultId);
      const { vault } = replay;
      const prepared = await prepareVacuum({
        replay,
        successorGenerationId: randomIdentifier("Generation"),
        assertedAt: input.assertedAt,
      });
      const outcome: CanonicalVacuumOutcome = {
        commandId: input.commandId,
        vaultId: input.vaultId,
        predecessorGenerationId: vault.replicaState.generationId,
        successorGenerationId: prepared.successor.baseline.generationId,
        vacuumEventRecordId: prepared.event.recordId,
        successorBaselineId: prepared.successor.baseline.recordId,
      };
      const eventResolution = {
        vaultId: input.vaultId,
        kind: 1 as const,
        logicalId: prepared.event.recordId,
        storageItemId: prepared.eventEnvelope.storageItemId,
        keyEpochId: vault.epochSecret.keyEpochId,
        availability: 1 as const,
      };
      const baselineResolution = {
        vaultId: input.vaultId,
        kind: 1 as const,
        logicalId: prepared.successor.baseline.recordId,
        storageItemId: prepared.successor.baselineEnvelope.storageItemId,
        keyEpochId: vault.epochSecret.keyEpochId,
        availability: 1 as const,
      };
      const nextDirectory = {
        ...vault.directory,
        generationId: prepared.successor.baseline.generationId,
      };
      const [nextReplicaState, eventResolutionItem, baselineResolutionItem, directoryItem] =
        await Promise.all([
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.replicaState.key,
            scopeKey: vaultKey,
            itemKey: "current",
            wrappingKey: vault.installationWrappingKey,
            domain: "awsm.local.replica-state",
            context: canonicalLocalStorageContext(
              input.vaultId,
              prepared.successor.baseline.generationId,
            ),
            bytes: encodeCanonicalReplicaState(prepared.adoptedReplicaState),
          }),
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.logicalResolution.key,
            scopeKey: vaultKey,
            itemKey: `1:${identifierStorageKey(prepared.event.recordId)}`,
            wrappingKey: vault.installationWrappingKey,
            domain: "awsm.local.logical-resolution",
            context: canonicalLocalStorageContext(input.vaultId, prepared.event.recordId),
            bytes: encodeLogicalResolution(eventResolution),
          }),
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.logicalResolution.key,
            scopeKey: vaultKey,
            itemKey: `1:${identifierStorageKey(prepared.successor.baseline.recordId)}`,
            wrappingKey: vault.installationWrappingKey,
            domain: "awsm.local.logical-resolution",
            context: canonicalLocalStorageContext(
              input.vaultId,
              prepared.successor.baseline.recordId,
            ),
            bytes: encodeLogicalResolution(baselineResolution),
          }),
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.vaultDirectory.key,
            scopeKey: "installation",
            itemKey: vaultKey,
            wrappingKey: vault.installationWrappingKey,
            domain: "awsm.local.vault-directory",
            context: canonicalLocalStorageContext(input.vaultId, input.vaultId),
            bytes: encodeVaultDirectoryEntry(nextDirectory),
          }),
        ]);
      const immutableItems: readonly NamespaceBytes[] = [
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(prepared.successor.baseline.recordId),
          bytes: prepared.successor.baselineEnvelope.bytes,
        },
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(prepared.event.recordId),
          bytes: prepared.eventEnvelope.bytes,
        },
        {
          namespace: NAMESPACES.commandOutcome.key,
          scopeKey: vaultKey,
          itemKey: input.commandId,
          bytes: encodeCanonicalVacuumOutcome(outcome),
        },
      ];
      try {
        await this.vaults.storage.commitReplicaMutation({
          realm: this.vaults.realm,
          expectedReplicaState: vault.replicaStateStorageBytes,
          nextReplicaState,
          immutableItems,
          mutableItems: [eventResolutionItem, baselineResolutionItem, directoryItem],
          deletedItems: [
            {
              namespace: NAMESPACES.libraryProjection.key,
              scopeKey: vaultKey,
              itemKey: "current",
            },
            {
              namespace: NAMESPACES.searchMaterialization.key,
              scopeKey: vaultKey,
              itemKey: "current",
            },
          ],
        });
        return outcome;
      } catch (error) {
        if (error instanceof CanonicalStorageError && error.id === "VAULT_CONTEXT_CHANGED") {
          continue;
        }
        throw error;
      }
    }
    throw new CanonicalStorageError(
      "VAULT_CONTEXT_CHANGED",
      "Vacuum could not commit because the accepted Frontier kept changing.",
    );
  }

  private async readOutcome(
    vaultKey: string,
    commandId: string,
  ): Promise<CanonicalVacuumOutcome | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.commandOutcome.key,
      scopeKey: vaultKey,
      itemKey: commandId,
    });
    if (bytes === undefined) return undefined;
    const outcome = decodeCanonicalVacuumOutcome(bytes);
    if (outcome.commandId !== commandId) {
      throw new TypeError("Stored Vacuum outcome belongs to another Command");
    }
    return outcome;
  }

  private assertVault(
    outcome: CanonicalVacuumOutcome,
    vaultId: Identifier<"Vault">,
  ): CanonicalVacuumOutcome {
    if (!bytesEqual(outcome.vaultId, vaultId)) {
      throw new TypeError("Vacuum outcome belongs to another Vault");
    }
    return outcome;
  }
}

import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  CanonicalStorageError,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { assertCanonicalCommandId } from "../capture/canonical-outcome";
import {
  type CanonicalLifecycleOutcome,
  decodeCanonicalLifecycleOutcome,
  encodeCanonicalLifecycleOutcome,
} from "./canonical-lifecycle-outcome";
import { prepareCanonicalClosureEvent } from "./canonical-lifecycle-prepare";
import {
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  encodeLogicalResolution,
  prepareWrappedLocalStateItem,
} from "./canonical-local-state";
import type { CanonicalVaultService } from "./canonical-service";

const MAX_FRONTIER_RETRIES = 4;

export class CanonicalLifecycleService {
  constructor(readonly vaults: CanonicalVaultService) {}

  async close(input: {
    readonly commandId: string;
    readonly vaultId: Identifier<"Vault">;
    readonly assertedAt: number | bigint;
  }): Promise<CanonicalLifecycleOutcome> {
    assertCanonicalCommandId(input.commandId);
    const vaultKey = identifierStorageKey(input.vaultId);
    const previous = await this.readOutcome(vaultKey, input.commandId);
    if (previous !== undefined) return this.assertVault(previous, input.vaultId);

    for (let attempt = 0; attempt < MAX_FRONTIER_RETRIES; attempt += 1) {
      const raced = await this.readOutcome(vaultKey, input.commandId);
      if (raced !== undefined) return this.assertVault(raced, input.vaultId);
      const vault = await this.vaults.openVault(input.vaultId);
      const prepared = await prepareCanonicalClosureEvent({
        vault,
        assertedAt: input.assertedAt,
      });
      const outcome: CanonicalLifecycleOutcome = {
        commandId: input.commandId,
        vaultId: input.vaultId,
        generationId: vault.replicaState.generationId,
        eventRecordId: prepared.event.recordId,
      };
      const resolution = {
        vaultId: input.vaultId,
        kind: 1 as const,
        logicalId: prepared.event.recordId,
        storageItemId: prepared.eventEnvelope.storageItemId,
        keyEpochId: vault.epochSecret.keyEpochId,
        availability: 1 as const,
      };
      const [nextReplicaState, resolutionItem] = await Promise.all([
        prepareWrappedLocalStateItem({
          namespace: NAMESPACES.replicaState.key,
          scopeKey: vaultKey,
          itemKey: "current",
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.replica-state",
          context: canonicalLocalStorageContext(input.vaultId, vault.replicaState.generationId),
          bytes: encodeCanonicalReplicaState(prepared.nextReplicaState),
        }),
        prepareWrappedLocalStateItem({
          namespace: NAMESPACES.logicalResolution.key,
          scopeKey: vaultKey,
          itemKey: `1:${identifierStorageKey(prepared.event.recordId)}`,
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.logical-resolution",
          context: canonicalLocalStorageContext(input.vaultId, prepared.event.recordId),
          bytes: encodeLogicalResolution(resolution),
        }),
      ]);
      const immutableItems: readonly NamespaceBytes[] = [
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
          bytes: encodeCanonicalLifecycleOutcome(outcome),
        },
      ];
      try {
        await this.vaults.storage.commitReplicaMutation({
          realm: this.vaults.realm,
          expectedReplicaState: vault.replicaStateStorageBytes,
          nextReplicaState,
          immutableItems,
          mutableItems: [resolutionItem],
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
      "Closure could not commit because the accepted Frontier kept changing.",
    );
  }

  private async readOutcome(
    vaultKey: string,
    commandId: string,
  ): Promise<CanonicalLifecycleOutcome | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.commandOutcome.key,
      scopeKey: vaultKey,
      itemKey: commandId,
    });
    if (bytes === undefined) return undefined;
    const outcome = decodeCanonicalLifecycleOutcome(bytes);
    if (outcome.commandId !== commandId) {
      throw new TypeError("Stored Lifecycle outcome belongs to another Command");
    }
    return outcome;
  }

  private assertVault(
    outcome: CanonicalLifecycleOutcome,
    vaultId: Identifier<"Vault">,
  ): CanonicalLifecycleOutcome {
    if (!bytesEqual(outcome.vaultId, vaultId)) {
      throw new TypeError("Lifecycle outcome belongs to another Vault");
    }
    return outcome;
  }
}

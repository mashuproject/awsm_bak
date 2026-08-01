import type { TypedDependency } from "../../domain/canonical/dependencies";
import type { Identifier } from "../../domain/canonical/identifiers";
import type { CanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import {
  CanonicalStorageError,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { assertCanonicalCommandId } from "../capture/canonical-outcome";
import {
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  encodeLogicalResolution,
  type LogicalResolution,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import type { CanonicalVaultService } from "../vault/canonical-service";
import {
  type CanonicalContentOutcome,
  decodeCanonicalContentOutcome,
  encodeCanonicalContentOutcome,
} from "./canonical-outcome";
import { prepareCanonicalContentEvent } from "./canonical-prepare";

const MAX_FRONTIER_RETRIES = 4;

export interface CanonicalContentCommand {
  readonly commandId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly type: number;
  readonly assertedAt: number | bigint;
  readonly body: CanonicalValue;
  readonly expectedCausalFrontier?: readonly Identifier<"VaultRecord">[];
  readonly dependencies?: readonly TypedDependency[];
  readonly protectionParameters?: Uint8Array;
}

export class CanonicalContentService {
  constructor(readonly vaults: CanonicalVaultService) {}

  async execute(command: CanonicalContentCommand): Promise<CanonicalContentOutcome> {
    assertCanonicalCommandId(command.commandId);
    const vaultKey = identifierStorageKey(command.vaultId);
    const previous = await this.readOutcome(vaultKey, command.commandId);
    if (previous !== undefined) {
      this.assertVault(previous, command.vaultId);
      return previous;
    }
    for (let attempt = 0; attempt < MAX_FRONTIER_RETRIES; attempt += 1) {
      const raced = await this.readOutcome(vaultKey, command.commandId);
      if (raced !== undefined) {
        this.assertVault(raced, command.vaultId);
        return raced;
      }
      const vault = await this.vaults.openVault(command.vaultId);
      if (
        command.expectedCausalFrontier !== undefined &&
        !sameIdentifierSet(vault.replicaState.causalFrontier, command.expectedCausalFrontier)
      ) {
        throw new CanonicalStorageError(
          "VAULT_CONTEXT_CHANGED",
          "The accepted causal Frontier changed before the fenced Content Event could commit.",
        );
      }
      const prepared = await prepareCanonicalContentEvent({
        vault,
        type: command.type,
        assertedAt: command.assertedAt,
        body: command.body,
        ...(command.dependencies === undefined ? {} : { dependencies: command.dependencies }),
        ...(command.protectionParameters === undefined
          ? {}
          : { protectionParameters: command.protectionParameters }),
      });
      const outcome: CanonicalContentOutcome = {
        commandId: command.commandId,
        vaultId: command.vaultId,
        generationId: vault.replicaState.generationId,
        eventRecordId: prepared.event.recordId,
      };
      const resolution: LogicalResolution = {
        vaultId: command.vaultId,
        kind: 1,
        logicalId: prepared.event.recordId,
        storageItemId: prepared.eventEnvelope.storageItemId,
        keyEpochId: vault.epochSecret.keyEpochId,
        availability: 1,
      };
      const [nextReplicaState, resolutionItem] = await Promise.all([
        prepareWrappedLocalStateItem({
          namespace: NAMESPACES.replicaState.key,
          scopeKey: vaultKey,
          itemKey: "current",
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.replica-state",
          context: canonicalLocalStorageContext(command.vaultId, vault.replicaState.generationId),
          bytes: encodeCanonicalReplicaState(prepared.nextReplicaState),
        }),
        prepareWrappedLocalStateItem({
          namespace: NAMESPACES.logicalResolution.key,
          scopeKey: vaultKey,
          itemKey: `1:${identifierStorageKey(prepared.event.recordId)}`,
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.logical-resolution",
          context: canonicalLocalStorageContext(command.vaultId, prepared.event.recordId),
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
          itemKey: command.commandId,
          bytes: encodeCanonicalContentOutcome(outcome),
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
      "The Content Event could not commit because the accepted Frontier kept changing.",
    );
  }

  private async readOutcome(
    vaultKey: string,
    commandId: string,
  ): Promise<CanonicalContentOutcome | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.commandOutcome.key,
      scopeKey: vaultKey,
      itemKey: commandId,
    });
    return bytes === undefined ? undefined : decodeCanonicalContentOutcome(bytes);
  }

  private assertVault(outcome: CanonicalContentOutcome, vaultId: Identifier<"Vault">): void {
    if (!bytesEqual(outcome.vaultId, vaultId)) {
      throw new TypeError("Content outcome Vault ID does not match");
    }
  }
}

function sameIdentifierSet(
  left: readonly Identifier<"VaultRecord">[],
  right: readonly Identifier<"VaultRecord">[],
): boolean {
  return (
    left.length === right.length &&
    left.every((candidate) => right.some((expected) => bytesEqual(candidate, expected)))
  );
}

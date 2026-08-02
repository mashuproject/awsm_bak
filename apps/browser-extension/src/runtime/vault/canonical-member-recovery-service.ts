import type { Identifier } from "../../domain/canonical/identifiers";
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
  encodeClientSecretState,
  encodeEpochSecretState,
  encodeLogicalResolution,
  encodeVaultDirectoryEntry,
  type LogicalResolution,
  prepareWrappedLocalStateItem,
} from "./canonical-local-state";
import {
  prepareCanonicalMemberRecoveryEnrollment,
  wipePreparedCanonicalMemberRecoveryEnrollment,
} from "./canonical-member-recovery";
import {
  type CanonicalMemberRecoveryOutcome,
  decodeCanonicalMemberRecoveryOutcome,
  encodeCanonicalMemberRecoveryOutcome,
} from "./canonical-member-recovery-outcome";
import type { CanonicalVaultService } from "./canonical-service";

const MAX_FRONTIER_RETRIES = 4;

export class CanonicalMemberRecoveryService {
  readonly replay: CanonicalReplayService;

  constructor(readonly vaults: CanonicalVaultService) {
    this.replay = new CanonicalReplayService(vaults);
  }

  async enroll(input: {
    readonly commandId: string;
    readonly vaultId: Identifier<"Vault">;
    readonly recoveryPhrase: string;
    readonly assertedAt: number | bigint;
  }): Promise<CanonicalMemberRecoveryOutcome> {
    assertCanonicalCommandId(input.commandId);
    const vaultKey = identifierStorageKey(input.vaultId);
    const previous = await this.readOutcome(vaultKey, input.commandId);
    if (previous !== undefined) return this.assertVault(previous, input.vaultId);

    for (let attempt = 0; attempt < MAX_FRONTIER_RETRIES; attempt += 1) {
      const raced = await this.readOutcome(vaultKey, input.commandId);
      if (raced !== undefined) return this.assertVault(raced, input.vaultId);
      const replay = await this.replay.replay(input.vaultId);
      const prepared = await prepareCanonicalMemberRecoveryEnrollment({
        replay,
        recoveryPhrase: input.recoveryPhrase,
        assertedAt: input.assertedAt,
        readRecoveryKeyEnvelope: (requirement) =>
          this.vaults.readResolvedOpaqueItem({
            vault: replay.vault,
            kind: 2,
            logicalId: requirement.keyEnvelopeId,
            expectedKeyEpochId: requirement.keyEpochId,
            namespace: NAMESPACES.keyEnvelope.key,
          }),
      });
      try {
        const outcome: CanonicalMemberRecoveryOutcome = {
          commandId: input.commandId,
          vaultId: input.vaultId,
          generationId: replay.vault.replicaState.generationId,
          memberId: prepared.clientSecret.memberId,
          clientCredentialId: prepared.clientSecret.clientCredentialId,
          eventRecordId: prepared.event.recordId,
        };
        const currentKeyEpochId = replay.vault.replicaState.currentKeyEpochId;
        const resolutions: readonly LogicalResolution[] = [
          {
            vaultId: input.vaultId,
            kind: 1,
            logicalId: prepared.event.recordId,
            storageItemId: prepared.eventEnvelope.storageItemId,
            keyEpochId: currentKeyEpochId,
            availability: 1,
          },
          ...prepared.clientKeyEnvelopes.map(
            (envelope): LogicalResolution => ({
              vaultId: input.vaultId,
              kind: 2,
              logicalId: envelope.id,
              storageItemId: envelope.envelope.storageItemId,
              keyEpochId: envelope.keyEpochId,
              availability: 1,
            }),
          ),
        ];
        const nextDirectory = {
          ...replay.vault.directory,
          selectedClientCredentialId: prepared.clientSecret.clientCredentialId,
        };
        const [nextReplicaState, directoryItem, clientSecretItem, ...stateItems] =
          await Promise.all([
            prepareWrappedLocalStateItem({
              namespace: NAMESPACES.replicaState.key,
              scopeKey: vaultKey,
              itemKey: "current",
              wrappingKey: replay.vault.installationWrappingKey,
              domain: "awsm.local.replica-state",
              context: canonicalLocalStorageContext(
                input.vaultId,
                replay.vault.replicaState.generationId,
              ),
              bytes: encodeCanonicalReplicaState(prepared.nextReplicaState),
            }),
            prepareWrappedLocalStateItem({
              namespace: NAMESPACES.vaultDirectory.key,
              scopeKey: "installation",
              itemKey: vaultKey,
              wrappingKey: replay.vault.installationWrappingKey,
              domain: "awsm.local.vault-directory",
              context: canonicalLocalStorageContext(input.vaultId, input.vaultId),
              bytes: encodeVaultDirectoryEntry(nextDirectory),
            }),
            prepareWrappedLocalStateItem({
              namespace: NAMESPACES.clientSecret.key,
              scopeKey: vaultKey,
              itemKey: identifierStorageKey(prepared.clientSecret.clientCredentialId),
              wrappingKey: replay.vault.installationWrappingKey,
              domain: "awsm.local.client-secret",
              context: canonicalLocalStorageContext(
                input.vaultId,
                prepared.clientSecret.clientCredentialId,
              ),
              bytes: encodeClientSecretState(prepared.clientSecret),
            }),
            ...resolutions.map((resolution) =>
              prepareWrappedLocalStateItem({
                namespace: NAMESPACES.logicalResolution.key,
                scopeKey: vaultKey,
                itemKey: `${resolution.kind}:${identifierStorageKey(
                  resolution.logicalId as Identifier<"VaultRecord">,
                )}`,
                wrappingKey: replay.vault.installationWrappingKey,
                domain: "awsm.local.logical-resolution",
                context: canonicalLocalStorageContext(input.vaultId, resolution.logicalId),
                bytes: encodeLogicalResolution(resolution),
              }),
            ),
            ...prepared.recoveredEpochs.map((epoch) =>
              prepareWrappedLocalStateItem({
                namespace: NAMESPACES.epochSecret.key,
                scopeKey: vaultKey,
                itemKey: identifierStorageKey(epoch.keyEpochId),
                wrappingKey: replay.vault.installationWrappingKey,
                domain: "awsm.local.epoch-secret",
                context: canonicalLocalStorageContext(input.vaultId, epoch.keyEpochId),
                bytes: encodeEpochSecretState(epoch),
              }),
            ),
          ]);
        const immutableItems: readonly NamespaceBytes[] = [
          {
            namespace: NAMESPACES.vaultRecord.key,
            scopeKey: vaultKey,
            itemKey: identifierStorageKey(prepared.event.recordId),
            bytes: prepared.eventEnvelope.bytes,
          },
          ...prepared.clientKeyEnvelopes.map((envelope) => ({
            namespace: NAMESPACES.keyEnvelope.key,
            scopeKey: vaultKey,
            itemKey: identifierStorageKey(envelope.id),
            bytes: envelope.envelope.bytes,
          })),
          {
            namespace: NAMESPACES.commandOutcome.key,
            scopeKey: vaultKey,
            itemKey: input.commandId,
            bytes: encodeCanonicalMemberRecoveryOutcome(outcome),
          },
        ];
        await this.vaults.storage.commitReplicaMutation({
          realm: this.vaults.realm,
          expectedReplicaState: replay.vault.replicaStateStorageBytes,
          nextReplicaState,
          immutableItems,
          mutableItems: [directoryItem, clientSecretItem, ...stateItems],
        });
        return outcome;
      } catch (error) {
        if (error instanceof CanonicalStorageError && error.id === "VAULT_CONTEXT_CHANGED") {
          continue;
        }
        throw error;
      } finally {
        await wipePreparedCanonicalMemberRecoveryEnrollment(prepared);
      }
    }
    throw new CanonicalStorageError(
      "VAULT_CONTEXT_CHANGED",
      "Member Recovery could not commit because the accepted Frontier kept changing.",
    );
  }

  private async readOutcome(
    vaultKey: string,
    commandId: string,
  ): Promise<CanonicalMemberRecoveryOutcome | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.commandOutcome.key,
      scopeKey: vaultKey,
      itemKey: commandId,
    });
    if (bytes === undefined) return undefined;
    const outcome = decodeCanonicalMemberRecoveryOutcome(bytes);
    if (outcome.commandId !== commandId) {
      throw new TypeError("Stored Member Recovery outcome belongs to another Command");
    }
    return outcome;
  }

  private assertVault(
    outcome: CanonicalMemberRecoveryOutcome,
    vaultId: Identifier<"Vault">,
  ): CanonicalMemberRecoveryOutcome {
    if (!bytesEqual(outcome.vaultId, vaultId)) {
      throw new TypeError("Member Recovery outcome belongs to another Vault");
    }
    return outcome;
  }
}

import { normalizeRecoveryPhrase } from "../../crypto/canonical";
import { wipe } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import {
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { CanonicalReplayService } from "../projection/canonical-replay";
import {
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  encodeLogicalResolution,
  type LogicalResolution,
  prepareWrappedLocalStateItem,
} from "./canonical-local-state";
import {
  type PreparedCanonicalRecoveryCredentialReplacement,
  prepareCanonicalRecoveryCredentialReplacement,
  wipePreparedCanonicalRecoveryCredentialReplacement,
} from "./canonical-recovery-replacement";
import type { CanonicalVaultService, PersistedOpenedCanonicalVault } from "./canonical-service";

export interface CanonicalRecoveryReplacementOutcome {
  readonly vaultId: Identifier<"Vault">;
  readonly memberId: Identifier<"Member">;
  readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
  readonly revision: number;
  readonly eventRecordId: Identifier<"VaultRecord">;
}

export class CanonicalRecoveryReplacementCeremony {
  readonly recoveryPhrase: string;
  private active = true;

  constructor(
    private readonly vaults: CanonicalVaultService,
    private readonly vault: PersistedOpenedCanonicalVault,
    private readonly prepared: PreparedCanonicalRecoveryCredentialReplacement,
  ) {
    this.recoveryPhrase = prepared.recoveryPhrase;
  }

  async confirm(completeRecoveryPhrase: string): Promise<CanonicalRecoveryReplacementOutcome> {
    this.assertActive();
    if (normalizeRecoveryPhrase(completeRecoveryPhrase) !== this.recoveryPhrase) {
      throw Object.assign(new Error("The full Recovery Phrase does not match."), {
        id: "RECOVERY_PHRASE_MISMATCH",
      });
    }
    const vaultId = this.vault.replicaState.vaultId;
    const vaultKey = identifierStorageKey(vaultId);
    const resolutions: readonly LogicalResolution[] = [
      {
        vaultId,
        kind: 1,
        logicalId: this.prepared.event.recordId,
        storageItemId: this.prepared.eventEnvelope.storageItemId,
        keyEpochId: this.vault.replicaState.currentKeyEpochId,
        availability: 1,
      },
      ...this.prepared.recoveryKeyEnvelopes.map(
        (envelope): LogicalResolution => ({
          vaultId,
          kind: 2,
          logicalId: envelope.id,
          storageItemId: envelope.envelope.storageItemId,
          keyEpochId: envelope.keyEpochId,
          availability: 1,
        }),
      ),
    ];
    try {
      const [nextReplicaState, ...resolutionItems] = await Promise.all([
        prepareWrappedLocalStateItem({
          namespace: NAMESPACES.replicaState.key,
          scopeKey: vaultKey,
          itemKey: "current",
          wrappingKey: this.vault.installationWrappingKey,
          domain: "awsm.local.replica-state",
          context: canonicalLocalStorageContext(vaultId, this.vault.replicaState.generationId),
          bytes: encodeCanonicalReplicaState(this.prepared.nextReplicaState),
        }),
        ...resolutions.map((resolution) =>
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.logicalResolution.key,
            scopeKey: vaultKey,
            itemKey: `${resolution.kind}:${identifierStorageKey(
              resolution.logicalId as Identifier<"VaultRecord">,
            )}`,
            wrappingKey: this.vault.installationWrappingKey,
            domain: "awsm.local.logical-resolution",
            context: canonicalLocalStorageContext(vaultId, resolution.logicalId),
            bytes: encodeLogicalResolution(resolution),
          }),
        ),
      ]);
      const immutableItems: readonly NamespaceBytes[] = [
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(this.prepared.event.recordId),
          bytes: this.prepared.eventEnvelope.bytes,
        },
        ...this.prepared.recoveryKeyEnvelopes.map((envelope) => ({
          namespace: NAMESPACES.keyEnvelope.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(envelope.id),
          bytes: envelope.envelope.bytes,
        })),
      ];
      await this.vaults.storage.commitReplicaMutation({
        realm: this.vaults.realm,
        expectedReplicaState: this.vault.replicaStateStorageBytes,
        nextReplicaState,
        immutableItems,
        mutableItems: resolutionItems,
      });
      this.active = false;
      return {
        vaultId,
        memberId: this.prepared.recoveryCredential.memberId,
        recoveryCredentialId: this.prepared.recoveryCredential.recoveryCredentialId,
        revision: this.prepared.recoveryCredential.revision,
        eventRecordId: this.prepared.event.recordId,
      };
    } catch (error) {
      this.active = false;
      throw error;
    } finally {
      if (!this.active) {
        await wipePreparedCanonicalRecoveryCredentialReplacement(this.prepared);
      }
    }
  }

  async cancel(): Promise<void> {
    this.assertActive();
    this.active = false;
    await wipePreparedCanonicalRecoveryCredentialReplacement(this.prepared);
  }

  private assertActive(): void {
    if (!this.active) throw new Error("The Recovery replacement ceremony is no longer active.");
  }
}

export class CanonicalRecoveryReplacementService {
  readonly replay: CanonicalReplayService;

  constructor(readonly vaults: CanonicalVaultService) {
    this.replay = new CanonicalReplayService(vaults);
  }

  async begin(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly assertedAt: number | bigint;
  }): Promise<CanonicalRecoveryReplacementCeremony> {
    const replay = await this.replay.replay(input.vaultId);
    const epochSecrets = await this.vaults.listEpochSecrets(replay.vault);
    try {
      const prepared = await prepareCanonicalRecoveryCredentialReplacement({
        replay,
        epochSecrets,
        assertedAt: input.assertedAt,
      });
      return new CanonicalRecoveryReplacementCeremony(this.vaults, replay.vault, prepared);
    } finally {
      await Promise.all(epochSecrets.map(({ key }) => wipe(key)));
    }
  }
}

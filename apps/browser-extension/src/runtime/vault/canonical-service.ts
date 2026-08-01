import { normalizeRecoveryPhrase } from "../../crypto/canonical";
import {
  type CompactPayloadType,
  type OpenedCompactItem,
  openCompactItem,
} from "../../crypto/compact";
import { openKeyEnvelope } from "../../crypto/key-envelope";
import { wipe } from "../../crypto/sodium";
import { DEPENDENCY_TYPES } from "../../domain/canonical/dependencies";
import type { Identifier } from "../../domain/canonical/identifiers";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { bytesEqual } from "../../domain/hash";
import {
  type CanonicalIndexedDb,
  identifierFromStorageKey,
  identifierStorageKey,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import {
  type PreparedCanonicalVaultCreation,
  prepareCanonicalVaultCreation,
} from "./canonical-create";
import {
  type CanonicalReplicaState,
  type ClientSecretState,
  decodeCanonicalReplicaState,
  decodeClientSecretState,
  decodeEpochSecretState,
  decodeInstallationSelection,
  decodeLogicalResolution,
  decodeVaultDirectoryEntry,
  type EpochSecretState,
  encodeInstallationSelection,
  type LogicalResolution,
  openWrappedLocalState,
  prepareCanonicalVaultStorage,
  type VaultDirectoryEntry,
} from "./canonical-local-state";
import { initialBaselineVaultLabel, validateInitialVaultAuthority } from "./canonical-open";

export interface CreatedCanonicalVault {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
}

export interface CanonicalVaultDirectoryItem extends VaultDirectoryEntry {
  readonly selected: boolean;
}

export interface OpenedCanonicalVault {
  readonly directory: VaultDirectoryEntry;
  readonly replicaState: CanonicalReplicaState;
  readonly clientSecret: ClientSecretState;
  readonly epochSecret: EpochSecretState;
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
}

export interface PersistedOpenedCanonicalVault extends OpenedCanonicalVault {
  readonly installationWrappingKey: CryptoKey;
  readonly replicaStateStorageBytes: Uint8Array;
}

function sameBytes(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

export class CanonicalVaultCreationCeremony {
  readonly recoveryPhrase: string;
  private active = true;

  constructor(
    private readonly storage: CanonicalIndexedDb,
    private readonly realm: StorageRealm,
    private readonly label: string | null,
    private readonly prepared: PreparedCanonicalVaultCreation,
  ) {
    this.recoveryPhrase = prepared.recoveryPhrase;
  }

  async confirm(completeRecoveryPhrase: string): Promise<CreatedCanonicalVault> {
    this.assertActive();
    if (normalizeRecoveryPhrase(completeRecoveryPhrase) !== this.recoveryPhrase) {
      throw Object.assign(new Error("The full Recovery Phrase does not match."), {
        id: "RECOVERY_PHRASE_MISMATCH",
      });
    }
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const storage = await prepareCanonicalVaultStorage({
      creation: this.prepared,
      label: this.label,
      realm: this.realm,
      wrappingKey,
    });
    await this.storage.commitInitialVault(storage.commit);
    this.active = false;
    const result = {
      vaultId: this.prepared.ids.vaultId,
      generationId: this.prepared.ids.generationId,
      memberId: this.prepared.ids.firstMemberId,
      clientCredentialId: this.prepared.ids.clientCredentialId,
    };
    await this.wipePreparedSecrets();
    return result;
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.wipePreparedSecrets();
  }

  private assertActive(): void {
    if (!this.active) throw new Error("The Vault creation ceremony is no longer active.");
  }

  private async wipePreparedSecrets(): Promise<void> {
    const { client, recovery, keyEpoch } = this.prepared.secrets;
    await Promise.all([
      wipe(client.signingSeed),
      wipe(client.signingSecretKey),
      wipe(client.wrappingPrivateKey),
      wipe(recovery.signingSeed),
      wipe(recovery.signingSecretKey),
      wipe(recovery.wrappingPrivateKey),
      wipe(keyEpoch.key),
      wipe(this.prepared.clientKeyEnvelope.keyEpochKey),
      wipe(this.prepared.clientKeyEnvelope.bytes),
      wipe(this.prepared.recoveryKeyEnvelope.keyEpochKey),
      wipe(this.prepared.recoveryKeyEnvelope.bytes),
    ]);
  }
}

export class CanonicalVaultService {
  constructor(
    readonly storage: CanonicalIndexedDb,
    readonly realm: StorageRealm,
  ) {}

  async beginCreate(input: {
    readonly label: string | null;
    readonly assertedAt: number | bigint;
  }): Promise<CanonicalVaultCreationCeremony> {
    const prepared = await prepareCanonicalVaultCreation(input);
    return new CanonicalVaultCreationCeremony(this.storage, this.realm, input.label, prepared);
  }

  async listVaults(): Promise<readonly CanonicalVaultDirectoryItem[]> {
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const selectionBytes = await this.storage.getBytes(this.realm, {
      namespace: NAMESPACES.installationSelection.key,
      scopeKey: "installation",
      itemKey: "current",
    });
    const selected =
      selectionBytes === undefined
        ? undefined
        : decodeInstallationSelection(selectionBytes).vaultId;
    const entries = await this.storage.listBytes(
      this.realm,
      NAMESPACES.vaultDirectory.key,
      "installation",
    );
    return Promise.all(
      entries.map(async (entry) => {
        const vaultId = identifierFromStorageKey("Vault", entry.itemKey);
        const directory = decodeVaultDirectoryEntry(
          await openWrappedLocalState({
            wrappingKey,
            domain: "awsm.local.vault-directory",
            vaultId,
            identity: vaultId,
            wrappedBytes: entry.bytes,
          }),
        );
        sameBytes(directory.vaultId, vaultId, "Vault Directory identity");
        return {
          ...directory,
          selected: selected !== undefined && bytesEqual(selected, directory.vaultId),
        };
      }),
    );
  }

  async selectVault(vaultId: Identifier<"Vault">): Promise<void> {
    await this.openVault(vaultId);
    await this.storage.putMutable(this.realm, {
      namespace: NAMESPACES.installationSelection.key,
      scopeKey: "installation",
      itemKey: "current",
      bytes: encodeInstallationSelection({ vaultId }),
    });
  }

  async openVault(vaultId: Identifier<"Vault">): Promise<PersistedOpenedCanonicalVault> {
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const vaultKey = identifierStorageKey(vaultId);
    const directoryWrapped = await this.requireBytes({
      namespace: NAMESPACES.vaultDirectory.key,
      scopeKey: "installation",
      itemKey: vaultKey,
    });
    const directory = decodeVaultDirectoryEntry(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.vault-directory",
        vaultId,
        identity: vaultId,
        wrappedBytes: directoryWrapped,
      }),
    );
    sameBytes(directory.vaultId, vaultId, "Vault Directory identity");

    const replicaWrapped = await this.requireBytes({
      namespace: NAMESPACES.replicaState.key,
      scopeKey: vaultKey,
      itemKey: "current",
    });
    const replicaState = decodeCanonicalReplicaState(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.replica-state",
        vaultId,
        identity: directory.generationId,
        wrappedBytes: replicaWrapped,
      }),
    );
    sameBytes(replicaState.vaultId, vaultId, "Replica Vault ID");
    sameBytes(replicaState.generationId, directory.generationId, "Directory Generation ID");

    const clientWrapped = await this.requireBytes({
      namespace: NAMESPACES.clientSecret.key,
      scopeKey: vaultKey,
      itemKey: identifierStorageKey(directory.selectedClientCredentialId),
    });
    const clientSecret = await decodeClientSecretState(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.client-secret",
        vaultId,
        identity: directory.selectedClientCredentialId,
        wrappedBytes: clientWrapped,
      }),
    );
    const epochWrapped = await this.requireBytes({
      namespace: NAMESPACES.epochSecret.key,
      scopeKey: vaultKey,
      itemKey: identifierStorageKey(replicaState.currentKeyEpochId),
    });
    const epochSecret = decodeEpochSecretState(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.epoch-secret",
        vaultId,
        identity: replicaState.currentKeyEpochId,
        wrappedBytes: epochWrapped,
      }),
    );

    const baselineEnvelopeBytes = await this.requireBytes({
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: vaultKey,
      itemKey: identifierStorageKey(replicaState.baselineId),
    });
    if (replicaState.continuityRecordIds.length === 0) {
      throw new TypeError("The Continuity Proof does not contain Genesis");
    }
    const continuityEvents = await Promise.all(
      replicaState.continuityRecordIds.map(async (recordId) => {
        const envelopeBytes = await this.requireBytes({
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(recordId),
        });
        await this.validateResolution({
          wrappingKey,
          vaultId,
          kind: 1,
          logicalId: recordId,
          expectedKeyEpochId: epochSecret.keyEpochId,
          envelopeBytes,
        });
        const event = decodeVaultEvent(
          (
            await openCompactItem({
              vaultId,
              keyEpochId: epochSecret.keyEpochId,
              keyEpochKey: epochSecret.key,
              envelopeBytes,
            })
          ).payloadBytes,
        );
        sameBytes(event.recordId, recordId, "Continuity Record ID");
        return event;
      }),
    );
    const genesisCandidates = continuityEvents.filter(
      (event) => event.family === 1 && event.type === 1,
    );
    const genesis = genesisCandidates[0];
    if (genesis === undefined || genesisCandidates.length !== 1) {
      throw new TypeError("The Continuity Proof must contain exactly one Genesis Event");
    }
    await this.validateResolution({
      wrappingKey,
      vaultId,
      kind: 1,
      logicalId: replicaState.baselineId,
      expectedKeyEpochId: epochSecret.keyEpochId,
      envelopeBytes: baselineEnvelopeBytes,
    });
    const baseline = decodeVaultBaseline(
      (
        await openCompactItem({
          vaultId,
          keyEpochId: epochSecret.keyEpochId,
          keyEpochKey: epochSecret.key,
          envelopeBytes: baselineEnvelopeBytes,
        })
      ).payloadBytes,
    );
    sameBytes(baseline.recordId, replicaState.baselineId, "Opened Baseline ID");
    if (initialBaselineVaultLabel(baseline) !== directory.label) {
      throw new TypeError("Vault Directory label does not match initial authoritative state");
    }
    await validateInitialVaultAuthority({
      baseline,
      genesis,
      replicaState,
      clientSecret,
      epochSecret,
      requireInitialReplicaState: false,
    });

    const keyEnvelopeDependencies = baseline.dependencies.filter(
      ({ type }) => type === DEPENDENCY_TYPES.KeyEnvelope,
    );
    let openedClientEnvelope = 0;
    for (const dependency of keyEnvelopeDependencies) {
      const keyEnvelopeId = dependency.id as Identifier<"KeyEnvelope">;
      const envelopeBytes = await this.requireBytes({
        namespace: NAMESPACES.keyEnvelope.key,
        scopeKey: vaultKey,
        itemKey: identifierStorageKey(keyEnvelopeId),
      });
      await this.validateResolution({
        wrappingKey,
        vaultId,
        kind: 2,
        logicalId: keyEnvelopeId,
        expectedKeyEpochId: epochSecret.keyEpochId,
        envelopeBytes,
      });
      try {
        const opened = await openKeyEnvelope({
          targetKind: 2,
          recipientWrappingPrivateKey: clientSecret.wrappingPrivateKey,
          envelopeBytes,
        });
        sameBytes(opened.id, keyEnvelopeId, "Client Key Envelope ID");
        sameBytes(
          opened.targetCredentialId,
          clientSecret.clientCredentialId,
          "Client Key Envelope target",
        );
        sameBytes(opened.keyEpochId, epochSecret.keyEpochId, "Client Key Envelope Epoch");
        sameBytes(opened.keyEpochKey, epochSecret.key, "Client Key Envelope Key");
        openedClientEnvelope += 1;
      } catch {
        // The Recovery-targeted Key Envelope is intentionally not openable by the Client key.
      }
    }
    if (openedClientEnvelope !== 1) {
      throw new TypeError("Exactly one initial Key Envelope must open for the selected Client");
    }
    return {
      directory,
      replicaState,
      clientSecret,
      epochSecret,
      baseline,
      genesis,
      installationWrappingKey: wrappingKey,
      replicaStateStorageBytes: replicaWrapped,
    };
  }

  async readLogicalResolution(input: {
    readonly vault: PersistedOpenedCanonicalVault;
    readonly kind: LogicalResolution["kind"];
    readonly logicalId: Uint8Array;
  }): Promise<LogicalResolution> {
    const vaultKey = identifierStorageKey(input.vault.replicaState.vaultId);
    const logicalKey = identifierStorageKey(input.logicalId as Identifier<"VaultRecord">);
    const wrapped = await this.requireBytes({
      namespace: NAMESPACES.logicalResolution.key,
      scopeKey: vaultKey,
      itemKey: `${input.kind}:${logicalKey}`,
    });
    const resolution = decodeLogicalResolution(
      await openWrappedLocalState({
        wrappingKey: input.vault.installationWrappingKey,
        domain: "awsm.local.logical-resolution",
        vaultId: input.vault.replicaState.vaultId,
        identity: input.logicalId,
        wrappedBytes: wrapped,
      }),
    );
    sameBytes(resolution.vaultId, input.vault.replicaState.vaultId, "Resolution Vault ID");
    if (resolution.kind !== input.kind) throw new TypeError("Logical Resolution kind is invalid");
    sameBytes(resolution.logicalId, input.logicalId, "Resolution logical ID");
    return resolution;
  }

  async openResolvedCompactItem(input: {
    readonly vault: PersistedOpenedCanonicalVault;
    readonly kind: 1 | 3 | 4;
    readonly logicalId: Uint8Array;
    readonly namespace:
      | typeof NAMESPACES.vaultRecord.key
      | typeof NAMESPACES.vaultObject.key
      | typeof NAMESPACES.featureManifest.key;
    readonly payloadType: CompactPayloadType;
  }): Promise<OpenedCompactItem> {
    const resolution = await this.readLogicalResolution(input);
    if (resolution.availability !== 1) {
      throw new TypeError("The required Compact item is not verified locally");
    }
    sameBytes(resolution.keyEpochId, input.vault.epochSecret.keyEpochId, "Resolution Key Epoch ID");
    const envelopeBytes = await this.requireBytes({
      namespace: input.namespace,
      scopeKey: identifierStorageKey(input.vault.replicaState.vaultId),
      itemKey: identifierStorageKey(input.logicalId as Identifier<"VaultRecord">),
    });
    sameBytes(
      resolution.storageItemId,
      decodeOpaqueEnvelope(envelopeBytes).storageItemId,
      "Resolution Storage Item ID",
    );
    const opened = await openCompactItem({
      vaultId: input.vault.replicaState.vaultId,
      keyEpochId: input.vault.epochSecret.keyEpochId,
      keyEpochKey: input.vault.epochSecret.key,
      envelopeBytes,
    });
    if (opened.payloadType !== input.payloadType) {
      throw new TypeError("Compact item payload type does not match its logical namespace");
    }
    return opened;
  }

  private async requireBytes(item: {
    readonly namespace: Parameters<CanonicalIndexedDb["getBytes"]>[1]["namespace"];
    readonly scopeKey: string;
    readonly itemKey: string;
  }): Promise<Uint8Array> {
    const bytes = await this.storage.getBytes(this.realm, item);
    if (bytes === undefined)
      throw new TypeError(`Required ${item.namespace} bytes are unavailable`);
    return bytes;
  }

  private async validateResolution(input: {
    readonly wrappingKey: CryptoKey;
    readonly vaultId: Identifier<"Vault">;
    readonly kind: LogicalResolution["kind"];
    readonly logicalId: Uint8Array;
    readonly expectedKeyEpochId: Identifier<"KeyEpoch">;
    readonly envelopeBytes: Uint8Array;
  }): Promise<void> {
    const vaultKey = identifierStorageKey(input.vaultId);
    const logicalKey = identifierStorageKey(input.logicalId as Identifier<"VaultRecord">);
    const wrapped = await this.requireBytes({
      namespace: NAMESPACES.logicalResolution.key,
      scopeKey: vaultKey,
      itemKey: `${input.kind}:${logicalKey}`,
    });
    const resolution = decodeLogicalResolution(
      await openWrappedLocalState({
        wrappingKey: input.wrappingKey,
        domain: "awsm.local.logical-resolution",
        vaultId: input.vaultId,
        identity: input.logicalId,
        wrappedBytes: wrapped,
      }),
    );
    sameBytes(resolution.vaultId, input.vaultId, "Resolution Vault ID");
    if (resolution.kind !== input.kind || resolution.availability !== 1) {
      throw new TypeError("Logical Resolution kind or local availability is invalid");
    }
    sameBytes(resolution.logicalId, input.logicalId, "Resolution logical ID");
    sameBytes(resolution.keyEpochId, input.expectedKeyEpochId, "Resolution Key Epoch ID");
    sameBytes(
      resolution.storageItemId,
      decodeOpaqueEnvelope(input.envelopeBytes).storageItemId,
      "Resolution Storage Item ID",
    );
  }
}

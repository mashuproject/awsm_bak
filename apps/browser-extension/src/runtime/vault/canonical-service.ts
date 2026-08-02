import { decodeRecoveryPhrase, normalizeRecoveryPhrase } from "../../crypto/canonical";
import {
  type CompactPayloadType,
  type OpenedCompactItem,
  openCompactItem,
} from "../../crypto/compact";
import { CryptoOperationError } from "../../crypto/errors";
import { unwrapInstallationBytes, wrapInstallationBytes } from "../../crypto/installation-wrap";
import { openKeyEnvelope } from "../../crypto/key-envelope";
import { wipe } from "../../crypto/sodium";
import { type Identifier, identifier } from "../../domain/canonical/identifiers";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { transcript } from "../../domain/canonical/transcript";
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
  wipePreparedCanonicalVaultCreation,
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
import { baselineVaultLabel, validateCurrentVaultAuthority } from "./canonical-open";
import {
  type CanonicalPendingVaultCreation,
  decodeCanonicalPendingVaultCreation,
  encodeCanonicalPendingVaultCreation,
} from "./canonical-pending-vault-creation";

export interface CreatedCanonicalVault {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
}

export interface CanonicalVaultDirectoryItem extends VaultDirectoryEntry {
  readonly lifecycle: 1 | 2;
  readonly selected: boolean;
}

export interface OpenedCanonicalVault {
  readonly directory: VaultDirectoryEntry;
  readonly replicaState: CanonicalReplicaState;
  readonly clientSecret: ClientSecretState | null;
  readonly epochSecret: EpochSecretState;
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
}

export function requireCanonicalClientSecret(vault: OpenedCanonicalVault): ClientSecretState {
  if (
    vault.clientSecret === null ||
    vault.replicaState.authoringClientCredentialId === null ||
    vault.replicaState.memberId === null ||
    vault.directory.selectedClientCredentialId === null
  ) {
    throw Object.assign(new Error("This Vault has no local authoring Client Credential."), {
      id: "VAULT_READ_ONLY",
    });
  }
  if (
    !bytesEqual(
      vault.clientSecret.clientCredentialId,
      vault.replicaState.authoringClientCredentialId,
    ) ||
    !bytesEqual(
      vault.clientSecret.clientCredentialId,
      vault.directory.selectedClientCredentialId,
    ) ||
    !bytesEqual(vault.clientSecret.memberId, vault.replicaState.memberId)
  ) {
    throw new TypeError("Local authoring Client Credential state is inconsistent");
  }
  return vault.clientSecret;
}

export interface PersistedOpenedCanonicalVault extends OpenedCanonicalVault {
  readonly installationWrappingKey: CryptoKey;
  readonly replicaStateStorageBytes: Uint8Array;
}

function sameBytes(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

const encoder = new TextEncoder();

interface PersistedPendingVaultCreation {
  readonly item: {
    readonly namespace: typeof NAMESPACES.pendingVaultCreation.key;
    readonly scopeKey: "installation";
    readonly itemKey: string;
    readonly bytes: Uint8Array;
  };
}

function pendingVaultCreationItem(setupId: string) {
  return {
    namespace: NAMESPACES.pendingVaultCreation.key,
    scopeKey: "installation" as const,
    itemKey: setupId,
  };
}

function pendingVaultCreationContext(setupId: string): Uint8Array {
  return transcript("awsm:pending-vault-creation-context:v1", [encoder.encode(setupId)]);
}

function creationNotFound(): Error {
  return Object.assign(new Error("The Vault creation ceremony is unavailable."), {
    id: "VAULT_CREATION_NOT_FOUND",
  });
}

function recoveryPhraseMismatch(): Error {
  return Object.assign(new Error("The full Recovery Phrase does not match."), {
    id: "RECOVERY_PHRASE_MISMATCH",
  });
}

async function wipePendingVaultCreation(value: CanonicalPendingVaultCreation): Promise<void> {
  await Promise.all([
    wipe(value.clientSigningSeed),
    wipe(value.clientWrappingPrivateKey),
    wipe(value.keyEpochKey),
    wipe(value.recoveryEnvelopeBytes),
    wipe(value.clientEnvelopeBytes),
    wipe(value.baselineProtectionParameters),
    wipe(value.genesisProtectionParameters),
  ]);
}

export class CanonicalVaultCreationCeremony {
  readonly recoveryPhrase: string;
  private active = true;

  constructor(
    private readonly storage: CanonicalIndexedDb,
    private readonly realm: StorageRealm,
    private readonly label: string | null,
    private readonly prepared: PreparedCanonicalVaultCreation,
    private readonly persisted: PersistedPendingVaultCreation | null = null,
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
    await this.storage.commitInitialVault({
      ...storage.commit,
      ...(this.persisted === null
        ? {}
        : {
            expectedMutableItems: [this.persisted.item],
            deletedItems: [pendingVaultCreationItem(this.persisted.item.itemKey)],
          }),
    });
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
    if (this.persisted !== null) {
      await this.storage.commitExecutionMutation({
        realm: this.realm,
        expectedMutableItems: [this.persisted.item],
        deletedItems: [pendingVaultCreationItem(this.persisted.item.itemKey)],
      });
    }
    this.active = false;
    await this.wipePreparedSecrets();
  }

  private assertActive(): void {
    if (!this.active) throw new Error("The Vault creation ceremony is no longer active.");
  }

  private async wipePreparedSecrets(): Promise<void> {
    await wipePreparedCanonicalVaultCreation(this.prepared);
  }
}

export class CanonicalVaultService {
  constructor(
    readonly storage: CanonicalIndexedDb,
    readonly realm: StorageRealm,
  ) {}

  async beginCreate(input: {
    readonly setupId: string;
    readonly expectedVaultId: Identifier<"Vault"> | null;
    readonly label: string | null;
    readonly assertedAt: number | bigint;
  }): Promise<CanonicalVaultCreationCeremony> {
    const prepared = await prepareCanonicalVaultCreation(input);
    try {
      const persisted = await this.persistPendingVaultCreation({
        setupId: input.setupId,
        expectedVaultId: input.expectedVaultId,
        label: input.label,
        assertedAt: input.assertedAt,
        prepared,
      });
      return new CanonicalVaultCreationCeremony(
        this.storage,
        this.realm,
        input.label,
        prepared,
        persisted,
      );
    } catch (error) {
      await wipePreparedCanonicalVaultCreation(prepared);
      throw error;
    }
  }

  async pendingCreationExpectedVault(setupId: string): Promise<Identifier<"Vault"> | null> {
    const { pending } = await this.readPendingVaultCreation(setupId);
    try {
      return pending.expectedVaultId === null
        ? null
        : identifier("Vault", Uint8Array.from(pending.expectedVaultId));
    } finally {
      await wipePendingVaultCreation(pending);
    }
  }

  async pendingCreation(): Promise<
    { readonly setupId: string; readonly expectedVaultId: Identifier<"Vault"> | null } | undefined
  > {
    const entries = await this.storage.listBytes(
      this.realm,
      NAMESPACES.pendingVaultCreation.key,
      "installation",
    );
    if (entries.length === 0) return undefined;
    if (entries.length !== 1) {
      throw new TypeError("The Installation has more than one pending Vault creation.");
    }
    const entry = entries[0];
    if (entry === undefined) throw new TypeError("Pending Vault creation inventory is invalid.");
    const { pending } = await this.readPendingVaultCreation(entry.itemKey);
    try {
      return {
        setupId: pending.setupId,
        expectedVaultId:
          pending.expectedVaultId === null
            ? null
            : identifier("Vault", Uint8Array.from(pending.expectedVaultId)),
      };
    } finally {
      await wipePendingVaultCreation(pending);
    }
  }

  async resumeCreate(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<CanonicalVaultCreationCeremony> {
    const { pending, persisted } = await this.readPendingVaultCreation(input.setupId);
    let recoveryEntropy: Uint8Array | undefined;
    try {
      try {
        recoveryEntropy = decodeRecoveryPhrase(input.recoveryPhrase);
      } catch {
        throw recoveryPhraseMismatch();
      }
      let prepared: PreparedCanonicalVaultCreation;
      try {
        prepared = await prepareCanonicalVaultCreation({
          label: pending.label,
          assertedAt: pending.assertedAt,
          deterministic: {
            ids: pending.ids,
            recoveryEntropy,
            clientSigningSeed: pending.clientSigningSeed,
            clientWrappingPrivateKey: pending.clientWrappingPrivateKey,
            keyEpochKey: pending.keyEpochKey,
            recoveryEnvelopeBytes: pending.recoveryEnvelopeBytes,
            clientEnvelopeBytes: pending.clientEnvelopeBytes,
            baselineProtectionParameters: pending.baselineProtectionParameters,
            genesisProtectionParameters: pending.genesisProtectionParameters,
          },
        });
      } catch (error) {
        if (error instanceof CryptoOperationError) throw recoveryPhraseMismatch();
        throw error;
      }
      return new CanonicalVaultCreationCeremony(
        this.storage,
        this.realm,
        pending.label,
        prepared,
        persisted,
      );
    } finally {
      if (recoveryEntropy !== undefined) await wipe(recoveryEntropy);
      await wipePendingVaultCreation(pending);
    }
  }

  async cancelPendingCreate(setupId: string): Promise<void> {
    const { pending, persisted } = await this.readPendingVaultCreation(setupId);
    try {
      await this.storage.commitExecutionMutation({
        realm: this.realm,
        expectedMutableItems: [persisted.item],
        deletedItems: [pendingVaultCreationItem(setupId)],
      });
    } finally {
      await wipePendingVaultCreation(pending);
    }
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
        const replicaState = decodeCanonicalReplicaState(
          await openWrappedLocalState({
            wrappingKey,
            domain: "awsm.local.replica-state",
            vaultId,
            identity: directory.generationId,
            wrappedBytes: await this.requireBytes({
              namespace: NAMESPACES.replicaState.key,
              scopeKey: identifierStorageKey(vaultId),
              itemKey: "current",
            }),
          }),
        );
        sameBytes(replicaState.vaultId, vaultId, "Replica Vault ID");
        sameBytes(replicaState.generationId, directory.generationId, "Directory Generation ID");
        return {
          ...directory,
          lifecycle: replicaState.lifecycle,
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

    const clientSecret =
      directory.selectedClientCredentialId === null
        ? null
        : await decodeClientSecretState(
            await openWrappedLocalState({
              wrappingKey,
              domain: "awsm.local.client-secret",
              vaultId,
              identity: directory.selectedClientCredentialId,
              wrappedBytes: await this.requireBytes({
                namespace: NAMESPACES.clientSecret.key,
                scopeKey: vaultKey,
                itemKey: identifierStorageKey(directory.selectedClientCredentialId),
              }),
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
    if (baselineVaultLabel(baseline) !== directory.label) {
      throw new TypeError("Vault Directory label does not match authoritative state");
    }
    const openedVault: PersistedOpenedCanonicalVault = {
      directory,
      replicaState,
      clientSecret,
      epochSecret,
      baseline,
      genesis,
      installationWrappingKey: wrappingKey,
      replicaStateStorageBytes: replicaWrapped,
    };
    const resolvedKeyEnvelopes = new Map<
      string,
      { readonly id: Identifier<"KeyEnvelope">; readonly bytes: Uint8Array }
    >();
    await validateCurrentVaultAuthority({
      baseline,
      genesis,
      continuityEvents,
      replicaState,
      clientSecret,
      epochSecret,
      dependencyResolver: {
        resolveKeyEnvelope: async ({ keyEnvelopeId, keyEpochId }) => {
          const cacheKey = identifierStorageKey(keyEnvelopeId);
          const cached = resolvedKeyEnvelopes.get(cacheKey);
          if (cached !== undefined) return cached.bytes;
          const envelopeBytes = await this.readResolvedOpaqueItem({
            vault: openedVault,
            kind: 2,
            logicalId: keyEnvelopeId,
            expectedKeyEpochId: keyEpochId,
            namespace: NAMESPACES.keyEnvelope.key,
          });
          resolvedKeyEnvelopes.set(cacheKey, { id: keyEnvelopeId, bytes: envelopeBytes });
          return envelopeBytes;
        },
        resolveFeatureManifest: async ({ featureManifestId }) =>
          (
            await this.openResolvedCompactItem({
              vault: openedVault,
              kind: 4,
              logicalId: featureManifestId,
              namespace: NAMESPACES.featureManifest.key,
              payloadType: 3,
            })
          ).payloadBytes,
      },
    });

    let openedClientEnvelope = 0;
    for (const { id: keyEnvelopeId, bytes: envelopeBytes } of resolvedKeyEnvelopes.values()) {
      if (clientSecret === null) continue;
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
    if (clientSecret !== null && openedClientEnvelope !== 1) {
      throw new TypeError("Exactly one current Key Envelope must open for the selected Client");
    }
    return openedVault;
  }

  async listEpochSecrets(
    vault: PersistedOpenedCanonicalVault,
  ): Promise<readonly EpochSecretState[]> {
    const vaultKey = identifierStorageKey(vault.replicaState.vaultId);
    const items = await this.storage.listBytes(this.realm, NAMESPACES.epochSecret.key, vaultKey);
    const secrets: EpochSecretState[] = [];
    try {
      for (const item of items) {
        const epochId = identifierFromStorageKey("KeyEpoch", item.itemKey);
        secrets.push(await this.decodeEpochSecret(vault, epochId, item.bytes));
      }
      return secrets;
    } catch (error) {
      await Promise.all(secrets.map(({ key }) => wipe(key)));
      throw error;
    }
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
    const usesOpenedEpoch = bytesEqual(resolution.keyEpochId, input.vault.epochSecret.keyEpochId);
    const epochSecret = usesOpenedEpoch
      ? input.vault.epochSecret
      : await this.readEpochSecret(input.vault, resolution.keyEpochId);
    try {
      const opened = await openCompactItem({
        vaultId: input.vault.replicaState.vaultId,
        keyEpochId: epochSecret.keyEpochId,
        keyEpochKey: epochSecret.key,
        envelopeBytes,
      });
      if (opened.payloadType !== input.payloadType) {
        throw new TypeError("Compact item payload type does not match its logical namespace");
      }
      return opened;
    } finally {
      if (!usesOpenedEpoch) await wipe(epochSecret.key);
    }
  }

  async readResolvedOpaqueItem(input: {
    readonly vault: PersistedOpenedCanonicalVault;
    readonly kind: 2;
    readonly logicalId: Identifier<"KeyEnvelope">;
    readonly expectedKeyEpochId: Identifier<"KeyEpoch">;
    readonly namespace: typeof NAMESPACES.keyEnvelope.key;
  }): Promise<Uint8Array> {
    const resolution = await this.readLogicalResolution(input);
    if (resolution.availability !== 1) {
      throw new TypeError("The required opaque item is not verified locally");
    }
    sameBytes(resolution.keyEpochId, input.expectedKeyEpochId, "Resolution Key Epoch ID");
    const envelopeBytes = await this.requireBytes({
      namespace: input.namespace,
      scopeKey: identifierStorageKey(input.vault.replicaState.vaultId),
      itemKey: identifierStorageKey(input.logicalId),
    });
    sameBytes(
      resolution.storageItemId,
      decodeOpaqueEnvelope(envelopeBytes).storageItemId,
      "Resolution Storage Item ID",
    );
    return envelopeBytes;
  }

  private async persistPendingVaultCreation(input: {
    readonly setupId: string;
    readonly expectedVaultId: Identifier<"Vault"> | null;
    readonly label: string | null;
    readonly assertedAt: number | bigint;
    readonly prepared: PreparedCanonicalVaultCreation;
  }): Promise<PersistedPendingVaultCreation> {
    const plaintext = encodeCanonicalPendingVaultCreation({
      setupId: input.setupId,
      expectedVaultId: input.expectedVaultId,
      label: input.label,
      assertedAt: input.assertedAt,
      ids: input.prepared.ids,
      clientSigningSeed: input.prepared.secrets.client.signingSeed,
      clientWrappingPrivateKey: input.prepared.secrets.client.wrappingPrivateKey,
      keyEpochKey: input.prepared.secrets.keyEpoch.key,
      recoveryEnvelopeBytes: input.prepared.recoveryKeyEnvelope.envelope.bytes,
      clientEnvelopeBytes: input.prepared.clientKeyEnvelope.envelope.bytes,
      baselineProtectionParameters: input.prepared.baselineEnvelope.protectionParameters,
      genesisProtectionParameters: input.prepared.genesisEnvelope.protectionParameters,
    });
    try {
      const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
      const key = pendingVaultCreationItem(input.setupId);
      const wrapped = await wrapInstallationBytes({
        wrappingKey,
        domain: "awsm.local.pending-vault-creation",
        context: pendingVaultCreationContext(input.setupId),
        bytes: plaintext,
      });
      const item = { ...key, bytes: wrapped };
      await this.storage.commitExecutionMutation({
        realm: this.realm,
        expectedAbsentItems: [key],
        mutableItems: [item],
      });
      return { item: { ...key, bytes: Uint8Array.from(wrapped) } };
    } finally {
      await wipe(plaintext);
    }
  }

  private async readPendingVaultCreation(setupId: string): Promise<{
    readonly pending: CanonicalPendingVaultCreation;
    readonly persisted: PersistedPendingVaultCreation;
  }> {
    const key = pendingVaultCreationItem(setupId);
    const wrapped = await this.storage.getBytes(this.realm, key);
    if (wrapped === undefined) throw creationNotFound();
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const plaintext = await unwrapInstallationBytes({
      wrappingKey,
      domain: "awsm.local.pending-vault-creation",
      context: pendingVaultCreationContext(setupId),
      wrappedBytes: wrapped,
    });
    let pending: CanonicalPendingVaultCreation | undefined;
    try {
      pending = decodeCanonicalPendingVaultCreation(plaintext);
      if (pending.setupId !== setupId) {
        throw new TypeError(
          "Pending Vault creation setup identity does not match storage identity",
        );
      }
      return {
        pending,
        persisted: { item: { ...key, bytes: Uint8Array.from(wrapped) } },
      };
    } catch (error) {
      if (pending !== undefined) await wipePendingVaultCreation(pending);
      throw error;
    } finally {
      await wipe(plaintext);
    }
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

  private async readEpochSecret(
    vault: PersistedOpenedCanonicalVault,
    epochId: Identifier<"KeyEpoch">,
  ): Promise<EpochSecretState> {
    return this.decodeEpochSecret(
      vault,
      epochId,
      await this.requireBytes({
        namespace: NAMESPACES.epochSecret.key,
        scopeKey: identifierStorageKey(vault.replicaState.vaultId),
        itemKey: identifierStorageKey(epochId),
      }),
    );
  }

  private async decodeEpochSecret(
    vault: PersistedOpenedCanonicalVault,
    epochId: Identifier<"KeyEpoch">,
    wrappedBytes: Uint8Array,
  ): Promise<EpochSecretState> {
    const plaintext = await openWrappedLocalState({
      wrappingKey: vault.installationWrappingKey,
      domain: "awsm.local.epoch-secret",
      vaultId: vault.replicaState.vaultId,
      identity: epochId,
      wrappedBytes,
    });
    try {
      const decoded = decodeEpochSecretState(plaintext);
      sameBytes(decoded.vaultId, vault.replicaState.vaultId, "Epoch Secret Vault ID");
      sameBytes(decoded.keyEpochId, epochId, "Epoch Secret storage identity");
      return { ...decoded, key: Uint8Array.from(decoded.key) };
    } finally {
      await wipe(plaintext);
    }
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

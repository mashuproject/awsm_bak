import { sha256 } from "@noble/hashes/sha2.js";

import { openKeyEnvelope } from "../../crypto/key-envelope";
import { wipe } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  type CanonicalIndexedDb,
  type InitialVaultCommit,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import {
  NAMESPACES,
  type NamespaceKey,
  type StorageRealm,
} from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import type {
  CanonicalArtifactImportStore,
  PreparedOpaqueArtifactRepresentation,
} from "../artifact/canonical-store";
import type {
  CompleteExportKeyInventory,
  CompleteExportManifest,
  CompleteExportOpaqueItem,
} from "../complete-export/contracts";
import { CanonicalReplayService } from "../projection/canonical-replay";
import {
  type CanonicalReplicaState,
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  encodeEpochSecretState,
  encodeInstallationSelection,
  encodeLogicalResolution,
  encodeVaultDirectoryEntry,
  type LogicalResolution,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import {
  CanonicalVaultService,
  type PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";
import {
  buildCompleteImportHistoryView,
  classifyCompleteImportCollision,
  type SameGenerationCompleteImportCollision,
} from "./collision";
import {
  type CompleteImportPreparedSource,
  readCompleteImportCompactBytes,
  validateCompleteExportSemantics,
} from "./semantic";

export interface ActivatedCompleteImport {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
}

export interface ReconciledCompleteImport {
  readonly relation: SameGenerationCompleteImportCollision;
  readonly changed: boolean;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

async function readVerifiedIncomingCompact(
  source: CompleteImportPreparedSource,
  item: CompleteExportOpaqueItem,
  field: string,
): Promise<Uint8Array> {
  const bytes = await readCompleteImportCompactBytes(source, item);
  same(sha256(bytes), item.byteDigest, `${field} byte digest`);
  same(decodeOpaqueEnvelope(bytes).storageItemId, item.storageItemId, `${field} Storage Item ID`);
  return bytes;
}

function compactNamespace(item: CompleteExportOpaqueItem): NamespaceKey {
  switch (item.namespace) {
    case 1:
      return NAMESPACES.vaultRecord.key;
    case 2:
      return NAMESPACES.keyEnvelope.key;
    case 3:
      return NAMESPACES.vaultObject.key;
    case 4:
      return NAMESPACES.featureManifest.key;
    case 5:
      throw new TypeError("Artifact wrapper activation requires streamed promotion");
  }
}

async function prepareCompactItems(input: {
  readonly source: CompleteImportPreparedSource;
  readonly inventory: readonly CompleteExportOpaqueItem[];
  readonly vaultKey: string;
}): Promise<readonly NamespaceBytes[]> {
  const items: NamespaceBytes[] = [];
  for (const item of input.inventory) {
    if (item.namespace === 5) continue;
    const bytes = await readVerifiedIncomingCompact(
      input.source,
      item,
      "Complete Import activation",
    );
    items.push({
      namespace: compactNamespace(item),
      scopeKey: input.vaultKey,
      itemKey: identifierStorageKey(item.logicalId as Identifier<"VaultRecord">),
      bytes,
    });
  }
  return items;
}

async function prepareKnownCompactItems(input: {
  readonly storage: CanonicalIndexedDb;
  readonly realm: StorageRealm;
  readonly vaults: CanonicalVaultService;
  readonly vault: PersistedOpenedCanonicalVault;
  readonly source: CompleteImportPreparedSource;
  readonly inventory: readonly CompleteExportOpaqueItem[];
  readonly vaultKey: string;
}): Promise<{
  readonly immutableItems: readonly NamespaceBytes[];
  readonly resolutions: readonly LogicalResolution[];
}> {
  const immutableItems: NamespaceBytes[] = [];
  const resolutions: LogicalResolution[] = [];
  for (const item of input.inventory) {
    if (item.namespace === 5) continue;
    const namespace = compactNamespace(item);
    const itemKey = identifierStorageKey(item.logicalId as Identifier<"VaultRecord">);
    const existing = await input.storage.getBytes(input.realm, {
      namespace,
      scopeKey: input.vaultKey,
      itemKey,
    });
    if (existing !== undefined) {
      const resolution = await input.vaults.readLogicalResolution({
        vault: input.vault,
        kind: item.namespace,
        logicalId: item.logicalId,
      });
      if (resolution.availability !== 1) {
        throw new TypeError("Existing Complete Import item is not verified locally");
      }
      same(
        decodeOpaqueEnvelope(existing).storageItemId,
        resolution.storageItemId,
        "Existing Complete Import Storage Item ID",
      );
      continue;
    }
    const bytes = await readVerifiedIncomingCompact(
      input.source,
      item,
      "Complete Import reconciliation",
    );
    immutableItems.push({ namespace, scopeKey: input.vaultKey, itemKey, bytes });
    resolutions.push({
      vaultId: input.vault.replicaState.vaultId,
      kind: item.namespace,
      logicalId: item.logicalId,
      storageItemId: item.storageItemId,
      keyEpochId: item.keyEpochId,
      availability: 1,
    });
  }
  return { immutableItems, resolutions };
}

function retainedAuthoringState(input: {
  readonly local: PersistedOpenedCanonicalVault;
  readonly activeClientCredentials: readonly {
    readonly clientCredentialId: Identifier<"ClientCredential">;
    readonly memberId: Identifier<"Member">;
  }[];
}): Pick<CanonicalReplicaState, "authoringClientCredentialId" | "memberId"> & {
  readonly selectedClientCredentialId: Identifier<"ClientCredential"> | null;
} {
  const authoringId = input.local.replicaState.authoringClientCredentialId;
  const memberId = input.local.replicaState.memberId;
  const selectedId = input.local.directory.selectedClientCredentialId;
  const clientSecret = input.local.clientSecret;
  if (
    authoringId === null ||
    memberId === null ||
    selectedId === null ||
    clientSecret === null ||
    !bytesEqual(authoringId, selectedId) ||
    !bytesEqual(authoringId, clientSecret.clientCredentialId) ||
    !bytesEqual(memberId, clientSecret.memberId) ||
    !input.activeClientCredentials.some(
      (credential) =>
        bytesEqual(credential.clientCredentialId, authoringId) &&
        bytesEqual(credential.memberId, memberId),
    )
  ) {
    return {
      authoringClientCredentialId: null,
      memberId: null,
      selectedClientCredentialId: null,
    };
  }
  return {
    authoringClientCredentialId: authoringId,
    memberId,
    selectedClientCredentialId: selectedId,
  };
}

async function verifyRetainedClientKeyDelivery(input: {
  readonly local: PersistedOpenedCanonicalVault;
  readonly authoringClientCredentialId: Identifier<"ClientCredential"> | null;
  readonly validated: Awaited<ReturnType<typeof validateCompleteExportSemantics>>;
  readonly source: CompleteImportPreparedSource;
}): Promise<void> {
  if (input.authoringClientCredentialId === null) return;
  const authoringClientCredentialId = input.authoringClientCredentialId;
  const clientSecret = input.local.clientSecret;
  if (clientSecret === null) {
    throw new TypeError("Retained Complete Import authoring has no local Client Secret");
  }
  for (const epoch of input.validated.keyInventory.entries) {
    const slots = input.validated.keyEnvelopeSlots.filter(
      (slot) =>
        slot.targetKind === 2 &&
        bytesEqual(slot.targetCredentialId, authoringClientCredentialId) &&
        bytesEqual(slot.keyEpochId, epoch.keyEpochId),
    );
    if (slots.length !== 1) {
      throw new TypeError("Retained Complete Import Client has no exact Key Envelope slot");
    }
    const slot = slots[0];
    const item = input.validated.manifest.opaqueItemInventory.find(
      (candidate) =>
        candidate.namespace === 2 &&
        slot !== undefined &&
        bytesEqual(candidate.logicalId, slot.keyEnvelopeId),
    );
    if (slot === undefined || item === undefined) {
      throw new TypeError("Retained Complete Import Client Key Envelope is unavailable");
    }
    const envelopeBytes = await readVerifiedIncomingCompact(
      input.source,
      item,
      "Retained Complete Import Client Key Envelope",
    );
    const opened = await openKeyEnvelope({
      targetKind: 2,
      recipientWrappingPrivateKey: clientSecret.wrappingPrivateKey,
      envelopeBytes,
    });
    try {
      same(opened.id, slot.keyEnvelopeId, "Retained Client Key Envelope ID");
      same(
        opened.targetCredentialId,
        authoringClientCredentialId,
        "Retained Client Key Envelope target",
      );
      same(opened.keyEpochId, epoch.keyEpochId, "Retained Client Key Envelope Epoch");
      same(opened.keyEpochKey, epoch.keyEpochKey, "Retained Client Key Envelope Key");
    } finally {
      await wipe(opened.keyEpochKey);
      await wipe(opened.bytes);
    }
  }
}

export class CanonicalCompleteImportService {
  constructor(
    readonly storage: CanonicalIndexedDb,
    readonly realm: StorageRealm,
    readonly artifacts: CanonicalArtifactImportStore,
  ) {}

  async classifyKnown(input: {
    readonly manifest: CompleteExportManifest;
    readonly keyInventory: CompleteExportKeyInventory;
    readonly source: CompleteImportPreparedSource;
  }): Promise<SameGenerationCompleteImportCollision> {
    const validated = await validateCompleteExportSemantics(input);
    try {
      const replay = await new CanonicalReplayService(
        new CanonicalVaultService(this.storage, this.realm),
      ).replay(validated.manifest.vaultId);
      return classifyCompleteImportCollision({
        local: buildCompleteImportHistoryView({
          state: replay.vault.replicaState,
          genesisId: replay.vault.genesis.recordId,
          events: replay.events,
        }),
        incoming: buildCompleteImportHistoryView({
          state: validated.replicaState,
          genesisId: validated.genesis.recordId,
          events: validated.events,
        }),
      });
    } finally {
      for (const entry of validated.keyInventory.entries) await wipe(entry.keyEpochKey);
    }
  }

  async reconcileKnown(input: {
    readonly manifest: CompleteExportManifest;
    readonly keyInventory: CompleteExportKeyInventory;
    readonly source: CompleteImportPreparedSource;
  }): Promise<ReconciledCompleteImport> {
    const validated = await validateCompleteExportSemantics(input);
    const preparedArtifacts: PreparedOpaqueArtifactRepresentation[] = [];
    let committed = false;
    try {
      const vaults = new CanonicalVaultService(this.storage, this.realm);
      const replay = await new CanonicalReplayService(vaults).replay(validated.manifest.vaultId);
      const relation = classifyCompleteImportCollision({
        local: buildCompleteImportHistoryView({
          state: replay.vault.replicaState,
          genesisId: replay.vault.genesis.recordId,
          events: replay.events,
        }),
        incoming: buildCompleteImportHistoryView({
          state: validated.replicaState,
          genesisId: validated.genesis.recordId,
          events: validated.events,
        }),
      });
      if (relation !== "incoming-fast-forward") return { relation, changed: false };
      for (const item of validated.manifest.opaqueItemInventory) {
        if (item.namespace !== 5) continue;
        preparedArtifacts.push(
          await this.artifacts.prepareOpaque({
            artifactId: item.logicalId as Identifier<"Artifact">,
            storageItemId: item.storageItemId,
            envelopeByteLength: item.byteLength,
            source: await input.source.openOpaque(item),
          }),
        );
      }
      const vaultKey = identifierStorageKey(validated.manifest.vaultId);
      const wrappingKey = replay.vault.installationWrappingKey;
      const compact = await prepareKnownCompactItems({
        storage: this.storage,
        realm: this.realm,
        vaults,
        vault: replay.vault,
        source: input.source,
        inventory: validated.manifest.opaqueItemInventory,
        vaultKey,
      });
      const artifactResolutions: LogicalResolution[] = validated.manifest.opaqueItemInventory
        .filter(({ namespace }) => namespace === 5)
        .map((item) => ({
          vaultId: validated.manifest.vaultId,
          kind: 5,
          logicalId: item.logicalId,
          storageItemId: item.storageItemId,
          keyEpochId: item.keyEpochId,
          availability: 1,
        }));
      const authoring = retainedAuthoringState({
        local: replay.vault,
        activeClientCredentials: validated.activeClientCredentials,
      });
      await verifyRetainedClientKeyDelivery({
        local: replay.vault,
        authoringClientCredentialId: authoring.authoringClientCredentialId,
        validated,
        source: input.source,
      });
      const nextState: CanonicalReplicaState = {
        ...validated.replicaState,
        authoringClientCredentialId: authoring.authoringClientCredentialId,
        memberId: authoring.memberId,
        preservationRoots: replay.vault.replicaState.preservationRoots,
        garbageCollectionFences: replay.vault.replicaState.garbageCollectionFences,
      };
      const nextReplicaState = await prepareWrappedLocalStateItem({
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultKey,
        itemKey: "current",
        wrappingKey,
        domain: "awsm.local.replica-state",
        context: canonicalLocalStorageContext(nextState.vaultId, nextState.generationId),
        bytes: encodeCanonicalReplicaState(nextState),
      });
      const resolutionItems = await Promise.all(
        [...compact.resolutions, ...artifactResolutions].map((resolution) =>
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.logicalResolution.key,
            scopeKey: vaultKey,
            itemKey: `${resolution.kind}:${identifierStorageKey(
              resolution.logicalId as Identifier<"VaultRecord">,
            )}`,
            wrappingKey,
            domain: "awsm.local.logical-resolution",
            context: canonicalLocalStorageContext(nextState.vaultId, resolution.logicalId),
            bytes: encodeLogicalResolution(resolution),
          }),
        ),
      );
      const directory = await prepareWrappedLocalStateItem({
        namespace: NAMESPACES.vaultDirectory.key,
        scopeKey: "installation",
        itemKey: vaultKey,
        wrappingKey,
        domain: "awsm.local.vault-directory",
        context: canonicalLocalStorageContext(nextState.vaultId, nextState.vaultId),
        bytes: encodeVaultDirectoryEntry({
          vaultId: nextState.vaultId,
          generationId: nextState.generationId,
          label: validated.vaultLabel,
          selectedClientCredentialId: authoring.selectedClientCredentialId,
        }),
      });
      const epochItems: NamespaceBytes[] = [];
      for (const entry of validated.keyInventory.entries) {
        const authorityEpoch = validated.keyEpochs.find(({ keyEpochId }) =>
          bytesEqual(keyEpochId, entry.keyEpochId),
        );
        if (authorityEpoch === undefined) {
          throw new TypeError("Complete Import Epoch is not authenticated by Authority State");
        }
        const encoded = encodeEpochSecretState({
          vaultId: nextState.vaultId,
          keyEpochId: entry.keyEpochId,
          displayNumber: authorityEpoch.displayNumber,
          key: entry.keyEpochKey,
        });
        try {
          epochItems.push(
            await prepareWrappedLocalStateItem({
              namespace: NAMESPACES.epochSecret.key,
              scopeKey: vaultKey,
              itemKey: identifierStorageKey(entry.keyEpochId),
              wrappingKey,
              domain: "awsm.local.epoch-secret",
              context: canonicalLocalStorageContext(nextState.vaultId, entry.keyEpochId),
              bytes: encoded,
            }),
          );
        } finally {
          await wipe(encoded);
        }
      }
      for (const prepared of preparedArtifacts) await prepared.promote();
      await this.storage.commitReplicaMutation({
        realm: this.realm,
        expectedReplicaState: replay.vault.replicaStateStorageBytes,
        nextReplicaState,
        immutableItems: compact.immutableItems,
        mutableItems: [...resolutionItems, directory, ...epochItems],
      });
      committed = true;
      return { relation, changed: true };
    } finally {
      for (const entry of validated.keyInventory.entries) await wipe(entry.keyEpochKey);
      if (!committed) {
        await Promise.all(preparedArtifacts.map((prepared) => prepared.discard())).catch(
          () => undefined,
        );
      }
    }
  }

  async activateUnknown(input: {
    readonly manifest: CompleteExportManifest;
    readonly keyInventory: CompleteExportKeyInventory;
    readonly source: CompleteImportPreparedSource;
  }): Promise<ActivatedCompleteImport> {
    const validated = await validateCompleteExportSemantics(input);
    const vaultId = validated.manifest.vaultId;
    const generationId = validated.manifest.generationId;
    const vaultKey = identifierStorageKey(vaultId);
    const preparedArtifacts: PreparedOpaqueArtifactRepresentation[] = [];
    let activated = false;
    try {
      for (const item of validated.manifest.opaqueItemInventory) {
        if (item.namespace !== 5) continue;
        preparedArtifacts.push(
          await this.artifacts.prepareOpaque({
            artifactId: item.logicalId as Identifier<"Artifact">,
            storageItemId: item.storageItemId,
            envelopeByteLength: item.byteLength,
            source: await input.source.openOpaque(item),
          }),
        );
      }
      const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
      const immutableItems = await prepareCompactItems({
        source: input.source,
        inventory: validated.manifest.opaqueItemInventory,
        vaultKey,
      });
      const resolutions: LogicalResolution[] = validated.manifest.opaqueItemInventory.map(
        (item) => ({
          vaultId,
          kind: item.namespace,
          logicalId: item.logicalId,
          storageItemId: item.storageItemId,
          keyEpochId: item.keyEpochId,
          availability: 1,
        }),
      );
      const replicaState = await prepareWrappedLocalStateItem({
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultKey,
        itemKey: "current",
        wrappingKey,
        domain: "awsm.local.replica-state",
        context: canonicalLocalStorageContext(vaultId, generationId),
        bytes: encodeCanonicalReplicaState(validated.replicaState),
      });
      const replicaSafetyItems = await Promise.all(
        resolutions.map((resolution) =>
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.logicalResolution.key,
            scopeKey: vaultKey,
            itemKey: `${resolution.kind}:${identifierStorageKey(
              resolution.logicalId as Identifier<"VaultRecord">,
            )}`,
            wrappingKey,
            domain: "awsm.local.logical-resolution",
            context: canonicalLocalStorageContext(vaultId, resolution.logicalId),
            bytes: encodeLogicalResolution(resolution),
          }),
        ),
      );
      const vaultDirectoryEntry = await prepareWrappedLocalStateItem({
        namespace: NAMESPACES.vaultDirectory.key,
        scopeKey: "installation",
        itemKey: vaultKey,
        wrappingKey,
        domain: "awsm.local.vault-directory",
        context: canonicalLocalStorageContext(vaultId, vaultId),
        bytes: encodeVaultDirectoryEntry({
          vaultId,
          generationId,
          label: validated.vaultLabel,
          selectedClientCredentialId: null,
        }),
      });
      const trustedSecrets: NamespaceBytes[] = [];
      for (const entry of validated.keyInventory.entries) {
        const authorityEpoch = validated.keyEpochs.find(({ keyEpochId }) =>
          bytesEqual(keyEpochId, entry.keyEpochId),
        );
        if (authorityEpoch === undefined) {
          throw new TypeError("Complete Import Epoch is not authenticated by Authority State");
        }
        const encoded = encodeEpochSecretState({
          vaultId,
          keyEpochId: entry.keyEpochId,
          displayNumber: authorityEpoch.displayNumber,
          key: entry.keyEpochKey,
        });
        try {
          trustedSecrets.push(
            await prepareWrappedLocalStateItem({
              namespace: NAMESPACES.epochSecret.key,
              scopeKey: vaultKey,
              itemKey: identifierStorageKey(entry.keyEpochId),
              wrappingKey,
              domain: "awsm.local.epoch-secret",
              context: canonicalLocalStorageContext(vaultId, entry.keyEpochId),
              bytes: encoded,
            }),
          );
        } finally {
          await wipe(encoded);
        }
      }
      const commit: InitialVaultCommit = {
        realm: this.realm,
        vaultKey,
        immutableItems,
        replicaState,
        replicaSafetyItems,
        vaultDirectoryEntry,
        installationStateItems: [
          {
            namespace: NAMESPACES.installationSelection.key,
            scopeKey: "installation",
            itemKey: "current",
            bytes: encodeInstallationSelection({ vaultId }),
          },
        ],
        trustedSecrets,
      };
      for (const prepared of preparedArtifacts) await prepared.promote();
      await this.storage.commitInitialVault(commit);
      activated = true;
      return { vaultId, generationId };
    } finally {
      for (const entry of validated.keyInventory.entries) await wipe(entry.keyEpochKey);
      if (!activated) {
        await Promise.all(preparedArtifacts.map((prepared) => prepared.discard())).catch(
          () => undefined,
        );
      }
    }
  }
}

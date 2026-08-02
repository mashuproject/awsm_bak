import { sha256 } from "@noble/hashes/sha2.js";

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
import {
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
  type CompleteImportPreparedSource,
  readCompleteImportCompactBytes,
  validateCompleteExportSemantics,
} from "./semantic";

export interface ActivatedCompleteImport {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
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
    const bytes = await readCompleteImportCompactBytes(input.source, item);
    same(sha256(bytes), item.byteDigest, "Complete Import activation byte digest");
    same(
      decodeOpaqueEnvelope(bytes).storageItemId,
      item.storageItemId,
      "Complete Import activation Storage Item ID",
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

export class CanonicalCompleteImportService {
  constructor(
    readonly storage: CanonicalIndexedDb,
    readonly realm: StorageRealm,
    readonly artifacts: CanonicalArtifactImportStore,
  ) {}

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

import { unwrapInstallationBytes, wrapInstallationBytes } from "../../crypto/installation-wrap";
import { readySodium } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import { keyEpochId } from "../../domain/canonical/identifiers";
import {
  arrayValue,
  exactCode,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nonnegativeInteger,
  nullable,
  oneOfCodes,
  textValue,
} from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import {
  type InitialVaultCommit,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import type { PreparedCanonicalVaultCreation } from "./canonical-create";

export const LOCAL_STATE_FORMAT = 1 as const;
export type LogicalResolutionKind = 1 | 2 | 3 | 4 | 5;
export type LocalAvailability = 1 | 2 | 3 | 4;

export interface CanonicalVacuumAdoption {
  readonly vacuumEventRecordId: Identifier<"VaultRecord">;
}

export interface CanonicalGarbageCollectionFence {
  readonly artifactId: Identifier<"Artifact">;
  readonly storageItemId: Identifier<"StorageItem">;
}

export interface CanonicalReplicaState {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly causalFrontier: readonly Identifier<"VaultRecord">[];
  readonly authorityFrontier: readonly Identifier<"VaultRecord">[];
  readonly continuityRecordIds: readonly Identifier<"VaultRecord">[];
  readonly baselineId: Identifier<"VaultRecord">;
  readonly currentKeyEpochId: Identifier<"KeyEpoch">;
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly authoringClientCredentialId: Identifier<"ClientCredential"> | null;
  readonly memberId: Identifier<"Member"> | null;
  readonly lifecycle: 1 | 2;
  readonly preservationRoots: readonly Identifier<"VaultRecord">[];
  readonly garbageCollectionFences: readonly CanonicalGarbageCollectionFence[];
  readonly adoption: CanonicalVacuumAdoption | null;
}

export interface LogicalResolution {
  readonly vaultId: Identifier<"Vault">;
  readonly kind: LogicalResolutionKind;
  readonly logicalId: Uint8Array;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly availability: LocalAvailability;
}

export interface VaultDirectoryEntry {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly label: string | null;
  readonly selectedClientCredentialId: Identifier<"ClientCredential"> | null;
}

export interface InstallationSelection {
  readonly vaultId: Identifier<"Vault">;
}

export interface ClientSecretState {
  readonly vaultId: Identifier<"Vault">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly signingPublicKey: Uint8Array;
  readonly signingSecretKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
  readonly wrappingPrivateKey: Uint8Array;
}

export interface EpochSecretState {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly displayNumber: number;
  readonly key: Uint8Array;
}

export interface PreparedCanonicalVaultStorage {
  readonly commit: InitialVaultCommit;
  readonly replicaState: CanonicalReplicaState;
  readonly logicalResolutions: readonly LogicalResolution[];
}

function exactBytes(value: CanonicalValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new TypeError(`${field} must contain exactly ${length} bytes`);
  }
  return Uint8Array.from(value);
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

export function encodeCanonicalReplicaState(state: CanonicalReplicaState): Uint8Array {
  return encodeCanonicalValue(
    indexedMap(
      LOCAL_STATE_FORMAT,
      state.vaultId,
      state.generationId,
      canonicalSet(state.causalFrontier),
      canonicalSet(state.authorityFrontier),
      canonicalSet(state.continuityRecordIds),
      state.baselineId,
      state.currentKeyEpochId,
      state.requiredFeatureSetId,
      state.authoringClientCredentialId,
      state.memberId,
      state.lifecycle,
      canonicalSet(state.preservationRoots),
      garbageCollectionFenceValues(state.garbageCollectionFences),
      state.adoption === null ? null : indexedMap(1, state.adoption.vacuumEventRecordId),
    ),
  );
}

export function decodeCanonicalReplicaState(bytes: Uint8Array): CanonicalReplicaState {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [...Array(15).keys()],
    "Canonical Replica State",
  );
  exactCode(mapValue(map, 0), LOCAL_STATE_FORMAT, "Replica State format");
  const state: CanonicalReplicaState = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Replica State Vault ID"),
    generationId: identifierValue(mapValue(map, 2), "Generation", "Replica State Generation ID"),
    causalFrontier: idSetValue(mapValue(map, 3), "VaultRecord", "Causal Frontier", {
      nonempty: true,
    }),
    authorityFrontier: idSetValue(mapValue(map, 4), "VaultRecord", "Authority Frontier", {
      nonempty: true,
    }),
    continuityRecordIds: idSetValue(mapValue(map, 5), "VaultRecord", "Continuity Record IDs", {
      nonempty: true,
    }),
    baselineId: identifierValue(mapValue(map, 6), "VaultRecord", "Active Baseline ID"),
    currentKeyEpochId: identifierValue(mapValue(map, 7), "KeyEpoch", "Current Key Epoch ID"),
    requiredFeatureSetId: identifierValue(
      mapValue(map, 8),
      "RequiredFeatureSet",
      "Required Feature Set ID",
    ),
    authoringClientCredentialId: nullable(mapValue(map, 9), (value) =>
      identifierValue(value, "ClientCredential", "Authoring Client Credential ID"),
    ),
    memberId: nullable(mapValue(map, 10), (value) =>
      identifierValue(value, "Member", "Replica Member ID"),
    ),
    lifecycle: oneOfCodes(mapValue(map, 11), [1, 2] as const, "Replica lifecycle"),
    preservationRoots: idSetValue(mapValue(map, 12), "VaultRecord", "Local preservation roots"),
    garbageCollectionFences: decodeGarbageCollectionFences(mapValue(map, 13)),
    adoption: nullable(mapValue(map, 14), (value) => {
      const adoption = exactMap(value, [0, 1], "Vacuum Adoption");
      exactCode(mapValue(adoption, 0), 1, "Vacuum Adoption format");
      return {
        vacuumEventRecordId: identifierValue(
          mapValue(adoption, 1),
          "VaultRecord",
          "Vacuum Adoption Event Record ID",
        ),
      };
    }),
  };
  if (
    state.adoption !== null &&
    !state.continuityRecordIds.some((recordId) =>
      bytesEqual(recordId, state.adoption?.vacuumEventRecordId ?? new Uint8Array()),
    )
  ) {
    throw new TypeError("Vacuum Adoption is inconsistent with accepted Replica Safety State");
  }
  if (!bytesEqual(encodeCanonicalReplicaState(state), bytes)) {
    throw new TypeError("Canonical Replica State bytes are not canonical");
  }
  return state;
}

function garbageCollectionFenceValue(
  fence: CanonicalGarbageCollectionFence,
): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, fence.artifactId],
    [1, fence.storageItemId],
  ]);
}

function garbageCollectionFenceValues(
  fences: readonly CanonicalGarbageCollectionFence[],
): readonly ReadonlyMap<number, CanonicalValue>[] {
  const artifactKeys = fences.map(({ artifactId }) => identifierStorageKey(artifactId));
  if (new Set(artifactKeys).size !== artifactKeys.length) {
    throw new TypeError("Garbage Collection fences contain a duplicate Artifact ID");
  }
  return canonicalSet(fences.map(garbageCollectionFenceValue));
}

function decodeGarbageCollectionFences(
  value: CanonicalValue,
): readonly CanonicalGarbageCollectionFence[] {
  const encoded = arrayValue(value, "Garbage Collection fences");
  const fences = encoded.map((entry, index) => {
    const fence = exactMap(entry, [0, 1], `Garbage Collection fence ${index}`);
    return {
      artifactId: identifierValue(
        mapValue(fence, 0),
        "Artifact",
        `Garbage Collection fence ${index} Artifact ID`,
      ),
      storageItemId: identifierValue(
        mapValue(fence, 1),
        "StorageItem",
        `Garbage Collection fence ${index} Storage Item ID`,
      ),
    };
  });
  if (
    !bytesEqual(
      encodeCanonicalValue(encoded),
      encodeCanonicalValue(garbageCollectionFenceValues(fences)),
    )
  ) {
    throw new TypeError("Garbage Collection fences must be a sorted duplicate-free canonical set");
  }
  return fences;
}

export function encodeLogicalResolution(value: LogicalResolution): Uint8Array {
  if (value.logicalId.byteLength !== 32) throw new TypeError("Logical ID must contain 32 bytes");
  return encodeCanonicalValue(
    indexedMap(
      LOCAL_STATE_FORMAT,
      value.vaultId,
      value.kind,
      value.logicalId,
      value.storageItemId,
      value.keyEpochId,
      value.availability,
    ),
  );
}

export function decodeLogicalResolution(bytes: Uint8Array): LogicalResolution {
  const map = exactMap(decodeCanonicalValue(bytes), [...Array(7).keys()], "Logical Resolution");
  exactCode(mapValue(map, 0), LOCAL_STATE_FORMAT, "Logical Resolution format");
  const resolution: LogicalResolution = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Resolution Vault ID"),
    kind: oneOfCodes(mapValue(map, 2), [1, 2, 3, 4, 5] as const, "Logical kind"),
    logicalId: exactBytes(mapValue(map, 3), 32, "Logical ID"),
    storageItemId: identifierValue(mapValue(map, 4), "StorageItem", "Storage Item ID"),
    keyEpochId: identifierValue(mapValue(map, 5), "KeyEpoch", "Resolution Key Epoch ID"),
    availability: oneOfCodes(mapValue(map, 6), [1, 2, 3, 4] as const, "Local availability"),
  };
  if (!bytesEqual(encodeLogicalResolution(resolution), bytes)) {
    throw new TypeError("Logical Resolution bytes are not canonical");
  }
  return resolution;
}

export function encodeVaultDirectoryEntry(value: VaultDirectoryEntry): Uint8Array {
  return encodeCanonicalValue(
    indexedMap(
      LOCAL_STATE_FORMAT,
      value.vaultId,
      value.generationId,
      value.label,
      value.selectedClientCredentialId,
    ),
  );
}

export function decodeVaultDirectoryEntry(bytes: Uint8Array): VaultDirectoryEntry {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4], "Vault Directory entry");
  exactCode(mapValue(map, 0), LOCAL_STATE_FORMAT, "Vault Directory format");
  const value: VaultDirectoryEntry = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Directory Vault ID"),
    generationId: identifierValue(mapValue(map, 2), "Generation", "Directory Generation ID"),
    label: nullable(mapValue(map, 3), (label) =>
      textValue(label, "Vault label", { maxUtf8Bytes: 1024 }),
    ),
    selectedClientCredentialId: nullable(mapValue(map, 4), (value) =>
      identifierValue(value, "ClientCredential", "Selected Client Credential ID"),
    ),
  };
  if (!bytesEqual(encodeVaultDirectoryEntry(value), bytes)) {
    throw new TypeError("Vault Directory bytes are not canonical");
  }
  return value;
}

export function encodeInstallationSelection(value: InstallationSelection): Uint8Array {
  return encodeCanonicalValue(indexedMap(LOCAL_STATE_FORMAT, value.vaultId));
}

export function decodeInstallationSelection(bytes: Uint8Array): InstallationSelection {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1], "Installation Selection");
  exactCode(mapValue(map, 0), LOCAL_STATE_FORMAT, "Installation Selection format");
  const value = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Selected Vault ID"),
  };
  if (!bytesEqual(encodeInstallationSelection(value), bytes)) {
    throw new TypeError("Installation Selection bytes are not canonical");
  }
  return value;
}

export function encodeClientSecretState(value: ClientSecretState): Uint8Array {
  return encodeCanonicalValue(
    indexedMap(
      LOCAL_STATE_FORMAT,
      value.vaultId,
      value.memberId,
      value.clientCredentialId,
      value.signingPublicKey,
      value.signingSecretKey,
      value.wrappingPublicKey,
      value.wrappingPrivateKey,
    ),
  );
}

export async function decodeClientSecretState(bytes: Uint8Array): Promise<ClientSecretState> {
  const map = exactMap(decodeCanonicalValue(bytes), [...Array(8).keys()], "Client Secret State");
  exactCode(mapValue(map, 0), LOCAL_STATE_FORMAT, "Client Secret format");
  const value: ClientSecretState = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Client Secret Vault ID"),
    memberId: identifierValue(mapValue(map, 2), "Member", "Client Secret Member ID"),
    clientCredentialId: identifierValue(
      mapValue(map, 3),
      "ClientCredential",
      "Client Secret Credential ID",
    ),
    signingPublicKey: exactBytes(mapValue(map, 4), 32, "Client signing public key"),
    signingSecretKey: exactBytes(mapValue(map, 5), 64, "Client signing secret key"),
    wrappingPublicKey: exactBytes(mapValue(map, 6), 32, "Client wrapping public key"),
    wrappingPrivateKey: exactBytes(mapValue(map, 7), 32, "Client wrapping private key"),
  };
  const sodium = await readySodium();
  if (
    !bytesEqual(
      sodium.crypto_sign_ed25519_sk_to_pk(value.signingSecretKey),
      value.signingPublicKey,
    ) ||
    !bytesEqual(sodium.crypto_scalarmult_base(value.wrappingPrivateKey), value.wrappingPublicKey)
  ) {
    throw new TypeError("Client Secret public and private keys do not match");
  }
  if (!bytesEqual(encodeClientSecretState(value), bytes)) {
    throw new TypeError("Client Secret bytes are not canonical");
  }
  return value;
}

export function encodeEpochSecretState(value: EpochSecretState): Uint8Array {
  if (!Number.isSafeInteger(value.displayNumber) || value.displayNumber < 0) {
    throw new TypeError("Key Epoch display number must be nonnegative");
  }
  if (!bytesEqual(keyEpochId(value.vaultId, value.key), value.keyEpochId)) {
    throw new TypeError("Epoch Secret key does not match its Key Epoch ID");
  }
  return encodeCanonicalValue(
    indexedMap(LOCAL_STATE_FORMAT, value.vaultId, value.keyEpochId, value.displayNumber, value.key),
  );
}

export function decodeEpochSecretState(bytes: Uint8Array): EpochSecretState {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4], "Epoch Secret State");
  exactCode(mapValue(map, 0), LOCAL_STATE_FORMAT, "Epoch Secret format");
  const value: EpochSecretState = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Epoch Secret Vault ID"),
    keyEpochId: identifierValue(mapValue(map, 2), "KeyEpoch", "Epoch Secret Key Epoch ID"),
    displayNumber: nonnegativeInteger(mapValue(map, 3), "Key Epoch display number"),
    key: exactBytes(mapValue(map, 4), 32, "Key Epoch Key"),
  };
  if (!bytesEqual(keyEpochId(value.vaultId, value.key), value.keyEpochId)) {
    throw new TypeError("Epoch Secret key does not match its Key Epoch ID");
  }
  if (!bytesEqual(encodeEpochSecretState(value), bytes)) {
    throw new TypeError("Epoch Secret bytes are not canonical");
  }
  return value;
}

export function canonicalLocalStorageContext(
  vaultId: Identifier<"Vault">,
  identity: Uint8Array,
): Uint8Array {
  return transcript("awsm:local-storage-context:v1", [vaultId, identity]);
}

export async function prepareWrappedLocalStateItem(input: {
  readonly namespace: NamespaceBytes["namespace"];
  readonly scopeKey: string;
  readonly itemKey: string;
  readonly wrappingKey: CryptoKey;
  readonly domain: string;
  readonly context: Uint8Array;
  readonly bytes: Uint8Array;
}): Promise<NamespaceBytes> {
  return {
    namespace: input.namespace,
    scopeKey: input.scopeKey,
    itemKey: input.itemKey,
    bytes: await wrapInstallationBytes(input),
  };
}

export async function prepareCanonicalVaultStorage(input: {
  readonly creation: PreparedCanonicalVaultCreation;
  readonly label: string | null;
  readonly realm: StorageRealm;
  readonly wrappingKey: CryptoKey;
  readonly additionalImmutableItems?: readonly NamespaceBytes[];
  readonly additionalLogicalResolutions?: readonly LogicalResolution[];
}): Promise<PreparedCanonicalVaultStorage> {
  const { creation } = input;
  const { ids } = creation;
  const vaultKey = identifierStorageKey(ids.vaultId);
  const replicaState: CanonicalReplicaState = {
    vaultId: ids.vaultId,
    generationId: ids.generationId,
    causalFrontier: [creation.genesis.recordId],
    authorityFrontier: [creation.genesis.recordId],
    continuityRecordIds: [creation.genesis.recordId],
    baselineId: creation.baseline.recordId,
    currentKeyEpochId: creation.secrets.keyEpoch.id,
    requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
    authoringClientCredentialId: ids.clientCredentialId,
    memberId: ids.firstMemberId,
    lifecycle: 1,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
  const logicalResolutions: LogicalResolution[] = [
    {
      vaultId: ids.vaultId,
      kind: 1,
      logicalId: creation.baseline.recordId,
      storageItemId: creation.baselineEnvelope.storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1,
    },
    {
      vaultId: ids.vaultId,
      kind: 1,
      logicalId: creation.genesis.recordId,
      storageItemId: creation.genesisEnvelope.storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1,
    },
    {
      vaultId: ids.vaultId,
      kind: 2,
      logicalId: creation.recoveryKeyEnvelope.id,
      storageItemId: creation.recoveryKeyEnvelope.envelope.storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1,
    },
    {
      vaultId: ids.vaultId,
      kind: 2,
      logicalId: creation.clientKeyEnvelope.id,
      storageItemId: creation.clientKeyEnvelope.envelope.storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1,
    },
    ...creation.featureManifests.map(({ id, envelope }) => ({
      vaultId: ids.vaultId,
      kind: 4 as const,
      logicalId: id,
      storageItemId: envelope.storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1 as const,
    })),
    ...(input.additionalLogicalResolutions ?? []),
  ];
  const replicaStateItem = await prepareWrappedLocalStateItem({
    namespace: NAMESPACES.replicaState.key,
    scopeKey: vaultKey,
    itemKey: "current",
    wrappingKey: input.wrappingKey,
    domain: "awsm.local.replica-state",
    context: canonicalLocalStorageContext(ids.vaultId, ids.generationId),
    bytes: encodeCanonicalReplicaState(replicaState),
  });
  const resolutionItems = await Promise.all(
    logicalResolutions.map((resolution) =>
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.logicalResolution.key,
        scopeKey: vaultKey,
        itemKey: `${resolution.kind}:${identifierStorageKey(
          resolution.logicalId as Identifier<"VaultRecord">,
        )}`,
        wrappingKey: input.wrappingKey,
        domain: "awsm.local.logical-resolution",
        context: canonicalLocalStorageContext(ids.vaultId, resolution.logicalId),
        bytes: encodeLogicalResolution(resolution),
      }),
    ),
  );
  const directoryItem = await prepareWrappedLocalStateItem({
    namespace: NAMESPACES.vaultDirectory.key,
    scopeKey: "installation",
    itemKey: vaultKey,
    wrappingKey: input.wrappingKey,
    domain: "awsm.local.vault-directory",
    context: canonicalLocalStorageContext(ids.vaultId, ids.vaultId),
    bytes: encodeVaultDirectoryEntry({
      vaultId: ids.vaultId,
      generationId: ids.generationId,
      label: input.label,
      selectedClientCredentialId: ids.clientCredentialId,
    }),
  });
  const clientSecretItem = await prepareWrappedLocalStateItem({
    namespace: NAMESPACES.clientSecret.key,
    scopeKey: vaultKey,
    itemKey: identifierStorageKey(ids.clientCredentialId),
    wrappingKey: input.wrappingKey,
    domain: "awsm.local.client-secret",
    context: canonicalLocalStorageContext(ids.vaultId, ids.clientCredentialId),
    bytes: encodeClientSecretState({
      vaultId: ids.vaultId,
      memberId: ids.firstMemberId,
      clientCredentialId: ids.clientCredentialId,
      signingPublicKey: creation.secrets.client.signingPublicKey,
      signingSecretKey: creation.secrets.client.signingSecretKey,
      wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
      wrappingPrivateKey: creation.secrets.client.wrappingPrivateKey,
    }),
  });
  const epochSecretItem = await prepareWrappedLocalStateItem({
    namespace: NAMESPACES.epochSecret.key,
    scopeKey: vaultKey,
    itemKey: identifierStorageKey(creation.secrets.keyEpoch.id),
    wrappingKey: input.wrappingKey,
    domain: "awsm.local.epoch-secret",
    context: canonicalLocalStorageContext(ids.vaultId, creation.secrets.keyEpoch.id),
    bytes: encodeEpochSecretState({
      vaultId: ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      displayNumber: 0,
      key: creation.secrets.keyEpoch.key,
    }),
  });

  return {
    replicaState,
    logicalResolutions,
    commit: {
      realm: input.realm,
      vaultKey,
      immutableItems: [
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(creation.baseline.recordId),
          bytes: creation.baselineEnvelope.bytes,
        },
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(creation.genesis.recordId),
          bytes: creation.genesisEnvelope.bytes,
        },
        {
          namespace: NAMESPACES.keyEnvelope.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(creation.recoveryKeyEnvelope.id),
          bytes: creation.recoveryKeyEnvelope.envelope.bytes,
        },
        {
          namespace: NAMESPACES.keyEnvelope.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(creation.clientKeyEnvelope.id),
          bytes: creation.clientKeyEnvelope.envelope.bytes,
        },
        ...creation.featureManifests.map(({ id, envelope }) => ({
          namespace: NAMESPACES.featureManifest.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(id),
          bytes: envelope.bytes,
        })),
        ...(input.additionalImmutableItems ?? []),
      ],
      replicaState: replicaStateItem,
      replicaSafetyItems: resolutionItems,
      vaultDirectoryEntry: directoryItem,
      installationStateItems: [
        {
          namespace: NAMESPACES.installationSelection.key,
          scopeKey: "installation",
          itemKey: "current",
          bytes: encodeInstallationSelection({ vaultId: ids.vaultId }),
        },
      ],
      trustedSecrets: [clientSecretItem, epochSecretItem],
    },
  };
}

export async function openWrappedLocalState(input: {
  readonly wrappingKey: CryptoKey;
  readonly domain: string;
  readonly vaultId: Identifier<"Vault">;
  readonly identity: Uint8Array;
  readonly wrappedBytes: Uint8Array;
}): Promise<Uint8Array> {
  return unwrapInstallationBytes({
    wrappingKey: input.wrappingKey,
    domain: input.domain,
    context: canonicalLocalStorageContext(input.vaultId, input.identity),
    wrappedBytes: input.wrappedBytes,
  });
}

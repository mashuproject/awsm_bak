import { assertCanonicalScopedKey } from "../../domain/canonical/value";

export const CANONICAL_DATABASE_NAME = "awsm";
export const CANONICAL_DATABASE_VERSION = 1;

export const STORAGE_FAMILIES = {
  VaultRecords: "vault_records",
  VaultObjects: "vault_objects",
  ReplicaSafetyState: "replica_safety_state",
  InstallationState: "installation_state",
  TrustedSecrets: "trusted_secrets",
  ExecutionState: "execution_state",
  PreparedData: "prepared_data",
  Quarantine: "quarantine",
  Materializations: "materializations",
  ManagedResources: "managed_resources",
  HostPolicyState: "host_policy_state",
} as const;

export type StorageFamily = (typeof STORAGE_FAMILIES)[keyof typeof STORAGE_FAMILIES];

export type StorageRealmKind = "Normal" | "Private" | "Temporary" | "Test";

export interface StorageRealm {
  readonly kind: StorageRealmKind;
  readonly id: string;
}

export const NORMAL_STORAGE_REALM: StorageRealm = { kind: "Normal", id: "default" };

export function storageRealmKey(realm: StorageRealm): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(realm.id)) {
    throw new TypeError("Storage Realm ID is invalid");
  }
  return `${realm.kind}:${realm.id}`;
}

export interface NamespaceDescriptor {
  readonly key: string;
  readonly family: StorageFamily;
  readonly schemaRevision: 1;
  readonly scope: "Installation" | "Vault" | "Replica" | "Remote" | "Job";
  readonly identity: string;
  readonly trustSource: "Authenticated" | "TrustedLocal" | "Untrusted" | "Derived";
  readonly protection:
    | "EpochEncrypted"
    | "InstallationWrapped"
    | "NonExtractable"
    | "Opaque"
    | "LocalClear";
  readonly synchronization: "Portable" | "ReplicaLocal" | "InstallationLocal" | "Never";
  readonly exportTreatment: "Required" | "Excluded" | "Rebuild" | "Explicit";
  readonly backupTreatment: "Required" | "Excluded" | "Rebuild" | "Explicit";
  readonly retention: string;
  readonly deletion: string;
  readonly transactionPartners: readonly string[];
  readonly unknownBehavior: "FailClosed" | "Quarantine" | "Discard";
  readonly immutable: boolean;
}

function namespace(descriptor: Omit<NamespaceDescriptor, "schemaRevision">): NamespaceDescriptor {
  assertCanonicalScopedKey(descriptor.key);
  return { ...descriptor, schemaRevision: 1 };
}

export const NAMESPACES = {
  vaultRecord: namespace({
    key: "awsm.storage.vault-record",
    family: STORAGE_FAMILIES.VaultRecords,
    scope: "Vault",
    identity: "Vault Record ID",
    trustSource: "Authenticated",
    protection: "EpochEncrypted",
    synchronization: "Portable",
    exportTreatment: "Required",
    backupTreatment: "Required",
    retention: "Reachable from a recognized Generation or preservation root",
    deletion: "Only after complete Replica garbage-collection proof",
    transactionPartners: ["awsm.storage.replica-state", "awsm.storage.logical-resolution"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  keyEnvelope: namespace({
    key: "awsm.storage.key-envelope",
    family: STORAGE_FAMILIES.VaultObjects,
    scope: "Vault",
    identity: "Key Envelope ID",
    trustSource: "Authenticated",
    protection: "Opaque",
    synchronization: "Portable",
    exportTreatment: "Required",
    backupTreatment: "Required",
    retention: "While required by readable authority state",
    deletion: "Only after reachability and authority proof",
    transactionPartners: ["awsm.storage.replica-state", "awsm.storage.logical-resolution"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  vaultObject: namespace({
    key: "awsm.storage.vault-object",
    family: STORAGE_FAMILIES.VaultObjects,
    scope: "Vault",
    identity: "Vault Object ID",
    trustSource: "Authenticated",
    protection: "EpochEncrypted",
    synchronization: "Portable",
    exportTreatment: "Required",
    backupTreatment: "Required",
    retention: "While reachable from recognized Vault state",
    deletion: "Only after complete Replica garbage-collection proof",
    transactionPartners: ["awsm.storage.replica-state", "awsm.storage.logical-resolution"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  featureManifest: namespace({
    key: "awsm.storage.feature-manifest",
    family: STORAGE_FAMILIES.VaultObjects,
    scope: "Vault",
    identity: "Feature Manifest ID",
    trustSource: "Authenticated",
    protection: "EpochEncrypted",
    synchronization: "Portable",
    exportTreatment: "Required",
    backupTreatment: "Required",
    retention: "While required by any recognized Required Feature Set",
    deletion: "Only after feature reachability proof",
    transactionPartners: ["awsm.storage.replica-state"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  artifactWrapper: namespace({
    key: "awsm.storage.artifact-wrapper",
    family: STORAGE_FAMILIES.VaultObjects,
    scope: "Vault",
    identity: "Artifact ID and Opaque Storage Item ID",
    trustSource: "Authenticated",
    protection: "Opaque",
    synchronization: "Portable",
    exportTreatment: "Required",
    backupTreatment: "Required",
    retention: "Present, Evicted, or UnexpectedlyMissing under Replica Safety State",
    deletion: "Storage Relief or complete garbage-collection proof",
    transactionPartners: ["awsm.storage.prepared-capture", "awsm.storage.replica-state"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  replicaState: namespace({
    key: "awsm.storage.replica-state",
    family: STORAGE_FAMILIES.ReplicaSafetyState,
    scope: "Replica",
    identity: "Vault ID",
    trustSource: "TrustedLocal",
    protection: "InstallationWrapped",
    synchronization: "ReplicaLocal",
    exportTreatment: "Excluded",
    backupTreatment: "Explicit",
    retention: "For the lifetime of the local Replica and its preservation roots",
    deletion: "Explicit local Replica retirement after pending-work disclosure",
    transactionPartners: ["awsm.storage.vault-record", "awsm.storage.vault-object"],
    unknownBehavior: "FailClosed",
    immutable: false,
  }),
  logicalResolution: namespace({
    key: "awsm.storage.logical-resolution",
    family: STORAGE_FAMILIES.ReplicaSafetyState,
    scope: "Replica",
    identity: "Logical item ID plus Remote",
    trustSource: "TrustedLocal",
    protection: "InstallationWrapped",
    synchronization: "ReplicaLocal",
    exportTreatment: "Excluded",
    backupTreatment: "Explicit",
    retention: "While the logical item or opaque representation is recognized",
    deletion: "With its representation or after re-enumeration proof",
    transactionPartners: ["awsm.storage.replica-state"],
    unknownBehavior: "FailClosed",
    immutable: false,
  }),
  vaultDirectory: namespace({
    key: "awsm.storage.vault-directory",
    family: STORAGE_FAMILIES.InstallationState,
    scope: "Installation",
    identity: "Vault ID",
    trustSource: "TrustedLocal",
    protection: "InstallationWrapped",
    synchronization: "InstallationLocal",
    exportTreatment: "Excluded",
    backupTreatment: "Explicit",
    retention: "Until local Vault removal",
    deletion: "Explicit local removal",
    transactionPartners: ["awsm.storage.replica-state", "awsm.storage.client-secret"],
    unknownBehavior: "FailClosed",
    immutable: false,
  }),
  installationSelection: namespace({
    key: "awsm.storage.installation-selection",
    family: STORAGE_FAMILIES.InstallationState,
    scope: "Installation",
    identity: "Singleton",
    trustSource: "TrustedLocal",
    protection: "LocalClear",
    synchronization: "InstallationLocal",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Installation lifetime",
    deletion: "With Installation State reset",
    transactionPartners: ["awsm.storage.vault-directory"],
    unknownBehavior: "FailClosed",
    immutable: false,
  }),
  installationWrappingKey: namespace({
    key: "awsm.storage.installation-wrapping-key",
    family: STORAGE_FAMILIES.TrustedSecrets,
    scope: "Installation",
    identity: "Storage Realm",
    trustSource: "TrustedLocal",
    protection: "NonExtractable",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Installation and Storage Realm lifetime",
    deletion: "With the complete Storage Realm reset",
    transactionPartners: ["awsm.storage.client-secret", "awsm.storage.epoch-secret"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  clientSecret: namespace({
    key: "awsm.storage.client-secret",
    family: STORAGE_FAMILIES.TrustedSecrets,
    scope: "Vault",
    identity: "Client Credential ID",
    trustSource: "TrustedLocal",
    protection: "InstallationWrapped",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Until Client Credential end or local removal",
    deletion: "Credential retirement or local Replica retirement",
    transactionPartners: ["awsm.storage.replica-state", "awsm.storage.vault-directory"],
    unknownBehavior: "FailClosed",
    immutable: false,
  }),
  epochSecret: namespace({
    key: "awsm.storage.epoch-secret",
    family: STORAGE_FAMILIES.TrustedSecrets,
    scope: "Vault",
    identity: "Key Epoch ID",
    trustSource: "TrustedLocal",
    protection: "InstallationWrapped",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "While retained authoritative content needs the Epoch",
    deletion: "Only after key reachability proof or local Replica retirement",
    transactionPartners: ["awsm.storage.replica-state"],
    unknownBehavior: "FailClosed",
    immutable: false,
  }),
  commandOutcome: namespace({
    key: "awsm.storage.command-outcome",
    family: STORAGE_FAMILIES.ExecutionState,
    scope: "Vault",
    identity: "Command ID",
    trustSource: "TrustedLocal",
    protection: "LocalClear",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Bounded idempotency window or related Job lifetime",
    deletion: "After bounded outcome retention",
    transactionPartners: ["awsm.storage.replica-state"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  replicaGarbageCollectionJob: namespace({
    key: "awsm.storage.replica-garbage-collection-job",
    family: STORAGE_FAMILIES.ExecutionState,
    scope: "Vault",
    identity: "Random local Replica Garbage Collection Job ID within one Vault",
    trustSource: "TrustedLocal",
    protection: "LocalClear",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Latest terminal outcome until a later heavy cleanup begins",
    deletion: "Prior terminal Job in the next heavy-cleanup installation transaction",
    transactionPartners: [
      "awsm.storage.replica-state",
      "awsm.storage.logical-resolution",
      "awsm.storage.artifact-wrapper",
      "awsm.storage.epoch-secret",
    ],
    unknownBehavior: "FailClosed",
    immutable: false,
  }),
  preparedCapture: namespace({
    key: "awsm.storage.prepared-capture",
    family: STORAGE_FAMILIES.PreparedData,
    scope: "Job",
    identity: "Capture Job ID and prepared item ID",
    trustSource: "TrustedLocal",
    protection: "Opaque",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Until promotion or terminal cleanup",
    deletion: "After terminal outcome and durable cleanup checkpoint",
    transactionPartners: ["awsm.storage.command-outcome", "awsm.storage.artifact-wrapper"],
    unknownBehavior: "FailClosed",
    immutable: true,
  }),
  incomingQuarantine: namespace({
    key: "awsm.storage.incoming-quarantine",
    family: STORAGE_FAMILIES.Quarantine,
    scope: "Remote",
    identity: "Remote and Opaque Storage Item ID",
    trustSource: "Untrusted",
    protection: "Opaque",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Bounded until validation or rejection",
    deletion: "After promotion, rejection, or bounded cleanup",
    transactionPartners: ["awsm.storage.replica-state"],
    unknownBehavior: "Quarantine",
    immutable: true,
  }),
  libraryProjection: namespace({
    key: "awsm.storage.library-projection",
    family: STORAGE_FAMILIES.Materializations,
    scope: "Replica",
    identity: "Generation, Frontier digest, and projection schema",
    trustSource: "Derived",
    protection: "InstallationWrapped",
    synchronization: "Never",
    exportTreatment: "Rebuild",
    backupTreatment: "Rebuild",
    retention: "While its exact source identity remains current",
    deletion: "Immediate invalidation or rebuild",
    transactionPartners: ["awsm.storage.replica-state"],
    unknownBehavior: "Discard",
    immutable: false,
  }),
  searchMaterialization: namespace({
    key: "awsm.storage.search-materialization",
    family: STORAGE_FAMILIES.Materializations,
    scope: "Replica",
    identity: "Vault, Generation, Frontier, corpus policy, and Search algorithm revisions",
    trustSource: "Derived",
    protection: "InstallationWrapped",
    synchronization: "Never",
    exportTreatment: "Rebuild",
    backupTreatment: "Rebuild",
    retention: "Only while its exact Materialization identity remains current",
    deletion: "Atomic replacement or immediate invalidation",
    transactionPartners: ["awsm.storage.replica-state"],
    unknownBehavior: "Discard",
    immutable: false,
  }),
  managedResource: namespace({
    key: "awsm.storage.managed-resource",
    family: STORAGE_FAMILIES.ManagedResources,
    scope: "Installation",
    identity: "Resource manifest digest",
    trustSource: "Authenticated",
    protection: "LocalClear",
    synchronization: "Never",
    exportTreatment: "Excluded",
    backupTreatment: "Excluded",
    retention: "Resource policy and active Materialization requirements",
    deletion: "When unused and independently reacquirable",
    transactionPartners: [],
    unknownBehavior: "Discard",
    immutable: true,
  }),
} as const;

export type NamespaceKey = (typeof NAMESPACES)[keyof typeof NAMESPACES]["key"];

export const NAMESPACE_REGISTRY: ReadonlyMap<NamespaceKey, NamespaceDescriptor> = new Map(
  Object.values(NAMESPACES).map((descriptor) => [descriptor.key, descriptor]),
);

if (NAMESPACE_REGISTRY.size !== Object.values(NAMESPACES).length) {
  throw new TypeError("Canonical storage namespace registry contains a duplicate key");
}

import { describe, expect, it } from "vitest";

import {
  CANONICAL_DATABASE_NAME,
  CANONICAL_DATABASE_VERSION,
  NAMESPACE_REGISTRY,
  NAMESPACES,
  NORMAL_STORAGE_REALM,
  STORAGE_FAMILIES,
  storageRealmKey,
} from "../../src/drivers/indexeddb/canonical-schema";

describe("canonical storage schema", () => {
  it("starts one clean database with the eleven canonical storage families", () => {
    expect(CANONICAL_DATABASE_NAME).toBe("awsm");
    expect(CANONICAL_DATABASE_VERSION).toBe(1);
    expect(Object.values(STORAGE_FAMILIES)).toHaveLength(11);
    expect(new Set(Object.values(STORAGE_FAMILIES)).size).toBe(11);
    expect(Object.values(STORAGE_FAMILIES).toSorted()).toEqual([
      "execution_state",
      "host_policy_state",
      "installation_state",
      "managed_resources",
      "materializations",
      "prepared_data",
      "quarantine",
      "replica_safety_state",
      "trusted_secrets",
      "vault_objects",
      "vault_records",
    ]);
  });

  it("registers every namespace exactly once in one canonical family", () => {
    expect(NAMESPACE_REGISTRY.size).toBe(Object.values(NAMESPACES).length);
    for (const descriptor of NAMESPACE_REGISTRY.values()) {
      expect(Object.values(STORAGE_FAMILIES)).toContain(descriptor.family);
      expect(descriptor.schemaRevision).toBe(1);
      expect(descriptor.key).toMatch(/^awsm\.storage\.[a-z0-9-]+$/u);
    }
  });

  it("makes the Storage Realm part of every physical key scope", () => {
    expect(storageRealmKey(NORMAL_STORAGE_REALM)).toBe("Normal:default");
    expect(storageRealmKey({ kind: "Private", id: "window-1" })).toBe("Private:window-1");
    expect(() => storageRealmKey({ kind: "Test", id: "../shared" })).toThrow(
      "Storage Realm ID is invalid",
    );
  });

  it("stores the wrapping key as a non-exportable installation secret", () => {
    expect(NAMESPACES.installationWrappingKey).toMatchObject({
      family: STORAGE_FAMILIES.TrustedSecrets,
      scope: "Installation",
      protection: "NonExtractable",
      synchronization: "Never",
      exportTreatment: "Excluded",
      backupTreatment: "Excluded",
      immutable: true,
    });
  });

  it("keeps Replica Garbage Collection orchestration in local Execution State", () => {
    expect(NAMESPACES.replicaGarbageCollectionJob).toMatchObject({
      key: "awsm.storage.replica-garbage-collection-job",
      family: STORAGE_FAMILIES.ExecutionState,
      scope: "Vault",
      protection: "LocalClear",
      synchronization: "Never",
      exportTreatment: "Excluded",
      backupTreatment: "Excluded",
      immutable: false,
    });
  });
});

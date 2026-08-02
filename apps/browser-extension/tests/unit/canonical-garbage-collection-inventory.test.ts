import { describe, expect, it, vi } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { loadReplicaGarbageCollectionInventory } from "../../src/runtime/storage/garbage-collection-inventory";
import {
  canonicalLocalStorageContext,
  encodeLogicalResolution,
  prepareWrappedLocalStateItem,
} from "../../src/runtime/vault/canonical-local-state";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

describe("canonical Replica Garbage Collection inventory", () => {
  it("authenticates protected resolutions and enumerates exact local compact and Epoch identities", async () => {
    const vaultId = filled("Vault", 1);
    const recordId = filled("VaultRecord", 2);
    const keyEpochId = filled("KeyEpoch", 3);
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const vaultKey = identifierStorageKey(vaultId);
    const resolution = {
      vaultId,
      kind: 1 as const,
      logicalId: recordId,
      storageItemId: filled("StorageItem", 4),
      keyEpochId,
      availability: 1 as const,
    };
    const wrapped = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.logicalResolution.key,
      scopeKey: vaultKey,
      itemKey: `1:${identifierStorageKey(recordId)}`,
      wrappingKey,
      domain: "awsm.local.logical-resolution",
      context: canonicalLocalStorageContext(vaultId, recordId),
      bytes: encodeLogicalResolution(resolution),
    });
    const listBytes = vi.fn(async (_realm, namespace: string) => {
      if (namespace === NAMESPACES.logicalResolution.key) return [{ ...wrapped, realmKey: "Test" }];
      if (namespace === NAMESPACES.vaultRecord.key) {
        return [
          {
            realmKey: "Test",
            namespace: NAMESPACES.vaultRecord.key,
            scopeKey: vaultKey,
            itemKey: identifierStorageKey(recordId),
            bytes: Uint8Array.of(1),
          },
        ];
      }
      if (namespace === NAMESPACES.epochSecret.key) {
        return [
          {
            realmKey: "Test",
            namespace: NAMESPACES.epochSecret.key,
            scopeKey: vaultKey,
            itemKey: identifierStorageKey(keyEpochId),
            bytes: Uint8Array.of(1),
          },
        ];
      }
      return [];
    });

    const inventory = await loadReplicaGarbageCollectionInventory(
      { storage: { listBytes }, realm: NORMAL_STORAGE_REALM } as never,
      {
        installationWrappingKey: wrappingKey,
        replicaState: { vaultId },
      } as never,
    );

    expect(inventory.resolutions).toEqual([resolution]);
    expect(inventory.compactItems).toEqual([{ kind: 1, logicalId: recordId }]);
    expect(inventory.epochSecretIds).toEqual([keyEpochId]);
  });

  it("fails closed on a malformed physical logical identity", async () => {
    const vaultId = filled("Vault", 1);
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const listBytes = vi.fn(async (_realm, namespace: string) =>
      namespace === NAMESPACES.vaultObject.key
        ? [
            {
              realmKey: "Test",
              namespace: NAMESPACES.vaultObject.key,
              scopeKey: identifierStorageKey(vaultId),
              itemKey: "not-an-id",
              bytes: Uint8Array.of(1),
            },
          ]
        : [],
    );

    await expect(
      loadReplicaGarbageCollectionInventory(
        { storage: { listBytes }, realm: NORMAL_STORAGE_REALM } as never,
        { installationWrappingKey: wrappingKey, replicaState: { vaultId } } as never,
      ),
    ).rejects.toThrow(/storage key/u);
  });
});

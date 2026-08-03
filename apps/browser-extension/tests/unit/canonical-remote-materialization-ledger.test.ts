import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { transcript, uint8 } from "../../src/domain/canonical/transcript";
import { sha256 } from "../../src/domain/hash";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { CanonicalRemoteMaterializationLedgerService } from "../../src/runtime/synchronization/canonical-remote-materialization-ledger-service";
import { decodeCanonicalRemoteMaterializationLedgerEntry } from "../../src/runtime/synchronization/canonical-state";
import { openWrappedLocalState } from "../../src/runtime/vault/canonical-local-state";
import { encodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

describe("canonical Remote materialization ledger", () => {
  it("atomically records one exact prepared outer item before Host admission", async () => {
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const commits: unknown[] = [];
    const envelope = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(1),
      payload: new Uint8Array(16).fill(2),
    });
    const vaultId = identifier("Vault", new Uint8Array(32).fill(3));
    const logicalId = identifier("VaultRecord", new Uint8Array(32).fill(4));
    const service = new CanonicalRemoteMaterializationLedgerService(
      {
        getOrCreateInstallationWrappingKey: async () => wrappingKey,
        commitExecutionMutation: async (commit: unknown) => commits.push(commit),
      } as unknown as ConstructorParameters<typeof CanonicalRemoteMaterializationLedgerService>[0],
      NORMAL_STORAGE_REALM,
    );

    await service.prepare({
      entry: {
        vaultId,
        remoteId: REMOTE_ID,
        logicalNamespace: 1,
        logicalId,
        keyEpochId: identifier("KeyEpoch", new Uint8Array(32).fill(5)),
        locator: new Uint8Array(32).fill(6),
        storageItemId: envelope.storageItemId,
        byteLength: envelope.bytes.byteLength,
        byteDigest: await sha256(envelope.bytes),
        state: "Prepared",
      },
      bytes: envelope.bytes,
    });

    expect(commits).toHaveLength(1);
    const commit = commits[0] as {
      readonly expectedAbsentItems: readonly {
        readonly namespace: string;
        readonly itemKey: string;
      }[];
      readonly immutableItems: readonly {
        readonly namespace: string;
        readonly scopeKey: string;
        readonly itemKey: string;
        readonly bytes: Uint8Array;
      }[];
      readonly mutableItems: readonly {
        readonly namespace: string;
        readonly scopeKey: string;
        readonly itemKey: string;
        readonly bytes: Uint8Array;
      }[];
    };
    expect(commit.expectedAbsentItems).toEqual([
      expect.objectContaining({ namespace: NAMESPACES.remoteMaterializationLedger.key }),
    ]);
    expect(commit.immutableItems).toEqual([
      {
        namespace: NAMESPACES.preparedOutgoingItem.key,
        scopeKey: REMOTE_ID,
        itemKey: identifierStorageKey(envelope.storageItemId),
        bytes: envelope.bytes,
      },
    ]);
    const ledger = commit.mutableItems[0];
    if (ledger === undefined) throw new TypeError("prepared ledger is absent");
    expect(ledger.namespace).toBe(NAMESPACES.remoteMaterializationLedger.key);
    expect(
      decodeCanonicalRemoteMaterializationLedgerEntry(
        await openWrappedLocalState({
          wrappingKey,
          domain: "awsm.local.remote-materialization-ledger",
          vaultId,
          identity: transcript("awsm:remote-materialization-ledger:v1", [
            new TextEncoder().encode(REMOTE_ID),
            uint8(1),
            logicalId,
          ]),
          wrappedBytes: ledger.bytes,
        }),
      ),
    ).toMatchObject({
      remoteId: REMOTE_ID,
      logicalNamespace: 1,
      storageItemId: envelope.storageItemId,
      state: "Prepared",
    });
  });

  it("confirms only the exact prepared item and atomically retires its local bytes", async () => {
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const stored = new Map<string, Uint8Array>();
    const commits: unknown[] = [];
    const storageKey = (namespace: string, scopeKey: string, itemKey: string) =>
      `${namespace}\u0000${scopeKey}\u0000${itemKey}`;
    const storage = {
      getOrCreateInstallationWrappingKey: async () => wrappingKey,
      getBytes: async (
        _realm: unknown,
        item: { readonly namespace: string; readonly scopeKey: string; readonly itemKey: string },
      ) => stored.get(storageKey(item.namespace, item.scopeKey, item.itemKey)),
      commitExecutionMutation: async (commit: {
        readonly immutableItems?: readonly {
          readonly namespace: string;
          readonly scopeKey: string;
          readonly itemKey: string;
          readonly bytes: Uint8Array;
        }[];
        readonly mutableItems?: readonly {
          readonly namespace: string;
          readonly scopeKey: string;
          readonly itemKey: string;
          readonly bytes: Uint8Array;
        }[];
        readonly deletedItems?: readonly {
          readonly namespace: string;
          readonly scopeKey: string;
          readonly itemKey: string;
        }[];
      }) => {
        commits.push(commit);
        for (const item of commit.immutableItems ?? []) {
          stored.set(storageKey(item.namespace, item.scopeKey, item.itemKey), item.bytes);
        }
        for (const item of commit.mutableItems ?? []) {
          stored.set(storageKey(item.namespace, item.scopeKey, item.itemKey), item.bytes);
        }
        for (const item of commit.deletedItems ?? []) {
          stored.delete(storageKey(item.namespace, item.scopeKey, item.itemKey));
        }
      },
    };
    const envelope = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(12),
      payload: new Uint8Array(16).fill(13),
    });
    const entry = {
      vaultId: identifier("Vault", new Uint8Array(32).fill(14)),
      remoteId: REMOTE_ID,
      logicalNamespace: 1 as const,
      logicalId: identifier("VaultRecord", new Uint8Array(32).fill(15)),
      keyEpochId: identifier("KeyEpoch", new Uint8Array(32).fill(16)),
      locator: new Uint8Array(32).fill(17),
      storageItemId: envelope.storageItemId,
      byteLength: envelope.bytes.byteLength,
      byteDigest: await sha256(envelope.bytes),
      state: "Prepared" as const,
    };
    const service = new CanonicalRemoteMaterializationLedgerService(
      storage as unknown as ConstructorParameters<
        typeof CanonicalRemoteMaterializationLedgerService
      >[0],
      NORMAL_STORAGE_REALM,
    );
    await expect(
      service.find({
        vaultId: entry.vaultId,
        remoteId: entry.remoteId,
        logicalNamespace: entry.logicalNamespace,
        logicalId: entry.logicalId,
      }),
    ).resolves.toBeNull();
    await service.prepare({ entry, bytes: envelope.bytes });

    await expect(
      service.load({
        vaultId: entry.vaultId,
        remoteId: entry.remoteId,
        logicalNamespace: entry.logicalNamespace,
        logicalId: entry.logicalId,
      }),
    ).resolves.toEqual({ entry, bytes: envelope.bytes });

    await expect(
      service.confirm({
        entry,
        admission: {
          storageItemId: identifier("StorageItem", new Uint8Array(32).fill(18)),
          byteLength: envelope.bytes.byteLength,
          admission: "stored",
        },
      }),
    ).rejects.toThrow(/does not match its prepared item/u);
    expect(commits).toHaveLength(1);

    await expect(
      service.confirm({
        entry,
        admission: {
          storageItemId: envelope.storageItemId,
          byteLength: envelope.bytes.byteLength,
          admission: "already_present",
        },
      }),
    ).resolves.toEqual({ ...entry, state: "Confirmed" });

    expect(commits).toHaveLength(2);
    const confirmation = commits[1] as {
      readonly expectedMutableItems: readonly { readonly namespace: string }[];
      readonly deletedItems: readonly { readonly namespace: string; readonly itemKey: string }[];
    };
    expect(confirmation.expectedMutableItems).toEqual([
      expect.objectContaining({ namespace: NAMESPACES.remoteMaterializationLedger.key }),
    ]);
    expect(confirmation.deletedItems).toEqual([
      {
        namespace: NAMESPACES.preparedOutgoingItem.key,
        scopeKey: REMOTE_ID,
        itemKey: identifierStorageKey(envelope.storageItemId),
      },
    ]);
    await expect(
      service.load({
        vaultId: entry.vaultId,
        remoteId: entry.remoteId,
        logicalNamespace: entry.logicalNamespace,
        logicalId: entry.logicalId,
      }),
    ).resolves.toEqual({ entry: { ...entry, state: "Confirmed" }, bytes: null });
  });
});

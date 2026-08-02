import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { decodeCanonicalValue, encodeCanonicalValue } from "../../src/domain/canonical/value";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { CanonicalReplicaRemoteService } from "../../src/runtime/synchronization/canonical-remote-service";
import {
  type CanonicalPullSynchronizationJob,
  type CanonicalReplicaRemote,
  decodeCanonicalPullSynchronizationJob,
  decodeCanonicalRemoteCredential,
  decodeCanonicalReplicaRemote,
  encodeCanonicalPullSynchronizationJob,
  encodeCanonicalRemoteCredential,
  encodeCanonicalReplicaRemote,
} from "../../src/runtime/synchronization/canonical-state";
import { openWrappedLocalState } from "../../src/runtime/vault/canonical-local-state";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
const REPLICA_HANDLE = "019fa62e-a653-7f63-b2bf-94e7ed5e46cb";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function remote(): CanonicalReplicaRemote {
  return {
    remoteId: REMOTE_ID,
    vaultId: filled("Vault", 1),
    name: "Staging replica",
    endpoint: "https://sync.example.test/",
    hostedReplicaHandle: REPLICA_HANDLE,
    enabled: true,
    inventoryPageSize: 100,
  };
}

function job(): CanonicalPullSynchronizationJob {
  return {
    jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
    vaultId: filled("Vault", 1),
    remoteId: REMOTE_ID,
    realm: { kind: "Normal", id: "default" },
    stage: 2,
    state: 1,
    snapshotCursor: 9,
    nextPosition: filled("StorageItem", 2),
    attempt: 0,
    retryAfterMs: null,
    quarantineStorageItemIds: [filled("StorageItem", 3)],
    progress: {
      discoveredItemCount: 4,
      downloadedItemCount: 1,
      promotedItemCount: 0,
      rejectedItemCount: 0,
    },
  };
}

describe("canonical synchronization state", () => {
  it("round-trips one Vault-local Hosted HTTP Remote without making it Vault state", () => {
    const value = remote();

    expect(decodeCanonicalReplicaRemote(encodeCanonicalReplicaRemote(value))).toEqual(value);
  });

  it("rejects an insecure or noncanonical Remote endpoint before it becomes local configuration", () => {
    expect(() =>
      encodeCanonicalReplicaRemote({ ...remote(), endpoint: "http://sync.example.test/" }),
    ).toThrow(/HTTPS/u);
    expect(() =>
      encodeCanonicalReplicaRemote({ ...remote(), endpoint: "https://sync.example.test" }),
    ).toThrow(/canonical/u);
  });

  it("round-trips a Remote-scoped bearer credential independently of the Remote configuration", () => {
    const credential = { remoteId: REMOTE_ID, bearerToken: "opaque-bearer-token" };

    expect(decodeCanonicalRemoteCredential(encodeCanonicalRemoteCredential(credential))).toEqual(
      credential,
    );
  });

  it("round-trips an exact resumable pull Job with its Realm, snapshot, retry state, and Quarantine references", () => {
    const value = job();

    expect(
      decodeCanonicalPullSynchronizationJob(encodeCanonicalPullSynchronizationJob(value)),
    ).toEqual(value);
  });

  it("rejects a finished pull Job that still retains Quarantine or retry state", () => {
    expect(() =>
      encodeCanonicalPullSynchronizationJob({
        ...job(),
        stage: 3,
        state: 3,
        retryAfterMs: 1,
      }),
    ).toThrow(/completed/i);
    expect(() =>
      encodeCanonicalPullSynchronizationJob({
        ...job(),
        stage: 3,
        state: 3,
        nextPosition: null,
      }),
    ).toThrow(/Quarantine/u);
  });

  it("rejects unrecognized persisted Job fields instead of interpreting another synchronization shape", () => {
    const value = decodeCanonicalValue(encodeCanonicalPullSynchronizationJob(job()));
    if (!(value instanceof Map)) throw new TypeError("fixture pull Job must be a map");
    value.set(13, 1);

    expect(() => decodeCanonicalPullSynchronizationJob(encodeCanonicalValue(value))).toThrow(
      /unknown fields/u,
    );
  });

  it("atomically persists a Remote configuration separately from its installation-wrapped bearer credential", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const commits: unknown[] = [];
    const storage = {
      getOrCreateInstallationWrappingKey: async () => key,
      commitInstallationMutation: async (commit: unknown) => commits.push(commit),
    };
    const service = new CanonicalReplicaRemoteService(
      storage as unknown as ConstructorParameters<typeof CanonicalReplicaRemoteService>[0],
      NORMAL_STORAGE_REALM,
    );
    const value = remote();

    await service.configure({ remote: value, bearerToken: "opaque-bearer-token" });

    expect(commits).toHaveLength(1);
    const commit = commits[0] as {
      readonly mutableItems: readonly {
        readonly namespace: string;
        readonly scopeKey: string;
        readonly itemKey: string;
        readonly bytes: Uint8Array;
      }[];
    };
    const configuration = commit.mutableItems.find(
      ({ namespace }) => namespace === NAMESPACES.replicaRemote.key,
    );
    const credential = commit.mutableItems.find(
      ({ namespace }) => namespace === NAMESPACES.remoteChannelCredential.key,
    );
    if (configuration === undefined || credential === undefined) {
      throw new TypeError("Remote configuration transaction is incomplete");
    }
    expect(commit.mutableItems).toHaveLength(2);
    expect(configuration.scopeKey).toBe(identifierStorageKey(value.vaultId));
    expect(configuration.itemKey).toBe(REMOTE_ID);
    expect(credential.scopeKey).toBe(REMOTE_ID);
    expect(credential.itemKey).toBe("bearer");
    expect(
      decodeCanonicalReplicaRemote(
        await openWrappedLocalState({
          wrappingKey: key,
          domain: "awsm.local.replica-remote",
          vaultId: value.vaultId,
          identity: new TextEncoder().encode(REMOTE_ID),
          wrappedBytes: configuration.bytes,
        }),
      ),
    ).toEqual(value);
    expect(
      decodeCanonicalRemoteCredential(
        await openWrappedLocalState({
          wrappingKey: key,
          domain: "awsm.local.remote-channel-credential",
          vaultId: value.vaultId,
          identity: new TextEncoder().encode(REMOTE_ID),
          wrappedBytes: credential.bytes,
        }),
      ),
    ).toEqual({ remoteId: REMOTE_ID, bearerToken: "opaque-bearer-token" });
  });

  it("lists and opens only the selected Vault's protected Remote and credential", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const stored = new Map<string, Uint8Array>();
    const storageKey = (namespace: string, scopeKey: string, itemKey: string) =>
      `${namespace}\u0000${scopeKey}\u0000${itemKey}`;
    const storage = {
      getOrCreateInstallationWrappingKey: async () => key,
      commitInstallationMutation: async (commit: {
        readonly expectedAbsentItems?: readonly {
          readonly namespace: string;
          readonly scopeKey: string;
          readonly itemKey: string;
        }[];
        readonly mutableItems?: readonly {
          readonly namespace: string;
          readonly scopeKey: string;
          readonly itemKey: string;
          readonly bytes: Uint8Array;
        }[];
      }) => {
        for (const item of commit.expectedAbsentItems ?? []) {
          if (stored.has(storageKey(item.namespace, item.scopeKey, item.itemKey))) {
            throw new TypeError("duplicate local identity");
          }
        }
        for (const item of commit.mutableItems ?? []) {
          stored.set(storageKey(item.namespace, item.scopeKey, item.itemKey), item.bytes);
        }
      },
      listBytes: async (_realm: unknown, namespace: string, scopeKey: string) =>
        [...stored.entries()]
          .map(([key, bytes]) => {
            const [storedNamespace, storedScopeKey, itemKey] = key.split("\u0000");
            return { storedNamespace, storedScopeKey, itemKey, bytes };
          })
          .filter(
            ({ storedNamespace, storedScopeKey }) =>
              storedNamespace === namespace && storedScopeKey === scopeKey,
          )
          .map(({ itemKey, bytes }) => ({
            realmKey: "Normal:default",
            namespace,
            scopeKey,
            itemKey,
            bytes,
          })),
      getBytes: async (
        _realm: unknown,
        item: { readonly namespace: string; readonly scopeKey: string; readonly itemKey: string },
      ) => stored.get(storageKey(item.namespace, item.scopeKey, item.itemKey)),
    };
    const service = new CanonicalReplicaRemoteService(
      storage as unknown as ConstructorParameters<typeof CanonicalReplicaRemoteService>[0],
      NORMAL_STORAGE_REALM,
    );
    const value = remote();
    await service.configure({ remote: value, bearerToken: "opaque-bearer-token" });

    await expect(service.list(value.vaultId)).resolves.toEqual([value]);
    await expect(service.load({ vaultId: value.vaultId, remoteId: REMOTE_ID })).resolves.toEqual({
      remote: value,
      bearerToken: "opaque-bearer-token",
    });
    await expect(service.list(filled("Vault", 9))).resolves.toEqual([]);
  });
});

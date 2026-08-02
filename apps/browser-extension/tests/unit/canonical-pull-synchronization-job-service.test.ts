import { describe, expect, it } from "vitest";

import { type Identifier, identifier } from "../../src/domain/canonical/identifiers";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { CanonicalPullSynchronizationJobService } from "../../src/runtime/synchronization/canonical-pull-synchronization-job-service";
import { encodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
const JOB_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46cb";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function reference(storageItemId: Identifier<"StorageItem">, locatorByte: number) {
  return { storageItemId, locator: new Uint8Array(32).fill(locatorByte) };
}

describe("canonical pull-synchronization Job service", () => {
  it("creates one local durable pull Job bound to the Vault, Remote, and Storage Realm", async () => {
    const commits: unknown[] = [];
    const service = new CanonicalPullSynchronizationJobService(
      {
        commitExecutionMutation: async (commit: unknown) => commits.push(commit),
      } as unknown as ConstructorParameters<typeof CanonicalPullSynchronizationJobService>[0],
      NORMAL_STORAGE_REALM,
      () => JOB_ID,
    );
    const vaultId = filled("Vault", 1);

    await expect(service.create({ vaultId, remoteId: REMOTE_ID })).resolves.toMatchObject({
      jobId: JOB_ID,
      vaultId,
      remoteId: REMOTE_ID,
      realm: NORMAL_STORAGE_REALM,
      stage: 1,
      state: 1,
      snapshotCursor: null,
      nextPosition: null,
      quarantineReferences: [],
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual(
      expect.objectContaining({
        expectedAbsentItems: [
          {
            namespace: NAMESPACES.pullSynchronizationJob.key,
            scopeKey: identifierStorageKey(vaultId),
            itemKey: JOB_ID,
          },
        ],
      }),
    );
  });

  it("atomically records an outer-verified opaque item in Remote Quarantine with its resumed Job", async () => {
    const commits: unknown[] = [];
    const service = new CanonicalPullSynchronizationJobService(
      {
        commitExecutionMutation: async (commit: unknown) => commits.push(commit),
      } as unknown as ConstructorParameters<typeof CanonicalPullSynchronizationJobService>[0],
      NORMAL_STORAGE_REALM,
      () => JOB_ID,
    );
    const vaultId = filled("Vault", 1);
    const job = await service.create({ vaultId, remoteId: REMOTE_ID });
    const envelope = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(8),
      payload: new Uint8Array(16).fill(9),
    });
    const next = {
      ...job,
      stage: 2 as const,
      snapshotCursor: 3,
      progress: {
        discoveredItemCount: 1,
        downloadedItemCount: 1,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
      quarantineReferences: [reference(envelope.storageItemId, 6)],
    };

    await service.recordQuarantine({ previous: job, next, bytes: envelope.bytes });

    const commit = commits[1] as {
      readonly immutableItems: readonly {
        readonly namespace: string;
        readonly scopeKey: string;
        readonly itemKey: string;
        readonly bytes: Uint8Array;
      }[];
      readonly expectedMutableItems: readonly { readonly bytes: Uint8Array }[];
      readonly mutableItems: readonly { readonly bytes: Uint8Array }[];
    };
    expect(commit.immutableItems).toEqual([
      {
        namespace: NAMESPACES.incomingQuarantine.key,
        scopeKey: REMOTE_ID,
        itemKey: identifierStorageKey(envelope.storageItemId),
        bytes: envelope.bytes,
      },
    ]);
    expect(commit.expectedMutableItems).toHaveLength(1);
    expect(commit.mutableItems).toHaveLength(1);
  });

  it("rejects a claimed Quarantine identity before any local transaction when outer bytes disagree", async () => {
    const commits: unknown[] = [];
    const service = new CanonicalPullSynchronizationJobService(
      {
        commitExecutionMutation: async (commit: unknown) => commits.push(commit),
      } as unknown as ConstructorParameters<typeof CanonicalPullSynchronizationJobService>[0],
      NORMAL_STORAGE_REALM,
      () => JOB_ID,
    );
    const job = await service.create({ vaultId: filled("Vault", 1), remoteId: REMOTE_ID });
    const envelope = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(8),
      payload: new Uint8Array(16).fill(9),
    });
    const next = {
      ...job,
      stage: 2 as const,
      snapshotCursor: 3,
      progress: {
        discoveredItemCount: 1,
        downloadedItemCount: 1,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
      quarantineReferences: [reference(filled("StorageItem", 7), 6)],
    };

    await expect(
      service.recordQuarantine({ previous: job, next, bytes: envelope.bytes }),
    ).rejects.toThrow(/Quarantine identity/u);
    expect(commits).toHaveLength(1);
  });

  it("never lets one download checkpoint discard an earlier Quarantine reference", async () => {
    const commits: unknown[] = [];
    const service = new CanonicalPullSynchronizationJobService(
      {
        commitExecutionMutation: async (commit: unknown) => commits.push(commit),
      } as unknown as ConstructorParameters<typeof CanonicalPullSynchronizationJobService>[0],
      NORMAL_STORAGE_REALM,
      () => JOB_ID,
    );
    const job = await service.create({ vaultId: filled("Vault", 1), remoteId: REMOTE_ID });
    const first = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(8),
      payload: new Uint8Array(16).fill(9),
    });
    const second = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(10),
      payload: new Uint8Array(16).fill(11),
    });
    const previous = {
      ...job,
      stage: 2 as const,
      snapshotCursor: 3,
      quarantineReferences: [reference(first.storageItemId, 6)],
      progress: {
        discoveredItemCount: 2,
        downloadedItemCount: 1,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
    };
    const next = {
      ...previous,
      quarantineReferences: [reference(second.storageItemId, 7)],
      progress: { ...previous.progress, downloadedItemCount: 2 },
    };

    await expect(service.recordQuarantine({ previous, next, bytes: second.bytes })).rejects.toThrow(
      /retain prior Quarantine/u,
    );
    expect(commits).toHaveLength(1);
  });

  it("advances an inventory checkpoint only through an exact prior local Job state", async () => {
    const commits: unknown[] = [];
    const service = new CanonicalPullSynchronizationJobService(
      {
        commitExecutionMutation: async (commit: unknown) => commits.push(commit),
      } as unknown as ConstructorParameters<typeof CanonicalPullSynchronizationJobService>[0],
      NORMAL_STORAGE_REALM,
      () => JOB_ID,
    );
    const previous = await service.create({ vaultId: filled("Vault", 1), remoteId: REMOTE_ID });
    const next = { ...previous, snapshotCursor: 3, nextPosition: filled("StorageItem", 4) };

    await service.checkpoint({ previous, next });

    const commit = commits[1] as {
      readonly expectedMutableItems: readonly { readonly bytes: Uint8Array }[];
      readonly mutableItems: readonly { readonly bytes: Uint8Array }[];
    };
    expect(commit.expectedMutableItems).toHaveLength(1);
    expect(commit.mutableItems).toHaveLength(1);
  });

  it("rejects an ordinary checkpoint that changes the retained Host locator", async () => {
    const commits: unknown[] = [];
    const service = new CanonicalPullSynchronizationJobService(
      {
        commitExecutionMutation: async (commit: unknown) => commits.push(commit),
      } as unknown as ConstructorParameters<typeof CanonicalPullSynchronizationJobService>[0],
      NORMAL_STORAGE_REALM,
      () => JOB_ID,
    );
    const storageItemId = filled("StorageItem", 7);
    const previous = {
      ...(await service.create({ vaultId: filled("Vault", 1), remoteId: REMOTE_ID })),
      quarantineReferences: [reference(storageItemId, 8)],
      progress: {
        discoveredItemCount: 1,
        downloadedItemCount: 1,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
    };
    const next = { ...previous, quarantineReferences: [reference(storageItemId, 9)] };

    await expect(service.checkpoint({ previous, next })).rejects.toThrow(/Quarantine state/u);
    expect(commits).toHaveLength(1);
  });

  it("reopens one persisted Job only when its Vault, Realm, and local identity agree", async () => {
    const stored = new Map<string, Uint8Array>();
    const storage = {
      commitExecutionMutation: async (commit: {
        readonly mutableItems?: readonly {
          readonly namespace: string;
          readonly scopeKey: string;
          readonly itemKey: string;
          readonly bytes: Uint8Array;
        }[];
      }) => {
        for (const item of commit.mutableItems ?? []) {
          stored.set(`${item.namespace}:${item.scopeKey}:${item.itemKey}`, item.bytes);
        }
      },
      getBytes: async (
        _realm: unknown,
        item: { readonly namespace: string; readonly scopeKey: string; readonly itemKey: string },
      ) => stored.get(`${item.namespace}:${item.scopeKey}:${item.itemKey}`),
    };
    const service = new CanonicalPullSynchronizationJobService(
      storage as unknown as ConstructorParameters<typeof CanonicalPullSynchronizationJobService>[0],
      NORMAL_STORAGE_REALM,
      () => JOB_ID,
    );
    const created = await service.create({ vaultId: filled("Vault", 1), remoteId: REMOTE_ID });

    await expect(service.load({ vaultId: created.vaultId, jobId: created.jobId })).resolves.toEqual(
      created,
    );
  });
});

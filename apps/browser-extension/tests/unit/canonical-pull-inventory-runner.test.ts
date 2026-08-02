import { describe, expect, it, vi } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import type { CanonicalOpaqueInventoryPage } from "../../src/runtime/synchronization/canonical-host-http";
import { CanonicalPullInventoryRunner } from "../../src/runtime/synchronization/canonical-pull-inventory-runner";
import type { CanonicalPullSynchronizationJob } from "../../src/runtime/synchronization/canonical-state";
import { encodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
const REPLICA_HANDLE = "019fa62e-a653-7f63-b2bf-94e7ed5e46cb";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function job(): CanonicalPullSynchronizationJob {
  return {
    jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
    vaultId: filled("Vault", 1),
    remoteId: REMOTE_ID,
    realm: { kind: "Normal", id: "default" },
    stage: 1,
    state: 1,
    snapshotCursor: null,
    nextPosition: null,
    attempt: 0,
    retryAfterMs: null,
    quarantineStorageItemIds: [],
    progress: {
      discoveredItemCount: 0,
      downloadedItemCount: 0,
      promotedItemCount: 0,
      rejectedItemCount: 0,
    },
  };
}

function page(
  snapshotCursor: number,
  nextPosition: CanonicalOpaqueInventoryPage["nextPosition"],
  items: CanonicalOpaqueInventoryPage["items"],
): CanonicalOpaqueInventoryPage {
  return { snapshotCursor, nextPosition, items };
}

function item(envelope: ReturnType<typeof encodeOpaqueEnvelope>) {
  return {
    storageItemId: envelope.storageItemId,
    storageClass: envelope.storageClass,
    byteLength: envelope.bytes.byteLength,
    ciphertextDigest: envelope.ciphertextDigest,
  } as const;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes));
      controller.close();
    },
  });
}

describe("canonical pull inventory runner", () => {
  it("holds one Host snapshot while it fetches only unknown Compact items into durable Quarantine", async () => {
    const known = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(1),
      payload: new Uint8Array(16).fill(2),
    });
    const first = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(3),
      payload: new Uint8Array(16).fill(4),
    });
    const streamable = encodeOpaqueEnvelope({
      storageClass: 2,
      protectionParameters: new Uint8Array(64).fill(5),
      payload: new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 16, ...new Uint8Array(16)]),
    });
    const second = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(6),
      payload: new Uint8Array(16).fill(7),
    });
    const position = filled("StorageItem", 8);
    const inventory = vi
      .fn()
      .mockResolvedValueOnce(page(9, position, [item(known), item(first), item(streamable)]))
      .mockResolvedValueOnce(page(9, null, [item(second)]));
    const download = vi
      .fn()
      .mockResolvedValueOnce(stream(first.bytes))
      .mockResolvedValueOnce(stream(second.bytes));
    const recordQuarantine = vi.fn().mockResolvedValue(undefined);
    const checkpoint = vi.fn().mockResolvedValue(undefined);
    const runner = new CanonicalPullInventoryRunner({
      inventory,
      item: download,
      hasStoredStorageItem: async (storageItemId) =>
        storageItemId.every((byte, index) => byte === known.storageItemId[index]),
      recordQuarantine,
      checkpoint,
    });

    await expect(
      runner.run({
        remote: {
          remoteId: REMOTE_ID,
          hostedReplicaHandle: REPLICA_HANDLE,
          inventoryPageSize: 100,
          enabled: true,
        },
        job: job(),
      }),
    ).resolves.toMatchObject({
      snapshotCursor: 9,
      nextPosition: null,
      stage: 2,
      quarantineStorageItemIds: [first.storageItemId, second.storageItemId],
      progress: {
        discoveredItemCount: 2,
        downloadedItemCount: 2,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
    });
    expect(inventory).toHaveBeenNthCalledWith(1, {
      replicaHandle: REPLICA_HANDLE,
      limit: 100,
    });
    expect(inventory).toHaveBeenNthCalledWith(2, {
      replicaHandle: REPLICA_HANDLE,
      snapshotCursor: 9,
      position,
      limit: 100,
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(recordQuarantine).toHaveBeenCalledTimes(2);
    expect(recordQuarantine.mock.calls[0]?.[0].next.stage).toBe(1);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

  it("rejects a Host item whose outer envelope disagrees with the opaque inventory before Quarantine", async () => {
    const claimed = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(1),
      payload: new Uint8Array(16).fill(2),
    });
    const delivered = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(3),
      payload: new Uint8Array(16).fill(4),
    });
    const recordQuarantine = vi.fn().mockResolvedValue(undefined);
    const runner = new CanonicalPullInventoryRunner({
      inventory: vi.fn().mockResolvedValue(page(9, null, [item(claimed)])),
      item: vi.fn().mockResolvedValue(stream(delivered.bytes)),
      hasStoredStorageItem: async () => false,
      recordQuarantine,
      checkpoint: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      runner.run({
        remote: {
          remoteId: REMOTE_ID,
          hostedReplicaHandle: REPLICA_HANDLE,
          inventoryPageSize: 1,
          enabled: true,
        },
        job: job(),
      }),
    ).rejects.toThrow(/disagree with its inventory/i);
    expect(recordQuarantine).not.toHaveBeenCalled();
  });
});

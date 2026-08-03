import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import {
  COMPACT_STORAGE_CLASS,
  decodeOpaqueEnvelope,
  PORTABLE_COMPACT_CEILING,
} from "../../storage/opaque-envelope";
import type { CanonicalOpaqueInventoryItem } from "./canonical-host-http";
import type { CanonicalPullSynchronizationJobService } from "./canonical-pull-synchronization-job-service";
import type { CanonicalPullSynchronizationJob } from "./canonical-state";

const MAX_COMPACT_OUTER_BYTES = PORTABLE_COMPACT_CEILING + 4_108;

type InventoryTransport = {
  readonly inventory: (input: {
    readonly replicaHandle: string;
    readonly snapshotCursor?: number;
    readonly position?: Identifier<"StorageItem">;
    readonly limit: number;
  }) => Promise<{
    readonly snapshotCursor: number;
    readonly nextPosition: Identifier<"StorageItem"> | null;
    readonly items: readonly CanonicalOpaqueInventoryItem[];
  }>;
  readonly item: (input: {
    readonly replicaHandle: string;
    readonly storageItemId: Identifier<"StorageItem">;
    readonly byteLength: number;
  }) => Promise<ReadableStream<Uint8Array>>;
};

type PullCheckpointSink = Pick<
  CanonicalPullSynchronizationJobService,
  "checkpoint" | "recordQuarantine"
>;

function same(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null ? right === null : right !== null && bytesEqual(left, right);
}

async function readCompactEnvelope(
  stream: ReadableStream<Uint8Array>,
  byteLength: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_COMPACT_OUTER_BYTES) {
    throw new TypeError("Compact Host inventory item exceeds the accepted outer-envelope bound");
  }
  const bytes = new Uint8Array(byteLength);
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Replica Host compact item chunks must contain bytes");
      }
      if (offset + next.value.byteLength > bytes.byteLength) {
        throw new TypeError("Replica Host compact item exceeds its declared length");
      }
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== bytes.byteLength) {
      throw new TypeError("Replica Host compact item ended before its declared length");
    }
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function verifyInventoryEnvelope(item: CanonicalOpaqueInventoryItem, bytes: Uint8Array): void {
  const envelope = decodeOpaqueEnvelope(bytes);
  if (
    !bytesEqual(envelope.storageItemId, item.storageItemId) ||
    envelope.storageClass !== item.storageClass ||
    envelope.bytes.byteLength !== item.byteLength ||
    !bytesEqual(envelope.ciphertextDigest, item.ciphertextDigest)
  ) {
    throw new TypeError("Replica Host opaque bytes disagree with its inventory metadata");
  }
}

function nextInventoryJob(
  job: CanonicalPullSynchronizationJob,
  input: {
    readonly stage: 1 | 2;
    readonly snapshotCursor: number;
    readonly nextPosition: Identifier<"StorageItem"> | null;
  },
): CanonicalPullSynchronizationJob {
  return {
    ...job,
    stage: input.stage,
    snapshotCursor: input.snapshotCursor,
    nextPosition: input.nextPosition,
  };
}

export class CanonicalPullInventoryRunner {
  constructor(
    private readonly dependencies: InventoryTransport &
      PullCheckpointSink & {
        readonly hasStoredStorageItem: (
          storageItemId: Identifier<"StorageItem">,
        ) => Promise<boolean>;
      },
  ) {}

  async run(input: {
    readonly remote: {
      readonly remoteId: string;
      readonly hostedReplicaHandle: string;
      readonly inventoryPageSize: number;
      readonly enabled: boolean;
    };
    readonly job: CanonicalPullSynchronizationJob;
  }): Promise<CanonicalPullSynchronizationJob> {
    if (!input.remote.enabled) throw new TypeError("Cannot pull from a disabled Replica Remote");
    if (input.remote.remoteId !== input.job.remoteId) {
      throw new TypeError(
        "Synchronization Job Remote does not match the configured Replica Remote",
      );
    }
    if (input.job.state !== 1 || input.job.stage !== 1) {
      throw new TypeError("Pull inventory requires an active inventory-stage Synchronization Job");
    }

    let job = input.job;
    const knownStorageItems = new Set(
      job.quarantineReferences.map(({ storageItemId }) => identifierStorageKey(storageItemId)),
    );
    for (;;) {
      const requestedPosition = job.nextPosition;
      const page = await this.dependencies.inventory({
        replicaHandle: input.remote.hostedReplicaHandle,
        ...(job.snapshotCursor === null
          ? {}
          : {
              snapshotCursor: job.snapshotCursor,
              ...(requestedPosition === null ? {} : { position: requestedPosition }),
            }),
        limit: input.remote.inventoryPageSize,
      });
      if (job.snapshotCursor !== null && page.snapshotCursor !== job.snapshotCursor) {
        throw new TypeError("Replica Host inventory snapshot changed during one pull Job");
      }
      if (requestedPosition !== null && same(requestedPosition, page.nextPosition)) {
        throw new TypeError("Replica Host inventory page did not advance its position");
      }
      const pageStorageItems = new Set<string>();
      for (const inventoryItem of page.items) {
        const storageKey = identifierStorageKey(inventoryItem.storageItemId);
        if (pageStorageItems.has(storageKey)) {
          throw new TypeError("Replica Host inventory page repeats an opaque Storage Item");
        }
        pageStorageItems.add(storageKey);
        if (
          inventoryItem.storageClass !== COMPACT_STORAGE_CLASS ||
          knownStorageItems.has(storageKey)
        ) {
          continue;
        }
        if (await this.dependencies.hasStoredStorageItem(inventoryItem.storageItemId)) continue;
        const bytes = await readCompactEnvelope(
          await this.dependencies.item({
            replicaHandle: input.remote.hostedReplicaHandle,
            storageItemId: inventoryItem.storageItemId,
            byteLength: inventoryItem.byteLength,
          }),
          inventoryItem.byteLength,
        );
        verifyInventoryEnvelope(inventoryItem, bytes);
        const next = {
          ...nextInventoryJob(job, {
            stage: 1,
            snapshotCursor: page.snapshotCursor,
            nextPosition: requestedPosition,
          }),
          quarantineReferences: [
            ...job.quarantineReferences,
            { storageItemId: inventoryItem.storageItemId, locator: inventoryItem.locator },
          ],
          progress: {
            ...job.progress,
            discoveredItemCount: job.progress.discoveredItemCount + 1,
            downloadedItemCount: job.progress.downloadedItemCount + 1,
          },
        };
        await this.dependencies.recordQuarantine({ previous: job, next, bytes });
        job = next;
        knownStorageItems.add(storageKey);
      }
      const next = nextInventoryJob(job, {
        stage: page.nextPosition === null ? 2 : 1,
        snapshotCursor: page.snapshotCursor,
        nextPosition: page.nextPosition,
      });
      if (
        next.stage !== job.stage ||
        next.snapshotCursor !== job.snapshotCursor ||
        !same(next.nextPosition, job.nextPosition)
      ) {
        await this.dependencies.checkpoint({ previous: job, next });
        job = next;
      }
      if (page.nextPosition === null) return job;
    }
  }
}

import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  type CanonicalIndexedDb,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import {
  type CanonicalPullSynchronizationJob,
  decodeCanonicalPullSynchronizationJob,
  encodeCanonicalPullSynchronizationJob,
} from "./canonical-state";

function sameRealm(left: StorageRealm, right: StorageRealm): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function item(job: CanonicalPullSynchronizationJob, bytes: Uint8Array): NamespaceBytes {
  return {
    namespace: NAMESPACES.pullSynchronizationJob.key,
    scopeKey: identifierStorageKey(job.vaultId),
    itemKey: job.jobId,
    bytes,
  };
}

function assertSameJobContext(
  previous: CanonicalPullSynchronizationJob,
  next: CanonicalPullSynchronizationJob,
  realm: StorageRealm,
): void {
  if (
    previous.jobId !== next.jobId ||
    previous.remoteId !== next.remoteId ||
    !bytesEqual(previous.vaultId, next.vaultId) ||
    !sameRealm(previous.realm, next.realm) ||
    !sameRealm(previous.realm, realm)
  ) {
    throw new TypeError("Synchronization Job context cannot change during local resumption");
  }
}

function key(value: Identifier<"StorageItem">): string {
  return identifierStorageKey(value);
}

function newlyAddedQuarantine(
  previous: CanonicalPullSynchronizationJob,
  next: CanonicalPullSynchronizationJob,
): Identifier<"StorageItem"> {
  const previousIds = new Set(previous.quarantineStorageItemIds.map(key));
  const nextIds = new Set(next.quarantineStorageItemIds.map(key));
  if (![...previousIds].every((storageItemId) => nextIds.has(storageItemId))) {
    throw new TypeError(
      "Synchronization download checkpoints must retain prior Quarantine references",
    );
  }
  const added = next.quarantineStorageItemIds.filter((item) => !previousIds.has(key(item)));
  if (added.length !== 1 || added[0] === undefined) {
    throw new TypeError(
      "Synchronization Job must add exactly one Quarantine identity per download",
    );
  }
  return added[0];
}

export class CanonicalPullSynchronizationJobService {
  constructor(
    private readonly storage: CanonicalIndexedDb,
    private readonly realm: StorageRealm,
    private readonly createJobId: () => string = () => crypto.randomUUID(),
  ) {}

  async create(input: {
    readonly vaultId: CanonicalPullSynchronizationJob["vaultId"];
    readonly remoteId: string;
  }): Promise<CanonicalPullSynchronizationJob> {
    const job: CanonicalPullSynchronizationJob = {
      jobId: this.createJobId(),
      vaultId: input.vaultId,
      remoteId: input.remoteId,
      realm: this.realm,
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
    const bytes = encodeCanonicalPullSynchronizationJob(job);
    const stored = item(job, bytes);
    await this.storage.commitExecutionMutation({
      realm: this.realm,
      expectedAbsentItems: [
        {
          namespace: stored.namespace,
          scopeKey: stored.scopeKey,
          itemKey: stored.itemKey,
        },
      ],
      mutableItems: [stored],
    });
    return decodeCanonicalPullSynchronizationJob(bytes);
  }

  async recordQuarantine(input: {
    readonly previous: CanonicalPullSynchronizationJob;
    readonly next: CanonicalPullSynchronizationJob;
    readonly bytes: Uint8Array;
  }): Promise<void> {
    assertSameJobContext(input.previous, input.next, this.realm);
    const previousBytes = encodeCanonicalPullSynchronizationJob(input.previous);
    const nextBytes = encodeCanonicalPullSynchronizationJob(input.next);
    const storageItemId = newlyAddedQuarantine(input.previous, input.next);
    const envelope = decodeOpaqueEnvelope(input.bytes);
    if (!bytesEqual(envelope.storageItemId, storageItemId)) {
      throw new TypeError("Quarantine identity does not match its outer envelope bytes");
    }
    const quarantine: NamespaceBytes = {
      namespace: NAMESPACES.incomingQuarantine.key,
      scopeKey: input.next.remoteId,
      itemKey: identifierStorageKey(storageItemId),
      bytes: Uint8Array.from(input.bytes),
    };
    await this.storage.commitExecutionMutation({
      realm: this.realm,
      expectedMutableItems: [item(input.previous, previousBytes)],
      immutableItems: [quarantine],
      mutableItems: [item(input.next, nextBytes)],
    });
  }
}

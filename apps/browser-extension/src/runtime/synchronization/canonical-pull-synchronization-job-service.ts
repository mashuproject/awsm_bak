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
  type CanonicalQuarantineReference,
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

function key(value: CanonicalQuarantineReference): string {
  return identifierStorageKey(value.storageItemId);
}

function newlyAddedQuarantine(
  previous: CanonicalPullSynchronizationJob,
  next: CanonicalPullSynchronizationJob,
): CanonicalQuarantineReference {
  const previousByStorageItem = new Map(
    previous.quarantineReferences.map((reference) => [key(reference), reference]),
  );
  const nextByStorageItem = new Map(
    next.quarantineReferences.map((reference) => [key(reference), reference]),
  );
  for (const [storageItemId, previousReference] of previousByStorageItem) {
    const nextReference = nextByStorageItem.get(storageItemId);
    if (
      nextReference === undefined ||
      !bytesEqual(previousReference.locator, nextReference.locator)
    ) {
      throw new TypeError(
        "Synchronization download checkpoints must retain prior Quarantine references",
      );
    }
  }
  const added = next.quarantineReferences.filter(
    (reference) => !previousByStorageItem.has(key(reference)),
  );
  if (added.length !== 1 || added[0] === undefined) {
    throw new TypeError(
      "Synchronization Job must add exactly one Quarantine identity per download",
    );
  }
  return added[0];
}

function sameQuarantine(
  previous: CanonicalPullSynchronizationJob,
  next: CanonicalPullSynchronizationJob,
): boolean {
  if (previous.quarantineReferences.length !== next.quarantineReferences.length) {
    return false;
  }
  const previousByStorageItem = new Map(
    previous.quarantineReferences.map((reference) => [key(reference), reference]),
  );
  return next.quarantineReferences.every((reference) => {
    const previousReference = previousByStorageItem.get(key(reference));
    return (
      previousReference !== undefined && bytesEqual(previousReference.locator, reference.locator)
    );
  });
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
      quarantineReferences: [],
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

  async load(input: {
    readonly vaultId: CanonicalPullSynchronizationJob["vaultId"];
    readonly jobId: string;
  }): Promise<CanonicalPullSynchronizationJob> {
    const bytes = await this.storage.getBytes(this.realm, {
      namespace: NAMESPACES.pullSynchronizationJob.key,
      scopeKey: identifierStorageKey(input.vaultId),
      itemKey: input.jobId,
    });
    if (bytes === undefined) throw new TypeError("Synchronization Job is unavailable");
    const job = decodeCanonicalPullSynchronizationJob(bytes);
    if (
      job.jobId !== input.jobId ||
      !bytesEqual(job.vaultId, input.vaultId) ||
      !sameRealm(job.realm, this.realm)
    ) {
      throw new TypeError(
        "Synchronization Job storage identity does not match its protected state",
      );
    }
    return job;
  }

  async recordQuarantine(input: {
    readonly previous: CanonicalPullSynchronizationJob;
    readonly next: CanonicalPullSynchronizationJob;
    readonly bytes: Uint8Array;
  }): Promise<void> {
    assertSameJobContext(input.previous, input.next, this.realm);
    const previousBytes = encodeCanonicalPullSynchronizationJob(input.previous);
    const nextBytes = encodeCanonicalPullSynchronizationJob(input.next);
    const quarantineReference = newlyAddedQuarantine(input.previous, input.next);
    const envelope = decodeOpaqueEnvelope(input.bytes);
    if (!bytesEqual(envelope.storageItemId, quarantineReference.storageItemId)) {
      throw new TypeError("Quarantine identity does not match its outer envelope bytes");
    }
    const quarantine: NamespaceBytes = {
      namespace: NAMESPACES.incomingQuarantine.key,
      scopeKey: input.next.remoteId,
      itemKey: identifierStorageKey(quarantineReference.storageItemId),
      bytes: Uint8Array.from(input.bytes),
    };
    await this.storage.commitExecutionMutation({
      realm: this.realm,
      expectedMutableItems: [item(input.previous, previousBytes)],
      immutableItems: [quarantine],
      mutableItems: [item(input.next, nextBytes)],
    });
  }

  async checkpoint(input: {
    readonly previous: CanonicalPullSynchronizationJob;
    readonly next: CanonicalPullSynchronizationJob;
  }): Promise<void> {
    assertSameJobContext(input.previous, input.next, this.realm);
    if (!sameQuarantine(input.previous, input.next)) {
      throw new TypeError("An ordinary Synchronization checkpoint cannot alter Quarantine state");
    }
    const previousBytes = encodeCanonicalPullSynchronizationJob(input.previous);
    const nextBytes = encodeCanonicalPullSynchronizationJob(input.next);
    await this.storage.commitExecutionMutation({
      realm: this.realm,
      expectedMutableItems: [item(input.previous, previousBytes)],
      mutableItems: [item(input.next, nextBytes)],
    });
  }
}

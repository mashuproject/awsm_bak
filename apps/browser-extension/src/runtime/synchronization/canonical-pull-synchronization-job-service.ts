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

function exactPromotionReferences(
  previous: CanonicalPullSynchronizationJob,
  next: CanonicalPullSynchronizationJob,
  promoted: readonly CanonicalQuarantineReference[],
): void {
  if (previous.stage !== 2 || previous.state !== 1) {
    throw new TypeError("Synchronization promotion requires an active validation-stage Job");
  }
  if (
    next.snapshotCursor !== previous.snapshotCursor ||
    !(
      next.nextPosition === previous.nextPosition ||
      (next.nextPosition !== null &&
        previous.nextPosition !== null &&
        bytesEqual(next.nextPosition, previous.nextPosition))
    )
  ) {
    throw new TypeError("Synchronization promotion cannot change the completed inventory snapshot");
  }
  if (next.stage !== 2 && next.stage !== 3) {
    throw new TypeError("Synchronization promotion cannot return to inventory");
  }
  if (next.attempt !== previous.attempt || next.retryAfterMs !== null) {
    throw new TypeError("Synchronization promotion cannot change retry state");
  }
  if (
    next.progress.discoveredItemCount !== previous.progress.discoveredItemCount ||
    next.progress.downloadedItemCount !== previous.progress.downloadedItemCount ||
    next.progress.rejectedItemCount !== previous.progress.rejectedItemCount
  ) {
    throw new TypeError("Synchronization promotion cannot change inventory or rejection progress");
  }

  const previousByStorageItem = new Map(
    previous.quarantineReferences.map((reference) => [key(reference), reference]),
  );
  const nextByStorageItem = new Map(
    next.quarantineReferences.map((reference) => [key(reference), reference]),
  );
  for (const [storageItemId, reference] of nextByStorageItem) {
    const prior = previousByStorageItem.get(storageItemId);
    if (prior === undefined || !bytesEqual(prior.locator, reference.locator)) {
      throw new TypeError("Synchronization promotion cannot add or rewrite Quarantine references");
    }
  }
  const removed = previous.quarantineReferences.filter(
    (reference) => !nextByStorageItem.has(key(reference)),
  );
  const promotedByStorageItem = new Map(promoted.map((reference) => [key(reference), reference]));
  if (promotedByStorageItem.size !== promoted.length || promoted.length === 0) {
    throw new TypeError("Synchronization promotion requires one or more distinct references");
  }
  if (
    removed.length !== promotedByStorageItem.size ||
    removed.some((reference) => {
      const candidate = promotedByStorageItem.get(key(reference));
      return candidate === undefined || !bytesEqual(candidate.locator, reference.locator);
    })
  ) {
    throw new TypeError("Synchronization promotion must remove exactly its validated references");
  }
  if (next.progress.promotedItemCount !== previous.progress.promotedItemCount + removed.length) {
    throw new TypeError("Synchronization promotion progress does not match removed Quarantine");
  }
}

function assertPromotionItem(
  item: NamespaceBytes,
  vaultId: CanonicalPullSynchronizationJob["vaultId"],
): void {
  if (
    ![
      NAMESPACES.vaultRecord.key,
      NAMESPACES.keyEnvelope.key,
      NAMESPACES.vaultObject.key,
      NAMESPACES.featureManifest.key,
    ].includes(item.namespace as (typeof NAMESPACES)[keyof typeof NAMESPACES]["key"]) ||
    item.scopeKey !== identifierStorageKey(vaultId)
  ) {
    throw new TypeError("Synchronization promotion item is outside the selected Vault");
  }
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

  async findActive(input: {
    readonly vaultId: CanonicalPullSynchronizationJob["vaultId"];
    readonly remoteId: string;
  }): Promise<CanonicalPullSynchronizationJob | undefined> {
    const vaultKey = identifierStorageKey(input.vaultId);
    const entries = await this.storage.listBytes(
      this.realm,
      NAMESPACES.pullSynchronizationJob.key,
      vaultKey,
    );
    const active: CanonicalPullSynchronizationJob[] = [];
    for (const entry of entries) {
      const job = decodeCanonicalPullSynchronizationJob(entry.bytes);
      if (
        job.jobId !== entry.itemKey ||
        !bytesEqual(job.vaultId, input.vaultId) ||
        !sameRealm(job.realm, this.realm)
      ) {
        throw new TypeError(
          "Synchronization Job storage identity does not match its protected state",
        );
      }
      if (job.remoteId === input.remoteId && job.state !== 3) active.push(job);
    }
    if (active.length > 1) {
      throw new TypeError("One Vault and Replica Remote cannot retain multiple active pull Jobs");
    }
    return active[0];
  }

  async readQuarantine(input: {
    readonly remoteId: string;
    readonly storageItemId: CanonicalQuarantineReference["storageItemId"];
  }): Promise<Uint8Array | undefined> {
    return this.storage.getBytes(this.realm, {
      namespace: NAMESPACES.incomingQuarantine.key,
      scopeKey: input.remoteId,
      itemKey: identifierStorageKey(input.storageItemId),
    });
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

  async completeValidation(
    previous: CanonicalPullSynchronizationJob,
  ): Promise<CanonicalPullSynchronizationJob> {
    if (
      previous.stage !== 2 ||
      previous.state !== 1 ||
      previous.nextPosition !== null ||
      previous.quarantineReferences.length !== 0 ||
      previous.progress.downloadedItemCount !==
        previous.progress.promotedItemCount + previous.progress.rejectedItemCount
    ) {
      throw new TypeError("Only an empty fully validated Synchronization Job can complete");
    }
    const next: CanonicalPullSynchronizationJob = { ...previous, stage: 3, state: 3 };
    await this.checkpoint({ previous, next });
    return next;
  }

  /**
   * Commits a caller-validated Compact promotion with the exact local pull checkpoint it consumes.
   * This transport boundary does not authenticate Vault semantics; callers must complete that proof
   * before invoking it.
   */
  async promoteValidated(input: {
    readonly previous: CanonicalPullSynchronizationJob;
    readonly next: CanonicalPullSynchronizationJob;
    readonly promotedReferences: readonly CanonicalQuarantineReference[];
    readonly expectedReplicaState: Uint8Array;
    readonly nextReplicaState: NamespaceBytes;
    readonly immutableItems: readonly NamespaceBytes[];
    readonly resolutionItems: readonly NamespaceBytes[];
  }): Promise<void> {
    assertSameJobContext(input.previous, input.next, this.realm);
    encodeCanonicalPullSynchronizationJob(input.previous);
    const nextBytes = encodeCanonicalPullSynchronizationJob(input.next);
    exactPromotionReferences(input.previous, input.next, input.promotedReferences);

    const vaultKey = identifierStorageKey(input.next.vaultId);
    if (
      input.nextReplicaState.namespace !== NAMESPACES.replicaState.key ||
      input.nextReplicaState.scopeKey !== vaultKey ||
      input.nextReplicaState.itemKey !== "current"
    ) {
      throw new TypeError("Synchronization promotion Replica State is outside the selected Vault");
    }
    const promotedStorageItems = new Set(
      input.promotedReferences.map((reference) => identifierStorageKey(reference.storageItemId)),
    );
    if (input.immutableItems.length !== promotedStorageItems.size) {
      throw new TypeError("Synchronization promotion must persist every consumed Quarantine item");
    }
    const itemStorageItems = new Set<string>();
    for (const immutable of input.immutableItems) {
      assertPromotionItem(immutable, input.next.vaultId);
      const storageItemId = identifierStorageKey(
        decodeOpaqueEnvelope(immutable.bytes).storageItemId,
      );
      if (!promotedStorageItems.has(storageItemId) || itemStorageItems.has(storageItemId)) {
        throw new TypeError("Synchronization promotion bytes do not match consumed Quarantine");
      }
      itemStorageItems.add(storageItemId);
    }
    for (const resolution of input.resolutionItems) {
      if (
        resolution.namespace !== NAMESPACES.logicalResolution.key ||
        resolution.scopeKey !== vaultKey
      ) {
        throw new TypeError("Synchronization promotion resolution is outside the selected Vault");
      }
    }

    const previousBytes = encodeCanonicalPullSynchronizationJob(input.previous);
    await this.storage.commitReplicaMutation({
      realm: this.realm,
      expectedReplicaState: input.expectedReplicaState,
      nextReplicaState: input.nextReplicaState,
      expectedMutableItems: [item(input.previous, previousBytes)],
      immutableItems: input.immutableItems,
      mutableItems: [...input.resolutionItems, item(input.next, nextBytes)],
      deletedItems: [
        ...input.promotedReferences.map((reference) => ({
          namespace: NAMESPACES.incomingQuarantine.key,
          scopeKey: input.next.remoteId,
          itemKey: identifierStorageKey(reference.storageItemId),
        })),
        {
          namespace: NAMESPACES.libraryProjection.key,
          scopeKey: vaultKey,
          itemKey: "current",
        },
        {
          namespace: NAMESPACES.searchMaterialization.key,
          scopeKey: vaultKey,
          itemKey: "current",
        },
      ],
    });
  }
}

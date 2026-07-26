import type { CaptureJob } from "../../domain/contracts";
import { bytesEqual } from "../../domain/hash";
import { decodeVaultMetadata } from "../../runtime/vault/decode";
import { deleteDatabase, openDatabase, requestValue, transactionDone } from "./database";
import {
  decodeCaptureJob,
  decodeCommandOutcome,
  decodeExportJob,
  decodeStoredCollectionProjection,
  decodeStoredEvent,
  decodeStoredObject,
  decodeStoredProjection,
  decodeStoredVaultGeneration,
  decodeStoredVaultHead,
  decodeStoredVaultNameProjection,
} from "./decode";
import { StorageDriverError, storageError } from "./errors";
import { assertNoActiveImport } from "./import-repository";
import { vaultKey, vaultKeyRange, vaultSingletonKey } from "./keys";
import {
  type AtomicRegistrationV1,
  type CommandOutcomeV1,
  STORES,
  type StoreCounts,
  type StoredEvent,
  type StoredObjectV1,
} from "./schema";
import { decodeStorageReliefCheckpoint, decodeStorageReliefJob } from "./storage-relief-decode";
import { assertNoActiveStorageRelief, hasActiveStorageRelief } from "./storage-relief-lease";

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    return;
  }
}

async function assertNoActiveExport(transaction: IDBTransaction, vaultId: string): Promise<void> {
  const values = await requestValue(
    transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(vaultId)),
  );
  if (
    values.map(decodeExportJob).some((job) => job.state === "Created" || job.state === "Running")
  ) {
    throw Object.assign(new Error("Vault Export is in progress."), {
      id: "VAULT_BUSY",
    });
  }
}

export class IndexedDbDriver {
  private readonly databasePromise: Promise<IDBDatabase>;
  readonly databaseName: string;
  readonly vaultId: string;

  constructor(databaseName: string, vaultId: string) {
    this.databaseName = databaseName;
    this.vaultId = vaultId;
    this.databasePromise = openDatabase(databaseName);
  }

  private assertEventVault(event: StoredEvent): void {
    if (event.vaultId !== this.vaultId) {
      throw new Error("The Event does not belong to the scoped Vault.");
    }
  }

  private decodeScopedCaptureJob(value: unknown): CaptureJob {
    const job = decodeCaptureJob(value);
    if (job.vaultId !== this.vaultId) {
      throw storageError(new Error("The Capture Job does not belong to the scoped Vault."));
    }
    return job;
  }

  private sameStoredObject(left: StoredObjectV1, right: StoredObjectV1): boolean {
    if (left.objectType !== right.objectType) return false;
    if (left.objectType === "BundleDescriptor" && right.objectType === "BundleDescriptor")
      return bytesEqual(left.envelopeBytes, right.envelopeBytes);
    if (left.objectType === "Artifact" && right.objectType === "Artifact")
      return (
        left.keyEpochId === right.keyEpochId &&
        left.envelopeFormat === right.envelopeFormat &&
        left.envelopeByteLength === right.envelopeByteLength &&
        left.envelopeChecksumAlgorithm === right.envelopeChecksumAlgorithm &&
        bytesEqual(left.envelopeChecksum, right.envelopeChecksum)
      );
    return false;
  }

  async putImmutableObject(record: StoredObjectV1): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction([STORES.objects, STORES.importJobs], "readwrite");
    try {
      await assertNoActiveImport(transaction);
      const store = transaction.objectStore(STORES.objects);
      const request: IDBRequest<unknown> = store.get(vaultKey(this.vaultId, record.objectId));
      const existingValue = await requestValue(request);
      if (existingValue === undefined) {
        store.add(record, vaultKey(this.vaultId, record.objectId));
        await transactionDone(transaction);
        return;
      }
      const existing = decodeStoredObject(existingValue);
      await transactionDone(transaction);
      if (!this.sameStoredObject(existing, record)) {
        throw new StorageDriverError(
          "IMMUTABLE_OBJECT_CONFLICT",
          "An Object identifier already exists with different bytes.",
        );
      }
    } catch (error) {
      throw storageError(error);
    }
  }

  async commitRegistration(input: AtomicRegistrationV1): Promise<CommandOutcomeV1> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.commandOutcomes,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.importJobs,
        STORES.vaultHead,
        STORES.storageReliefJobs,
      ],
      "readwrite",
    );
    const outcomes = transaction.objectStore(STORES.commandOutcomes);
    try {
      this.assertEventVault(input.event);
      const objectIds = input.objects.map((object) => object.objectId);
      const artifactIds = objectIds.slice(1);
      if (
        input.objects.length < 2 ||
        input.objects[0]?.objectType !== "BundleDescriptor" ||
        input.objects.slice(1).some((object) => object.objectType !== "Artifact") ||
        new Set(objectIds).size !== objectIds.length ||
        artifactIds.join("\n") !== [...artifactIds].toSorted().join("\n") ||
        [...objectIds].toSorted().join("\n") !== input.event.referencedObjectIds.join("\n") ||
        input.outcome.descriptorObjectId !== input.objects[0].objectId ||
        input.graph.bundleId !== input.outcome.bundleId ||
        input.graph.descriptorObjectId !== input.objects[0].objectId ||
        input.graph.artifactObjectIds.join("\n") !== artifactIds.join("\n")
      ) {
        throw new Error("The registration does not contain an exact canonical Bundle graph.");
      }
      await assertNoActiveExport(transaction, this.vaultId);
      await assertNoActiveImport(transaction);
      await assertNoActiveStorageRelief(transaction, this.vaultId);
      if (
        (await requestValue(
          transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(this.vaultId)),
        )) !== 0
      ) {
        throw new Error("Vault Vacuum is in progress. Retry the capture.");
      }
      const headStore = transaction.objectStore(STORES.vaultHead);
      const head = (await requestValue(headStore.get(vaultSingletonKey(this.vaultId, "active")))) as
        | import("./schema").StoredVaultHeadV1
        | undefined;
      if (head === undefined) throw new Error("The active Vault Generation is missing.");
      const existingRequest: IDBRequest<unknown> = outcomes.get(
        vaultKey(this.vaultId, input.outcome.commandId),
      );
      const existing = await requestValue(existingRequest);
      if (existing !== undefined) {
        await transactionDone(transaction);
        return decodeCommandOutcome(existing);
      }
      const objectStore = transaction.objectStore(STORES.objects);
      for (const object of input.objects)
        objectStore.add(object, vaultKey(this.vaultId, object.objectId));
      transaction
        .objectStore(STORES.events)
        .add(input.event, vaultKey(this.vaultId, input.event.eventId));
      transaction
        .objectStore(STORES.libraryProjection)
        .add(input.projection, vaultKey(this.vaultId, input.projection.bundleId));
      outcomes.add(input.outcome, vaultKey(this.vaultId, input.outcome.commandId));
      headStore.put(
        {
          ...head,
          appendedObjectIds: [...head.appendedObjectIds, ...objectIds].toSorted(),
          appendedEventIds: [...head.appendedEventIds, input.event.eventId].toSorted(),
        },
        vaultSingletonKey(this.vaultId, "active"),
      );
      await transactionDone(transaction);
      return input.outcome;
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitStaleEpochCaptureReplays(input: {
    readonly expectedHead: import("./schema").StoredVaultHeadV1;
    readonly retainedObjectIds: readonly string[];
    readonly retainedEventIds: readonly string[];
    readonly replays: readonly {
      readonly oldBundleId: string;
      readonly oldEventId: string;
      readonly registration: AtomicRegistrationV1;
    }[];
  }): Promise<void> {
    const retainedObjectIds = [...input.retainedObjectIds].toSorted();
    const retainedEventIds = [...input.retainedEventIds].toSorted();
    const newObjectIds = input.replays
      .flatMap((replay) => replay.registration.objects.map((object) => object.objectId))
      .toSorted();
    const newEventIds = input.replays.map((replay) => replay.registration.event.eventId).toSorted();
    if (
      input.expectedHead.vaultId !== this.vaultId ||
      new Set(retainedObjectIds).size !== retainedObjectIds.length ||
      new Set(retainedEventIds).size !== retainedEventIds.length ||
      new Set(newObjectIds).size !== newObjectIds.length ||
      new Set(newEventIds).size !== newEventIds.length ||
      retainedObjectIds.some((id) => !input.expectedHead.appendedObjectIds.includes(id)) ||
      retainedEventIds.some((id) => !input.expectedHead.appendedEventIds.includes(id)) ||
      input.replays.some(
        (replay) =>
          !input.expectedHead.appendedEventIds.includes(replay.oldEventId) ||
          replay.registration.event.vaultId !== this.vaultId,
      )
    )
      throw storageError(new Error("Stale epoch replay closure is inconsistent."));
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.commandOutcomes,
        STORES.vaultHead,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.importJobs,
        STORES.storageReliefJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveExport(transaction, this.vaultId);
      await assertNoActiveImport(transaction);
      await assertNoActiveStorageRelief(transaction, this.vaultId);
      if (
        (await requestValue(
          transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(this.vaultId)),
        )) !== 0
      )
        throw Object.assign(new Error("Vault Vacuum is in progress."), {
          id: "VAULT_BUSY",
        });
      const headStore = transaction.objectStore(STORES.vaultHead);
      const storedHead = await requestValue(
        headStore.get(vaultSingletonKey(this.vaultId, "active")),
      );
      const current = storedHead === undefined ? undefined : decodeStoredVaultHead(storedHead);
      if (
        current === undefined ||
        current.generationId !== input.expectedHead.generationId ||
        current.generationNumber !== input.expectedHead.generationNumber ||
        current.appendedObjectIds.join("\n") !== input.expectedHead.appendedObjectIds.join("\n") ||
        current.appendedEventIds.join("\n") !== input.expectedHead.appendedEventIds.join("\n")
      )
        throw Object.assign(new Error("Vault changed during stale epoch replay."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      for (const replay of input.replays) {
        for (const object of replay.registration.objects)
          transaction
            .objectStore(STORES.objects)
            .add(object, vaultKey(this.vaultId, object.objectId));
        transaction
          .objectStore(STORES.events)
          .add(
            replay.registration.event,
            vaultKey(this.vaultId, replay.registration.event.eventId),
          );
        transaction
          .objectStore(STORES.libraryProjection)
          .delete(vaultKey(this.vaultId, replay.oldBundleId));
        transaction
          .objectStore(STORES.libraryProjection)
          .add(
            replay.registration.projection,
            vaultKey(this.vaultId, replay.registration.projection.bundleId),
          );
        transaction
          .objectStore(STORES.commandOutcomes)
          .add(
            replay.registration.outcome,
            vaultKey(this.vaultId, replay.registration.outcome.commandId),
          );
      }
      headStore.put(
        {
          ...current,
          appendedObjectIds: [...retainedObjectIds, ...newObjectIds].toSorted(),
          appendedEventIds: [...retainedEventIds, ...newEventIds].toSorted(),
        },
        vaultSingletonKey(this.vaultId, "active"),
      );
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async hasObject(objectId: string): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.objects, "readonly");
    const request = transaction.objectStore(STORES.objects).count(vaultKey(this.vaultId, objectId));
    const count = await requestValue(request);
    await transactionDone(transaction);
    return count === 1;
  }

  async clearLibraryProjection(): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.libraryProjection, STORES.collectionProjection, STORES.importJobs],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      transaction.objectStore(STORES.libraryProjection).delete(vaultKeyRange(this.vaultId));
      transaction.objectStore(STORES.collectionProjection).delete(vaultKeyRange(this.vaultId));
      await transactionDone(transaction);
    } catch (error) {
      throw storageError(error);
    }
  }

  async replaceLibraryProjections(
    projections: readonly import("./schema").StoredProjectionV1[],
    collectionProjection: import("./schema").StoredCollectionProjectionV1,
    vaultNameProjection: import("./schema").StoredVaultNameProjectionV1,
  ): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.libraryProjection,
        STORES.collectionProjection,
        STORES.vaultNameProjection,
        STORES.vacuumJobs,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      if (
        (await requestValue(
          transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(this.vaultId)),
        )) !== 0
      ) {
        throw new Error("Vault Vacuum is in progress. Retry the Projection rebuild.");
      }
      const itemStore = transaction.objectStore(STORES.libraryProjection);
      itemStore.delete(vaultKeyRange(this.vaultId));
      for (const projection of projections)
        itemStore.add(projection, vaultKey(this.vaultId, projection.bundleId));
      const collectionStore = transaction.objectStore(STORES.collectionProjection);
      collectionStore.delete(vaultKeyRange(this.vaultId));
      collectionStore.add(collectionProjection, vaultSingletonKey(this.vaultId, "active"));
      if (vaultNameProjection.vaultId !== this.vaultId) {
        throw new Error("Vault Name Projection belongs to another Vault.");
      }
      transaction
        .objectStore(STORES.vaultNameProjection)
        .put(vaultNameProjection, vaultSingletonKey(this.vaultId, "active"));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitLibraryState(
    event: StoredEvent,
    projections: readonly import("./schema").StoredProjectionV1[],
  ): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.events,
        STORES.libraryProjection,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.vaultHead,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      this.assertEventVault(event);
      await assertNoActiveImport(transaction);
      await assertNoActiveExport(transaction, this.vaultId);
      if (
        (await requestValue(
          transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(this.vaultId)),
        )) !== 0
      ) {
        throw new Error("Vault Vacuum is in progress. Retry the Library change.");
      }
      const headStore = transaction.objectStore(STORES.vaultHead);
      const head = (await requestValue(headStore.get(vaultSingletonKey(this.vaultId, "active")))) as
        | import("./schema").StoredVaultHeadV1
        | undefined;
      if (head === undefined) throw new Error("The active Vault Generation is missing.");
      transaction.objectStore(STORES.events).add(event, vaultKey(this.vaultId, event.eventId));
      const projectionStore = transaction.objectStore(STORES.libraryProjection);
      for (const projection of projections)
        projectionStore.put(projection, vaultKey(this.vaultId, projection.bundleId));
      headStore.put(
        {
          ...head,
          appendedEventIds: [...head.appendedEventIds, event.eventId].toSorted(),
        },
        vaultSingletonKey(this.vaultId, "active"),
      );
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitCollectionOperation(input: {
    readonly event: import("./schema").StoredEvent;
    readonly projections: readonly import("./schema").StoredProjectionV1[];
    readonly collectionProjection?: import("./schema").StoredCollectionProjectionV1;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.events,
        STORES.libraryProjection,
        STORES.collectionProjection,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.vaultHead,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      this.assertEventVault(input.event);
      await assertNoActiveImport(transaction);
      await assertNoActiveExport(transaction, this.vaultId);
      if (
        (await requestValue(
          transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(this.vaultId)),
        )) !== 0
      ) {
        throw new Error("Vault Vacuum is in progress. Retry the Collection change.");
      }
      const headStore = transaction.objectStore(STORES.vaultHead);
      const head = (await requestValue(headStore.get(vaultSingletonKey(this.vaultId, "active")))) as
        | import("./schema").StoredVaultHeadV1
        | undefined;
      if (head === undefined) throw new Error("The active Vault Generation is missing.");
      transaction
        .objectStore(STORES.events)
        .add(input.event, vaultKey(this.vaultId, input.event.eventId));
      const itemStore = transaction.objectStore(STORES.libraryProjection);
      for (const projection of input.projections)
        itemStore.put(projection, vaultKey(this.vaultId, projection.bundleId));
      if (input.collectionProjection !== undefined) {
        transaction
          .objectStore(STORES.collectionProjection)
          .put(input.collectionProjection, vaultSingletonKey(this.vaultId, "active"));
      }
      headStore.put(
        {
          ...head,
          appendedEventIds: [...head.appendedEventIds, input.event.eventId].toSorted(),
        },
        vaultSingletonKey(this.vaultId, "active"),
      );
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async saveCaptureJob(value: CaptureJob): Promise<void> {
    const job = this.decodeScopedCaptureJob(value);
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.captureJobs, STORES.exportJobs, STORES.importJobs, STORES.storageReliefJobs],
      "readwrite",
    );
    const done = transactionDone(transaction);
    if (job.state === "Created" || job.state === "Running") {
      await assertNoActiveExport(transaction, this.vaultId);
      await assertNoActiveImport(transaction);
      await assertNoActiveStorageRelief(transaction, this.vaultId);
    }
    transaction.objectStore(STORES.captureJobs).put(job, vaultKey(this.vaultId, job.jobId));
    try {
      await done;
    } catch (error) {
      throw storageError(error);
    }
  }

  async getCaptureJob(jobId: string): Promise<CaptureJob | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.captureJobs, "readonly");
    const done = transactionDone(transaction);
    const value = await requestValue(
      transaction.objectStore(STORES.captureJobs).get(vaultKey(this.vaultId, jobId)),
    );
    await done;
    return value === undefined ? undefined : this.decodeScopedCaptureJob(value);
  }

  async latestCaptureJob(): Promise<CaptureJob | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.captureJobs, "readonly");
    const done = transactionDone(transaction);
    const values = await requestValue(
      transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(this.vaultId)),
    );
    await done;
    return values
      .map((value) => this.decodeScopedCaptureJob(value))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async dismissCaptureNotice(jobId: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction([STORES.captureJobs, STORES.importJobs], "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORES.captureJobs);
    try {
      await assertNoActiveImport(transaction);
      const value = await requestValue(store.get(vaultKey(this.vaultId, jobId)));
      if (value === undefined) throw new Error("Capture job does not exist");
      const job = this.decodeScopedCaptureJob(value);
      if (job.state !== "Succeeded")
        throw new Error("Only completed capture notices can be dismissed");
      store.put({ ...job, noticeDismissed: true }, vaultKey(this.vaultId, job.jobId));
      await done;
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async findCommandOutcome(commandId: string): Promise<CommandOutcomeV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.commandOutcomes, "readonly");
    const done = transactionDone(transaction);
    const value = await requestValue(
      transaction.objectStore(STORES.commandOutcomes).get(vaultKey(this.vaultId, commandId)),
    );
    await done;
    return value === undefined ? undefined : decodeCommandOutcome(value);
  }

  async listEncryptedProjections(): Promise<readonly import("./schema").StoredProjectionV1[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.libraryProjection, "readonly");
    const done = transactionDone(transaction);
    const values = await requestValue(
      transaction.objectStore(STORES.libraryProjection).getAll(vaultKeyRange(this.vaultId)),
    );
    await done;
    return values.map(decodeStoredProjection);
  }

  async getCollectionProjection(): Promise<
    import("./schema").StoredCollectionProjectionV1 | undefined
  > {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.collectionProjection, "readonly");
    const value = await requestValue(
      transaction
        .objectStore(STORES.collectionProjection)
        .get(vaultSingletonKey(this.vaultId, "active")),
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : decodeStoredCollectionProjection(value);
  }

  async getStoredObject(objectId: string): Promise<StoredObjectV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.objects, "readonly");
    const done = transactionDone(transaction);
    const value = await requestValue(
      transaction.objectStore(STORES.objects).get(vaultKey(this.vaultId, objectId)),
    );
    await done;
    return value === undefined ? undefined : decodeStoredObject(value);
  }

  async listStoredObjects(): Promise<readonly StoredObjectV1[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.objects, "readonly");
    const done = transactionDone(transaction);
    const values = await requestValue(
      transaction.objectStore(STORES.objects).getAll(vaultKeyRange(this.vaultId)),
    );
    await done;
    return values.map(decodeStoredObject);
  }

  async listStoredEvents(): Promise<readonly StoredEvent[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.events, "readonly");
    const done = transactionDone(transaction);
    const values = await requestValue(
      transaction.objectStore(STORES.events).getAll(vaultKeyRange(this.vaultId)),
    );
    await done;
    return values.map((value) => {
      const event = decodeStoredEvent(value);
      this.assertEventVault(event);
      return event;
    });
  }

  async getStoredEvent(eventId: string): Promise<StoredEvent | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.events, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.events).get(vaultKey(this.vaultId, eventId)),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const event = decodeStoredEvent(value);
    this.assertEventVault(event);
    return event;
  }

  async listAuthoritativeIds(): Promise<{
    readonly objectIds: readonly string[];
    readonly eventIds: readonly string[];
  }> {
    const database = await this.databasePromise;
    const transaction = database.transaction([STORES.objects, STORES.events], "readonly");
    const [objectKeys, eventKeys] = await Promise.all([
      requestValue(transaction.objectStore(STORES.objects).getAllKeys(vaultKeyRange(this.vaultId))),
      requestValue(transaction.objectStore(STORES.events).getAllKeys(vaultKeyRange(this.vaultId))),
    ]);
    await transactionDone(transaction);
    const scopedId = (key: IDBValidKey): string => {
      if (
        !Array.isArray(key) ||
        key.length !== 2 ||
        key[0] !== this.vaultId ||
        typeof key[1] !== "string"
      ) {
        throw storageError(new Error("Authoritative key is outside the scoped Vault."));
      }
      return key[1];
    };
    return {
      objectIds: objectKeys.map(scopedId).toSorted(),
      eventIds: eventKeys.map(scopedId).toSorted(),
    };
  }

  async commitVacuum(input: {
    readonly jobId: string;
    readonly objectIds: readonly string[];
    readonly eventIds: readonly string[];
    readonly eventsToAdd: readonly StoredEvent[];
    readonly bundleIds: readonly string[];
    readonly expectedGenerationId?: string;
    readonly generation: import("./schema").StoredVaultGenerationV1;
    readonly head: import("./schema").StoredVaultHeadV1;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.commandOutcomes,
        STORES.vaultGenerations,
        STORES.vaultHead,
        STORES.vacuumJobs,
        STORES.importJobs,
        STORES.artifactAvailability,
        STORES.storageReliefJobs,
        STORES.storageReliefCheckpoints,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      await assertNoActiveStorageRelief(transaction, this.vaultId);
      for (const event of input.eventsToAdd) this.assertEventVault(event);
      const vacuumJobs = transaction.objectStore(STORES.vacuumJobs);
      const job = (await requestValue(vacuumJobs.get(vaultKey(this.vaultId, input.jobId)))) as
        | import("./schema").StoredVacuumJobV1
        | undefined;
      if (job === undefined || job.sourceGenerationId !== input.expectedGenerationId) {
        throw new Error("The Vault Vacuum lease is missing or invalid.");
      }
      const headStore = transaction.objectStore(STORES.vaultHead);
      const currentHead = (await requestValue(
        headStore.get(vaultSingletonKey(this.vaultId, "active")),
      )) as import("./schema").StoredVaultHeadV1 | undefined;
      if (currentHead?.generationId !== input.expectedGenerationId) {
        throw new Error("The active Vault Generation changed during Vacuum.");
      }
      const objects = transaction.objectStore(STORES.objects);
      for (const objectId of input.objectIds) objects.delete(vaultKey(this.vaultId, objectId));
      const removedObjectIds = new Set(input.objectIds);
      const availability = transaction.objectStore(STORES.artifactAvailability);
      for (const objectId of removedObjectIds)
        availability.delete(vaultKey(this.vaultId, objectId));
      const checkpoints = transaction.objectStore(STORES.storageReliefCheckpoints);
      const checkpointValues = await requestValue(checkpoints.getAll(vaultKeyRange(this.vaultId)));
      const decodedCheckpoints = checkpointValues.map(decodeStorageReliefCheckpoint);
      const affectedJobIds = new Set(
        decodedCheckpoints
          .filter((checkpoint) => removedObjectIds.has(checkpoint.artifactObjectId))
          .map((checkpoint) => checkpoint.jobId),
      );
      if (affectedJobIds.size > 0) {
        const jobs = transaction.objectStore(STORES.storageReliefJobs);
        const jobValues = await requestValue(jobs.getAll(vaultKeyRange(this.vaultId)));
        for (const value of jobValues) {
          const reliefJob = decodeStorageReliefJob(value);
          if (!affectedJobIds.has(reliefJob.jobId)) continue;
          if (
            reliefJob.state !== "Succeeded" &&
            reliefJob.state !== "Failed" &&
            reliefJob.state !== "Cancelled"
          )
            throw new Error("Vault Vacuum conflicts with active storage relief.");
          jobs.delete(vaultKey(this.vaultId, reliefJob.jobId));
          for (const checkpoint of decodedCheckpoints)
            if (checkpoint.jobId === reliefJob.jobId)
              checkpoints.delete([this.vaultId, checkpoint.jobId, checkpoint.artifactObjectId]);
        }
      }
      const events = transaction.objectStore(STORES.events);
      for (const eventId of input.eventIds) events.delete(vaultKey(this.vaultId, eventId));
      for (const event of input.eventsToAdd)
        events.add(event, vaultKey(this.vaultId, event.eventId));
      const projections = transaction.objectStore(STORES.libraryProjection);
      for (const bundleId of input.bundleIds) projections.delete(vaultKey(this.vaultId, bundleId));
      const outcomes = transaction.objectStore(STORES.commandOutcomes);
      const outcomeValues = await requestValue(outcomes.getAll(vaultKeyRange(this.vaultId)));
      for (const value of outcomeValues) {
        const outcome = decodeCommandOutcome(value);
        if (input.bundleIds.includes(outcome.bundleId))
          outcomes.delete(vaultKey(this.vaultId, outcome.commandId));
      }
      const generations = transaction.objectStore(STORES.vaultGenerations);
      generations.delete(vaultKeyRange(this.vaultId));
      generations.add(input.generation, vaultKey(this.vaultId, input.generation.generationId));
      headStore.put(input.head, vaultSingletonKey(this.vaultId, "active"));
      vacuumJobs.delete(vaultKey(this.vaultId, input.jobId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async acquireVacuum(
    jobId: string,
    createdAt: string,
  ): Promise<import("./schema").StoredVaultHeadV1> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.vaultHead,
        STORES.storageReliefJobs,
        STORES.vacuumJobs,
        STORES.captureJobs,
        STORES.exportJobs,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      await assertNoActiveStorageRelief(transaction, this.vaultId);
      const jobs = transaction.objectStore(STORES.vacuumJobs);
      if ((await requestValue(jobs.count(vaultKeyRange(this.vaultId)))) !== 0)
        throw new Error("Vault Vacuum is already in progress.");
      const captureJobs = await requestValue(
        transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(this.vaultId)),
      );
      if (
        captureJobs.some((value) => {
          const job = this.decodeScopedCaptureJob(value);
          return job.state === "Created" || job.state === "Running";
        })
      ) {
        throw Object.assign(new Error("Capture is in progress."), {
          id: "VAULT_BUSY",
        });
      }
      const exportJobs = await requestValue(
        transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(this.vaultId)),
      );
      if (
        exportJobs
          .map(decodeExportJob)
          .some((job) => job.state === "Created" || job.state === "Running")
      ) {
        throw Object.assign(new Error("Export is in progress."), {
          id: "VAULT_BUSY",
        });
      }
      const head = (await requestValue(
        transaction.objectStore(STORES.vaultHead).get(vaultSingletonKey(this.vaultId, "active")),
      )) as import("./schema").StoredVaultHeadV1 | undefined;
      if (head === undefined) throw new Error("The active Vault Generation is missing.");
      jobs.add(
        {
          version: 1,
          jobId,
          sourceGenerationId: head.generationId,
          stage: "Preflight",
          createdAt,
        },
        vaultKey(this.vaultId, jobId),
      );
      await transactionDone(transaction);
      return head;
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async releaseVacuum(jobId: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction([STORES.vacuumJobs, STORES.importJobs], "readwrite");
    await assertNoActiveImport(transaction);
    const store = transaction.objectStore(STORES.vacuumJobs);
    const job = (await requestValue(store.get(vaultKey(this.vaultId, jobId)))) as
      | import("./schema").StoredVacuumJobV1
      | undefined;
    if (job?.stage !== "ActivateRemote" && job?.stage !== "ActivateLocal")
      store.delete(vaultKey(this.vaultId, jobId));
    await transactionDone(transaction);
  }

  async updateVacuumStage(
    jobId: string,
    stage: import("./schema").StoredVacuumJobV1["stage"],
  ): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction([STORES.vacuumJobs, STORES.importJobs], "readwrite");
    await assertNoActiveImport(transaction);
    const store = transaction.objectStore(STORES.vacuumJobs);
    const value = (await requestValue(store.get(vaultKey(this.vaultId, jobId)))) as
      | import("./schema").StoredVacuumJobV1
      | undefined;
    if (value === undefined) {
      abortTransaction(transaction);
      throw storageError(new Error("Vault Vacuum lease is missing."));
    }
    store.put({ ...value, stage }, vaultKey(this.vaultId, jobId));
    await transactionDone(transaction);
  }

  async persistSynchronizedVacuumCandidate(
    jobId: string,
    candidate: import("../../runtime/library/vacuum").VacuumCandidate,
  ): Promise<void> {
    if (candidate.jobId !== jobId || candidate.expectedGenerationId === undefined)
      throw storageError(new Error("Synchronized Vacuum candidate is incomplete."));
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vacuumJobs, "readwrite");
    const store = transaction.objectStore(STORES.vacuumJobs);
    const value = (await requestValue(store.get(vaultKey(this.vaultId, jobId)))) as
      | import("./schema").StoredVacuumJobV1
      | undefined;
    if (value === undefined || value.sourceGenerationId !== candidate.expectedGenerationId) {
      abortTransaction(transaction);
      throw storageError(new Error("Synchronized Vacuum lease is missing or stale."));
    }
    store.put({ ...value, stage: "ActivateRemote", candidate }, vaultKey(this.vaultId, jobId));
    await transactionDone(transaction);
  }

  async markSynchronizedVacuumActivated(jobId: string, headCursor: number): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vacuumJobs, "readwrite");
    const store = transaction.objectStore(STORES.vacuumJobs);
    const value = (await requestValue(store.get(vaultKey(this.vaultId, jobId)))) as
      | import("./schema").StoredVacuumJobV1
      | undefined;
    if (
      value?.stage !== "ActivateRemote" ||
      value.candidate === undefined ||
      !Number.isSafeInteger(headCursor) ||
      headCursor < 0
    ) {
      abortTransaction(transaction);
      throw storageError(new Error("Synchronized Vacuum activation is inconsistent."));
    }
    store.put(
      { ...value, stage: "ActivateLocal", activatedHeadCursor: headCursor },
      vaultKey(this.vaultId, jobId),
    );
    await transactionDone(transaction);
  }

  async latestVacuumJob(): Promise<import("./schema").StoredVacuumJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vacuumJobs, "readonly");
    const values = (await requestValue(
      transaction.objectStore(STORES.vacuumJobs).getAll(vaultKeyRange(this.vaultId)),
    )) as import("./schema").StoredVacuumJobV1[];
    await transactionDone(transaction);
    if (values.length > 1) throw storageError(new Error("Multiple Vault Vacuum leases exist."));
    return values[0];
  }

  async getVaultGeneration(
    generationId: string,
  ): Promise<import("./schema").StoredVaultGenerationV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultGenerations, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.vaultGenerations).get(vaultKey(this.vaultId, generationId)),
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : decodeStoredVaultGeneration(value);
  }

  async reconcileInterruptedVacuum(): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vacuumJobs, "readwrite");
    const store = transaction.objectStore(STORES.vacuumJobs);
    const jobs = (await requestValue(
      store.getAll(vaultKeyRange(this.vaultId)),
    )) as import("./schema").StoredVacuumJobV1[];
    for (const job of jobs) {
      if (job.stage !== "ActivateRemote" && job.stage !== "ActivateLocal")
        store.delete(vaultKey(this.vaultId, job.jobId));
    }
    await transactionDone(transaction);
  }

  async discardSynchronizedVacuum(jobId: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vacuumJobs, "readwrite");
    transaction.objectStore(STORES.vacuumJobs).delete(vaultKey(this.vaultId, jobId));
    await transactionDone(transaction);
  }

  async acquireExport(
    job: import("./schema").ExportJobV1,
  ): Promise<import("./schema").StoredVaultHeadV1> {
    if (job.vaultId !== this.vaultId || job.state !== "Created") {
      throw storageError(new Error("Invalid Export Job context."));
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.workspaceMetadata,
        STORES.vaultMetadata,
        STORES.exportJobs,
        STORES.captureJobs,
        STORES.vacuumJobs,
        STORES.importJobs,
        STORES.vaultHead,
        STORES.storageReliefJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      await assertNoActiveStorageRelief(transaction, this.vaultId);
      const [workspaceValue, metadataValue, exports, captures, vacuumCount, head] =
        await Promise.all([
          requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
          requestValue(
            transaction
              .objectStore(STORES.vaultMetadata)
              .get(vaultSingletonKey(this.vaultId, "metadata")),
          ),
          requestValue(
            transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(this.vaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(this.vaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(this.vaultId)),
          ),
          requestValue(
            transaction
              .objectStore(STORES.vaultHead)
              .get(vaultSingletonKey(this.vaultId, "active")),
          ),
        ]);
      if (
        typeof workspaceValue !== "object" ||
        workspaceValue === null ||
        !("activeVaultId" in workspaceValue) ||
        workspaceValue.activeVaultId !== this.vaultId
      ) {
        throw Object.assign(new Error("The active Vault changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      }
      if (metadataValue === undefined || decodeVaultMetadata(metadataValue).manuallyLocked) {
        throw Object.assign(new Error("Vault is locked."), {
          id: "VAULT_LOCKED",
        });
      }
      if (
        vacuumCount !== 0 ||
        captures
          .map((value) => this.decodeScopedCaptureJob(value))
          .some((candidate) => candidate.state === "Created" || candidate.state === "Running") ||
        exports
          .map(decodeExportJob)
          .some((candidate) => candidate.state === "Created" || candidate.state === "Running")
      )
        throw Object.assign(new Error("Vault is busy."), { id: "VAULT_BUSY" });
      if (head === undefined) throw new Error("Active Vault head is missing.");
      const scopedHead = decodeStoredVaultHead(head);
      if (scopedHead.vaultId !== this.vaultId) throw new Error("Active Vault head is cross-Vault.");
      transaction.objectStore(STORES.exportJobs).add(job, vaultKey(this.vaultId, job.jobId));
      await transactionDone(transaction);
      return scopedHead;
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async updateExportJob(job: import("./schema").ExportJobV1): Promise<void> {
    const decoded = decodeExportJob(job);
    if (decoded.vaultId !== this.vaultId)
      throw storageError(new Error("Export Job is cross-Vault."));
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.exportJobs, "readwrite");
    const store = transaction.objectStore(STORES.exportJobs);
    try {
      const currentValue = await requestValue(store.get(vaultKey(this.vaultId, decoded.jobId)));
      if (currentValue === undefined) throw new Error("Export Job is missing.");
      const current = decodeExportJob(currentValue);
      if (
        current.state === "Succeeded" ||
        current.state === "Failed" ||
        current.state === "Cancelled"
      ) {
        throw new Error("Export Job is already terminal.");
      }
      store.put(decoded, vaultKey(this.vaultId, decoded.jobId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async latestExportJob(): Promise<import("./schema").ExportJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.exportJobs, "readonly");
    const values = await requestValue(
      transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(this.vaultId)),
    );
    await transactionDone(transaction);
    return values
      .map(decodeExportJob)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async requestExportCancellation(
    jobId: string,
    updatedAt: string,
  ): Promise<import("./schema").ExportJobV1> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.exportJobs, "readwrite");
    const store = transaction.objectStore(STORES.exportJobs);
    try {
      const value = await requestValue(store.get(vaultKey(this.vaultId, jobId)));
      if (value === undefined) throw new Error("Export Job is missing.");
      const job = decodeExportJob(value);
      if (job.state !== "Created" && job.state !== "Running")
        throw new Error("Export Job is terminal.");
      const next = { ...job, cancellationRequested: true, updatedAt };
      store.put(next, vaultKey(this.vaultId, jobId));
      await transactionDone(transaction);
      return next;
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async reconcileInterruptedExports(updatedAt: string): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.exportJobs, "readwrite");
    const store = transaction.objectStore(STORES.exportJobs);
    const values = await requestValue(store.getAll(vaultKeyRange(this.vaultId)));
    let changed = false;
    for (const value of values) {
      const job = decodeExportJob(value);
      if (job.state !== "Created" && job.state !== "Running") continue;
      store.put(
        { ...job, state: "Failed", updatedAt, errorId: "EXPORT_INTERRUPTED" },
        vaultKey(this.vaultId, job.jobId),
      );
      changed = true;
    }
    await transactionDone(transaction);
    return changed;
  }

  async managementBusy(): Promise<"Capture" | "Vacuum" | "Export" | "Storage relief" | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.captureJobs, STORES.vacuumJobs, STORES.exportJobs, STORES.storageReliefJobs],
      "readonly",
    );
    const [captureValues, vacuumCount, exportValues, storageRelief] = await Promise.all([
      requestValue(transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(this.vaultId))),
      requestValue(transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(this.vaultId))),
      requestValue(transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(this.vaultId))),
      hasActiveStorageRelief(transaction, this.vaultId),
    ]);
    await transactionDone(transaction);
    if (storageRelief) return "Storage relief";
    if (vacuumCount !== 0) return "Vacuum";
    if (
      exportValues
        .map(decodeExportJob)
        .some((job) => job.state === "Created" || job.state === "Running")
    )
      return "Export";
    return captureValues.some((value) => {
      const job = this.decodeScopedCaptureJob(value);
      return job.state === "Created" || job.state === "Running";
    })
      ? "Capture"
      : undefined;
  }

  async getVaultHead(): Promise<import("./schema").StoredVaultHeadV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultHead, "readonly");
    const done = transactionDone(transaction);
    const value = (await requestValue(
      transaction.objectStore(STORES.vaultHead).get(vaultSingletonKey(this.vaultId, "active")),
    )) as import("./schema").StoredVaultHeadV1 | undefined;
    await done;
    if (value === undefined) return undefined;
    const head = decodeStoredVaultHead(value);
    if (head.vaultId !== this.vaultId) throw storageError(new Error("Vault head is cross-Vault."));
    return head;
  }

  async getVaultNameProjection(): Promise<
    import("./schema").StoredVaultNameProjectionV1 | undefined
  > {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultNameProjection, "readonly");
    const value = await requestValue(
      transaction
        .objectStore(STORES.vaultNameProjection)
        .get(vaultSingletonKey(this.vaultId, "active")),
    );
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    const projection = decodeStoredVaultNameProjection(value);
    if (projection.vaultId !== this.vaultId) {
      throw storageError(new Error("Vault Name Projection belongs to another Vault."));
    }
    return projection;
  }

  async reconcileInterruptedJobs(updatedAt: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.captureJobs, STORES.commandOutcomes],
      "readwrite",
    );
    const done = transactionDone(transaction);
    const jobsStore = transaction.objectStore(STORES.captureJobs);
    const outcomesStore = transaction.objectStore(STORES.commandOutcomes);
    try {
      const values = await requestValue(jobsStore.getAll(vaultKeyRange(this.vaultId)));
      for (const value of values) {
        const job = this.decodeScopedCaptureJob(value);
        if (job.state !== "Running") continue;
        const outcome = await requestValue(
          outcomesStore.get(vaultKey(this.vaultId, job.commandId)),
        );
        const reconciled: CaptureJob =
          outcome === undefined
            ? {
                ...job,
                state: "Failed",
                updatedAt,
                errorId: "CAPTURE_INTERRUPTED",
              }
            : { ...job, state: "Succeeded", stage: "Commit", updatedAt };
        jobsStore.put(reconciled, vaultKey(this.vaultId, reconciled.jobId));
      }
      await done;
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async counts(): Promise<StoreCounts> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.objects, STORES.events, STORES.libraryProjection, STORES.commandOutcomes],
      "readonly",
    );
    const [objects, events, projections, outcomes] = await Promise.all([
      requestValue(transaction.objectStore(STORES.objects).count(vaultKeyRange(this.vaultId))),
      requestValue(transaction.objectStore(STORES.events).count(vaultKeyRange(this.vaultId))),
      requestValue(
        transaction.objectStore(STORES.libraryProjection).count(vaultKeyRange(this.vaultId)),
      ),
      requestValue(
        transaction.objectStore(STORES.commandOutcomes).count(vaultKeyRange(this.vaultId)),
      ),
    ]);
    await transactionDone(transaction);
    return { objects, events, projections, outcomes };
  }

  async deleteDatabase(): Promise<void> {
    await deleteDatabase(this.databaseName, await this.databasePromise);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}

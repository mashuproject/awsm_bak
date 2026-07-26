import {
  type CreateStorageReliefJobInput,
  createStorageReliefJob,
} from "./create-storage-relief-job";
import { abortTransaction, openDatabase, requestValue, transactionDone } from "./database";
import { storageError } from "./errors";
import { vaultKey, vaultKeyRange } from "./keys";
import { saveStorageReliefJob } from "./save-storage-relief-job";
import { DATABASE_NAME, STORES } from "./schema";
import {
  decodeStorageReliefCheckpoint,
  decodeStorageReliefJob,
  decodeStoredRemoteOnlyArtifact,
} from "./storage-relief-decode";
import { assertCheckpointSetMatchesJob } from "./storage-relief-repository-guards";
import type {
  StorageReliefCheckpointV1,
  StorageReliefJobV1,
  StoredRemoteOnlyArtifactV1,
} from "./storage-relief-schema";
import {
  aggregateStorageReliefCheckpoints,
  assertStorageReliefCheckpointTransition,
} from "./storage-relief-state";

function checkpointRange(vaultId: string, jobId: string): IDBKeyRange {
  return IDBKeyRange.bound([vaultId, jobId], [vaultId, jobId, []]);
}

function checkpointKey(value: StorageReliefCheckpointV1): [string, string, string] {
  return [value.vaultId, value.jobId, value.artifactObjectId];
}

function withAggregate(
  job: StorageReliefJobV1,
  checkpoints: readonly StorageReliefCheckpointV1[],
  updatedAt: string,
): StorageReliefJobV1 {
  return decodeStorageReliefJob({
    ...job,
    ...aggregateStorageReliefCheckpoints(checkpoints),
    updatedAt,
  });
}

export class IndexedDbStorageReliefRepository {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  async createStorageReliefJob(input: CreateStorageReliefJobInput): Promise<void> {
    await createStorageReliefJob(await this.databasePromise, input);
  }

  async saveStorageReliefJob(job: StorageReliefJobV1): Promise<void> {
    await saveStorageReliefJob(await this.databasePromise, job);
  }

  async latestStorageReliefJob(vaultId: string): Promise<StorageReliefJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.storageReliefJobs, STORES.storageReliefCheckpoints],
      "readonly",
    );
    const values = await requestValue(
      transaction.objectStore(STORES.storageReliefJobs).getAll(vaultKeyRange(vaultId)),
    );
    const jobs = values.map(decodeStorageReliefJob);
    if (jobs.length > 1) throw storageError(new Error("Multiple storage-relief Jobs exist."));
    const job = jobs[0];
    if (job !== undefined) {
      const checkpointValues = await requestValue(
        transaction
          .objectStore(STORES.storageReliefCheckpoints)
          .getAll(checkpointRange(vaultId, job.jobId)),
      );
      const checkpoints = checkpointValues.map(decodeStorageReliefCheckpoint);
      assertCheckpointSetMatchesJob(job, checkpoints);
    }
    await transactionDone(transaction);
    return job;
  }

  async listStorageReliefCheckpoints(
    vaultId: string,
    jobId: string,
  ): Promise<readonly StorageReliefCheckpointV1[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.storageReliefCheckpoints, "readonly");
    const values = await requestValue(
      transaction
        .objectStore(STORES.storageReliefCheckpoints)
        .getAll(checkpointRange(vaultId, jobId)),
    );
    await transactionDone(transaction);
    return values.map(decodeStorageReliefCheckpoint);
  }

  async saveStorageReliefCheckpoint(
    checkpoint: StorageReliefCheckpointV1,
    updatedAt: string,
  ): Promise<void> {
    const next = decodeStorageReliefCheckpoint(checkpoint);
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.storageReliefJobs, STORES.storageReliefCheckpoints],
      "readwrite",
    );
    try {
      const jobs = transaction.objectStore(STORES.storageReliefJobs);
      const checkpoints = transaction.objectStore(STORES.storageReliefCheckpoints);
      const [jobValue, currentValue, allValues] = await Promise.all([
        requestValue(jobs.get(vaultKey(next.vaultId, next.jobId))),
        requestValue(checkpoints.get(checkpointKey(next))),
        requestValue(checkpoints.getAll(checkpointRange(next.vaultId, next.jobId))),
      ]);
      if (jobValue === undefined || currentValue === undefined)
        throw new Error("Storage-relief Job or checkpoint is missing.");
      const job = decodeStorageReliefJob(jobValue);
      const current = decodeStorageReliefCheckpoint(currentValue);
      assertStorageReliefCheckpointTransition(current, next);
      const all = allValues.map(decodeStorageReliefCheckpoint);
      const replaced = all.map((value) =>
        value.artifactObjectId === next.artifactObjectId ? next : value,
      );
      checkpoints.put(next, checkpointKey(next));
      jobs.put(withAggregate(job, replaced, updatedAt), vaultKey(job.vaultId, job.jobId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      if (error instanceof Error) throw storageError(error);
      throw storageError(error);
    }
  }

  async markArtifactRemoteOnly(input: {
    readonly checkpoint: StorageReliefCheckpointV1;
    readonly availability: StoredRemoteOnlyArtifactV1;
    readonly updatedAt: string;
  }): Promise<void> {
    const next = decodeStorageReliefCheckpoint(input.checkpoint);
    const availability = decodeStoredRemoteOnlyArtifact(input.availability);
    if (
      next.state !== "Evicted" ||
      availability.vaultId !== next.vaultId ||
      availability.artifactObjectId !== next.artifactObjectId
    )
      throw storageError(new Error("Remote-only availability does not match the checkpoint."));
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.storageReliefJobs, STORES.storageReliefCheckpoints, STORES.artifactAvailability],
      "readwrite",
    );
    try {
      const jobs = transaction.objectStore(STORES.storageReliefJobs);
      const checkpoints = transaction.objectStore(STORES.storageReliefCheckpoints);
      const [jobValue, currentValue, allValues] = await Promise.all([
        requestValue(jobs.get(vaultKey(next.vaultId, next.jobId))),
        requestValue(checkpoints.get(checkpointKey(next))),
        requestValue(checkpoints.getAll(checkpointRange(next.vaultId, next.jobId))),
      ]);
      if (jobValue === undefined || currentValue === undefined)
        throw new Error("Storage-relief Job or checkpoint is missing.");
      const current = decodeStorageReliefCheckpoint(currentValue);
      assertStorageReliefCheckpointTransition(current, next);
      const all = allValues
        .map(decodeStorageReliefCheckpoint)
        .map((value) => (value.artifactObjectId === next.artifactObjectId ? next : value));
      const job = withAggregate(decodeStorageReliefJob(jobValue), all, input.updatedAt);
      checkpoints.put(next, checkpointKey(next));
      jobs.put(job, vaultKey(job.vaultId, job.jobId));
      transaction
        .objectStore(STORES.artifactAvailability)
        .put(availability, vaultKey(availability.vaultId, availability.artifactObjectId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      if (error instanceof Error) throw storageError(error);
      throw storageError(error);
    }
  }

  async clearArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.artifactAvailability, "readwrite");
    transaction
      .objectStore(STORES.artifactAvailability)
      .delete(vaultKey(vaultId, artifactObjectId));
    await transactionDone(transaction);
  }

  async listRemoteOnlyArtifacts(vaultId: string): Promise<readonly StoredRemoteOnlyArtifactV1[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.artifactAvailability, "readonly");
    const values = await requestValue(
      transaction.objectStore(STORES.artifactAvailability).getAll(vaultKeyRange(vaultId)),
    );
    await transactionDone(transaction);
    return values.map(decodeStoredRemoteOnlyArtifact);
  }

  async isArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.artifactAvailability, "readonly");
    const count = await requestValue(
      transaction
        .objectStore(STORES.artifactAvailability)
        .count(vaultKey(vaultId, artifactObjectId)),
    );
    await transactionDone(transaction);
    return count === 1;
  }

  async requestStorageReliefCancellation(
    vaultId: string,
    jobId: string,
    updatedAt: string,
  ): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.storageReliefJobs, "readwrite");
    const store = transaction.objectStore(STORES.storageReliefJobs);
    const value = await requestValue(store.get(vaultKey(vaultId, jobId)));
    if (value === undefined) {
      await transactionDone(transaction);
      return false;
    }
    const job = decodeStorageReliefJob(value);
    if (job.state === "Succeeded" || job.state === "Failed" || job.state === "Cancelled") {
      await transactionDone(transaction);
      return false;
    }
    store.put({ ...job, cancellationRequested: true, updatedAt }, vaultKey(vaultId, jobId));
    await transactionDone(transaction);
    return true;
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}

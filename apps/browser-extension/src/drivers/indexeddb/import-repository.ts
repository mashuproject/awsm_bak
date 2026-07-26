import type { RuntimeErrorId } from "../../domain/contracts";
import { integer, timestamp, uuid } from "../../domain/validation";
import { openDatabase, requestValue, transactionDone } from "./database";
import { decodeCaptureJob, decodeExportJob, decodeImportJob } from "./decode";
import { storageError } from "./errors";
import { vaultKeyRange } from "./keys";
import { DATABASE_NAME, type ImportJobStage, type ImportJobV1, STORES } from "./schema";
import { hasActiveStorageRelief } from "./storage-relief-lease";

function active(job: ImportJobV1): boolean {
  return job.state === "Created" || job.state === "Running";
}

export async function assertNoActiveImport(transaction: IDBTransaction): Promise<void> {
  const values = await requestValue(transaction.objectStore(STORES.importJobs).getAll());
  if (values.map(decodeImportJob).some(active)) {
    throw Object.assign(new Error("Vault Import is in progress."), {
      id: "VAULT_BUSY",
    });
  }
}

export class IndexedDbImportRepository {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(readonly databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  async begin(input: {
    readonly jobId: string;
    readonly sourceByteLength: number;
    readonly createdAt: string;
  }): Promise<ImportJobV1> {
    const jobId = uuid(input.jobId, "beginVaultImport.jobId");
    const sourceByteLength = integer(input.sourceByteLength, "beginVaultImport.sourceByteLength");
    const createdAt = timestamp(input.createdAt, "beginVaultImport.createdAt");
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.workspaceMetadata,
        STORES.importJobs,
        STORES.captureJobs,
        STORES.exportJobs,
        STORES.vacuumJobs,
        STORES.storageReliefJobs,
      ],
      "readwrite",
    );
    try {
      const store = transaction.objectStore(STORES.importJobs);
      const existing = (await requestValue(store.getAll())).map(decodeImportJob);
      if (existing.some(active)) {
        throw Object.assign(new Error("Vault Import is already in progress."), {
          id: "VAULT_BUSY",
        });
      }
      const workspace = (await requestValue(
        transaction.objectStore(STORES.workspaceMetadata).get("local"),
      )) as { readonly activeVaultId?: string } | undefined;
      const activeVaultId = workspace?.activeVaultId;
      if (activeVaultId !== undefined) {
        const [captures, exports, vacuumCount, storageRelief] = await Promise.all([
          requestValue(
            transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(activeVaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(activeVaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(activeVaultId)),
          ),
          hasActiveStorageRelief(transaction, activeVaultId),
        ]);
        if (
          vacuumCount !== 0 ||
          storageRelief ||
          captures
            .map(decodeCaptureJob)
            .some((job) => job.state === "Created" || job.state === "Running") ||
          exports
            .map(decodeExportJob)
            .some((job) => job.state === "Created" || job.state === "Running")
        ) {
          throw Object.assign(new Error("The active Vault is busy."), {
            id: "VAULT_BUSY",
          });
        }
      }
      for (const candidate of existing) store.delete(candidate.jobId);
      const job: ImportJobV1 = {
        version: 1,
        jobId,
        state: "Created",
        stage: "Acquire",
        createdAt,
        updatedAt: createdAt,
        sourceByteLength,
        acquiredBytes: 0,
        completedEntries: 0,
        totalEntries: 0,
        processedBytes: 0,
        totalBytes: 0,
        cancellationRequested: false,
      };
      store.add(job, jobId);
      await transactionDone(transaction);
      return job;
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async latest(): Promise<ImportJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.importJobs, "readonly");
    const values = await requestValue(transaction.objectStore(STORES.importJobs).getAll());
    await transactionDone(transaction);
    return values
      .map(decodeImportJob)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async isBusy(): Promise<boolean> {
    const latest = await this.latest();
    return latest !== undefined && active(latest);
  }

  private async update(
    jobId: string,
    updatedAt: string,
    transform: (job: ImportJobV1) => ImportJobV1,
  ): Promise<ImportJobV1> {
    uuid(jobId, "importJob.jobId");
    timestamp(updatedAt, "importJob.updatedAt");
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.importJobs, "readwrite");
    const store = transaction.objectStore(STORES.importJobs);
    try {
      const value = await requestValue(store.get(jobId));
      if (value === undefined) throw new Error("Import Job is missing.");
      const next = decodeImportJob(transform(decodeImportJob(value)));
      store.put(next, jobId);
      await transactionDone(transaction);
      return next;
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async reportAcquired(
    jobId: string,
    acquiredBytes: number,
    updatedAt: string,
  ): Promise<ImportJobV1> {
    integer(acquiredBytes, "reportVaultImportProgress.acquiredBytes");
    return this.update(jobId, updatedAt, (job) => {
      if (job.state !== "Created" || job.stage !== "Acquire") {
        throw new Error("Import Job is not acquiring a source.");
      }
      if (acquiredBytes < job.acquiredBytes || acquiredBytes > job.sourceByteLength) {
        throw new Error("Import acquisition progress is outside its valid range.");
      }
      return { ...job, acquiredBytes, updatedAt };
    });
  }

  async completeStaging(
    jobId: string,
    stagedByteLength: number,
    updatedAt: string,
  ): Promise<ImportJobV1> {
    integer(stagedByteLength, "completeVaultImportStaging.stagedByteLength");
    return this.update(jobId, updatedAt, (job) => {
      if (
        job.state !== "Created" ||
        job.stage !== "Acquire" ||
        stagedByteLength !== job.sourceByteLength ||
        job.acquiredBytes !== job.sourceByteLength
      ) {
        throw new Error("The staged Import source is incomplete.");
      }
      return { ...job, stage: "Authenticate", updatedAt };
    });
  }

  async authenticationFailed(jobId: string, updatedAt: string): Promise<ImportJobV1> {
    return this.update(jobId, updatedAt, (job) => {
      if (job.state !== "Created" || job.stage !== "Authenticate") {
        throw new Error("Import Job is not awaiting authentication.");
      }
      return {
        ...job,
        completedEntries: 0,
        totalEntries: 0,
        processedBytes: 0,
        totalBytes: 0,
        updatedAt,
      };
    });
  }

  async authenticationSucceeded(
    jobId: string,
    destinationVaultId: string,
    updatedAt: string,
  ): Promise<ImportJobV1> {
    uuid(destinationVaultId, "importJob.destinationVaultId");
    return this.update(jobId, updatedAt, (job) => {
      if (job.state !== "Created" || job.stage !== "Authenticate") {
        throw new Error("Import Job is not awaiting authentication.");
      }
      return {
        ...job,
        state: "Running",
        stage: "Validate",
        destinationVaultId,
        completedEntries: 0,
        totalEntries: 0,
        processedBytes: 0,
        totalBytes: 0,
        updatedAt,
      };
    });
  }

  async advance(
    jobId: string,
    progress: {
      readonly stage: Exclude<ImportJobStage, "Acquire" | "Authenticate">;
      readonly completedEntries: number;
      readonly totalEntries: number;
      readonly processedBytes: number;
      readonly totalBytes: number;
      readonly updatedAt: string;
    },
  ): Promise<ImportJobV1> {
    return this.update(jobId, progress.updatedAt, (job) => {
      if (job.state !== "Running") throw new Error("Import Job is not running.");
      const stages = ["Validate", "Prepare", "Rebuild", "Commit"] as const;
      const currentStage = stages.indexOf(job.stage as (typeof stages)[number]);
      const nextStage = stages.indexOf(progress.stage);
      if (currentStage < 0 || nextStage < currentStage) {
        throw new Error("Import execution stage cannot move backward.");
      }
      if (
        nextStage === currentStage &&
        (progress.completedEntries < job.completedEntries ||
          progress.processedBytes < job.processedBytes ||
          progress.totalEntries !== job.totalEntries ||
          progress.totalBytes !== job.totalBytes)
      ) {
        throw new Error("Import execution progress cannot regress.");
      }
      return { ...job, ...progress };
    });
  }

  async reconcileInterrupted(updatedAt: string): Promise<boolean> {
    const latest = await this.latest();
    if (latest === undefined || !active(latest)) return false;
    await this.update(latest.jobId, updatedAt, (job) => ({
      ...job,
      state: "Failed",
      updatedAt,
      errorId: "IMPORT_INTERRUPTED",
    }));
    return true;
  }

  async fail(jobId: string, errorId: RuntimeErrorId, updatedAt: string): Promise<ImportJobV1> {
    return this.update(jobId, updatedAt, (job) => {
      if (!active(job)) return job;
      return { ...job, state: "Failed", errorId, updatedAt };
    });
  }

  async cancel(jobId: string, updatedAt: string): Promise<ImportJobV1> {
    uuid(jobId, "cancelVaultImport.jobId");
    timestamp(updatedAt, "cancelVaultImport.updatedAt");
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.importJobs, "readwrite");
    const store = transaction.objectStore(STORES.importJobs);
    try {
      const value = await requestValue(store.get(jobId));
      if (value === undefined) throw new Error("Import Job is missing.");
      const job = decodeImportJob(value);
      if (job.state === "Cancelled") {
        await transactionDone(transaction);
        return job;
      }
      if (!active(job)) throw new Error("Import Job is already terminal.");
      const next = decodeImportJob({
        ...job,
        state: "Cancelled",
        updatedAt,
        cancellationRequested: true,
      });
      store.put(next, jobId);
      await transactionDone(transaction);
      return next;
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}

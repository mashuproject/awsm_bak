import type { VaultRecordsV1, VaultRepository } from "../../runtime/vault/contracts";
import { decodeVaultRecords } from "../../runtime/vault/decode";
import { deleteDatabase, openDatabase, requestValue, transactionDone } from "./database";
import { decodeExportJob } from "./decode";
import { storageError } from "./errors";
import { assertNoActiveImport } from "./import-repository";
import { vaultKeyRange, vaultSingletonKey } from "./keys";
import { DATABASE_NAME, STORES } from "./schema";

export class IndexedDbVaultRepository implements VaultRepository {
  private readonly databasePromise: Promise<IDBDatabase>;
  readonly databaseName: string;

  constructor(databaseName = DATABASE_NAME) {
    this.databaseName = databaseName;
    this.databasePromise = openDatabase(databaseName);
  }

  async load(vaultId: string): Promise<VaultRecordsV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.vaultMetadata,
        STORES.keySlots,
        STORES.deviceKeys,
        STORES.vaultGenerations,
        STORES.vaultHead,
      ],
      "readonly",
    );
    try {
      const metadataRequest: IDBRequest<unknown> = transaction
        .objectStore(STORES.vaultMetadata)
        .get(vaultSingletonKey(vaultId, "metadata"));
      const deviceSlotRequest: IDBRequest<unknown> = transaction
        .objectStore(STORES.keySlots)
        .get(vaultSingletonKey(vaultId, "device"));
      const deviceKeyRequest: IDBRequest<unknown> = transaction
        .objectStore(STORES.deviceKeys)
        .get(vaultSingletonKey(vaultId, "device"));
      const generationsRequest: IDBRequest<unknown[]> = transaction
        .objectStore(STORES.vaultGenerations)
        .getAll(vaultKeyRange(vaultId));
      const headRequest: IDBRequest<unknown> = transaction
        .objectStore(STORES.vaultHead)
        .get(vaultSingletonKey(vaultId, "active"));
      const [metadata, deviceSlot, deviceKey, generations, head] = await Promise.all([
        requestValue(metadataRequest),
        requestValue(deviceSlotRequest),
        requestValue(deviceKeyRequest),
        requestValue(generationsRequest),
        requestValue(headRequest),
      ]);
      await transactionDone(transaction);
      if (metadata === undefined) {
        return undefined;
      }
      return decodeVaultRecords({
        metadata,
        deviceSlot,
        deviceKey,
        generations,
        head,
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  async setManualLock(vaultId: string, manuallyLocked: boolean): Promise<void> {
    const records = await this.load(vaultId);
    if (records === undefined) throw storageError(new Error("The scoped Vault does not exist"));
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultMetadata, STORES.exportJobs, STORES.importJobs],
      "readwrite",
    );
    await assertNoActiveImport(transaction);
    const exportValues = await requestValue(
      transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(vaultId)),
    );
    if (
      exportValues
        .map(decodeExportJob)
        .some((job) => job.state === "Created" || job.state === "Running")
    ) {
      transaction.abort();
      throw Object.assign(new Error("Vault Export is in progress."), { id: "VAULT_BUSY" });
    }
    transaction
      .objectStore(STORES.vaultMetadata)
      .put({ ...records.metadata, manuallyLocked }, vaultSingletonKey(vaultId, "metadata"));
    try {
      await transactionDone(transaction);
    } catch (error) {
      throw storageError(error);
    }
  }

  async deleteDatabase(): Promise<void> {
    await deleteDatabase(this.databaseName, await this.databasePromise);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}

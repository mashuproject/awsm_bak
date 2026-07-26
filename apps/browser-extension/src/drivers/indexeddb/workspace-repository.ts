import { DomainValidationError } from "../../domain/errors";
import {
  canonicalRecord,
  integer,
  literal,
  record,
  timestamp,
  uuid,
} from "../../domain/validation";
import type { InitialDeviceAuthority } from "../../runtime/recovery/initial-attachment";
import type { VaultRecordsV1 } from "../../runtime/vault/contracts";
import { decodeVaultMetadata, decodeVaultRecords } from "../../runtime/vault/decode";
import {
  decryptWorkspaceVaultName,
  type WorkspaceVaultNameCacheV1,
} from "../../runtime/vault/workspace-name-cache";
import { createWorkspaceNameCacheKey } from "../../runtime/vault/workspace-name-key";
import { deleteDatabase, openDatabase, requestValue, transactionDone } from "./database";
import {
  decodeExportJob,
  decodeImportJob,
  decodeStoredObject,
  decodeStoredVaultNameProjection,
} from "./decode";
import { prepareDeviceAuthorityStorage } from "./device-repository";
import { storageError } from "./errors";
import { assertNoActiveImport } from "./import-repository";
import { vaultKey, vaultKeyRange, vaultSingletonKey } from "./keys";
import {
  DATABASE_NAME,
  type ImportJobV1,
  STORES,
  type StoredCollectionProjectionV1,
  type StoredEvent,
  type StoredObjectV1,
  type StoredProjectionV1,
  type StoredVaultHeadV1,
  type StoredVaultNameProjectionV1,
  type SynchronizationJobV1,
  type VaultDirectoryEntryV1,
  type VaultReplacementJobV1,
  type WorkspaceMetadataV1,
  type WorkspaceRecordsV1,
} from "./schema";

export interface AtomicVaultCreateV1 {
  readonly expectedActiveVaultId?: string;
  readonly records: VaultRecordsV1;
  readonly event: StoredEvent;
  readonly projection: StoredVaultNameProjectionV1;
  readonly cache: WorkspaceVaultNameCacheV1;
}

export interface AtomicVaultSelect {
  readonly expectedActiveVaultId: string;
  readonly vaultId: string;
}

export interface AtomicVaultRename {
  readonly expectedActiveVaultId: string;
  readonly vaultId: string;
  readonly event: StoredEvent;
  readonly projection: StoredVaultNameProjectionV1;
  readonly cache: WorkspaceVaultNameCacheV1;
}

export interface ReplaceVaultNameCache {
  readonly expectedActiveVaultId: string;
  readonly vaultId: string;
  readonly cache: WorkspaceVaultNameCacheV1;
}

export interface AtomicVaultImport {
  readonly job: ImportJobV1;
  readonly records: VaultRecordsV1;
  readonly epochStorage: import("../../runtime/vault/contracts").PreparedVaultEpochStorage;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly libraryProjections: readonly StoredProjectionV1[];
  readonly collectionProjection: StoredCollectionProjectionV1;
  readonly vaultNameProjection: StoredVaultNameProjectionV1;
  readonly nameCache: WorkspaceVaultNameCacheV1;
  readonly preparedArtifactObjectIds: readonly string[];
}

export interface AtomicRemoteBootstrap {
  readonly job: SynchronizationJobV1;
  readonly records: VaultRecordsV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly libraryProjections: readonly StoredProjectionV1[];
  readonly collectionProjection: StoredCollectionProjectionV1;
  readonly vaultNameProjection: StoredVaultNameProjectionV1;
  readonly nameCache: WorkspaceVaultNameCacheV1;
  readonly preparedArtifactObjectIds: readonly string[];
}

export interface AtomicVaultReplacementStage {
  readonly job: VaultReplacementJobV1;
  readonly records: VaultRecordsV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly libraryProjections: readonly StoredProjectionV1[];
  readonly collectionProjection: StoredCollectionProjectionV1;
  readonly vaultNameProjection: StoredVaultNameProjectionV1;
  readonly preparedArtifactObjectIds: readonly string[];
}

export interface AtomicVaultReplacementPromotion {
  readonly job: VaultReplacementJobV1;
  readonly authority: InitialDeviceAuthority;
  readonly nameCache: WorkspaceVaultNameCacheV1;
  readonly promotedAt: string;
}

export interface VaultReplacementPromotionResult {
  readonly job: VaultReplacementJobV1;
  readonly removedSourceArtifactObjectIds: readonly string[];
}

export interface AtomicRemoteReconciliation {
  readonly expectedGenerationId: string;
  readonly expectedDeliveryCursor: number;
  readonly expectedLocalHead: StoredVaultHeadV1;
  readonly registration: import("./schema").StoredAccountVaultV1;
  readonly job: SynchronizationJobV1;
  readonly head: StoredVaultHeadV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly libraryProjections: readonly StoredProjectionV1[];
  readonly collectionProjection: StoredCollectionProjectionV1;
  readonly vaultNameProjection: StoredVaultNameProjectionV1;
  readonly nameCache: WorkspaceVaultNameCacheV1;
  readonly installedArtifactObjectIds: readonly string[];
}

export interface AtomicStaleDiscard {
  readonly job: SynchronizationJobV1;
  readonly expectedStaleGenerationId: string;
  readonly registration: import("./schema").StoredAccountVaultV1;
  readonly originalRecords: VaultRecordsV1;
  readonly remoteGeneration: import("./schema").StoredVaultGenerationV1;
  readonly remoteHead: StoredVaultHeadV1;
  readonly remoteEvents: readonly StoredEvent[];
  readonly remoteObjects: readonly StoredObjectV1[];
  readonly remoteLibraryProjections: readonly StoredProjectionV1[];
  readonly remoteCollectionProjection: StoredCollectionProjectionV1;
  readonly remoteVaultNameProjection: StoredVaultNameProjectionV1;
  readonly remoteNameCache: WorkspaceVaultNameCacheV1;
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.toSorted().join("\n") === expected.toSorted().join("\n");
}

function decodeWorkspaceMetadata(value: unknown): WorkspaceMetadataV1 {
  const input = canonicalRecord(value, "workspaceMetadata", [
    "version",
    "workspaceId",
    "createdAt",
    "activeVaultId",
  ]);
  return {
    version: literal(input.version, 1, "workspaceMetadata.version"),
    workspaceId: uuid(input.workspaceId, "workspaceMetadata.workspaceId"),
    createdAt: timestamp(input.createdAt, "workspaceMetadata.createdAt"),
    ...(input.activeVaultId === undefined
      ? {}
      : {
          activeVaultId: uuid(input.activeVaultId, "workspaceMetadata.activeVaultId"),
        }),
  };
}

function decodeNameCacheKey(value: unknown): CryptoKey {
  if (!(value instanceof CryptoKey) || value.extractable || value.algorithm.name !== "AES-GCM") {
    throw new DomainValidationError(
      "workspaceNameCacheKey",
      "must be a non-exportable AES-GCM Web Crypto key",
    );
  }
  if (!value.usages.includes("encrypt") || !value.usages.includes("decrypt")) {
    throw new DomainValidationError(
      "workspaceNameCacheKey",
      "must support encryption and decryption",
    );
  }
  return value;
}

function decodeDirectoryEntry(value: unknown): VaultDirectoryEntryV1 {
  const input = canonicalRecord(value, "vaultDirectoryEntry", ["version", "vaultId", "createdAt"]);
  return {
    version: literal(input.version, 1, "vaultDirectoryEntry.version"),
    vaultId: uuid(input.vaultId, "vaultDirectoryEntry.vaultId"),
    createdAt: timestamp(input.createdAt, "vaultDirectoryEntry.createdAt"),
  };
}

function decodeVaultHead(value: unknown): StoredVaultHeadV1 {
  const input = record(value, "vaultHead");
  const allowed = new Set([
    "version",
    "vaultId",
    "generationId",
    "generationNumber",
    "appendedObjectIds",
    "appendedEventIds",
  ]);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new DomainValidationError("vaultHead", "contains fields outside the canonical schema");
  }
  const ids = (value: unknown, field: string): readonly string[] => {
    if (!Array.isArray(value)) throw new DomainValidationError(field, "must be an array");
    const parsed = value.map((candidate, index) => uuid(candidate, `${field}[${index}]`));
    if (
      new Set(parsed).size !== parsed.length ||
      parsed.some((id, index) => id !== parsed.toSorted()[index])
    ) {
      throw new DomainValidationError(field, "must contain unique UUIDs in lexical order");
    }
    return parsed;
  };
  return {
    version: literal(input.version, 1, "vaultHead.version"),
    vaultId: uuid(input.vaultId, "vaultHead.vaultId"),
    generationId: uuid(input.generationId, "vaultHead.generationId"),
    generationNumber: integer(input.generationNumber, "vaultHead.generationNumber"),
    appendedObjectIds: ids(input.appendedObjectIds, "vaultHead.appendedObjectIds"),
    appendedEventIds: ids(input.appendedEventIds, "vaultHead.appendedEventIds"),
  };
}

function decodeNameCache(value: unknown): WorkspaceVaultNameCacheV1 {
  const input = canonicalRecord(value, "workspaceVaultNameCache", [
    "version",
    "vaultId",
    "sourceEventId",
    "nonce",
    "ciphertext",
  ]);
  if (!(input.nonce instanceof Uint8Array) || input.nonce.byteLength !== 12) {
    throw new DomainValidationError("workspaceVaultNameCache.nonce", "must be 12 bytes");
  }
  if (!(input.ciphertext instanceof Uint8Array) || input.ciphertext.byteLength < 17) {
    throw new DomainValidationError(
      "workspaceVaultNameCache.ciphertext",
      "must contain authenticated ciphertext",
    );
  }
  return {
    version: literal(input.version, 1, "workspaceVaultNameCache.version"),
    vaultId: uuid(input.vaultId, "workspaceVaultNameCache.vaultId"),
    sourceEventId: uuid(input.sourceEventId, "workspaceVaultNameCache.sourceEventId"),
    nonce: input.nonce,
    ciphertext: input.ciphertext,
  };
}

export class IndexedDbWorkspaceRepository {
  private readonly databasePromise: Promise<IDBDatabase>;
  readonly databaseName: string;

  constructor(databaseName = DATABASE_NAME) {
    this.databaseName = databaseName;
    this.databasePromise = openDatabase(databaseName);
  }

  async bootstrap(createdAt: string): Promise<WorkspaceRecordsV1> {
    const existing = await this.load();
    if (existing !== undefined) return existing;
    timestamp(createdAt, "workspaceMetadata.createdAt");
    const nameCacheKey = await createWorkspaceNameCacheKey();
    const metadata: WorkspaceMetadataV1 = {
      version: 1,
      workspaceId: crypto.randomUUID(),
      createdAt,
    };
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.workspaceMetadata, STORES.workspaceKeys],
      "readwrite",
    );
    try {
      transaction.objectStore(STORES.workspaceMetadata).add(metadata, "local");
      transaction.objectStore(STORES.workspaceKeys).add(nameCacheKey, "name-cache");
      await transactionDone(transaction);
      return { metadata, nameCacheKey };
    } catch (error) {
      transaction.abort();
      const raced = await this.load();
      if (raced !== undefined) return raced;
      throw storageError(error);
    }
  }

  async load(): Promise<WorkspaceRecordsV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.workspaceMetadata, STORES.workspaceKeys],
      "readonly",
    );
    try {
      const [metadataValue, keyValue] = await Promise.all([
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        requestValue(transaction.objectStore(STORES.workspaceKeys).get("name-cache")),
      ]);
      await transactionDone(transaction);
      if (metadataValue === undefined && keyValue === undefined) return undefined;
      if (metadataValue === undefined || keyValue === undefined) {
        throw new DomainValidationError("workspace", "is only partially initialized");
      }
      return {
        metadata: decodeWorkspaceMetadata(metadataValue),
        nameCacheKey: decodeNameCacheKey(keyValue),
      };
    } catch (error) {
      throw storageError(error);
    }
  }

  async listVaultDirectory(): Promise<readonly VaultDirectoryEntryV1[]> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultDirectory, "readonly");
    try {
      const values = await requestValue(transaction.objectStore(STORES.vaultDirectory).getAll());
      await transactionDone(transaction);
      return values.map(decodeDirectoryEntry);
    } catch (error) {
      throw storageError(error);
    }
  }

  async loadVaultStatus(
    vaultId: string,
  ): Promise<{ readonly manuallyLocked: boolean } | undefined> {
    uuid(vaultId, "vaultId");
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultMetadata, "readonly");
    try {
      const metadataValue = await requestValue(
        transaction.objectStore(STORES.vaultMetadata).get(vaultSingletonKey(vaultId, "metadata")),
      );
      await transactionDone(transaction);
      if (metadataValue === undefined) return undefined;
      const metadata = decodeVaultMetadata(metadataValue);
      return { manuallyLocked: metadata.manuallyLocked };
    } catch (error) {
      throw storageError(error);
    }
  }

  async readVaultName(key: CryptoKey, workspaceId: string, vaultId: string): Promise<string> {
    uuid(workspaceId, "workspaceId");
    uuid(vaultId, "vaultId");
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultNameCache, "readonly");
    try {
      const value = await requestValue(transaction.objectStore(STORES.vaultNameCache).get(vaultId));
      await transactionDone(transaction);
      if (value === undefined)
        throw new DomainValidationError("workspaceVaultNameCache", "is missing");
      const cache = decodeNameCache(value);
      if (cache.vaultId !== vaultId) {
        throw new DomainValidationError(
          "workspaceVaultNameCache.vaultId",
          "does not match its key",
        );
      }
      return await decryptWorkspaceVaultName(key, workspaceId, cache);
    } catch (error) {
      throw storageError(error);
    }
  }

  async commitVaultCreate(input: AtomicVaultCreateV1): Promise<void> {
    const vaultId = input.records.metadata.vaultId;
    if (
      input.event.vaultId !== vaultId ||
      input.projection.vaultId !== vaultId ||
      input.cache.vaultId !== vaultId ||
      input.event.eventId !== input.projection.sourceEventId ||
      input.event.eventId !== input.cache.sourceEventId
    ) {
      throw storageError(new Error("Atomic Vault creation records do not share one identity."));
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.workspaceMetadata,
        STORES.vaultDirectory,
        STORES.vaultNameCache,
        STORES.vaultNameProjection,
        STORES.vaultMetadata,
        STORES.keySlots,
        STORES.deviceKeys,
        STORES.events,
        STORES.captureJobs,
        STORES.vaultGenerations,
        STORES.vaultHead,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      const workspaceValue = await requestValue(
        transaction.objectStore(STORES.workspaceMetadata).get("local"),
      );
      if (workspaceValue === undefined) throw new Error("Workspace is not initialized.");
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      if (workspace.activeVaultId !== input.expectedActiveVaultId) {
        throw Object.assign(new Error("The active Vault changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      }
      const currentVaultId = workspace.activeVaultId;
      if (currentVaultId !== undefined) {
        const [captureJobs, vacuumJobs, exportJobs, previousMetadataValue] = await Promise.all([
          requestValue(
            transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(currentVaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.vacuumJobs).getAll(vaultKeyRange(currentVaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(currentVaultId)),
          ),
          requestValue(
            transaction
              .objectStore(STORES.vaultMetadata)
              .get(vaultSingletonKey(currentVaultId, "metadata")),
          ),
        ]);
        const captureBusy = captureJobs.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "state" in value &&
            (value.state === "Created" || value.state === "Running"),
        );
        const exportBusy = exportJobs
          .map(decodeExportJob)
          .some((job) => job.state === "Created" || job.state === "Running");
        if (captureBusy || vacuumJobs.length > 0 || exportBusy) {
          throw Object.assign(new Error("The active Vault is busy."), {
            id: "VAULT_BUSY",
          });
        }
        if (previousMetadataValue === undefined)
          throw new Error("Active Vault metadata is missing.");
        const previousMetadata = decodeVaultMetadata(previousMetadataValue);
        transaction
          .objectStore(STORES.vaultMetadata)
          .put(
            { ...previousMetadata, manuallyLocked: true },
            vaultSingletonKey(currentVaultId, "metadata"),
          );
      }
      const records = input.records;
      transaction
        .objectStore(STORES.vaultMetadata)
        .add(records.metadata, vaultSingletonKey(vaultId, "metadata"));
      transaction
        .objectStore(STORES.keySlots)
        .add(records.deviceSlot, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.deviceKeys)
        .add(records.deviceKey, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.vaultGenerations)
        .add(records.generation, vaultKey(vaultId, records.generation.generationId));
      transaction
        .objectStore(STORES.events)
        .add(input.event, vaultKey(vaultId, input.event.eventId));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .add(input.projection, vaultSingletonKey(vaultId, "active"));
      transaction.objectStore(STORES.vaultNameCache).add(input.cache, vaultId);
      transaction.objectStore(STORES.vaultDirectory).add(
        {
          version: 1,
          vaultId,
          createdAt: records.metadata.createdAt,
        } satisfies VaultDirectoryEntryV1,
        vaultId,
      );
      transaction
        .objectStore(STORES.vaultHead)
        .add(
          { ...records.head, appendedEventIds: [input.event.eventId] },
          vaultSingletonKey(vaultId, "active"),
        );
      transaction
        .objectStore(STORES.workspaceMetadata)
        .put({ ...workspace, activeVaultId: vaultId }, "local");
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async commitVaultSelect(input: AtomicVaultSelect): Promise<void> {
    uuid(input.expectedActiveVaultId, "selectActiveVault.expectedActiveVaultId");
    uuid(input.vaultId, "selectActiveVault.vaultId");
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.workspaceMetadata,
        STORES.vaultDirectory,
        STORES.vaultMetadata,
        STORES.captureJobs,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      const workspaceValue = await requestValue(
        transaction.objectStore(STORES.workspaceMetadata).get("local"),
      );
      if (workspaceValue === undefined) throw new Error("Workspace is not initialized.");
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      if (workspace.activeVaultId !== input.expectedActiveVaultId) {
        throw Object.assign(new Error("The active Vault changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      }
      if (input.vaultId === workspace.activeVaultId) {
        await transactionDone(transaction);
        return;
      }
      const previousVaultId = workspace.activeVaultId;
      if (previousVaultId === undefined) {
        throw Object.assign(new Error("No active Vault exists."), {
          id: "VAULT_NOT_FOUND",
        });
      }
      const [
        targetDirectory,
        targetMetadataValue,
        previousMetadataValue,
        captureJobs,
        vacuumJobs,
        exportJobs,
      ] = await Promise.all([
        requestValue(transaction.objectStore(STORES.vaultDirectory).get(input.vaultId)),
        requestValue(
          transaction
            .objectStore(STORES.vaultMetadata)
            .get(vaultSingletonKey(input.vaultId, "metadata")),
        ),
        requestValue(
          transaction
            .objectStore(STORES.vaultMetadata)
            .get(vaultSingletonKey(previousVaultId, "metadata")),
        ),
        requestValue(
          transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(previousVaultId)),
        ),
        requestValue(
          transaction.objectStore(STORES.vacuumJobs).getAll(vaultKeyRange(previousVaultId)),
        ),
        requestValue(
          transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(previousVaultId)),
        ),
      ]);
      if (targetDirectory === undefined || targetMetadataValue === undefined) {
        throw Object.assign(new Error("The selected Vault does not exist."), {
          id: "VAULT_NOT_FOUND",
        });
      }
      if (previousMetadataValue === undefined) throw new Error("Active Vault metadata is missing.");
      const captureBusy = captureJobs.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "state" in value &&
          (value.state === "Created" || value.state === "Running"),
      );
      const exportBusy = exportJobs
        .map(decodeExportJob)
        .some((job) => job.state === "Created" || job.state === "Running");
      if (captureBusy || vacuumJobs.length > 0 || exportBusy) {
        throw Object.assign(new Error("The active Vault is busy."), {
          id: "VAULT_BUSY",
        });
      }
      const targetMetadata = decodeVaultMetadata(targetMetadataValue);
      const previousMetadata = decodeVaultMetadata(previousMetadataValue);
      transaction
        .objectStore(STORES.vaultMetadata)
        .put(
          { ...previousMetadata, manuallyLocked: true },
          vaultSingletonKey(previousVaultId, "metadata"),
        );
      transaction
        .objectStore(STORES.vaultMetadata)
        .put(
          { ...targetMetadata, manuallyLocked: true },
          vaultSingletonKey(input.vaultId, "metadata"),
        );
      transaction
        .objectStore(STORES.workspaceMetadata)
        .put({ ...workspace, activeVaultId: input.vaultId }, "local");
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async commitVaultRename(input: AtomicVaultRename): Promise<void> {
    uuid(input.expectedActiveVaultId, "renameVault.expectedActiveVaultId");
    uuid(input.vaultId, "renameVault.vaultId");
    if (
      input.expectedActiveVaultId !== input.vaultId ||
      input.event.vaultId !== input.vaultId ||
      input.projection.vaultId !== input.vaultId ||
      input.cache.vaultId !== input.vaultId ||
      input.event.eventId !== input.projection.sourceEventId ||
      input.event.eventId !== input.cache.sourceEventId
    ) {
      throw Object.assign(new Error("Vault Rename records do not share one active identity."), {
        id: "VAULT_CONTEXT_CHANGED",
      });
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.workspaceMetadata,
        STORES.vaultMetadata,
        STORES.captureJobs,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.events,
        STORES.vaultNameProjection,
        STORES.vaultNameCache,
        STORES.vaultHead,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      const [workspaceValue, metadataValue, captureJobs, vacuumCount, exportJobs, headValue] =
        await Promise.all([
          requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
          requestValue(
            transaction
              .objectStore(STORES.vaultMetadata)
              .get(vaultSingletonKey(input.vaultId, "metadata")),
          ),
          requestValue(
            transaction.objectStore(STORES.captureJobs).getAll(vaultKeyRange(input.vaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.vacuumJobs).count(vaultKeyRange(input.vaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.exportJobs).getAll(vaultKeyRange(input.vaultId)),
          ),
          requestValue(
            transaction
              .objectStore(STORES.vaultHead)
              .get(vaultSingletonKey(input.vaultId, "active")),
          ),
        ]);
      if (workspaceValue === undefined) throw new Error("Workspace is not initialized.");
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      if (workspace.activeVaultId !== input.expectedActiveVaultId) {
        throw Object.assign(new Error("The active Vault changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      }
      if (metadataValue === undefined || headValue === undefined) {
        throw Object.assign(new Error("The active Vault does not exist."), {
          id: "VAULT_NOT_FOUND",
        });
      }
      const metadata = decodeVaultMetadata(metadataValue);
      if (metadata.manuallyLocked) {
        throw Object.assign(new Error("Unlock the Vault before renaming it."), {
          id: "VAULT_LOCKED",
        });
      }
      const captureBusy = captureJobs.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "state" in value &&
          (value.state === "Created" || value.state === "Running"),
      );
      const exportBusy = exportJobs
        .map(decodeExportJob)
        .some((job) => job.state === "Created" || job.state === "Running");
      if (captureBusy || vacuumCount !== 0 || exportBusy) {
        throw Object.assign(new Error("The active Vault is busy."), {
          id: "VAULT_BUSY",
        });
      }
      const head = decodeVaultHead(headValue);
      if (head.vaultId !== input.vaultId) throw new Error("Vault head identity mismatch.");
      transaction
        .objectStore(STORES.events)
        .add(input.event, vaultKey(input.vaultId, input.event.eventId));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .put(input.projection, vaultSingletonKey(input.vaultId, "active"));
      transaction.objectStore(STORES.vaultNameCache).put(input.cache, input.vaultId);
      transaction.objectStore(STORES.vaultHead).put(
        {
          ...head,
          appendedEventIds: [...head.appendedEventIds, input.event.eventId].toSorted(),
        },
        vaultSingletonKey(input.vaultId, "active"),
      );
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async replaceVaultNameCache(input: ReplaceVaultNameCache): Promise<void> {
    uuid(input.expectedActiveVaultId, "replaceVaultNameCache.expectedActiveVaultId");
    uuid(input.vaultId, "replaceVaultNameCache.vaultId");
    if (input.expectedActiveVaultId !== input.vaultId || input.cache.vaultId !== input.vaultId) {
      throw Object.assign(new Error("The active Vault changed."), {
        id: "VAULT_CONTEXT_CHANGED",
      });
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.workspaceMetadata,
        STORES.vaultDirectory,
        STORES.vaultNameProjection,
        STORES.vaultNameCache,
        STORES.importJobs,
      ],
      "readwrite",
    );
    try {
      await assertNoActiveImport(transaction);
      const [workspaceValue, directoryValue, projectionValue] = await Promise.all([
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        requestValue(transaction.objectStore(STORES.vaultDirectory).get(input.vaultId)),
        requestValue(
          transaction
            .objectStore(STORES.vaultNameProjection)
            .get(vaultSingletonKey(input.vaultId, "active")),
        ),
      ]);
      if (workspaceValue === undefined) throw new Error("Workspace is not initialized.");
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      if (workspace.activeVaultId !== input.expectedActiveVaultId) {
        throw Object.assign(new Error("The active Vault changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      }
      if (directoryValue === undefined || projectionValue === undefined) {
        throw Object.assign(new Error("The active Vault name state is unavailable."), {
          id: "VAULT_NOT_FOUND",
        });
      }
      const projection = decodeStoredVaultNameProjection(projectionValue);
      if (
        projection.vaultId !== input.vaultId ||
        projection.sourceEventId !== input.cache.sourceEventId
      ) {
        throw new Error("The Vault name cache does not match its authoritative Projection.");
      }
      transaction.objectStore(STORES.vaultNameCache).put(input.cache, input.vaultId);
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async commitVaultImport(input: AtomicVaultImport): Promise<void> {
    const records = decodeVaultRecords({
      metadata: input.records.metadata,
      deviceSlot: input.records.deviceSlot,
      deviceKey: input.records.deviceKey,
      generations: [input.records.generation],
      head: input.records.head,
    });
    const vaultId = records.metadata.vaultId;
    const eventIds = input.events.map((event) => event.eventId);
    const objectIds = input.objects.map((object) => object.objectId);
    const artifactIds = input.objects
      .filter((object) => object.objectType === "Artifact")
      .map((object) => object.objectId);
    if (
      input.job.state !== "Running" ||
      input.job.stage !== "Commit" ||
      input.job.cancellationRequested ||
      input.job.destinationVaultId !== vaultId ||
      !records.metadata.manuallyLocked ||
      records.head.vaultId !== vaultId ||
      records.head.generationId !== records.generation.generationId ||
      records.head.generationNumber !== records.generation.generationNumber ||
      input.events.some((event) => event.vaultId !== vaultId) ||
      new Set(eventIds).size !== eventIds.length ||
      new Set(objectIds).size !== objectIds.length ||
      !sameIds(eventIds, records.head.appendedEventIds) ||
      !sameIds(objectIds, records.head.appendedObjectIds) ||
      !sameIds(artifactIds, input.preparedArtifactObjectIds) ||
      input.collectionProjection.projectionId !== vaultId ||
      input.vaultNameProjection.vaultId !== vaultId ||
      input.nameCache.vaultId !== vaultId ||
      input.nameCache.sourceEventId !== input.vaultNameProjection.sourceEventId ||
      !eventIds.includes(input.vaultNameProjection.sourceEventId) ||
      input.epochStorage.epochs.length === 0 ||
      input.epochStorage.epochs.some(
        (epoch, ordinal) =>
          epoch.vaultId !== vaultId ||
          epoch.ordinal !== ordinal ||
          !(epoch.wrappedRootKey instanceof Uint8Array),
      ) ||
      new Set(input.epochStorage.epochs.map((epoch) => epoch.keyEpochId)).size !==
        input.epochStorage.epochs.length ||
      input.epochStorage.epochs.at(-1)?.keyEpochId !== records.metadata.activeKeyEpochId ||
      new Set(input.libraryProjections.map((projection) => projection.bundleId)).size !==
        input.libraryProjections.length
    ) {
      throw storageError(new Error("Atomic Vault Import records are inconsistent."));
    }
    const database = await this.databasePromise;
    const stores = [
      STORES.workspaceMetadata,
      STORES.vaultDirectory,
      STORES.vaultNameCache,
      STORES.vaultNameProjection,
      STORES.vaultMetadata,
      STORES.keySlots,
      STORES.deviceKeys,
      STORES.deviceLocalKeys,
      STORES.epochKeys,
      STORES.objects,
      STORES.events,
      STORES.libraryProjection,
      STORES.collectionProjection,
      STORES.vaultGenerations,
      STORES.vaultHead,
      STORES.importJobs,
    ];
    const transaction = database.transaction(stores, "readwrite");
    try {
      const [jobValue, workspaceValue, collisionCounts] = await Promise.all([
        requestValue(transaction.objectStore(STORES.importJobs).get(input.job.jobId)),
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        Promise.all([
          requestValue(transaction.objectStore(STORES.vaultDirectory).count(vaultId)),
          requestValue(transaction.objectStore(STORES.vaultNameCache).count(vaultId)),
          requestValue(
            transaction
              .objectStore(STORES.vaultNameProjection)
              .count(vaultSingletonKey(vaultId, "active")),
          ),
          requestValue(
            transaction
              .objectStore(STORES.vaultMetadata)
              .count(vaultSingletonKey(vaultId, "metadata")),
          ),
          requestValue(
            transaction.objectStore(STORES.keySlots).count(vaultSingletonKey(vaultId, "device")),
          ),
          requestValue(
            transaction.objectStore(STORES.deviceKeys).count(vaultSingletonKey(vaultId, "device")),
          ),
          requestValue(transaction.objectStore(STORES.deviceLocalKeys).count(`${vaultId}:wrap`)),
          requestValue(transaction.objectStore(STORES.epochKeys).count(vaultKeyRange(vaultId))),
          requestValue(transaction.objectStore(STORES.objects).count(vaultKeyRange(vaultId))),
          requestValue(transaction.objectStore(STORES.events).count(vaultKeyRange(vaultId))),
          requestValue(
            transaction.objectStore(STORES.libraryProjection).count(vaultKeyRange(vaultId)),
          ),
          requestValue(
            transaction
              .objectStore(STORES.collectionProjection)
              .count(vaultSingletonKey(vaultId, "active")),
          ),
          requestValue(
            transaction.objectStore(STORES.vaultGenerations).count(vaultKeyRange(vaultId)),
          ),
          requestValue(
            transaction.objectStore(STORES.vaultHead).count(vaultSingletonKey(vaultId, "active")),
          ),
        ]),
      ]);
      if (jobValue === undefined || workspaceValue === undefined) {
        throw new Error("Import Job or Workspace is missing.");
      }
      const storedJob = decodeImportJob(jobValue);
      if (
        storedJob.jobId !== input.job.jobId ||
        storedJob.state !== "Running" ||
        storedJob.stage !== "Commit" ||
        storedJob.cancellationRequested ||
        storedJob.destinationVaultId !== vaultId
      ) {
        throw Object.assign(new Error("Import Job ownership changed."), {
          id: "VAULT_BUSY",
        });
      }
      if (collisionCounts.some((count) => count !== 0)) {
        throw Object.assign(new Error("The imported Vault already exists."), {
          id: "VAULT_ALREADY_EXISTS",
        });
      }
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      transaction
        .objectStore(STORES.vaultMetadata)
        .add(records.metadata, vaultSingletonKey(vaultId, "metadata"));
      transaction
        .objectStore(STORES.keySlots)
        .add(records.deviceSlot, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.deviceKeys)
        .add(records.deviceKey, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.deviceLocalKeys)
        .add(input.epochStorage.wrappingKey, `${vaultId}:wrap`);
      for (const epoch of input.epochStorage.epochs) {
        if (epoch.vaultId !== vaultId) {
          throw new Error("Imported Vault epoch storage has mismatched ownership.");
        }
        transaction.objectStore(STORES.epochKeys).add(epoch, [vaultId, epoch.keyEpochId]);
      }
      transaction
        .objectStore(STORES.vaultGenerations)
        .add(records.generation, vaultKey(vaultId, records.generation.generationId));
      transaction
        .objectStore(STORES.vaultHead)
        .add(records.head, vaultSingletonKey(vaultId, "active"));
      for (const event of input.events) {
        transaction.objectStore(STORES.events).add(event, vaultKey(vaultId, event.eventId));
      }
      for (const object of input.objects) {
        transaction.objectStore(STORES.objects).add(object, vaultKey(vaultId, object.objectId));
      }
      for (const projection of input.libraryProjections) {
        transaction
          .objectStore(STORES.libraryProjection)
          .add(projection, vaultKey(vaultId, projection.bundleId));
      }
      transaction
        .objectStore(STORES.collectionProjection)
        .add(input.collectionProjection, vaultSingletonKey(vaultId, "active"));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .add(input.vaultNameProjection, vaultSingletonKey(vaultId, "active"));
      transaction.objectStore(STORES.vaultNameCache).add(input.nameCache, vaultId);
      transaction.objectStore(STORES.vaultDirectory).add(
        {
          version: 1,
          vaultId,
          createdAt: records.metadata.createdAt,
        } satisfies VaultDirectoryEntryV1,
        vaultId,
      );
      if (workspace.activeVaultId === undefined) {
        transaction
          .objectStore(STORES.workspaceMetadata)
          .put({ ...workspace, activeVaultId: vaultId }, "local");
      }
      transaction
        .objectStore(STORES.importJobs)
        .put({ ...storedJob, state: "Succeeded" }, storedJob.jobId);
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async commitRemoteBootstrap(input: AtomicRemoteBootstrap): Promise<void> {
    const records = decodeVaultRecords({
      metadata: input.records.metadata,
      deviceSlot: input.records.deviceSlot,
      deviceKey: input.records.deviceKey,
      generations: [input.records.generation],
      head: input.records.head,
    });
    const vaultId = records.metadata.vaultId;
    const eventIds = input.events.map((event) => event.eventId).toSorted();
    const objectIds = input.objects.map((object) => object.objectId).toSorted();
    const artifactIds = input.objects
      .filter((object) => object.objectType === "Artifact")
      .map((object) => object.objectId)
      .toSorted();
    if (
      input.job.state !== "Running" ||
      input.job.stage !== "ActivateLocal" ||
      input.job.vaultId !== vaultId ||
      input.job.generationId !== records.generation.generationId ||
      records.metadata.manuallyLocked ||
      records.head.vaultId !== vaultId ||
      records.head.generationId !== records.generation.generationId ||
      input.events.some((event) => event.vaultId !== vaultId) ||
      new Set(eventIds).size !== eventIds.length ||
      new Set(objectIds).size !== objectIds.length ||
      artifactIds.join("\n") !== [...input.preparedArtifactObjectIds].toSorted().join("\n") ||
      input.collectionProjection.projectionId !== vaultId ||
      input.vaultNameProjection.vaultId !== vaultId ||
      input.nameCache.vaultId !== vaultId ||
      input.nameCache.sourceEventId !== input.vaultNameProjection.sourceEventId ||
      !eventIds.includes(input.vaultNameProjection.sourceEventId) ||
      new Set(input.libraryProjections.map((projection) => projection.bundleId)).size !==
        input.libraryProjections.length
    )
      throw storageError(new Error("Atomic remote Replica records are inconsistent."));

    const database = await this.databasePromise;
    const stores = [
      STORES.workspaceMetadata,
      STORES.vaultDirectory,
      STORES.vaultNameCache,
      STORES.vaultNameProjection,
      STORES.vaultMetadata,
      STORES.keySlots,
      STORES.deviceKeys,
      STORES.objects,
      STORES.events,
      STORES.libraryProjection,
      STORES.collectionProjection,
      STORES.vaultGenerations,
      STORES.vaultHead,
      STORES.synchronizationJobs,
    ];
    const transaction = database.transaction(stores, "readwrite");
    try {
      const [jobValue, workspaceValue, collision] = await Promise.all([
        requestValue(transaction.objectStore(STORES.synchronizationJobs).get("active")),
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        requestValue(transaction.objectStore(STORES.vaultDirectory).count(vaultId)),
      ]);
      if (jobValue === undefined || workspaceValue === undefined || collision !== 0)
        throw Object.assign(new Error("Remote bootstrap ownership changed."), {
          id: collision === 0 ? "VAULT_BUSY" : "VAULT_ALREADY_EXISTS",
        });
      const storedJob = jobValue as SynchronizationJobV1;
      if (
        storedJob.jobId !== input.job.jobId ||
        storedJob.stage !== "ActivateLocal" ||
        storedJob.state !== "Running" ||
        storedJob.vaultId !== vaultId
      )
        throw Object.assign(new Error("Remote bootstrap Job changed."), { id: "VAULT_BUSY" });
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      transaction
        .objectStore(STORES.vaultMetadata)
        .add(records.metadata, vaultSingletonKey(vaultId, "metadata"));
      transaction
        .objectStore(STORES.keySlots)
        .add(records.deviceSlot, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.deviceKeys)
        .add(records.deviceKey, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.vaultGenerations)
        .add(records.generation, vaultKey(vaultId, records.generation.generationId));
      transaction
        .objectStore(STORES.vaultHead)
        .add(records.head, vaultSingletonKey(vaultId, "active"));
      for (const event of input.events)
        transaction.objectStore(STORES.events).add(event, vaultKey(vaultId, event.eventId));
      for (const object of input.objects)
        transaction.objectStore(STORES.objects).add(object, vaultKey(vaultId, object.objectId));
      for (const projection of input.libraryProjections)
        transaction
          .objectStore(STORES.libraryProjection)
          .add(projection, vaultKey(vaultId, projection.bundleId));
      transaction
        .objectStore(STORES.collectionProjection)
        .add(input.collectionProjection, vaultSingletonKey(vaultId, "active"));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .add(input.vaultNameProjection, vaultSingletonKey(vaultId, "active"));
      transaction.objectStore(STORES.vaultNameCache).add(input.nameCache, vaultId);
      transaction.objectStore(STORES.vaultDirectory).add(
        {
          version: 1,
          vaultId,
          createdAt: records.metadata.createdAt,
        } satisfies VaultDirectoryEntryV1,
        vaultId,
      );
      transaction
        .objectStore(STORES.workspaceMetadata)
        .put({ ...workspace, activeVaultId: vaultId }, "local");
      transaction
        .objectStore(STORES.synchronizationJobs)
        .put({ ...storedJob, state: "Succeeded", stage: "Checkpoint" }, "active");
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async stageVaultReplacement(input: AtomicVaultReplacementStage): Promise<void> {
    const records = decodeVaultRecords({
      metadata: input.records.metadata,
      deviceSlot: input.records.deviceSlot,
      deviceKey: input.records.deviceKey,
      generations: [input.records.generation],
      head: input.records.head,
    });
    const job = input.job;
    const vaultId = records.metadata.vaultId;
    const eventIds = input.events.map((event) => event.eventId).toSorted();
    const objectIds = input.objects.map((object) => object.objectId).toSorted();
    const artifactIds = input.objects
      .filter((object) => object.objectType === "Artifact")
      .map((object) => object.objectId)
      .toSorted();
    if (
      job.state !== "Running" ||
      job.stage !== "StageRemote" ||
      job.targetVaultId !== vaultId ||
      job.targetDeviceId !== records.metadata.deviceId ||
      job.targetKeyEpochId !== records.metadata.activeKeyEpochId ||
      job.targetGenerationId !== records.generation.generationId ||
      job.targetGenerationNumber !== records.generation.generationNumber ||
      job.sourceVaultId === vaultId ||
      records.head.vaultId !== vaultId ||
      records.head.generationId !== records.generation.generationId ||
      records.head.generationNumber !== records.generation.generationNumber ||
      input.events.some((event) => event.vaultId !== vaultId) ||
      eventIds.join("\n") !== records.head.appendedEventIds.join("\n") ||
      objectIds.join("\n") !== records.head.appendedObjectIds.join("\n") ||
      new Set(eventIds).size !== eventIds.length ||
      new Set(objectIds).size !== objectIds.length ||
      artifactIds.join("\n") !== [...input.preparedArtifactObjectIds].toSorted().join("\n") ||
      input.collectionProjection.projectionId !== vaultId ||
      input.vaultNameProjection.vaultId !== vaultId ||
      !eventIds.includes(input.vaultNameProjection.sourceEventId) ||
      new Set(input.libraryProjections.map((projection) => projection.bundleId)).size !==
        input.libraryProjections.length
    )
      throw storageError(new Error("Staged Vault replacement records are inconsistent."));

    const stores = [
      STORES.workspaceMetadata,
      STORES.vaultDirectory,
      STORES.vaultReplacementJobs,
      STORES.vaultMetadata,
      STORES.keySlots,
      STORES.deviceKeys,
      STORES.objects,
      STORES.events,
      STORES.libraryProjection,
      STORES.collectionProjection,
      STORES.vaultNameProjection,
      STORES.vaultGenerations,
      STORES.vaultHead,
      STORES.synchronizationCheckpoints,
    ];
    const database = await this.databasePromise;
    const transaction = database.transaction(stores, "readwrite");
    try {
      const [workspaceValue, storedJobValue, directoryCount] = await Promise.all([
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        requestValue(
          transaction
            .objectStore(STORES.vaultReplacementJobs)
            .get(vaultKey(job.sourceVaultId, job.jobId)),
        ),
        requestValue(transaction.objectStore(STORES.vaultDirectory).count(vaultId)),
      ]);
      if (workspaceValue === undefined || storedJobValue === undefined)
        throw Object.assign(new Error("Vault replacement staging ownership changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      const storedJob = storedJobValue as VaultReplacementJobV1;
      if (
        workspace.activeVaultId !== job.sourceVaultId ||
        storedJob.jobId !== job.jobId ||
        storedJob.updatedAt !== job.updatedAt ||
        storedJob.stage !== "StageRemote" ||
        storedJob.targetVaultId !== vaultId ||
        directoryCount !== 0
      )
        throw Object.assign(new Error("Vault replacement staging ownership changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      const collisionCounts = await Promise.all([
        requestValue(transaction.objectStore(STORES.vaultMetadata).count(vaultKeyRange(vaultId))),
        requestValue(transaction.objectStore(STORES.keySlots).count(vaultKeyRange(vaultId))),
        requestValue(transaction.objectStore(STORES.deviceKeys).count(vaultKeyRange(vaultId))),
        requestValue(transaction.objectStore(STORES.objects).count(vaultKeyRange(vaultId))),
        requestValue(transaction.objectStore(STORES.events).count(vaultKeyRange(vaultId))),
        requestValue(
          transaction.objectStore(STORES.libraryProjection).count(vaultKeyRange(vaultId)),
        ),
        requestValue(
          transaction.objectStore(STORES.collectionProjection).count(vaultKeyRange(vaultId)),
        ),
        requestValue(
          transaction.objectStore(STORES.vaultNameProjection).count(vaultKeyRange(vaultId)),
        ),
        requestValue(
          transaction.objectStore(STORES.vaultGenerations).count(vaultKeyRange(vaultId)),
        ),
        requestValue(transaction.objectStore(STORES.vaultHead).count(vaultKeyRange(vaultId))),
      ]);
      if (collisionCounts.some((count) => count !== 0))
        throw Object.assign(new Error("The replacement Vault identity is already in use."), {
          id: "VAULT_ALREADY_EXISTS",
        });
      transaction
        .objectStore(STORES.vaultMetadata)
        .add(records.metadata, vaultSingletonKey(vaultId, "metadata"));
      transaction
        .objectStore(STORES.keySlots)
        .add(records.deviceSlot, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.deviceKeys)
        .add(records.deviceKey, vaultSingletonKey(vaultId, "device"));
      transaction
        .objectStore(STORES.vaultGenerations)
        .add(records.generation, vaultKey(vaultId, records.generation.generationId));
      transaction
        .objectStore(STORES.vaultHead)
        .add(records.head, vaultSingletonKey(vaultId, "active"));
      for (const event of input.events)
        transaction.objectStore(STORES.events).add(event, vaultKey(vaultId, event.eventId));
      for (const object of input.objects)
        transaction.objectStore(STORES.objects).add(object, vaultKey(vaultId, object.objectId));
      for (const projection of input.libraryProjections)
        transaction
          .objectStore(STORES.libraryProjection)
          .add(projection, vaultKey(vaultId, projection.bundleId));
      transaction
        .objectStore(STORES.collectionProjection)
        .add(input.collectionProjection, vaultSingletonKey(vaultId, "active"));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .add(input.vaultNameProjection, vaultSingletonKey(vaultId, "active"));
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async hasStagedVaultReplacement(input: {
    readonly sourceVaultId: string;
    readonly targetVaultId: string;
    readonly jobId: string;
  }): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.workspaceMetadata,
        STORES.vaultDirectory,
        STORES.vaultReplacementJobs,
        STORES.vaultMetadata,
        STORES.vaultHead,
      ],
      "readonly",
    );
    const [workspaceValue, directoryCount, jobValue, metadataCount, headCount] = await Promise.all([
      requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
      requestValue(transaction.objectStore(STORES.vaultDirectory).count(input.targetVaultId)),
      requestValue(
        transaction
          .objectStore(STORES.vaultReplacementJobs)
          .get(vaultKey(input.sourceVaultId, input.jobId)),
      ),
      requestValue(
        transaction.objectStore(STORES.vaultMetadata).count(vaultKeyRange(input.targetVaultId)),
      ),
      requestValue(
        transaction.objectStore(STORES.vaultHead).count(vaultKeyRange(input.targetVaultId)),
      ),
    ]);
    await transactionDone(transaction);
    if (workspaceValue === undefined || jobValue === undefined) return false;
    const workspace = decodeWorkspaceMetadata(workspaceValue);
    const job = jobValue as VaultReplacementJobV1;
    return (
      workspace.activeVaultId === input.sourceVaultId &&
      job.jobId === input.jobId &&
      job.sourceVaultId === input.sourceVaultId &&
      job.targetVaultId === input.targetVaultId &&
      directoryCount === 0 &&
      metadataCount === 1 &&
      headCount === 1
    );
  }

  async discardStagedVaultReplacement(job: VaultReplacementJobV1): Promise<void> {
    const targetVaultId = job.targetVaultId;
    if (
      targetVaultId === undefined ||
      !["StageRemote", "Upload", "CompleteRemote"].includes(job.stage)
    )
      throw storageError(new Error("Vault replacement is not safely discardable."));
    const stores = [
      STORES.workspaceMetadata,
      STORES.vaultDirectory,
      STORES.vaultReplacementJobs,
      STORES.vaultMetadata,
      STORES.keySlots,
      STORES.deviceKeys,
      STORES.objects,
      STORES.events,
      STORES.libraryProjection,
      STORES.collectionProjection,
      STORES.vaultNameProjection,
      STORES.vaultGenerations,
      STORES.vaultHead,
      STORES.synchronizationCheckpoints,
    ];
    const database = await this.databasePromise;
    const transaction = database.transaction(stores, "readwrite");
    try {
      const [workspaceValue, directoryCount, storedJobValue] = await Promise.all([
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        requestValue(transaction.objectStore(STORES.vaultDirectory).count(targetVaultId)),
        requestValue(
          transaction
            .objectStore(STORES.vaultReplacementJobs)
            .get(vaultKey(job.sourceVaultId, job.jobId)),
        ),
      ]);
      const workspace =
        workspaceValue === undefined ? undefined : decodeWorkspaceMetadata(workspaceValue);
      const storedJob = storedJobValue as VaultReplacementJobV1 | undefined;
      if (
        workspace?.activeVaultId !== job.sourceVaultId ||
        directoryCount !== 0 ||
        storedJob?.updatedAt !== job.updatedAt ||
        storedJob.targetVaultId !== targetVaultId ||
        !["StageRemote", "Upload", "CompleteRemote"].includes(storedJob.stage)
      )
        throw Object.assign(new Error("Vault replacement discard ownership changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      for (const storeName of [
        STORES.vaultMetadata,
        STORES.keySlots,
        STORES.deviceKeys,
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.collectionProjection,
        STORES.vaultNameProjection,
        STORES.vaultGenerations,
        STORES.vaultHead,
        STORES.synchronizationCheckpoints,
      ])
        transaction.objectStore(storeName).delete(vaultKeyRange(targetVaultId));
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async commitVaultReplacement(
    input: AtomicVaultReplacementPromotion,
  ): Promise<VaultReplacementPromotionResult> {
    const job = input.job;
    const targetVaultId = job.targetVaultId;
    if (
      job.state !== "Running" ||
      job.stage !== "PromoteLocal" ||
      targetVaultId === undefined ||
      job.targetDeviceId === undefined ||
      job.targetRecoveryGenerationId === undefined ||
      job.targetKeyEpochId === undefined ||
      job.targetGenerationId === undefined ||
      job.targetGenerationNumber === undefined ||
      job.targetHeadCursor === undefined ||
      job.purgeId === undefined ||
      input.authority.accountId !== job.accountId ||
      input.authority.vaultId !== targetVaultId ||
      input.authority.recoveryGenerationId !== job.targetRecoveryGenerationId ||
      input.authority.identity.deviceId !== job.targetDeviceId ||
      input.authority.remoteGenerationId !== job.targetGenerationId ||
      input.authority.remoteGenerationNumber !== job.targetGenerationNumber ||
      input.nameCache.vaultId !== targetVaultId
    )
      throw storageError(new Error("Vault replacement promotion authority is incomplete."));
    timestamp(input.promotedAt, "vaultReplacement.promotedAt");
    const preparedAuthority = await prepareDeviceAuthorityStorage(
      input.authority,
      job.targetHeadCursor,
    );
    if (
      preparedAuthority.registration.activeKeyEpochId !== job.targetKeyEpochId ||
      preparedAuthority.identity.deviceId !== job.targetDeviceId
    )
      throw storageError(new Error("Vault replacement Device authority changed."));

    const stores = [
      STORES.workspaceMetadata,
      STORES.vaultDirectory,
      STORES.vaultNameCache,
      STORES.vaultNameProjection,
      STORES.vaultMetadata,
      STORES.keySlots,
      STORES.deviceKeys,
      STORES.objects,
      STORES.events,
      STORES.libraryProjection,
      STORES.collectionProjection,
      STORES.vaultGenerations,
      STORES.vaultHead,
      STORES.captureJobs,
      STORES.commandOutcomes,
      STORES.vacuumJobs,
      STORES.exportJobs,
      STORES.importJobs,
      STORES.artifactAvailability,
      STORES.storageReliefJobs,
      STORES.storageReliefCheckpoints,
      STORES.synchronizationJobs,
      STORES.synchronizationCheckpoints,
      STORES.serverSwitchJobs,
      STORES.serverSwitchCheckpoints,
      STORES.deviceEnrollmentJobs,
      STORES.futureProtectionJobs,
      STORES.deviceIdentities,
      STORES.deviceLocalKeys,
      STORES.epochKeys,
      STORES.deviceSessions,
      STORES.recoveryKits,
      STORES.vaultSyncState,
      STORES.vaultReplacementJobs,
    ];
    const database = await this.databasePromise;
    const transaction = database.transaction(stores, "readwrite");
    try {
      const [
        workspaceValue,
        storedJobValue,
        sourceHeadValue,
        targetHeadValue,
        targetMetadataValue,
        targetNameValue,
        sourceObjectValues,
        sourceDirectoryCount,
        targetDirectoryCount,
      ] = await Promise.all([
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        requestValue(
          transaction
            .objectStore(STORES.vaultReplacementJobs)
            .get(vaultKey(job.sourceVaultId, job.jobId)),
        ),
        requestValue(
          transaction
            .objectStore(STORES.vaultHead)
            .get(vaultSingletonKey(job.sourceVaultId, "active")),
        ),
        requestValue(
          transaction.objectStore(STORES.vaultHead).get(vaultSingletonKey(targetVaultId, "active")),
        ),
        requestValue(
          transaction
            .objectStore(STORES.vaultMetadata)
            .get(vaultSingletonKey(targetVaultId, "metadata")),
        ),
        requestValue(
          transaction
            .objectStore(STORES.vaultNameProjection)
            .get(vaultSingletonKey(targetVaultId, "active")),
        ),
        requestValue(
          transaction.objectStore(STORES.objects).getAll(vaultKeyRange(job.sourceVaultId)),
        ),
        requestValue(transaction.objectStore(STORES.vaultDirectory).count(job.sourceVaultId)),
        requestValue(transaction.objectStore(STORES.vaultDirectory).count(targetVaultId)),
      ]);
      const workspace =
        workspaceValue === undefined ? undefined : decodeWorkspaceMetadata(workspaceValue);
      const storedJob = storedJobValue as VaultReplacementJobV1 | undefined;
      const sourceHead =
        sourceHeadValue === undefined ? undefined : decodeVaultHead(sourceHeadValue);
      const targetHead =
        targetHeadValue === undefined ? undefined : decodeVaultHead(targetHeadValue);
      const targetMetadata =
        targetMetadataValue === undefined ? undefined : decodeVaultMetadata(targetMetadataValue);
      const targetName =
        targetNameValue === undefined
          ? undefined
          : decodeStoredVaultNameProjection(targetNameValue);
      const sourceArtifactObjectIds = sourceObjectValues
        .map(decodeStoredObject)
        .filter((object) => object.objectType === "Artifact")
        .map((object) => object.objectId)
        .toSorted();
      if (
        workspace?.activeVaultId !== job.sourceVaultId ||
        storedJob?.updatedAt !== job.updatedAt ||
        storedJob.stage !== "PromoteLocal" ||
        storedJob.purgeId !== job.purgeId ||
        sourceDirectoryCount !== 1 ||
        targetDirectoryCount !== 0 ||
        sourceHead?.generationId !== job.sourceHead.generationId ||
        sourceHead.generationNumber !== job.sourceHead.generationNumber ||
        sourceHead.appendedObjectIds.join("\n") !== job.sourceHead.appendedObjectIds.join("\n") ||
        sourceHead.appendedEventIds.join("\n") !== job.sourceHead.appendedEventIds.join("\n") ||
        targetHead?.vaultId !== targetVaultId ||
        targetHead.generationId !== job.targetGenerationId ||
        targetHead.generationNumber !== job.targetGenerationNumber ||
        targetMetadata?.deviceId !== job.targetDeviceId ||
        targetMetadata.activeKeyEpochId !== job.targetKeyEpochId ||
        targetName?.sourceEventId !== input.nameCache.sourceEventId ||
        job.targetHeadCursor !== 1 + targetHead.appendedEventIds.length
      )
        throw Object.assign(new Error("Vault replacement promotion ownership changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      const targetCheckpoints = await Promise.all([
        ...targetHead.appendedObjectIds.map((objectId) =>
          requestValue(
            transaction
              .objectStore(STORES.synchronizationCheckpoints)
              .get([targetVaultId, "Object", objectId]),
          ),
        ),
        ...targetHead.appendedEventIds.map((eventId) =>
          requestValue(
            transaction
              .objectStore(STORES.synchronizationCheckpoints)
              .get([targetVaultId, "Event", eventId]),
          ),
        ),
      ]);
      if (
        targetCheckpoints.some((checkpoint, index) => {
          const value = checkpoint as import("./schema").SynchronizationCheckpointV1 | undefined;
          return index < targetHead.appendedObjectIds.length
            ? value?.state !== "Durable"
            : value?.state !== "Committed";
        })
      )
        throw Object.assign(new Error("Vault replacement upload is incomplete."), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });

      const clearSourceRange = (storeName: string): void => {
        transaction.objectStore(storeName).delete(vaultKeyRange(job.sourceVaultId));
      };
      for (const storeName of [
        STORES.vaultMetadata,
        STORES.keySlots,
        STORES.deviceKeys,
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.collectionProjection,
        STORES.vaultNameProjection,
        STORES.vaultGenerations,
        STORES.vaultHead,
        STORES.captureJobs,
        STORES.commandOutcomes,
        STORES.vacuumJobs,
        STORES.exportJobs,
        STORES.artifactAvailability,
        STORES.storageReliefJobs,
        STORES.storageReliefCheckpoints,
        STORES.synchronizationCheckpoints,
        STORES.epochKeys,
      ])
        clearSourceRange(storeName);
      transaction.objectStore(STORES.vaultDirectory).delete(job.sourceVaultId);
      transaction.objectStore(STORES.vaultNameCache).delete(job.sourceVaultId);
      transaction.objectStore(STORES.deviceIdentities).delete(job.sourceVaultId);
      transaction.objectStore(STORES.deviceSessions).delete(job.sourceVaultId);
      transaction.objectStore(STORES.recoveryKits).delete(job.sourceVaultId);
      transaction.objectStore(STORES.deviceLocalKeys).delete(`${job.sourceVaultId}:wrap`);
      transaction.objectStore(STORES.deviceLocalKeys).delete(`${job.sourceVaultId}:session`);
      transaction.objectStore(STORES.synchronizationJobs).clear();
      transaction.objectStore(STORES.serverSwitchJobs).clear();
      transaction.objectStore(STORES.serverSwitchCheckpoints).clear();
      transaction.objectStore(STORES.deviceEnrollmentJobs).clear();
      transaction.objectStore(STORES.futureProtectionJobs).clear();
      transaction.objectStore(STORES.importJobs).clear();

      transaction
        .objectStore(STORES.deviceIdentities)
        .put(preparedAuthority.identity, targetVaultId);
      transaction
        .objectStore(STORES.deviceLocalKeys)
        .put(preparedAuthority.wrappingKey, `${targetVaultId}:wrap`);
      transaction
        .objectStore(STORES.deviceLocalKeys)
        .put(preparedAuthority.sessionKey, `${targetVaultId}:session`);
      for (const epoch of preparedAuthority.epochs)
        transaction.objectStore(STORES.epochKeys).put(epoch, [targetVaultId, epoch.keyEpochId]);
      transaction.objectStore(STORES.deviceSessions).put(preparedAuthority.session, targetVaultId);
      transaction
        .objectStore(STORES.recoveryKits)
        .put(preparedAuthority.recoveryKit, targetVaultId);
      transaction.objectStore(STORES.vaultSyncState).put(preparedAuthority.registration, "active");
      transaction.objectStore(STORES.vaultNameCache).add(input.nameCache, targetVaultId);
      transaction.objectStore(STORES.vaultDirectory).add(
        {
          version: 1,
          vaultId: targetVaultId,
          createdAt: targetMetadata.createdAt,
        } satisfies VaultDirectoryEntryV1,
        targetVaultId,
      );
      transaction
        .objectStore(STORES.workspaceMetadata)
        .put({ ...workspace, activeVaultId: targetVaultId }, "local");
      const promoted: VaultReplacementJobV1 = {
        ...storedJob,
        state: "Running",
        stage: "PurgeSource",
        updatedAt: input.promotedAt,
      };
      transaction
        .objectStore(STORES.vaultReplacementJobs)
        .put(promoted, vaultKey(job.sourceVaultId, job.jobId));
      await transactionDone(transaction);
      return {
        job: promoted,
        removedSourceArtifactObjectIds: sourceArtifactObjectIds,
      };
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async commitRemoteReconciliation(input: AtomicRemoteReconciliation): Promise<void> {
    const vaultId = input.registration.vaultId;
    if (
      input.job.vaultId !== vaultId ||
      input.job.generationId !== input.expectedGenerationId ||
      input.head.vaultId !== vaultId ||
      input.head.generationId !== input.expectedGenerationId ||
      input.registration.remoteGenerationId !== input.expectedGenerationId ||
      input.registration.deliveryCursor < input.expectedDeliveryCursor ||
      input.events.some((event) => event.vaultId !== vaultId) ||
      input.collectionProjection.projectionId !== vaultId ||
      input.vaultNameProjection.vaultId !== vaultId ||
      input.nameCache.vaultId !== vaultId
    )
      throw storageError(new Error("Remote reconciliation records are inconsistent."));
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.vaultSyncState,
        STORES.synchronizationJobs,
        STORES.vaultHead,
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.collectionProjection,
        STORES.vaultNameProjection,
        STORES.vaultNameCache,
        STORES.artifactAvailability,
      ],
      "readwrite",
    );
    try {
      const [storedRegistrationValue, storedJobValue, storedHeadValue] = await Promise.all([
        requestValue(transaction.objectStore(STORES.vaultSyncState).get("active")),
        requestValue(transaction.objectStore(STORES.synchronizationJobs).get("active")),
        requestValue(
          transaction.objectStore(STORES.vaultHead).get(vaultSingletonKey(vaultId, "active")),
        ),
      ]);
      const storedRegistration = storedRegistrationValue as
        | import("./schema").StoredAccountVaultV1
        | undefined;
      const storedJob = storedJobValue as SynchronizationJobV1 | undefined;
      const storedHead = storedHeadValue as StoredVaultHeadV1 | undefined;
      if (
        storedRegistration?.vaultId !== vaultId ||
        storedRegistration.deliveryCursor !== input.expectedDeliveryCursor ||
        storedJob?.jobId !== input.job.jobId ||
        storedHead?.generationId !== input.expectedGenerationId ||
        storedHead.appendedEventIds.join("\n") !==
          input.expectedLocalHead.appendedEventIds.join("\n") ||
        storedHead.appendedObjectIds.join("\n") !==
          input.expectedLocalHead.appendedObjectIds.join("\n") ||
        input.expectedLocalHead.appendedEventIds.some(
          (eventId) => !input.head.appendedEventIds.includes(eventId),
        ) ||
        input.expectedLocalHead.appendedObjectIds.some(
          (objectId) => !input.head.appendedObjectIds.includes(objectId),
        )
      )
        throw Object.assign(new Error("Remote reconciliation ownership changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      for (const event of input.events)
        transaction.objectStore(STORES.events).put(event, vaultKey(vaultId, event.eventId));
      for (const object of input.objects)
        transaction.objectStore(STORES.objects).put(object, vaultKey(vaultId, object.objectId));
      transaction.objectStore(STORES.libraryProjection).delete(vaultKeyRange(vaultId));
      for (const projection of input.libraryProjections)
        transaction
          .objectStore(STORES.libraryProjection)
          .put(projection, vaultKey(vaultId, projection.bundleId));
      transaction
        .objectStore(STORES.collectionProjection)
        .put(input.collectionProjection, vaultSingletonKey(vaultId, "active"));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .put(input.vaultNameProjection, vaultSingletonKey(vaultId, "active"));
      transaction.objectStore(STORES.vaultNameCache).put(input.nameCache, vaultId);
      for (const artifactObjectId of input.installedArtifactObjectIds)
        transaction
          .objectStore(STORES.artifactAvailability)
          .delete(vaultKey(vaultId, artifactObjectId));
      transaction
        .objectStore(STORES.vaultHead)
        .put(input.head, vaultSingletonKey(vaultId, "active"));
      transaction.objectStore(STORES.vaultSyncState).put(input.registration, "active");
      const { preparedArtifactObjectIds: _preparedArtifactObjectIds, ...completedJob } = input.job;
      transaction
        .objectStore(STORES.synchronizationJobs)
        .put({ ...completedJob, state: "Succeeded", stage: "Checkpoint" }, "active");
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async commitStaleDiscard(input: AtomicStaleDiscard): Promise<void> {
    const vaultId = input.originalRecords.metadata.vaultId;
    if (
      input.job.state !== "Running" ||
      input.job.stage !== "ActivateServerReplacement" ||
      input.job.vaultId !== vaultId ||
      input.registration.vaultId !== vaultId ||
      input.registration.remoteGenerationId !== input.remoteGeneration.generationId ||
      input.remoteHead.vaultId !== vaultId ||
      input.remoteHead.generationId !== input.remoteGeneration.generationId ||
      input.remoteEvents.some((event) => event.vaultId !== vaultId) ||
      input.remoteNameCache.vaultId !== vaultId
    )
      throw storageError(new Error("Stale discard records are inconsistent."));
    const stores = [
      STORES.workspaceMetadata,
      STORES.vaultSyncState,
      STORES.synchronizationJobs,
      STORES.vaultDirectory,
      STORES.vaultNameCache,
      STORES.vaultNameProjection,
      STORES.vaultMetadata,
      STORES.keySlots,
      STORES.deviceKeys,
      STORES.objects,
      STORES.events,
      STORES.libraryProjection,
      STORES.collectionProjection,
      STORES.vaultGenerations,
      STORES.vaultHead,
      STORES.captureJobs,
      STORES.commandOutcomes,
      STORES.vacuumJobs,
      STORES.exportJobs,
      STORES.artifactAvailability,
      STORES.storageReliefJobs,
      STORES.storageReliefCheckpoints,
    ];
    const database = await this.databasePromise;
    const transaction = database.transaction(stores, "readwrite");
    try {
      const [workspaceValue, jobValue, headValue] = await Promise.all([
        requestValue(transaction.objectStore(STORES.workspaceMetadata).get("local")),
        requestValue(transaction.objectStore(STORES.synchronizationJobs).get("active")),
        requestValue(
          transaction.objectStore(STORES.vaultHead).get(vaultSingletonKey(vaultId, "active")),
        ),
      ]);
      const workspace = decodeWorkspaceMetadata(workspaceValue);
      const storedJob = jobValue as SynchronizationJobV1 | undefined;
      const staleHead = headValue as StoredVaultHeadV1 | undefined;
      if (
        workspace.activeVaultId !== vaultId ||
        storedJob?.jobId !== input.job.jobId ||
        storedJob.stage !== "ActivateServerReplacement" ||
        staleHead?.generationId !== input.expectedStaleGenerationId
      )
        throw Object.assign(new Error("Stale discard ownership changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });

      const clearVaultRange = (storeName: string, targetVaultId: string): void => {
        transaction.objectStore(storeName).delete(vaultKeyRange(targetVaultId));
      };
      for (const storeName of [
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.vaultGenerations,
        STORES.captureJobs,
        STORES.commandOutcomes,
        STORES.vacuumJobs,
        STORES.exportJobs,
      ])
        clearVaultRange(storeName, vaultId);
      transaction
        .objectStore(STORES.collectionProjection)
        .delete(vaultSingletonKey(vaultId, "active"));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .delete(vaultSingletonKey(vaultId, "active"));

      transaction
        .objectStore(STORES.vaultMetadata)
        .put(
          { ...input.originalRecords.metadata, manuallyLocked: false },
          vaultSingletonKey(vaultId, "metadata"),
        );
      transaction
        .objectStore(STORES.vaultGenerations)
        .put(input.remoteGeneration, vaultKey(vaultId, input.remoteGeneration.generationId));
      transaction
        .objectStore(STORES.vaultHead)
        .put(input.remoteHead, vaultSingletonKey(vaultId, "active"));
      for (const event of input.remoteEvents)
        transaction.objectStore(STORES.events).put(event, vaultKey(vaultId, event.eventId));
      for (const object of input.remoteObjects)
        transaction.objectStore(STORES.objects).put(object, vaultKey(vaultId, object.objectId));
      for (const projection of input.remoteLibraryProjections)
        transaction
          .objectStore(STORES.libraryProjection)
          .put(projection, vaultKey(vaultId, projection.bundleId));
      transaction
        .objectStore(STORES.collectionProjection)
        .put(input.remoteCollectionProjection, vaultSingletonKey(vaultId, "active"));
      transaction
        .objectStore(STORES.vaultNameProjection)
        .put(input.remoteVaultNameProjection, vaultSingletonKey(vaultId, "active"));
      transaction.objectStore(STORES.vaultNameCache).put(input.remoteNameCache, vaultId);
      transaction.objectStore(STORES.artifactAvailability).delete(vaultKeyRange(vaultId));
      transaction.objectStore(STORES.storageReliefJobs).delete(vaultKeyRange(vaultId));
      transaction.objectStore(STORES.storageReliefCheckpoints).delete(vaultKeyRange(vaultId));
      transaction.objectStore(STORES.vaultSyncState).put(input.registration, "active");
      const { preparedArtifactObjectIds: _preparedArtifactObjectIds, ...completedJob } = input.job;
      transaction
        .objectStore(STORES.synchronizationJobs)
        .put({ ...completedJob, state: "Succeeded", stage: "Checkpoint" }, "active");
      await transactionDone(transaction);
    } catch (error) {
      try {
        transaction.abort();
      } catch {}
      throw storageError(error);
    }
  }

  async hasVaultCollision(vaultId: string): Promise<boolean> {
    uuid(vaultId, "importVault.vaultId");
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.vaultDirectory,
        STORES.vaultNameCache,
        STORES.vaultNameProjection,
        STORES.vaultMetadata,
        STORES.keySlots,
        STORES.deviceKeys,
        STORES.objects,
        STORES.events,
        STORES.libraryProjection,
        STORES.collectionProjection,
        STORES.vaultGenerations,
        STORES.vaultHead,
      ],
      "readonly",
    );
    const counts = await Promise.all([
      requestValue(transaction.objectStore(STORES.vaultDirectory).count(vaultId)),
      requestValue(transaction.objectStore(STORES.vaultNameCache).count(vaultId)),
      requestValue(
        transaction.objectStore(STORES.vaultNameProjection).count(vaultKeyRange(vaultId)),
      ),
      requestValue(transaction.objectStore(STORES.vaultMetadata).count(vaultKeyRange(vaultId))),
      requestValue(transaction.objectStore(STORES.keySlots).count(vaultKeyRange(vaultId))),
      requestValue(transaction.objectStore(STORES.deviceKeys).count(vaultKeyRange(vaultId))),
      requestValue(transaction.objectStore(STORES.objects).count(vaultKeyRange(vaultId))),
      requestValue(transaction.objectStore(STORES.events).count(vaultKeyRange(vaultId))),
      requestValue(transaction.objectStore(STORES.libraryProjection).count(vaultKeyRange(vaultId))),
      requestValue(
        transaction.objectStore(STORES.collectionProjection).count(vaultKeyRange(vaultId)),
      ),
      requestValue(transaction.objectStore(STORES.vaultGenerations).count(vaultKeyRange(vaultId))),
      requestValue(transaction.objectStore(STORES.vaultHead).count(vaultKeyRange(vaultId))),
    ]);
    await transactionDone(transaction);
    return counts.some((count) => count !== 0);
  }

  async hasVaultDirectoryEntry(vaultId: string): Promise<boolean> {
    uuid(vaultId, "importVault.vaultId");
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultDirectory, "readonly");
    const count = await requestValue(transaction.objectStore(STORES.vaultDirectory).count(vaultId));
    await transactionDone(transaction);
    return count !== 0;
  }

  async deleteDatabase(): Promise<void> {
    await deleteDatabase(this.databaseName, await this.databasePromise);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}

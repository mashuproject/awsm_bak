import { digestArtifactPayload, sealArtifactFrames } from "../../../src/crypto/artifact-stream";
import { openCompactItem, sealCompactItem } from "../../../src/crypto/compact";
import { DEPENDENCY_TYPES } from "../../../src/domain/canonical/dependencies";
import {
  keyEpochId as deriveKeyEpochId,
  type Identifier,
  identifier,
  randomIdentifier,
} from "../../../src/domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  encodeVaultObject,
  NOTE_CONTENT_OBJECT,
} from "../../../src/domain/canonical/object";
import {
  decodeVaultBaseline,
  decodeVaultEvent,
  verifyVaultEventSignature,
} from "../../../src/domain/canonical/record";
import { concatBytes } from "../../../src/domain/canonical/transcript";
import { canonicalMap } from "../../../src/domain/canonical/value";
import { bytesEqual } from "../../../src/domain/hash";
import {
  CanonicalIndexedDb,
  CanonicalStorageError,
  identifierFromStorageKey,
  openCanonicalDatabase,
} from "../../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../../src/drivers/indexeddb/canonical-schema";
import { CanonicalOpfsArtifactStore } from "../../../src/hosts/shared/canonical-artifact-store";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../../../src/runtime/artifact/canonical-store";
import type {
  CanonicalBackupPreparedSnapshot,
  CanonicalBackupVerificationArea,
} from "../../../src/runtime/backup/service";
import { CanonicalBackupService } from "../../../src/runtime/backup/service";
import { CanonicalCaptureService } from "../../../src/runtime/capture/canonical-service";
import { CanonicalClientRuntime } from "../../../src/runtime/client/canonical-runtime";
import {
  prepareCompleteExportEntry,
  sealCompleteExportStream,
  sequenceCompleteExportEntries,
} from "../../../src/runtime/complete-export/container";
import {
  type CompleteExportManifestInput,
  type CompleteExportOpaqueItem,
  completeExportStateDigest,
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "../../../src/runtime/complete-export/contracts";
import { CanonicalCompleteImportService } from "../../../src/runtime/complete-import/service";
import { prepareCanonicalContentEvent } from "../../../src/runtime/content/canonical-prepare";
import { CanonicalLibraryProjectionService } from "../../../src/runtime/library/canonical-projection";
import { createPageSnapshotBlob } from "../../../src/runtime/page-snapshot";
import { CanonicalReplayService } from "../../../src/runtime/projection/canonical-replay";
import { CanonicalRestoreService } from "../../../src/runtime/restore/service";
import { decodeReplicaGarbageCollectionJob } from "../../../src/runtime/storage/garbage-collection-job";
import { CanonicalReplicaGarbageCollectionService } from "../../../src/runtime/storage/garbage-collection-service";
import { CanonicalHostedArtifactHydrationService } from "../../../src/runtime/synchronization/canonical-hosted-artifact-hydration";
import { CanonicalHostedPullService } from "../../../src/runtime/synchronization/canonical-hosted-pull-service";
import {
  deriveHostedReplicaOpaqueLocator,
  HOSTED_REPLICA_LOGICAL_NAMESPACE,
} from "../../../src/runtime/synchronization/canonical-hosted-replica-locator";
import { nextCanonicalPullRetry } from "../../../src/runtime/synchronization/canonical-pull-retry";
import { CanonicalPullSynchronizationJobService } from "../../../src/runtime/synchronization/canonical-pull-synchronization-job-service";
import { CanonicalReplicaRemoteService } from "../../../src/runtime/synchronization/canonical-remote-service";
import { prepareCanonicalVaultCreation } from "../../../src/runtime/vault/canonical-create";
import { prepareCanonicalClosureEvent } from "../../../src/runtime/vault/canonical-lifecycle-prepare";
import {
  canonicalLocalStorageContext,
  decodeCanonicalReplicaState,
  decodeClientSecretState,
  decodeEpochSecretState,
  decodeInstallationSelection,
  decodeVaultDirectoryEntry,
  encodeCanonicalReplicaState,
  encodeLogicalResolution,
  encodeVaultDirectoryEntry,
  openWrappedLocalState,
  prepareCanonicalVaultStorage,
  prepareWrappedLocalStateItem,
} from "../../../src/runtime/vault/canonical-local-state";
import { CanonicalVaultService } from "../../../src/runtime/vault/canonical-service";
import { prepareVacuum } from "../../../src/runtime/vault/canonical-vacuum-content-checkpoint";
import {
  decodeOpaqueEnvelope,
  encodeOpaqueEnvelope,
  FRAME_PLAINTEXT_LIMIT,
} from "../../../src/storage/opaque-envelope";

function id(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}

async function deleteBrowserDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("Database deletion blocked")), {
      once: true,
    });
  });
}

function canonicalStorageErrorId(error: unknown): string {
  if (error instanceof CanonicalStorageError) return error.id;
  throw error;
}

function bytesKey(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function* chunkedSource(bytes: Uint8Array, size = 13): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.slice(offset, Math.min(offset + size, bytes.byteLength));
  }
}

class BrowserMemoryCanonicalArtifactStore implements CanonicalArtifactStore {
  readonly promoted = new Map<string, Uint8Array>();

  async prepare(
    input: Parameters<CanonicalArtifactStore["prepare"]>[0],
  ): Promise<PreparedArtifactRepresentation> {
    const frames: Uint8Array[] = [];
    const stream = await sealArtifactFrames({
      ...input,
      writeFrame: async (frame) => {
        frames.push(Uint8Array.from(frame));
      },
    });
    const bytes = concatBytes([stream.envelopePrefix.prefixBytes, ...frames]);
    const envelope = decodeOpaqueEnvelope(bytes);
    const key = bytesKey(envelope.storageItemId);
    let ownsPromotion = false;
    return {
      artifactId: input.artifactId,
      storageItemId: envelope.storageItemId,
      envelopeByteLength: bytes.byteLength,
      stream,
      promote: async () => {
        const existing = this.promoted.get(key);
        if (existing !== undefined && !bytesEqual(existing, bytes)) {
          throw new Error("Artifact Storage Item collision");
        }
        if (existing === undefined) {
          this.promoted.set(key, bytes);
          ownsPromotion = true;
        }
      },
      discard: async () => {
        if (ownsPromotion && bytesEqual(this.promoted.get(key) ?? new Uint8Array(), bytes)) {
          this.promoted.delete(key);
          ownsPromotion = false;
        }
      },
    };
  }

  async has(storageItemId: Identifier<"StorageItem">): Promise<boolean> {
    return this.promoted.has(bytesKey(storageItemId));
  }

  async open(storageItemId: Identifier<"StorageItem">): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.promoted.get(bytesKey(storageItemId));
    if (bytes === undefined) throw new Error("Artifact is unavailable");
    return new Blob([Uint8Array.from(bytes)]).stream();
  }

  async remove(storageItemId: Identifier<"StorageItem">): Promise<void> {
    this.promoted.delete(bytesKey(storageItemId));
  }
}

async function canonicalStorageScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-${crypto.randomUUID()}`;
  const schemaDatabase = await openCanonicalDatabase(databaseName);
  const databaseVersion = schemaDatabase.version;
  const stores = [...schemaDatabase.objectStoreNames].toSorted();
  schemaDatabase.close();
  const storage = new CanonicalIndexedDb(databaseName);
  try {
    const wrappingKey = await storage.getOrCreateInstallationWrappingKey(NORMAL_STORAGE_REALM);
    const carrierBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const carrier = await crypto.subtle.importKey(
      "raw",
      carrierBytes,
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign"],
    );
    const wrapped = await crypto.subtle.wrapKey("raw", carrier, wrappingKey, "AES-KW");
    const restoredWrappingKey =
      await storage.getOrCreateInstallationWrappingKey(NORMAL_STORAGE_REALM);
    const unwrapped = await crypto.subtle.unwrapKey(
      "raw",
      wrapped,
      restoredWrappingKey,
      "AES-KW",
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign"],
    );
    const restoredCarrier = new Uint8Array(await crypto.subtle.exportKey("raw", unwrapped));

    const sharedItem = {
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: "vault-realm-proof",
      itemKey: "record-1",
      bytes: Uint8Array.of(1),
    } as const;
    await storage.putImmutable(NORMAL_STORAGE_REALM, sharedItem);
    await storage.putImmutable(NORMAL_STORAGE_REALM, sharedItem);
    await storage.putImmutable(
      { kind: "Test", id: "isolated" },
      { ...sharedItem, bytes: Uint8Array.of(2) },
    );
    const normalBytes = await storage.getBytes(NORMAL_STORAGE_REALM, sharedItem);
    const testBytes = await storage.getBytes({ kind: "Test", id: "isolated" }, sharedItem);
    let immutableConflict = "missing";
    try {
      await storage.putImmutable(NORMAL_STORAGE_REALM, {
        ...sharedItem,
        bytes: Uint8Array.of(3),
      });
    } catch (error) {
      immutableConflict = canonicalStorageErrorId(error);
    }

    const failedVaultKey = "vault-atomic-failure";
    const collidingRecord = {
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: failedVaultKey,
      itemKey: "genesis",
      bytes: Uint8Array.of(4),
    } as const;
    await storage.putImmutable(NORMAL_STORAGE_REALM, collidingRecord);
    const failedReplicaState = {
      namespace: NAMESPACES.replicaState.key,
      scopeKey: failedVaultKey,
      itemKey: "state",
      bytes: Uint8Array.of(5),
    } as const;
    const failedDirectory = {
      namespace: NAMESPACES.vaultDirectory.key,
      scopeKey: "installation",
      itemKey: failedVaultKey,
      bytes: Uint8Array.of(6),
    } as const;
    const failedSecret = {
      namespace: NAMESPACES.clientSecret.key,
      scopeKey: failedVaultKey,
      itemKey: "credential",
      bytes: Uint8Array.of(7),
    } as const;
    try {
      await storage.commitInitialVault({
        realm: NORMAL_STORAGE_REALM,
        vaultKey: failedVaultKey,
        immutableItems: [{ ...collidingRecord, bytes: Uint8Array.of(8) }],
        replicaState: failedReplicaState,
        vaultDirectoryEntry: failedDirectory,
        trustedSecrets: [failedSecret],
      });
    } catch {
      // The conflicting immutable identity must abort every initialization write.
    }
    const initializationAtomic =
      (await storage.getBytes(NORMAL_STORAGE_REALM, failedReplicaState)) === undefined &&
      (await storage.getBytes(NORMAL_STORAGE_REALM, failedDirectory)) === undefined &&
      (await storage.getBytes(NORMAL_STORAGE_REALM, failedSecret)) === undefined;

    const vaultKey = "vault-cas-proof";
    const initialReplicaState = {
      namespace: NAMESPACES.replicaState.key,
      scopeKey: vaultKey,
      itemKey: "state",
      bytes: Uint8Array.of(10),
    } as const;
    await storage.commitInitialVault({
      realm: NORMAL_STORAGE_REALM,
      vaultKey,
      immutableItems: [
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: "genesis",
          bytes: Uint8Array.of(11),
        },
      ],
      replicaState: initialReplicaState,
      vaultDirectoryEntry: {
        namespace: NAMESPACES.vaultDirectory.key,
        scopeKey: "installation",
        itemKey: vaultKey,
        bytes: Uint8Array.of(12),
      },
      trustedSecrets: [
        {
          namespace: NAMESPACES.epochSecret.key,
          scopeKey: vaultKey,
          itemKey: "epoch",
          bytes: Uint8Array.of(13),
        },
      ],
    });
    const nextReplicaState = { ...initialReplicaState, bytes: Uint8Array.of(20) };
    await storage.commitReplicaMutation({
      realm: NORMAL_STORAGE_REALM,
      expectedReplicaState: initialReplicaState.bytes,
      nextReplicaState,
    });
    const staleRecord = {
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: vaultKey,
      itemKey: "stale-record",
      bytes: Uint8Array.of(21),
    } as const;
    let staleFrontier = "missing";
    try {
      await storage.commitReplicaMutation({
        realm: NORMAL_STORAGE_REALM,
        expectedReplicaState: initialReplicaState.bytes,
        nextReplicaState: { ...initialReplicaState, bytes: Uint8Array.of(22) },
        immutableItems: [staleRecord],
      });
    } catch (error) {
      staleFrontier = canonicalStorageErrorId(error);
    }
    const mutableJob = {
      namespace: NAMESPACES.replicaGarbageCollectionJob.key,
      scopeKey: vaultKey,
      itemKey: "conditional-job",
      bytes: Uint8Array.of(30),
    } as const;
    await storage.putMutable(NORMAL_STORAGE_REALM, mutableJob);
    const staleMutableRecord = {
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: vaultKey,
      itemKey: "stale-mutable-record",
      bytes: Uint8Array.of(31),
    } as const;
    let staleMutable = "missing";
    try {
      await storage.commitReplicaMutation({
        realm: NORMAL_STORAGE_REALM,
        expectedReplicaState: nextReplicaState.bytes,
        expectedMutableItems: [{ ...mutableJob, bytes: Uint8Array.of(32) }],
        nextReplicaState: { ...initialReplicaState, bytes: Uint8Array.of(33) },
        mutableItems: [{ ...mutableJob, bytes: Uint8Array.of(34) }],
        immutableItems: [staleMutableRecord],
      });
    } catch (error) {
      staleMutable = canonicalStorageErrorId(error);
    }
    const currentReplicaAfterMutableConflict = await storage.getBytes(
      NORMAL_STORAGE_REALM,
      nextReplicaState,
    );
    const currentJobAfterMutableConflict = await storage.getBytes(NORMAL_STORAGE_REALM, mutableJob);
    const existingResolution = {
      namespace: NAMESPACES.logicalResolution.key,
      scopeKey: vaultKey,
      itemKey: "existing-resolution",
      bytes: Uint8Array.of(40),
    } as const;
    await storage.putMutable(NORMAL_STORAGE_REALM, existingResolution);
    const staleAbsentRecord = {
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: vaultKey,
      itemKey: "stale-absent-record",
      bytes: Uint8Array.of(41),
    } as const;
    let staleAbsent = "missing";
    try {
      await storage.commitReplicaMutation({
        realm: NORMAL_STORAGE_REALM,
        expectedReplicaState: nextReplicaState.bytes,
        expectedAbsentItems: [
          {
            namespace: existingResolution.namespace,
            scopeKey: existingResolution.scopeKey,
            itemKey: existingResolution.itemKey,
          },
        ],
        nextReplicaState: { ...initialReplicaState, bytes: Uint8Array.of(42) },
        immutableItems: [staleAbsentRecord],
      });
    } catch (error) {
      staleAbsent = canonicalStorageErrorId(error);
    }
    const currentReplicaAfterAbsentConflict = await storage.getBytes(
      NORMAL_STORAGE_REALM,
      nextReplicaState,
    );

    return {
      databaseVersion,
      stores,
      wrappingKeyExtractable: wrappingKey.extractable,
      wrappingKeyReused:
        restoredCarrier.length === carrierBytes.length &&
        restoredCarrier.every((value, index) => value === carrierBytes[index]),
      realmIsolation: normalBytes?.[0] === 1 && testBytes?.[0] === 2,
      immutableIdempotent: normalBytes?.[0] === 1,
      immutableConflict,
      initializationAtomic,
      staleFrontier,
      staleWriteAbsent: (await storage.getBytes(NORMAL_STORAGE_REALM, staleRecord)) === undefined,
      staleMutable,
      staleMutableWriteAbsent:
        currentReplicaAfterMutableConflict?.[0] === 20 &&
        currentJobAfterMutableConflict?.[0] === 30 &&
        (await storage.getBytes(NORMAL_STORAGE_REALM, staleMutableRecord)) === undefined,
      staleAbsent,
      staleAbsentWriteAbsent:
        currentReplicaAfterAbsentConflict?.[0] === 20 &&
        (await storage.getBytes(NORMAL_STORAGE_REALM, staleAbsentRecord)) === undefined,
    };
  } finally {
    await storage.close();
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalPullJobScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-pull-job-${crypto.randomUUID()}`;
  const vaultId = identifier("Vault", new Uint8Array(32).fill(1));
  const remoteId = id("101");
  const storage = new CanonicalIndexedDb(databaseName);
  try {
    const jobs = new CanonicalPullSynchronizationJobService(storage, NORMAL_STORAGE_REALM, () =>
      id("102"),
    );
    const created = await jobs.create({ vaultId, remoteId });
    const envelope = encodeOpaqueEnvelope({
      storageClass: 1,
      protectionParameters: new Uint8Array(64).fill(3),
      payload: new Uint8Array(16).fill(4),
    });
    const resumedPosition = identifier("StorageItem", new Uint8Array(32).fill(5));
    const checkpoint = {
      ...created,
      snapshotCursor: 9,
      nextPosition: resumedPosition,
      quarantineReferences: [
        { storageItemId: envelope.storageItemId, locator: new Uint8Array(32).fill(6) },
      ],
      progress: {
        discoveredItemCount: 1,
        downloadedItemCount: 1,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
    };
    await jobs.recordQuarantine({ previous: created, next: checkpoint, bytes: envelope.bytes });
    const waiting = nextCanonicalPullRetry({
      previous: checkpoint,
      nowMs: 10_000,
      random: () => 0,
      hostRetryAfterMs: 2_000,
    });
    await jobs.checkpoint({ previous: checkpoint, next: waiting });
    await storage.close();

    const restarted = new CanonicalIndexedDb(databaseName);
    try {
      const resumed = await new CanonicalPullSynchronizationJobService(
        restarted,
        NORMAL_STORAGE_REALM,
      ).load({ vaultId, jobId: checkpoint.jobId });
      const quarantined = await restarted.listBytes(
        NORMAL_STORAGE_REALM,
        NAMESPACES.incomingQuarantine.key,
        remoteId,
      );
      return {
        snapshotCursor: resumed.snapshotCursor,
        quarantineCount: quarantined.length,
        locatorRetained:
          resumed.quarantineReferences.length === 1 &&
          bytesEqual(
            resumed.quarantineReferences[0]?.locator ?? new Uint8Array(),
            new Uint8Array(32).fill(6),
          ),
        waitingRetry:
          resumed.stage === 1 &&
          resumed.state === 2 &&
          resumed.attempt === 1 &&
          resumed.retryAfterMs === 12_000 &&
          resumed.nextPosition !== null &&
          resumed.snapshotCursor === 9,
      };
    } finally {
      await restarted.close();
    }
  } finally {
    await storage.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalHostedPullScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-hosted-pull-${crypto.randomUUID()}`;
  const storage = new CanonicalIndexedDb(databaseName);
  try {
    const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const ceremony = await vaults.beginCreate({
      setupId: id("103"),
      expectedVaultId: null,
      label: "Hosted pull",
      assertedAt: 1,
    });
    const created = await ceremony.confirm(ceremony.recoveryPhrase);
    const vault = await vaults.openVault(created.vaultId);
    const object = encodeVaultObject({
      vaultId: created.vaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      body: canonicalMap([
        [0, 1],
        [1, "Hosted note"],
        [2, "Pulled through IndexedDB."],
        [3, "awsm.note.commonmark"],
      ]),
      extensions: new Map(),
    });
    const objectEnvelope = await sealCompactItem({
      vaultId: created.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      payloadType: 2,
      payloadBytes: object.bytes,
      protectionParameters: new Uint8Array(64).fill(10),
    });
    const content = await prepareCanonicalContentEvent({
      vault,
      type: 27,
      assertedAt: 2,
      body: canonicalMap([
        [0, identifier("Note", new Uint8Array(32).fill(3))],
        [
          1,
          canonicalMap([
            [0, 1],
            [1, identifier("Collection", new Uint8Array(32).fill(4))],
          ]),
        ],
        [2, object.objectId],
      ]),
      dependencies: [{ type: DEPENDENCY_TYPES.NoteContentObject, id: object.objectId }],
      protectionParameters: new Uint8Array(64).fill(9),
    });
    const remoteId = id("104");
    const locatorSalt = new Uint8Array(32).fill(91);
    const locator = await deriveHostedReplicaOpaqueLocator({
      locatorSalt,
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultRecord,
      logicalId: content.event.recordId,
    });
    const objectLocator = await deriveHostedReplicaOpaqueLocator({
      locatorSalt,
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultObject,
      logicalId: object.objectId,
    });
    const jobs = new CanonicalPullSynchronizationJobService(storage, NORMAL_STORAGE_REALM, () =>
      id("105"),
    );
    const createdJob = await jobs.create({ vaultId: created.vaultId, remoteId });
    const recordValidationJob = {
      ...createdJob,
      stage: 2 as const,
      snapshotCursor: 1,
      quarantineReferences: [{ storageItemId: content.eventEnvelope.storageItemId, locator }],
      progress: {
        discoveredItemCount: 1,
        downloadedItemCount: 1,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
    };
    await jobs.recordQuarantine({
      previous: createdJob,
      next: recordValidationJob,
      bytes: content.eventEnvelope.bytes,
    });
    const validationJob = {
      ...recordValidationJob,
      quarantineReferences: [
        ...recordValidationJob.quarantineReferences,
        { storageItemId: objectEnvelope.storageItemId, locator: objectLocator },
      ],
      progress: {
        ...recordValidationJob.progress,
        discoveredItemCount: 2,
        downloadedItemCount: 2,
      },
    };
    await jobs.recordQuarantine({
      previous: recordValidationJob,
      next: validationJob,
      bytes: objectEnvelope.bytes,
    });
    const pulled = await new CanonicalHostedPullService({
      remotes: {
        withLoaded: async (_input, operation) =>
          operation({
            remote: {
              remoteId,
              vaultId: created.vaultId,
              name: "Fixture host",
              endpoint: "https://host.example/",
              hostedReplicaHandle: id("106"),
              locatorSalt,
              enabled: true,
              inventoryPageSize: 100,
            },
            bearerToken: "fixture-channel-token",
          }),
      },
      vaults,
      jobs,
    }).pull({ vaultId: created.vaultId, remoteId });
    const quarantine = await storage.getBytes(NORMAL_STORAGE_REALM, {
      namespace: NAMESPACES.incomingQuarantine.key,
      scopeKey: remoteId,
      itemKey: bytesKey(content.eventEnvelope.storageItemId),
    });
    const objectQuarantine = await storage.getBytes(NORMAL_STORAGE_REALM, {
      namespace: NAMESPACES.incomingQuarantine.key,
      scopeKey: remoteId,
      itemKey: bytesKey(objectEnvelope.storageItemId),
    });
    const promoted = await storage.getBytes(NORMAL_STORAGE_REALM, {
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: bytesKey(created.vaultId),
      itemKey: bytesKey(content.event.recordId),
    });
    const promotedObject = await storage.getBytes(NORMAL_STORAGE_REALM, {
      namespace: NAMESPACES.vaultObject.key,
      scopeKey: bytesKey(created.vaultId),
      itemKey: bytesKey(object.objectId),
    });
    await storage.close();

    const restartedStorage = new CanonicalIndexedDb(databaseName);
    try {
      const reopened = await new CanonicalVaultService(
        restartedStorage,
        NORMAL_STORAGE_REALM,
      ).openVault(created.vaultId);
      return {
        promoted: promoted !== undefined,
        objectPromoted: promotedObject !== undefined,
        completed: pulled.stage === 3 && pulled.state === 3,
        quarantineRemoved: quarantine === undefined && objectQuarantine === undefined,
        reopened:
          reopened.replicaState.causalFrontier.length === 1 &&
          sameBytes(
            reopened.replicaState.causalFrontier[0] ?? new Uint8Array(),
            content.event.recordId,
          ),
      };
    } finally {
      await restartedStorage.close();
    }
  } finally {
    await storage.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalHostedArtifactHydrationScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-hosted-artifact-hydration-${crypto.randomUUID()}`;
  const storage = new CanonicalIndexedDb(databaseName);
  const artifacts = new CanonicalOpfsArtifactStore();
  let hydratedStorageItemId: Identifier<"StorageItem"> | undefined;
  try {
    const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const ceremony = await vaults.beginCreate({
      setupId: id("107"),
      expectedVaultId: null,
      label: "Hosted Artifact hydration",
      assertedAt: 1,
    });
    const created = await ceremony.confirm(ceremony.recoveryPhrase);
    const vault = await vaults.openVault(created.vaultId);
    const payload = new TextEncoder().encode("hydrated Artifact payload");
    const plaintextDigest = await digestArtifactPayload({
      plaintextLength: payload.byteLength,
      source: chunkedSource(payload),
    });
    const object = encodeVaultObject({
      vaultId: created.vaultId,
      objectType: ARTIFACT_OBJECT,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      body: canonicalMap([
        [0, 1],
        [1, "awsm.artifact.capture"],
        [2, "application/vnd.awsm.web-page+zip"],
        [3, "awsm.representation.web-page-zip"],
        [4, payload.byteLength],
        [5, plaintextDigest],
        [
          6,
          canonicalMap([
            [0, 1],
            [1, 1_048_576],
            [2, 16],
            [3, payload.byteLength],
            [4, plaintextDigest],
          ]),
        ],
        [7, new Uint8Array([0xa1, 0x00, 0x01])],
      ]),
      extensions: new Map(),
    });
    const objectEnvelope = await sealCompactItem({
      vaultId: created.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      payloadType: 2,
      payloadBytes: object.bytes,
      protectionParameters: new Uint8Array(64).fill(11),
    });
    const sourceWrapper = await artifacts.prepare({
      vaultId: created.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      artifactId: artifactId(object),
      contract: { plaintextLength: payload.byteLength, plaintextDigest },
      source: chunkedSource(payload),
      protectionParameters: new Uint8Array(64).fill(12),
    });
    await sourceWrapper.promote();
    const remoteWrapper = new Uint8Array(
      await new Response(await artifacts.open(sourceWrapper.storageItemId)).arrayBuffer(),
    );
    await artifacts.remove(sourceWrapper.storageItemId);

    const vaultKey = bytesKey(created.vaultId);
    const objectResolution = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.logicalResolution.key,
      scopeKey: vaultKey,
      itemKey: `3:${bytesKey(object.objectId)}`,
      wrappingKey: vault.installationWrappingKey,
      domain: "awsm.local.logical-resolution",
      context: canonicalLocalStorageContext(created.vaultId, object.objectId),
      bytes: encodeLogicalResolution({
        vaultId: created.vaultId,
        kind: 3,
        logicalId: object.objectId,
        storageItemId: objectEnvelope.storageItemId,
        keyEpochId: vault.epochSecret.keyEpochId,
        availability: 1,
      }),
    });
    await storage.commitReplicaMutation({
      realm: NORMAL_STORAGE_REALM,
      expectedReplicaState: vault.replicaStateStorageBytes,
      nextReplicaState: {
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultKey,
        itemKey: "current",
        bytes: vault.replicaStateStorageBytes,
      },
      immutableItems: [
        {
          namespace: NAMESPACES.vaultObject.key,
          scopeKey: vaultKey,
          itemKey: bytesKey(object.objectId),
          bytes: objectEnvelope.bytes,
        },
      ],
      mutableItems: [objectResolution],
    });

    const remoteId = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
    const locatorSalt = new Uint8Array(32).fill(92);
    const locator = await deriveHostedReplicaOpaqueLocator({
      locatorSalt,
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.Artifact,
      logicalId: artifactId(object),
    });
    const remote = {
      remoteId,
      vaultId: created.vaultId,
      name: "Fixture Artifact Host",
      endpoint: "https://artifact-host.example/",
      hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
      locatorSalt,
      enabled: true,
      inventoryPageSize: 100,
    };
    let sessionRefreshes = 0;
    const remotes = new CanonicalReplicaRemoteService(storage, NORMAL_STORAGE_REALM, {
      now: () => 1_000,
      createSessionHttp: () => ({
        refresh: async ({ refreshToken }) => {
          sessionRefreshes += 1;
          if (refreshToken !== "expired-fixture-refresh-token") {
            throw new TypeError("Fixture refresh token did not remain installation-local");
          }
          return {
            username: "archive_reader",
            sessionId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cd",
            accessToken: "fresh-fixture-access-token",
            accessExpiresAt: 2_000,
            refreshToken: "fresh-fixture-refresh-token",
            refreshExpiresAt: 3_000,
          };
        },
      }),
    });
    await remotes.configureHostedSession({
      remote,
      session: {
        username: "archive_reader",
        sessionId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cd",
        accessToken: "expired-fixture-access-token",
        accessExpiresAt: 999,
        refreshToken: "expired-fixture-refresh-token",
        refreshExpiresAt: 3_000,
      },
    });
    const hydrated = await new CanonicalHostedArtifactHydrationService({
      remotes,
      vaults,
      artifacts,
      createHttp: ({ bearerToken }) => ({
        inventory: async () => ({
          snapshotCursor: 1,
          nextPosition: null,
          items: [
            {
              storageItemId: sourceWrapper.storageItemId,
              storageClass: 2,
              byteLength: remoteWrapper.byteLength,
              ciphertextDigest: sourceWrapper.stream.envelopePrefix.ciphertextDigest,
              locator,
            },
          ],
        }),
        item: async () => {
          if (bearerToken !== "fresh-fixture-access-token") {
            throw new TypeError("Hosted Artifact hydration did not use refreshed channel access");
          }
          return new Blob([remoteWrapper]).stream();
        },
      }),
    }).hydrate({ vaultId: created.vaultId, artifactId: artifactId(object) });
    hydratedStorageItemId = hydrated.storageItemId;
    const openedAfterHydration = await vaults.openVault(created.vaultId);
    const resolution = await vaults.readLogicalResolution({
      vault: openedAfterHydration,
      kind: 5,
      logicalId: artifactId(object),
    });
    await storage.close();

    const restartedStorage = new CanonicalIndexedDb(databaseName);
    try {
      const restartedVaults = new CanonicalVaultService(restartedStorage, NORMAL_STORAGE_REALM);
      const reopened = await restartedVaults.openVault(created.vaultId);
      const reopenedResolution = await restartedVaults.readLogicalResolution({
        vault: reopened,
        kind: 5,
        logicalId: artifactId(object),
      });
      const restartedRemotes = new CanonicalReplicaRemoteService(
        restartedStorage,
        NORMAL_STORAGE_REALM,
        {
          now: () => 1_001,
          createSessionHttp: () => ({
            refresh: async () => {
              throw new Error("Restart should use the persisted fresh access token");
            },
          }),
        },
      );
      const restartedChannel = await restartedRemotes.withLoaded(
        { vaultId: created.vaultId, remoteId },
        async (loaded) => loaded,
      );
      return {
        hydrated:
          hydrated.remoteId === remoteId &&
          bytesEqual(hydrated.storageItemId, sourceWrapper.storageItemId) &&
          (await artifacts.has(sourceWrapper.storageItemId)),
        localResolutionPublished:
          resolution.availability === 1 &&
          bytesEqual(resolution.storageItemId, sourceWrapper.storageItemId),
        reopened:
          reopenedResolution.availability === 1 &&
          bytesEqual(reopenedResolution.storageItemId, sourceWrapper.storageItemId),
        refreshedChannelPersisted:
          sessionRefreshes === 1 && restartedChannel.bearerToken === "fresh-fixture-access-token",
      };
    } finally {
      await restartedStorage.close();
    }
  } finally {
    if (hydratedStorageItemId !== undefined) await artifacts.remove(hydratedStorageItemId);
    await storage.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function canonicalVaultInitializationScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-vault-${crypto.randomUUID()}`;
  const initial = new CanonicalIndexedDb(databaseName);
  const wrappingKey = await initial.getOrCreateInstallationWrappingKey(NORMAL_STORAGE_REALM);
  const creation = await prepareCanonicalVaultCreation({
    label: "Research vault",
    assertedAt: 1_800_000_000_000,
  });
  const prepared = await prepareCanonicalVaultStorage({
    creation,
    label: "Research vault",
    realm: NORMAL_STORAGE_REALM,
    wrappingKey,
  });
  await initial.commitInitialVault(prepared.commit);
  await initial.close();

  const reopened = new CanonicalIndexedDb(databaseName);
  try {
    const restoredWrappingKey =
      await reopened.getOrCreateInstallationWrappingKey(NORMAL_STORAGE_REALM);
    const storedReplica = await reopened.getBytes(
      NORMAL_STORAGE_REALM,
      prepared.commit.replicaState,
    );
    if (storedReplica === undefined) throw new Error("Missing Replica State");
    const replica = decodeCanonicalReplicaState(
      await openWrappedLocalState({
        wrappingKey: restoredWrappingKey,
        domain: "awsm.local.replica-state",
        vaultId: creation.ids.vaultId,
        identity: creation.ids.generationId,
        wrappedBytes: storedReplica,
      }),
    );
    const clientItem = prepared.commit.trustedSecrets.find(
      ({ namespace }) => namespace === NAMESPACES.clientSecret.key,
    );
    const epochItem = prepared.commit.trustedSecrets.find(
      ({ namespace }) => namespace === NAMESPACES.epochSecret.key,
    );
    if (clientItem === undefined || epochItem === undefined) throw new Error("Missing secrets");
    const storedClient = await reopened.getBytes(NORMAL_STORAGE_REALM, clientItem);
    const storedEpoch = await reopened.getBytes(NORMAL_STORAGE_REALM, epochItem);
    if (storedClient === undefined || storedEpoch === undefined) throw new Error("Missing secrets");
    const client = await decodeClientSecretState(
      await openWrappedLocalState({
        wrappingKey: restoredWrappingKey,
        domain: "awsm.local.client-secret",
        vaultId: creation.ids.vaultId,
        identity: creation.ids.clientCredentialId,
        wrappedBytes: storedClient,
      }),
    );
    const epoch = decodeEpochSecretState(
      await openWrappedLocalState({
        wrappingKey: restoredWrappingKey,
        domain: "awsm.local.epoch-secret",
        vaultId: creation.ids.vaultId,
        identity: creation.secrets.keyEpoch.id,
        wrappedBytes: storedEpoch,
      }),
    );
    const directoryBytes = await reopened.getBytes(
      NORMAL_STORAGE_REALM,
      prepared.commit.vaultDirectoryEntry,
    );
    if (directoryBytes === undefined) throw new Error("Missing Vault Directory entry");
    const directory = decodeVaultDirectoryEntry(
      await openWrappedLocalState({
        wrappingKey: restoredWrappingKey,
        domain: "awsm.local.vault-directory",
        vaultId: creation.ids.vaultId,
        identity: creation.ids.vaultId,
        wrappedBytes: directoryBytes,
      }),
    );
    const [baselineItem, genesisItem] = prepared.commit.immutableItems.filter(
      ({ namespace }) => namespace === NAMESPACES.vaultRecord.key,
    );
    if (baselineItem === undefined || genesisItem === undefined) throw new Error("Missing Records");
    const storedBaseline = await reopened.getBytes(NORMAL_STORAGE_REALM, baselineItem);
    const storedGenesis = await reopened.getBytes(NORMAL_STORAGE_REALM, genesisItem);
    if (storedBaseline === undefined || storedGenesis === undefined)
      throw new Error("Missing Records");
    const baseline = decodeVaultBaseline(
      (
        await openCompactItem({
          vaultId: creation.ids.vaultId,
          keyEpochId: epoch.keyEpochId,
          keyEpochKey: epoch.key,
          envelopeBytes: storedBaseline,
        })
      ).payloadBytes,
    );
    const genesis = decodeVaultEvent(
      (
        await openCompactItem({
          vaultId: creation.ids.vaultId,
          keyEpochId: epoch.keyEpochId,
          keyEpochKey: epoch.key,
          envelopeBytes: storedGenesis,
        })
      ).payloadBytes,
    );
    const service = new CanonicalVaultService(reopened, NORMAL_STORAGE_REALM);
    const openedByService = await service.openVault(creation.ids.vaultId);
    const listedByService = await service.listVaults();
    let duplicateCreation = "missing";
    try {
      await reopened.commitInitialVault(prepared.commit);
    } catch (error) {
      duplicateCreation = canonicalStorageErrorId(error);
    }
    return {
      recoveryWordCount: creation.recoveryPhrase.split(" ").length,
      directoryLabel: directory.label,
      baselineRestored: sameBytes(baseline.recordId, creation.baseline.recordId),
      genesisRestored: sameBytes(genesis.recordId, creation.genesis.recordId),
      genesisSignature: await verifyVaultEventSignature(genesis, client.signingPublicKey),
      frontierRestored:
        replica.causalFrontier.length === 1 &&
        sameBytes(replica.causalFrontier[0] ?? new Uint8Array(), genesis.recordId) &&
        sameBytes(replica.authorityFrontier[0] ?? new Uint8Array(), genesis.recordId),
      epochRestored: sameBytes(epoch.keyEpochId, creation.secrets.keyEpoch.id),
      serviceRestored:
        sameBytes(openedByService.baseline.recordId, creation.baseline.recordId) &&
        sameBytes(openedByService.genesis.recordId, creation.genesis.recordId),
      selectedInDirectory: listedByService.length === 1 && listedByService[0]?.selected === true,
      duplicateCreation,
    };
  } finally {
    await reopened.close();
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalCompleteImportScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-complete-import-${crypto.randomUUID()}`;
  const creation = await prepareCanonicalVaultCreation({
    label: "Imported research",
    assertedAt: 1_800_000_000_001,
  });
  const stored = [
    {
      namespace: 1 as const,
      logicalId: creation.baseline.recordId,
      bytes: creation.baselineEnvelope.bytes,
    },
    {
      namespace: 1 as const,
      logicalId: creation.genesis.recordId,
      bytes: creation.genesisEnvelope.bytes,
    },
    {
      namespace: 2 as const,
      logicalId: creation.recoveryKeyEnvelope.id,
      bytes: creation.recoveryKeyEnvelope.envelope.bytes,
    },
    {
      namespace: 2 as const,
      logicalId: creation.clientKeyEnvelope.id,
      bytes: creation.clientKeyEnvelope.envelope.bytes,
    },
  ];
  const initialReplicaState = {
    vaultId: creation.ids.vaultId,
    generationId: creation.ids.generationId,
    causalFrontier: [creation.genesis.recordId],
    authorityFrontier: [creation.genesis.recordId],
    continuityRecordIds: [creation.genesis.recordId],
    baselineId: creation.baseline.recordId,
    currentKeyEpochId: creation.secrets.keyEpoch.id,
    requiredFeatureSetId: creation.baseline.requiredFeatureSetId,
    authoringClientCredentialId: creation.ids.clientCredentialId,
    memberId: creation.ids.firstMemberId,
    lifecycle: 1 as const,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
  const closure = await prepareCanonicalClosureEvent({
    vault: {
      directory: {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        label: "Imported research",
        selectedClientCredentialId: creation.ids.clientCredentialId,
      },
      replicaState: initialReplicaState,
      clientSecret: {
        vaultId: creation.ids.vaultId,
        memberId: creation.ids.firstMemberId,
        clientCredentialId: creation.ids.clientCredentialId,
        signingPublicKey: creation.secrets.client.signingPublicKey,
        signingSecretKey: creation.secrets.client.signingSecretKey,
        wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
        wrappingPrivateKey: creation.secrets.client.wrappingPrivateKey,
      },
      epochSecret: {
        vaultId: creation.ids.vaultId,
        keyEpochId: creation.secrets.keyEpoch.id,
        displayNumber: 0,
        key: creation.secrets.keyEpoch.key,
      },
      baseline: creation.baseline,
      genesis: creation.genesis,
    },
    assertedAt: 1_800_000_000_002,
  });
  const siblingClosure = await prepareCanonicalClosureEvent({
    vault: {
      directory: {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        label: "Imported research",
        selectedClientCredentialId: creation.ids.clientCredentialId,
      },
      replicaState: initialReplicaState,
      clientSecret: {
        vaultId: creation.ids.vaultId,
        memberId: creation.ids.firstMemberId,
        clientCredentialId: creation.ids.clientCredentialId,
        signingPublicKey: creation.secrets.client.signingPublicKey,
        signingSecretKey: creation.secrets.client.signingSecretKey,
        wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
        wrappingPrivateKey: creation.secrets.client.wrappingPrivateKey,
      },
      epochSecret: {
        vaultId: creation.ids.vaultId,
        keyEpochId: creation.secrets.keyEpoch.id,
        displayNumber: 0,
        key: creation.secrets.keyEpoch.key,
      },
      baseline: creation.baseline,
      genesis: creation.genesis,
    },
    assertedAt: 1_800_000_000_003,
    protectionParameters: new Uint8Array(64).fill(61),
  });
  const packageFrom = (
    packageItems: readonly {
      readonly namespace: 1 | 2;
      readonly logicalId: Uint8Array;
      readonly bytes: Uint8Array;
    }[],
    frontierId: Identifier<"VaultRecord">,
    options: {
      readonly generationId?: Identifier<"Generation">;
      readonly baselineId?: Identifier<"VaultRecord">;
      readonly authorityFrontierId?: Identifier<"VaultRecord">;
    } = {},
  ) => {
    const generationId = options.generationId ?? creation.ids.generationId;
    const baselineId = options.baselineId ?? creation.baseline.recordId;
    const opaqueItemInventory: CompleteExportOpaqueItem[] = packageItems.map((item) => {
      const entry = prepareCompleteExportEntry(2, item.bytes);
      return {
        namespace: item.namespace,
        logicalId: item.logicalId,
        storageItemId: decodeOpaqueEnvelope(item.bytes).storageItemId,
        keyEpochId: creation.secrets.keyEpoch.id,
        byteLength: entry.header.byteLength,
        byteDigest: entry.header.byteDigest,
      };
    });
    const manifestInput: CompleteExportManifestInput = {
      vaultId: creation.ids.vaultId,
      generationId,
      frontier: [frontierId],
      requiredFeatureSetId: creation.baseline.requiredFeatureSetId,
      typedLogicalRoots: [
        { type: DEPENDENCY_TYPES.VaultRecord, id: frontierId },
        { type: DEPENDENCY_TYPES.VaultBaseline, id: baselineId },
      ],
      opaqueItemInventory,
      continuityProofRoots: [options.authorityFrontierId ?? frontierId],
    };
    const manifest = decodeCompleteExportManifest(
      encodeCompleteExportManifest({
        format: 1,
        ...manifestInput,
        stateDigest: completeExportStateDigest(manifestInput),
      }),
    );
    const keyInventory = decodeCompleteExportKeyInventory(
      encodeCompleteExportKeyInventory({
        vaultId: creation.ids.vaultId,
        generationId,
        entries: [
          {
            keyEpochId: creation.secrets.keyEpoch.id,
            keyEpochKey: creation.secrets.keyEpoch.key,
          },
        ],
      }),
    );
    const bytesByStorageId = new Map(
      packageItems.map((item, index) => [
        bytesKey(opaqueItemInventory[index]?.storageItemId ?? new Uint8Array()),
        item.bytes,
      ]),
    );
    return {
      manifest,
      keyInventory,
      source: {
        openOpaque: async (item: CompleteExportOpaqueItem) => {
          const bytes = bytesByStorageId.get(bytesKey(item.storageItemId));
          if (bytes === undefined) throw new Error("Missing Complete Import fixture bytes");
          return new Blob([Uint8Array.from(bytes)]).stream();
        },
      },
    };
  };
  const initialPackage = packageFrom(stored, creation.genesis.recordId);
  const createBackupVerificationArea = (): CanonicalBackupVerificationArea => {
    const staged = new Map<string, Uint8Array>();
    return {
      beginOpaque: async (item) => {
        const chunks: Uint8Array[] = [];
        const itemKey = bytesKey(item.storageItemId);
        return {
          write: async (bytes) => {
            chunks.push(Uint8Array.from(bytes));
          },
          finish: async () => {
            staged.set(itemKey, concatBytes(chunks));
          },
          abort: async () => {
            staged.delete(itemKey);
          },
        };
      },
      abortAll: async () => {
        staged.clear();
      },
      openOpaque: async (item) => {
        const bytes = staged.get(bytesKey(item.storageItemId));
        if (bytes === undefined) throw new Error("Missing staged Backup wrapper");
        return new Blob([Uint8Array.from(bytes)]).stream();
      },
      discard: async () => {
        staged.clear();
      },
    };
  };
  const backupOpaqueEntries = await Promise.all(
    initialPackage.manifest.opaqueItemInventory.map(async (item) =>
      prepareCompleteExportEntry(
        2,
        new Uint8Array(
          await new Response(await initialPackage.source.openOpaque(item)).arrayBuffer(),
        ),
      ),
    ),
  );
  backupOpaqueEntries.sort((left, right) =>
    bytesKey(left.header.entryId).localeCompare(bytesKey(right.header.entryId)),
  );
  const encryptedBackupPackage: Uint8Array[] = [];
  const backupPassphrase = "correct horse battery staple";
  const sealedBackupPackage = await sealCompleteExportStream({
    passphrase: backupPassphrase,
    salt: new Uint8Array(16).fill(71),
    nonce: new Uint8Array(24).fill(72),
    plaintext: sequenceCompleteExportEntries([
      prepareCompleteExportEntry(1, encodeCompleteExportManifest(initialPackage.manifest)),
      ...backupOpaqueEntries,
      prepareCompleteExportEntry(3, encodeCompleteExportKeyInventory(initialPackage.keyInventory)),
    ]),
    write: async (bytes) => {
      encryptedBackupPackage.push(Uint8Array.from(bytes));
    },
  });
  const [reprotectedBaseline, reprotectedGenesis] = await Promise.all([
    sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: creation.baseline.bytes,
      protectionParameters: new Uint8Array(64).fill(62),
    }),
    sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: creation.genesis.bytes,
      protectionParameters: new Uint8Array(64).fill(63),
    }),
  ]);
  const reprotectedStored = stored.map((item) => {
    if (sameBytes(item.logicalId, creation.baseline.recordId)) {
      return { ...item, bytes: reprotectedBaseline.bytes };
    }
    if (sameBytes(item.logicalId, creation.genesis.recordId)) {
      return { ...item, bytes: reprotectedGenesis.bytes };
    }
    return item;
  });
  const successorPackage = packageFrom(
    [
      ...reprotectedStored,
      {
        namespace: 1,
        logicalId: closure.event.recordId,
        bytes: closure.eventEnvelope.bytes,
      },
    ],
    closure.event.recordId,
  );
  const siblingPackage = packageFrom(
    [
      ...stored,
      {
        namespace: 1,
        logicalId: siblingClosure.event.recordId,
        bytes: siblingClosure.eventEnvelope.bytes,
      },
    ],
    siblingClosure.event.recordId,
  );
  const vacuumReplay = await new CanonicalReplayService({} as never).replayOpened({
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Imported research",
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState: initialReplicaState,
    clientSecret: {
      vaultId: creation.ids.vaultId,
      memberId: creation.ids.firstMemberId,
      clientCredentialId: creation.ids.clientCredentialId,
      signingPublicKey: creation.secrets.client.signingPublicKey,
      signingSecretKey: creation.secrets.client.signingSecretKey,
      wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
      wrappingPrivateKey: creation.secrets.client.wrappingPrivateKey,
    },
    epochSecret: {
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      displayNumber: 0,
      key: creation.secrets.keyEpoch.key,
    },
    baseline: creation.baseline,
    genesis: creation.genesis,
    installationWrappingKey: {} as CryptoKey,
    replicaStateStorageBytes: new Uint8Array(),
  });
  const vacuum = await prepareVacuum({
    replay: vacuumReplay,
    successorGenerationId: randomIdentifier("Generation"),
    assertedAt: 1_800_000_000_004,
  });
  const vacuumPackage = packageFrom(
    [
      ...stored,
      {
        namespace: 1,
        logicalId: vacuum.successor.baseline.recordId,
        bytes: vacuum.successor.baselineEnvelope.bytes,
      },
      {
        namespace: 1,
        logicalId: vacuum.event.recordId,
        bytes: vacuum.eventEnvelope.bytes,
      },
    ],
    vacuum.successor.baseline.recordId,
    {
      generationId: vacuum.successor.baseline.generationId,
      baselineId: vacuum.successor.baseline.recordId,
      authorityFrontierId: vacuum.event.recordId,
    },
  );
  const authoringDatabaseName = `awsm-canonical-complete-import-authoring-${crypto.randomUUID()}`;
  const authoringStorage = new CanonicalIndexedDb(authoringDatabaseName);
  let authoringPreserved = false;
  try {
    const wrappingKey =
      await authoringStorage.getOrCreateInstallationWrappingKey(NORMAL_STORAGE_REALM);
    const prepared = await prepareCanonicalVaultStorage({
      creation,
      label: "Imported research",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey,
    });
    await authoringStorage.commitInitialVault(prepared.commit);
    await new CanonicalCompleteImportService(
      authoringStorage,
      NORMAL_STORAGE_REALM,
      new CanonicalOpfsArtifactStore(),
    ).reconcileKnown(successorPackage);
    const retained = await new CanonicalVaultService(
      authoringStorage,
      NORMAL_STORAGE_REALM,
    ).openVault(creation.ids.vaultId);
    authoringPreserved =
      retained.clientSecret !== null &&
      sameBytes(
        retained.replicaState.authoringClientCredentialId ?? new Uint8Array(),
        creation.ids.clientCredentialId,
      ) &&
      sameBytes(retained.replicaState.memberId ?? new Uint8Array(), creation.ids.firstMemberId) &&
      sameBytes(
        retained.directory.selectedClientCredentialId ?? new Uint8Array(),
        creation.ids.clientCredentialId,
      );
  } finally {
    await authoringStorage.close();
    await deleteBrowserDatabase(authoringDatabaseName);
  }
  const vacuumDatabaseName = `awsm-canonical-complete-import-vacuum-${crypto.randomUUID()}`;
  const vacuumStorage = new CanonicalIndexedDb(vacuumDatabaseName);
  let vacuumAdoption: unknown = null;
  let vacuumReopened = false;
  let predecessorMaterializationsRemoved = false;
  let predecessorAfterAdoption: unknown = null;
  let successorStatePreserved = false;
  let garbageCollectionReclaimedPredecessor = false;
  let garbageCollectionReclaimedArtifact = false;
  let garbageCollectionResumedAfterInterruption = false;
  try {
    await new CanonicalCompleteImportService(
      vacuumStorage,
      NORMAL_STORAGE_REALM,
      new CanonicalOpfsArtifactStore(),
    ).activateUnknown(initialPackage);
    const vaultKey = bytesKey(creation.ids.vaultId);
    await vacuumStorage.putMutable(NORMAL_STORAGE_REALM, {
      namespace: NAMESPACES.libraryProjection.key,
      scopeKey: vaultKey,
      itemKey: "current",
      bytes: new Uint8Array([1]),
    });
    await vacuumStorage.putMutable(NORMAL_STORAGE_REALM, {
      namespace: NAMESPACES.searchMaterialization.key,
      scopeKey: vaultKey,
      itemKey: "current",
      bytes: new Uint8Array([2]),
    });
    vacuumAdoption = await new CanonicalCompleteImportService(
      vacuumStorage,
      NORMAL_STORAGE_REALM,
      new CanonicalOpfsArtifactStore(),
    ).reconcileKnown(vacuumPackage);
    const adopted = await new CanonicalVaultService(vacuumStorage, NORMAL_STORAGE_REALM).openVault(
      creation.ids.vaultId,
    );
    vacuumReopened =
      sameBytes(adopted.replicaState.generationId, vacuum.successor.baseline.generationId) &&
      sameBytes(
        adopted.replicaState.adoption?.vacuumEventRecordId ?? new Uint8Array(),
        vacuum.event.recordId,
      );
    predecessorMaterializationsRemoved =
      (await vacuumStorage.getBytes(NORMAL_STORAGE_REALM, {
        namespace: NAMESPACES.libraryProjection.key,
        scopeKey: vaultKey,
        itemKey: "current",
      })) === undefined &&
      (await vacuumStorage.getBytes(NORMAL_STORAGE_REALM, {
        namespace: NAMESPACES.searchMaterialization.key,
        scopeKey: vaultKey,
        itemKey: "current",
      })) === undefined;
    predecessorAfterAdoption = await new CanonicalCompleteImportService(
      vacuumStorage,
      NORMAL_STORAGE_REALM,
      new CanonicalOpfsArtifactStore(),
    ).reconcileKnown(initialPackage);
    successorStatePreserved = sameBytes(
      (
        await new CanonicalVaultService(vacuumStorage, NORMAL_STORAGE_REALM).openVault(
          creation.ids.vaultId,
        )
      ).replicaState.generationId,
      vacuum.successor.baseline.generationId,
    );
    const vaults = new CanonicalVaultService(vacuumStorage, NORMAL_STORAGE_REALM);
    const artifactStore = new CanonicalOpfsArtifactStore();
    const beforeGarbageCollection = await vaults.openVault(creation.ids.vaultId);
    const orphanedArtifactId = randomIdentifier("Artifact");
    const orphanedArtifactBytes = new TextEncoder().encode("unreachable predecessor artifact");
    const orphanedArtifact = await artifactStore.prepare({
      vaultId: creation.ids.vaultId,
      keyEpochId: beforeGarbageCollection.epochSecret.keyEpochId,
      keyEpochKey: beforeGarbageCollection.epochSecret.key,
      artifactId: orphanedArtifactId,
      contract: {
        plaintextLength: orphanedArtifactBytes.byteLength,
        plaintextDigest: await digestArtifactPayload({
          plaintextLength: orphanedArtifactBytes.byteLength,
          source: chunkedSource(orphanedArtifactBytes),
        }),
      },
      source: chunkedSource(orphanedArtifactBytes),
    });
    await orphanedArtifact.promote();
    const orphanedResolution = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.logicalResolution.key,
      scopeKey: vaultKey,
      itemKey: `5:${bytesKey(orphanedArtifactId)}`,
      wrappingKey: beforeGarbageCollection.installationWrappingKey,
      domain: "awsm.local.logical-resolution",
      context: canonicalLocalStorageContext(creation.ids.vaultId, orphanedArtifactId),
      bytes: encodeLogicalResolution({
        vaultId: creation.ids.vaultId,
        kind: 5,
        logicalId: orphanedArtifactId,
        storageItemId: orphanedArtifact.storageItemId,
        keyEpochId: beforeGarbageCollection.epochSecret.keyEpochId,
        availability: 1,
      }),
    });
    await vacuumStorage.commitReplicaMutation({
      realm: NORMAL_STORAGE_REALM,
      expectedReplicaState: beforeGarbageCollection.replicaStateStorageBytes,
      nextReplicaState: {
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultKey,
        itemKey: "current",
        bytes: beforeGarbageCollection.replicaStateStorageBytes,
      },
      mutableItems: [orphanedResolution],
    });
    let interruptedAfterRemoval = false;
    try {
      await new CanonicalReplicaGarbageCollectionService({
        replays: new CanonicalReplayService(vaults),
        artifacts: {
          remove: async (storageItemId) => {
            await artifactStore.remove(storageItemId);
            throw new Error("injected post-removal interruption");
          },
        },
        now: () => 1_000,
      }).collect(creation.ids.vaultId);
    } catch (error) {
      interruptedAfterRemoval =
        error instanceof Error && error.message === "injected post-removal interruption";
    }
    const interruptedVault = await vaults.openVault(creation.ids.vaultId);
    const interruptedJobs = await vacuumStorage.listBytes(
      NORMAL_STORAGE_REALM,
      NAMESPACES.replicaGarbageCollectionJob.key,
      vaultKey,
    );
    const interruptedJob =
      interruptedJobs.length === 1 && interruptedJobs[0] !== undefined
        ? decodeReplicaGarbageCollectionJob(interruptedJobs[0].bytes)
        : null;
    const interruptionPersisted =
      interruptedAfterRemoval &&
      !(await artifactStore.has(orphanedArtifact.storageItemId)) &&
      interruptedVault.replicaState.garbageCollectionFences.length === 1 &&
      interruptedJob?.state === 2 &&
      interruptedJob.attempt === 1 &&
      (await vacuumStorage.getBytes(NORMAL_STORAGE_REALM, {
        namespace: NAMESPACES.logicalResolution.key,
        scopeKey: vaultKey,
        itemKey: `5:${bytesKey(orphanedArtifactId)}`,
      })) !== undefined;
    const garbageCollection = await new CanonicalReplicaGarbageCollectionService({
      replays: new CanonicalReplayService(vaults),
      artifacts: artifactStore,
      now: () => 31_001,
    }).collect(creation.ids.vaultId);
    const reopenedAfterGarbageCollection = await vaults.openVault(creation.ids.vaultId);
    const terminalJobs = await vacuumStorage.listBytes(
      NORMAL_STORAGE_REALM,
      NAMESPACES.replicaGarbageCollectionJob.key,
      vaultKey,
    );
    const terminalJob =
      terminalJobs.length === 1 && terminalJobs[0] !== undefined
        ? decodeReplicaGarbageCollectionJob(terminalJobs[0].bytes)
        : null;
    garbageCollectionReclaimedPredecessor =
      garbageCollection.removedCompactItemCount >= 1 &&
      garbageCollection.removedResolutionCount >= 1 &&
      (await vacuumStorage.getBytes(NORMAL_STORAGE_REALM, {
        namespace: NAMESPACES.vaultRecord.key,
        scopeKey: vaultKey,
        itemKey: bytesKey(creation.baseline.recordId),
      })) === undefined &&
      (await vacuumStorage.getBytes(NORMAL_STORAGE_REALM, {
        namespace: NAMESPACES.logicalResolution.key,
        scopeKey: vaultKey,
        itemKey: `1:${bytesKey(creation.baseline.recordId)}`,
      })) === undefined &&
      sameBytes(
        reopenedAfterGarbageCollection.replicaState.generationId,
        vacuum.successor.baseline.generationId,
      );
    garbageCollectionReclaimedArtifact =
      garbageCollection.removedArtifactCount === 1 &&
      !(await artifactStore.has(orphanedArtifact.storageItemId)) &&
      (await vacuumStorage.getBytes(NORMAL_STORAGE_REALM, {
        namespace: NAMESPACES.logicalResolution.key,
        scopeKey: vaultKey,
        itemKey: `5:${bytesKey(orphanedArtifactId)}`,
      })) === undefined &&
      terminalJob?.state === 3 &&
      terminalJob.attempt === 2 &&
      terminalJob.terminalOutcome?.removedCompactItemCount ===
        garbageCollection.removedCompactItemCount &&
      terminalJob.terminalOutcome.removedResolutionCount ===
        garbageCollection.removedResolutionCount &&
      terminalJob.terminalOutcome.removedEpochSecretCount ===
        garbageCollection.removedEpochSecretCount &&
      terminalJob.terminalOutcome.removedArtifactCount === garbageCollection.removedArtifactCount &&
      reopenedAfterGarbageCollection.replicaState.garbageCollectionFences.length === 0;
    garbageCollectionResumedAfterInterruption =
      interruptionPersisted && garbageCollectionReclaimedArtifact;
  } finally {
    await vacuumStorage.close();
    await deleteBrowserDatabase(vacuumDatabaseName);
  }
  const backupRestoreDatabaseName = `awsm-canonical-backup-restore-${crypto.randomUUID()}`;
  const backupRestoreStorage = new CanonicalIndexedDb(backupRestoreDatabaseName);
  let backupSnapshotCommitted = false;
  let backupRestoredReadable = false;
  let backupKnownNoop = false;
  try {
    const backupBytes: Uint8Array[] = [];
    let snapshotManifestBytes: Uint8Array | undefined;
    const prepared: CanonicalBackupPreparedSnapshot = {
      write: async (bytes) => {
        backupBytes.push(Uint8Array.from(bytes));
      },
      finish: async () => undefined,
      open: async function* () {
        for (const bytes of backupBytes) yield Uint8Array.from(bytes);
      },
      commit: async (bytes) => {
        snapshotManifestBytes = Uint8Array.from(bytes);
      },
      abort: async () => undefined,
    };
    const backup = await new CanonicalBackupService({
      exporter: {
        export: async (input) => {
          for (const bytes of encryptedBackupPackage) await input.write(bytes);
          return {
            manifest: initialPackage.manifest,
            opaqueItemCount: initialPackage.manifest.opaqueItemInventory.length,
            frameCount: sealedBackupPackage.frameCount,
          };
        },
      },
      createVerificationArea: async () => createBackupVerificationArea(),
    }).createSnapshot({
      backupSetId: new Uint8Array(32).fill(73),
      vaultId: creation.ids.vaultId,
      passphrase: backupPassphrase,
      salt: new Uint8Array(16).fill(71),
      nonce: new Uint8Array(24).fill(72),
      prepared,
    });
    if (snapshotManifestBytes === undefined) throw new Error("Backup did not commit its Snapshot");
    backupSnapshotCommitted = true;
    const vaults = new CanonicalVaultService(backupRestoreStorage, NORMAL_STORAGE_REALM);
    const completeImports = new CanonicalCompleteImportService(
      backupRestoreStorage,
      NORMAL_STORAGE_REALM,
      new CanonicalOpfsArtifactStore(),
    );
    const restores = new CanonicalRestoreService({ vaults, completeImports });
    const restored = await restores.restore({
      snapshotManifestBytes,
      passphrase: backupPassphrase,
      encrypted: (async function* () {
        for (const bytes of backupBytes) yield Uint8Array.from(bytes);
      })(),
      verification: createBackupVerificationArea(),
    });
    const opened = await vaults.openVault(creation.ids.vaultId);
    backupRestoredReadable =
      restored.kind === "activated" &&
      sameBytes(restored.snapshotId, backup.snapshot.snapshotId) &&
      sameBytes(opened.genesis.recordId, creation.genesis.recordId) &&
      opened.clientSecret === null;
    const repeated = await restores.restore({
      snapshotManifestBytes,
      passphrase: backupPassphrase,
      encrypted: (async function* () {
        for (const bytes of backupBytes) yield Uint8Array.from(bytes);
      })(),
      verification: createBackupVerificationArea(),
    });
    backupKnownNoop =
      repeated.kind === "reconciled" && repeated.relation === "equal" && !repeated.changed;
  } finally {
    await backupRestoreStorage.close();
    await deleteBrowserDatabase(backupRestoreDatabaseName);
  }
  const first = new CanonicalIndexedDb(databaseName);
  try {
    await new CanonicalCompleteImportService(
      first,
      NORMAL_STORAGE_REALM,
      new CanonicalOpfsArtifactStore(),
    ).activateUnknown(initialPackage);
    const recordCount = (
      await first.listBytes(
        NORMAL_STORAGE_REALM,
        NAMESPACES.vaultRecord.key,
        bytesKey(creation.ids.vaultId),
      )
    ).length;
    const resolutionCount = (
      await first.listBytes(
        NORMAL_STORAGE_REALM,
        NAMESPACES.logicalResolution.key,
        bytesKey(creation.ids.vaultId),
      )
    ).length;
    const epochCount = (
      await first.listBytes(
        NORMAL_STORAGE_REALM,
        NAMESPACES.epochSecret.key,
        bytesKey(creation.ids.vaultId),
      )
    ).length;
    await first.close();

    const restarted = new CanonicalIndexedDb(databaseName);
    try {
      const opened = await new CanonicalVaultService(restarted, NORMAL_STORAGE_REALM).openVault(
        creation.ids.vaultId,
      );
      const knownRelation = await new CanonicalCompleteImportService(
        restarted,
        NORMAL_STORAGE_REALM,
        new CanonicalOpfsArtifactStore(),
      ).classifyKnown(initialPackage);
      const incomingRelation = await new CanonicalCompleteImportService(
        restarted,
        NORMAL_STORAGE_REALM,
        new CanonicalOpfsArtifactStore(),
      ).classifyKnown(successorPackage);
      const reconciliation = await new CanonicalCompleteImportService(
        restarted,
        NORMAL_STORAGE_REALM,
        new CanonicalOpfsArtifactStore(),
      ).reconcileKnown(successorPackage);
      const reconciled = await new CanonicalVaultService(restarted, NORMAL_STORAGE_REALM).openVault(
        creation.ids.vaultId,
      );
      const ancestorReconciliation = await new CanonicalCompleteImportService(
        restarted,
        NORMAL_STORAGE_REALM,
        new CanonicalOpfsArtifactStore(),
      ).reconcileKnown(initialPackage);
      const divergentReconciliation = await new CanonicalCompleteImportService(
        restarted,
        NORMAL_STORAGE_REALM,
        new CanonicalOpfsArtifactStore(),
      ).reconcileKnown(siblingPackage);
      const afterNonMutatingCollisions = await new CanonicalVaultService(
        restarted,
        NORMAL_STORAGE_REALM,
      ).openVault(creation.ids.vaultId);
      let duplicate = "missing";
      try {
        await new CanonicalCompleteImportService(
          restarted,
          NORMAL_STORAGE_REALM,
          new CanonicalOpfsArtifactStore(),
        ).activateUnknown(initialPackage);
      } catch (error) {
        duplicate = canonicalStorageErrorId(error);
      }
      return {
        vaultLabel: opened.directory.label,
        readOnly:
          opened.clientSecret === null &&
          opened.replicaState.authoringClientCredentialId === null &&
          opened.replicaState.memberId === null,
        authoringPreserved,
        vacuumAdoption,
        vacuumReopened,
        predecessorMaterializationsRemoved,
        predecessorAfterAdoption,
        successorStatePreserved,
        garbageCollectionReclaimedPredecessor,
        garbageCollectionReclaimedArtifact,
        garbageCollectionResumedAfterInterruption,
        backupSnapshotCommitted,
        backupRestoredReadable,
        backupKnownNoop,
        recordCount,
        resolutionCount,
        epochCount,
        restartedReadable: sameBytes(opened.genesis.recordId, creation.genesis.recordId),
        knownRelation,
        incomingRelation,
        reconciliation,
        ancestorReconciliation,
        divergentReconciliation,
        reconciledLifecycle: reconciled.replicaState.lifecycle,
        collisionStatePreserved: sameBytes(
          afterNonMutatingCollisions.replicaState.causalFrontier[0] ?? new Uint8Array(),
          closure.event.recordId,
        ),
        reconciledRecordCount: (
          await restarted.listBytes(
            NORMAL_STORAGE_REALM,
            NAMESPACES.vaultRecord.key,
            bytesKey(creation.ids.vaultId),
          )
        ).length,
        duplicate,
      };
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalVaultCeremonyScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-ceremony-${crypto.randomUUID()}`;
  const firstStorage = new CanonicalIndexedDb(databaseName);
  const artifacts = new BrowserMemoryCanonicalArtifactStore();
  try {
    const service = new CanonicalVaultService(firstStorage, NORMAL_STORAGE_REALM);
    const runtime = new CanonicalClientRuntime(
      service,
      new CanonicalCaptureService(service, artifacts),
      new CanonicalLibraryProjectionService(service, artifacts),
    );
    const setup = await runtime.beginVaultCreation({
      expectedVaultId: null,
      label: "Confirmed vault",
      assertedAt: 99,
    });
    let mismatch = "missing";
    try {
      await runtime.confirmVaultCreation({
        setupId: setup.setupId,
        recoveryPhrase: "not a real phrase",
      });
    } catch (error) {
      mismatch =
        error instanceof Error && "id" in error && typeof error.id === "string"
          ? error.id
          : "unexpected";
    }
    await firstStorage.close();

    const restartedStorage = new CanonicalIndexedDb(databaseName);
    try {
      const restartedService = new CanonicalVaultService(restartedStorage, NORMAL_STORAGE_REALM);
      const restartedRuntime = new CanonicalClientRuntime(
        restartedService,
        new CanonicalCaptureService(restartedService, artifacts),
        new CanonicalLibraryProjectionService(restartedService, artifacts),
      );
      const resumableState = await restartedRuntime.state();
      const resumableSetupId = resumableState.pendingVaultCreation?.setupId === setup.setupId;
      const resumablePhraseAbsent = !Object.hasOwn(
        resumableState.pendingVaultCreation ?? {},
        "recoveryPhrase",
      );
      const created = await restartedRuntime.confirmVaultCreation({
        setupId: setup.setupId,
        recoveryPhrase: setup.recoveryPhrase,
      });
      const vaultId = identifierFromStorageKey("Vault", created.vaultId);
      const opened = await restartedService.openVault(vaultId);
      const directories = await restartedStorage.listBytes(
        NORMAL_STORAGE_REALM,
        NAMESPACES.vaultDirectory.key,
        "installation",
      );
      const selectionItem = {
        namespace: NAMESPACES.installationSelection.key,
        scopeKey: "installation",
        itemKey: "current",
      } as const;
      const selectionBytes = await restartedStorage.getBytes(NORMAL_STORAGE_REALM, selectionItem);
      if (selectionBytes === undefined) throw new Error("Missing Installation Selection");
      const selection = decodeInstallationSelection(selectionBytes);
      let reused = "missing";
      try {
        await restartedRuntime.confirmVaultCreation({
          setupId: setup.setupId,
          recoveryPhrase: setup.recoveryPhrase,
        });
      } catch (error) {
        reused =
          error instanceof Error && "id" in error && typeof error.id === "string"
            ? error.id
            : "unexpected";
      }
      return {
        mismatch,
        directoryCount: directories.length,
        selected: sameBytes(selection.vaultId, vaultId),
        opened: sameBytes(opened.directory.vaultId, vaultId),
        resumableSetupId,
        resumablePhraseAbsent,
        resumedAfterRestart: true,
        reused,
      };
    } finally {
      await restartedStorage.close();
    }
  } finally {
    await firstStorage.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalCaptureCommitScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-capture-${crypto.randomUUID()}`;
  const storage = new CanonicalIndexedDb(databaseName);
  try {
    const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const ceremony = await vaults.beginCreate({
      setupId: crypto.randomUUID(),
      expectedVaultId: null,
      label: "Capture vault",
      assertedAt: 1,
    });
    const created = await ceremony.confirm(ceremony.recoveryPhrase);
    const artifacts = new BrowserMemoryCanonicalArtifactStore();
    const captures = new CanonicalCaptureService(vaults, artifacts);
    const command = async (commandId: string, capturedAt: number) => {
      const url = `https://example.com/${commandId}`;
      const snapshot = await createPageSnapshotBlob({
        capturedAt,
        originalUrl: url,
        finalUrl: url,
        documents: [
          {
            originalUrl: url,
            finalUrl: url,
            bytes: new TextEncoder().encode(`<!doctype html><title>${commandId}</title>`),
            scrollX: 0,
            scrollY: 0,
          },
        ],
        resources: [],
        omissions: [],
      });
      return {
        commandId,
        vaultId: created.vaultId,
        originalUrl: url,
        finalUrl: url,
        title: commandId,
        capturedAt,
        primary: { blob: snapshot.blob },
      };
    };
    const [firstCommand, secondCommand] = await Promise.all([
      command("capture-one", 10),
      command("capture-two", 11),
    ]);
    const [first, second] = await Promise.all([
      captures.execute(firstCommand),
      captures.execute(secondCommand),
    ]);
    const repeated = await captures.execute(firstCommand);
    const reopened = await vaults.openVault(created.vaultId);
    const vaultKey = bytesKey(created.vaultId);
    const [records, objects, outcomes, resolutions] = await Promise.all([
      storage.listBytes(NORMAL_STORAGE_REALM, NAMESPACES.vaultRecord.key, vaultKey),
      storage.listBytes(NORMAL_STORAGE_REALM, NAMESPACES.vaultObject.key, vaultKey),
      storage.listBytes(NORMAL_STORAGE_REALM, NAMESPACES.commandOutcome.key, vaultKey),
      storage.listBytes(NORMAL_STORAGE_REALM, NAMESPACES.logicalResolution.key, vaultKey),
    ]);
    const frontier = reopened.replicaState.causalFrontier[0];
    return {
      firstIdempotent: sameBytes(first.eventRecordId, repeated.eventRecordId),
      bothCommitted:
        first.eventRecordId.some((byte, index) => byte !== second.eventRecordId[index]) &&
        frontier !== undefined &&
        (sameBytes(frontier, first.eventRecordId) || sameBytes(frontier, second.eventRecordId)),
      recordCount: records.length,
      objectCount: objects.length,
      outcomeCount: outcomes.length,
      resolutionCount: resolutions.length,
      artifactCount: artifacts.promoted.size,
      reopenedAfterCapture: sameBytes(
        reopened.genesis.recordId,
        reopened.replicaState.authorityFrontier[0] ?? new Uint8Array(),
      ),
    };
  } finally {
    await storage.close();
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalMemberRecoveryScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-member-recovery-${crypto.randomUUID()}`;
  const storage = new CanonicalIndexedDb(databaseName);
  const artifacts = new BrowserMemoryCanonicalArtifactStore();
  try {
    const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const runtime = new CanonicalClientRuntime(
      vaults,
      new CanonicalCaptureService(vaults, artifacts),
      new CanonicalLibraryProjectionService(vaults, artifacts),
    );
    const setup = await runtime.beginVaultCreation({
      expectedVaultId: null,
      label: "Recovery vault",
      assertedAt: 1,
    });
    const created = await runtime.confirmVaultCreation({
      setupId: setup.setupId,
      recoveryPhrase: setup.recoveryPhrase,
    });
    const vaultId = identifierFromStorageKey("Vault", created.vaultId);
    const opened = await vaults.openVault(vaultId);
    const originalMemberId = opened.replicaState.memberId;
    const originalClientCredentialId = opened.replicaState.authoringClientCredentialId;
    if (originalMemberId === null || originalClientCredentialId === null) {
      throw new Error("New Vault did not retain its initial local Client authority");
    }
    const vaultStorageKey = bytesKey(vaultId);
    const readOnlyReplicaState = {
      ...opened.replicaState,
      authoringClientCredentialId: null,
      memberId: null,
    };
    const [nextReplicaState, directoryItem] = await Promise.all([
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultStorageKey,
        itemKey: "current",
        wrappingKey: opened.installationWrappingKey,
        domain: "awsm.local.replica-state",
        context: canonicalLocalStorageContext(vaultId, opened.replicaState.generationId),
        bytes: encodeCanonicalReplicaState(readOnlyReplicaState),
      }),
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.vaultDirectory.key,
        scopeKey: "installation",
        itemKey: vaultStorageKey,
        wrappingKey: opened.installationWrappingKey,
        domain: "awsm.local.vault-directory",
        context: canonicalLocalStorageContext(vaultId, vaultId),
        bytes: encodeVaultDirectoryEntry({
          ...opened.directory,
          selectedClientCredentialId: null,
        }),
      }),
    ]);
    await storage.commitReplicaMutation({
      realm: NORMAL_STORAGE_REALM,
      expectedReplicaState: opened.replicaStateStorageBytes,
      nextReplicaState,
      mutableItems: [directoryItem],
      deletedItems: [
        {
          namespace: NAMESPACES.clientSecret.key,
          scopeKey: vaultStorageKey,
          itemKey: bytesKey(originalClientCredentialId),
        },
      ],
    });
    const readOnly = await vaults.openVault(vaultId);
    const recovery = await runtime.recoverMember({
      expectedVaultId: created.vaultId,
      commandId: "browser-member-recovery",
      recoveryPhrase: setup.recoveryPhrase,
      assertedAt: 2,
    });
    const recoveredReplay = await new CanonicalReplayService(vaults).replay(vaultId);
    const recoveryEvent = recoveredReplay.events.find(
      ({ recordId }) => bytesKey(recordId) === recovery.eventRecordId,
    );
    const replacementSetup = await runtime.beginRecoveryPhraseReplacement({
      expectedVaultId: created.vaultId,
      assertedAt: 3,
    });
    const replacement = await runtime.confirmRecoveryPhraseReplacement({
      setupId: replacementSetup.setupId,
      recoveryPhrase: replacementSetup.recoveryPhrase,
    });
    let oldPhraseRetired = false;
    try {
      await runtime.recoverMember({
        expectedVaultId: created.vaultId,
        commandId: "browser-retired-member-recovery",
        recoveryPhrase: setup.recoveryPhrase,
        assertedAt: 4,
      });
    } catch (error) {
      oldPhraseRetired =
        error instanceof Error &&
        error.message === "Recovery Phrase does not match an effective Recovery Credential";
    }
    await storage.close();

    const restartedStorage = new CanonicalIndexedDb(databaseName);
    try {
      const restartedVaults = new CanonicalVaultService(restartedStorage, NORMAL_STORAGE_REALM);
      const restartedRuntime = new CanonicalClientRuntime(
        restartedVaults,
        new CanonicalCaptureService(restartedVaults, artifacts),
        new CanonicalLibraryProjectionService(restartedVaults, artifacts),
      );
      const restarted = await restartedVaults.openVault(vaultId);
      const restartedReplay = await new CanonicalReplayService(restartedVaults).replay(vaultId);
      const activeClient = restartedReplay.authority.clientCredentials.get(
        recovery.clientCredentialId,
      );
      const authored = await restartedRuntime.closeVault({
        expectedVaultId: created.vaultId,
        commandId: "browser-recovered-close",
        assertedAt: 5,
      });
      const [clientSecrets, epochSecrets] = await Promise.all([
        restartedStorage.listBytes(
          NORMAL_STORAGE_REALM,
          NAMESPACES.clientSecret.key,
          vaultStorageKey,
        ),
        restartedStorage.listBytes(
          NORMAL_STORAGE_REALM,
          NAMESPACES.epochSecret.key,
          vaultStorageKey,
        ),
      ]);
      return {
        readOnlyBeforeRecovery:
          readOnly.clientSecret === null &&
          readOnly.replicaState.memberId === null &&
          readOnly.replicaState.authoringClientCredentialId === null,
        recoveredSameMember: recovery.memberId === bytesKey(originalMemberId),
        freshClientCredential: recovery.clientCredentialId !== bytesKey(originalClientCredentialId),
        recoveryEventAccepted: recoveryEvent?.family === 1 && recoveryEvent.type === 9,
        replacementRevision: replacement.revision,
        oldPhraseRetired,
        effectiveRecoveryHeads: restartedReplay.authority.recoveryCredentials.filter(
          ({ effective }) => effective,
        ).length,
        restartedClientActive:
          restarted.clientSecret !== null &&
          bytesKey(restarted.clientSecret.clientCredentialId) === recovery.clientCredentialId &&
          activeClient?.active === true,
        authoredAfterRestart: authored.eventRecordId.length === 64,
        clientSecretCount: clientSecrets.length,
        epochSecretCount: epochSecrets.length,
      };
    } finally {
      await restartedStorage.close();
    }
  } finally {
    await storage.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalLibraryProjectionScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-library-${crypto.randomUUID()}`;
  const storage = new CanonicalIndexedDb(databaseName);
  try {
    const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const ceremony = await vaults.beginCreate({
      setupId: crypto.randomUUID(),
      expectedVaultId: null,
      label: "Library vault",
      assertedAt: 1,
    });
    const created = await ceremony.confirm(ceremony.recoveryPhrase);
    const artifacts = new BrowserMemoryCanonicalArtifactStore();
    const captures = new CanonicalCaptureService(vaults, artifacts);
    const library = new CanonicalLibraryProjectionService(vaults, artifacts);
    const capture = async (commandId: string, title: string, capturedAt: number) => {
      const url = `https://example.com/${commandId}`;
      const snapshot = await createPageSnapshotBlob({
        capturedAt,
        originalUrl: url,
        finalUrl: url,
        documents: [
          {
            originalUrl: url,
            finalUrl: url,
            bytes: new TextEncoder().encode(`<!doctype html><title>${title}</title>`),
            scrollX: 0,
            scrollY: 0,
          },
        ],
        resources: [],
        omissions: [],
      });
      return captures.execute({
        commandId,
        vaultId: created.vaultId,
        originalUrl: url,
        finalUrl: url,
        title,
        capturedAt,
        primary: { blob: snapshot.blob },
      });
    };
    const firstOutcome = await capture("library-one", "First", 10);
    const firstProjection = await library.load(created.vaultId);
    const firstCache = await storage.listBytes(
      NORMAL_STORAGE_REALM,
      NAMESPACES.libraryProjection.key,
      bytesKey(created.vaultId),
    );
    const secondOutcome = await capture("library-two", "Second", 11);
    const updatedProjection = await library.load(created.vaultId);
    await storage.close();

    const restartedStorage = new CanonicalIndexedDb(databaseName);
    try {
      const restartedVaults = new CanonicalVaultService(restartedStorage, NORMAL_STORAGE_REALM);
      const restartedLibrary = new CanonicalLibraryProjectionService(restartedVaults, artifacts);
      const restartedProjection = await restartedLibrary.load(created.vaultId);
      const caches = await restartedStorage.listBytes(
        NORMAL_STORAGE_REALM,
        NAMESPACES.libraryProjection.key,
        bytesKey(created.vaultId),
      );
      return {
        firstCaptureCount: firstProjection.captures.length,
        firstCaptureMatches: sameBytes(
          firstProjection.captures[0]?.bundleId ?? new Uint8Array(),
          firstOutcome.bundleId,
        ),
        firstCacheCount: firstCache.length,
        updatedTitles: updatedProjection.captures.map(({ title }) => title),
        updatedCaptureIds: updatedProjection.captures.map(({ bundleId }) => bytesKey(bundleId)),
        expectedCaptureIds: [firstOutcome.bundleId, secondOutcome.bundleId].map(bytesKey),
        allArtifactsAvailable: updatedProjection.captures.every(
          ({ artifactAvailableLocally }) => artifactAvailableLocally,
        ),
        conflictCount: updatedProjection.conflicts.length,
        restartedCaptureCount: restartedProjection.captures.length,
        cacheCount: caches.length,
        cacheCiphertextExcludesTitles: caches.every(
          ({ bytes }) =>
            !new TextDecoder().decode(bytes).includes("First") &&
            !new TextDecoder().decode(bytes).includes("Second"),
        ),
      };
    } finally {
      await restartedStorage.close();
    }
  } finally {
    await storage.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalClientRuntimeScenario(): Promise<unknown> {
  const databaseName = `awsm-canonical-client-${crypto.randomUUID()}`;
  const storage = new CanonicalIndexedDb(databaseName);
  const artifacts = new BrowserMemoryCanonicalArtifactStore();
  try {
    const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const library = new CanonicalLibraryProjectionService(vaults, artifacts);
    const runtime = new CanonicalClientRuntime(
      vaults,
      new CanonicalCaptureService(vaults, artifacts),
      library,
    );
    const firstSetup = await runtime.beginVaultCreation({
      expectedVaultId: null,
      label: "First",
      assertedAt: 1,
    });
    const first = await runtime.confirmVaultCreation({
      setupId: firstSetup.setupId,
      recoveryPhrase: firstSetup.recoveryPhrase,
    });
    const secondSetup = await runtime.beginVaultCreation({
      expectedVaultId: first.vaultId,
      label: "Second",
      assertedAt: 2,
    });
    const second = await runtime.confirmVaultCreation({
      setupId: secondSetup.setupId,
      recoveryPhrase: secondSetup.recoveryPhrase,
    });
    const selectedAfterCreate = (await runtime.state()).vaults.find(
      ({ selected }) => selected,
    )?.label;
    const switched = await runtime.selectVault({
      expectedVaultId: second.vaultId,
      vaultId: first.vaultId,
    });
    const selectedAfterSwitch = switched.vaults.find(({ selected }) => selected)?.label;
    const capturedAt = 10;
    const url = "https://example.com/facade";
    const snapshot = await createPageSnapshotBlob({
      capturedAt,
      originalUrl: url,
      finalUrl: url,
      documents: [
        {
          originalUrl: url,
          finalUrl: url,
          bytes: new TextEncoder().encode("<!doctype html><title>Facade capture</title>"),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
      omissions: [],
    });
    const capture = await runtime.capture({
      expectedVaultId: first.vaultId,
      commandId: "facade-capture",
      originalUrl: url,
      finalUrl: url,
      title: "Facade capture",
      capturedAt,
      primary: { blob: snapshot.blob },
    });
    const initialLibrary = await runtime.listLibrary(first.vaultId);
    const originalCollectionId = initialLibrary[0]?.collectionId;
    if (originalCollectionId === undefined) throw new Error("Initial Collection is unavailable");
    const deleted = await runtime.deleteCaptures({
      expectedVaultId: first.vaultId,
      commandId: "facade-delete",
      bundleIds: [capture.bundleId],
      assertedAt: 11,
    });
    const repeatedDelete = await runtime.deleteCaptures({
      expectedVaultId: first.vaultId,
      commandId: "facade-delete",
      bundleIds: [capture.bundleId],
      assertedAt: 11,
    });
    const deletedLibrary = await runtime.listLibrary(first.vaultId);
    await runtime.restoreCaptures({
      expectedVaultId: first.vaultId,
      commandId: "facade-restore",
      bundleIds: [capture.bundleId],
      assertedAt: 12,
    });
    const restoredLibrary = await runtime.listLibrary(first.vaultId);
    const destinationCollectionId = bytesKey(randomIdentifier("Collection"));
    await runtime.moveCaptures({
      expectedVaultId: first.vaultId,
      commandId: "facade-move",
      bundleIds: [capture.bundleId],
      destinationCollectionId,
      assertedAt: 13,
    });
    const movedLibrary = await runtime.listLibrary(first.vaultId);
    await runtime.setCollectionTitle({
      expectedVaultId: first.vaultId,
      commandId: "facade-title",
      collectionId: destinationCollectionId,
      title: "Reading list",
      assertedAt: 14,
    });
    const collections = await runtime.listCollections(first.vaultId);
    const merge = await runtime.mergeCollections({
      expectedVaultId: first.vaultId,
      commandId: "facade-merge",
      sourceCollectionIds: [destinationCollectionId],
      destinationCollectionId: originalCollectionId,
      assertedAt: 15,
    });
    const mergedLibrary = await runtime.listLibrary(first.vaultId);
    await runtime.revertCollectionMerge({
      expectedVaultId: first.vaultId,
      commandId: "facade-merge-revert",
      redirectCauseId: merge.eventRecordId,
      assertedAt: 16,
    });
    const revertedMergeLibrary = await runtime.listLibrary(first.vaultId);
    const folder = await runtime.createFolder({
      expectedVaultId: first.vaultId,
      commandId: "facade-folder-create",
      name: "Inbox",
      parentFolderId: null,
      assertedAt: 17,
    });
    await runtime.renameFolder({
      expectedVaultId: first.vaultId,
      commandId: "facade-folder-rename",
      folderId: folder.folderId,
      name: "Research",
      assertedAt: 18,
    });
    await runtime.placeFolder({
      expectedVaultId: first.vaultId,
      commandId: "facade-folder-place",
      folderId: folder.folderId,
      parentFolderId: null,
      assertedAt: 19,
    });
    await runtime.deleteFolder({
      expectedVaultId: first.vaultId,
      commandId: "facade-folder-delete",
      folderId: folder.folderId,
      assertedAt: 20,
    });
    const foldersAfterDelete = await runtime.listFolders(first.vaultId);
    await runtime.restoreFolder({
      expectedVaultId: first.vaultId,
      commandId: "facade-folder-restore",
      folderId: folder.folderId,
      assertedAt: 21,
    });
    const foldersAfterRestore = await runtime.listFolders(first.vaultId);
    await runtime.placeCollectionInFolder({
      expectedVaultId: first.vaultId,
      commandId: "facade-collection-folder",
      collectionId: destinationCollectionId,
      folderId: folder.folderId,
      assertedAt: 22,
    });
    const folderCollections = await runtime.listCollections(first.vaultId);
    const tag = await runtime.createTag({
      expectedVaultId: first.vaultId,
      commandId: "facade-tag-create",
      name: "Saved",
      assertedAt: 23,
    });
    await runtime.renameTag({
      expectedVaultId: first.vaultId,
      commandId: "facade-tag-rename",
      tagId: tag.tagId,
      name: "Important",
      assertedAt: 24,
    });
    await runtime.assignTag({
      expectedVaultId: first.vaultId,
      commandId: "facade-tag-assign",
      tagId: tag.tagId,
      targetKind: "Collection",
      targetId: destinationCollectionId,
      assertedAt: 25,
    });
    const activeTagAssignments = await runtime.listTagAssignments(first.vaultId);
    await runtime.deleteTag({
      expectedVaultId: first.vaultId,
      commandId: "facade-tag-delete",
      tagId: tag.tagId,
      assertedAt: 26,
    });
    const dormantTagAssignments = await runtime.listTagAssignments(first.vaultId);
    await runtime.restoreTag({
      expectedVaultId: first.vaultId,
      commandId: "facade-tag-restore",
      tagId: tag.tagId,
      assertedAt: 27,
    });
    const restoredTagAssignments = await runtime.listTagAssignments(first.vaultId);
    await runtime.removeTagAssignments({
      expectedVaultId: first.vaultId,
      commandId: "facade-tag-remove",
      tagId: tag.tagId,
      targetKind: "Collection",
      targetId: destinationCollectionId,
      assertedAt: 28,
    });
    const tagAssignmentsAfterRemove = await runtime.listTagAssignments(first.vaultId);
    const tags = await runtime.listTags(first.vaultId);
    const note = await runtime.createNote({
      expectedVaultId: first.vaultId,
      commandId: "facade-note-create",
      targetKind: "Collection",
      targetId: destinationCollectionId,
      title: "Context",
      body: "A complete **Note**.",
      assertedAt: 29,
    });
    const notes = (await library.load(identifierFromStorageKey("Vault", first.vaultId))).notes;
    await runtime.reviseNote({
      expectedVaultId: first.vaultId,
      commandId: "facade-note-revise",
      noteId: note.noteId,
      title: "Context",
      body: "Revised body.",
      assertedAt: 30,
    });
    const revisedNotes = await runtime.listNotes(first.vaultId);
    await runtime.deleteNote({
      expectedVaultId: first.vaultId,
      commandId: "facade-note-delete",
      noteId: note.noteId,
      assertedAt: 31,
    });
    const deletedNotes = await runtime.listNotes(first.vaultId);
    await runtime.restoreNote({
      expectedVaultId: first.vaultId,
      commandId: "facade-note-restore",
      noteId: note.noteId,
      assertedAt: 32,
    });
    const restoredNotes = await runtime.listNotes(first.vaultId);
    const searchCapture = (
      await runtime.search({
        expectedVaultId: first.vaultId,
        query: "facade",
        scope: "Active",
        hosts: [],
        collectionIds: [],
        tagIds: [],
      })
    ).find(({ kind }) => kind === "Capture");
    const searchNote = (
      await runtime.search({
        expectedVaultId: first.vaultId,
        query: "revised",
        scope: "Active",
        hosts: [],
        collectionIds: [],
        tagIds: [],
      })
    ).find(({ kind }) => kind === "Note");
    const searchCoverage = await runtime.searchCoverage(first.vaultId);
    const searchCaches = await storage.listBytes(
      NORMAL_STORAGE_REALM,
      NAMESPACES.searchMaterialization.key,
      first.vaultId,
    );
    const vacuum = await runtime.vacuumVault({
      expectedVaultId: first.vaultId,
      commandId: "facade-vacuum",
      assertedAt: 33,
    });
    const repeatedVacuum = await runtime.vacuumVault({
      expectedVaultId: first.vaultId,
      commandId: "facade-vacuum",
      assertedAt: 33,
    });
    const postVacuumSearchCaches = await storage.listBytes(
      NORMAL_STORAGE_REALM,
      NAMESPACES.searchMaterialization.key,
      first.vaultId,
    );
    const postVacuumLibraryCaches = await storage.listBytes(
      NORMAL_STORAGE_REALM,
      NAMESPACES.libraryProjection.key,
      first.vaultId,
    );
    const postVacuumNotes = await runtime.listNotes(first.vaultId);
    await runtime.capture({
      expectedVaultId: first.vaultId,
      commandId: "facade-post-vacuum-capture",
      originalUrl: url,
      finalUrl: url,
      title: "Facade capture after Vacuum",
      capturedAt,
      primary: { blob: snapshot.blob },
    });
    const postVacuumLibrary = await runtime.listLibrary(first.vaultId);
    const secondVacuum = await runtime.vacuumVault({
      expectedVaultId: first.vaultId,
      commandId: "facade-vacuum-second-generation",
      assertedAt: 34,
    });
    const postSecondVacuumLibrary = await runtime.listLibrary(first.vaultId);
    const postSecondVacuumNotes = await runtime.listNotes(first.vaultId);
    const forkSetup = await runtime.beginVaultFork({
      expectedVaultId: first.vaultId,
      assertedAt: 35,
    });
    const fork = await runtime.confirmVaultFork({
      setupId: forkSetup.setupId,
      recoveryPhrase: forkSetup.recoveryPhrase,
    });
    const forkLibrary = await runtime.listLibrary(fork.vaultId);
    const forkNotes = await runtime.listNotes(fork.vaultId);
    await runtime.selectVault({
      expectedVaultId: fork.vaultId,
      vaultId: first.vaultId,
    });
    const sourceLibraryAfterFork = await runtime.listLibrary(first.vaultId);
    const closure = await runtime.closeVault({
      expectedVaultId: first.vaultId,
      commandId: "facade-close",
      assertedAt: 36,
    });
    const repeatedClosure = await runtime.closeVault({
      expectedVaultId: first.vaultId,
      commandId: "facade-close",
      assertedAt: 36,
    });
    let closedWriteRejected: string | undefined;
    try {
      await runtime.setCollectionTitle({
        expectedVaultId: first.vaultId,
        commandId: "facade-after-close",
        collectionId: destinationCollectionId,
        title: "Too late",
        assertedAt: 35,
      });
    } catch (error) {
      closedWriteRejected = error instanceof Error ? error.message : String(error);
    }
    const records = await storage.listBytes(
      NORMAL_STORAGE_REALM,
      NAMESPACES.vaultRecord.key,
      first.vaultId,
    );
    await storage.close();

    const restartedStorage = new CanonicalIndexedDb(databaseName);
    try {
      const restartedVaults = new CanonicalVaultService(restartedStorage, NORMAL_STORAGE_REALM);
      const restartedLibrary = new CanonicalLibraryProjectionService(restartedVaults, artifacts);
      const restarted = new CanonicalClientRuntime(
        restartedVaults,
        new CanonicalCaptureService(restartedVaults, artifacts),
        restartedLibrary,
      );
      const restartedState = await restarted.state();
      const restartedFolders = await restarted.listFolders(first.vaultId);
      const restartedCollections = await restarted.listCollections(first.vaultId);
      const restartedTags = await restarted.listTags(first.vaultId);
      const restartedTagAssignments = await restarted.listTagAssignments(first.vaultId);
      const restartedNotes = (
        await restartedLibrary.load(identifierFromStorageKey("Vault", first.vaultId))
      ).notes;
      const restartedClosedSearchNote = (
        await restarted.search({
          expectedVaultId: first.vaultId,
          query: "revised",
          scope: "Active",
          hosts: [],
          collectionIds: [],
          tagIds: [],
        })
      ).find(({ kind }) => kind === "Note");
      await restarted.selectVault({
        expectedVaultId: first.vaultId,
        vaultId: fork.vaultId,
      });
      const restartedForkLibrary = await restarted.listLibrary(fork.vaultId);
      const restartedForkNotes = await restarted.listNotes(fork.vaultId);
      return {
        recoveryWordCount: secondSetup.recoveryPhrase.split(" ").length,
        selectedAfterCreate,
        selectedAfterSwitch,
        captureCount: initialLibrary.length,
        captureTitle: initialLibrary[0]?.title,
        captureMatches: initialLibrary[0]?.bundleId === capture.bundleId,
        deleteIdempotent: deleted.eventRecordId === repeatedDelete.eventRecordId,
        deletedLifecycle: deletedLibrary[0]?.lifecycle,
        restoredLifecycle: restoredLibrary[0]?.lifecycle,
        moved: movedLibrary[0]?.collectionId === destinationCollectionId,
        collectionTitle: collections.find(
          ({ collectionId }) => collectionId === destinationCollectionId,
        )?.title,
        merged: mergedLibrary[0]?.collectionId === originalCollectionId,
        mergeReverted: revertedMergeLibrary[0]?.collectionId === destinationCollectionId,
        folderName: foldersAfterRestore[0]?.name,
        folderLifecycleAfterDelete: foldersAfterDelete[0]?.lifecycle,
        folderLifecycleAfterRestore: foldersAfterRestore[0]?.lifecycle,
        collectionFolderPlaced:
          folderCollections.find(({ collectionId }) => collectionId === destinationCollectionId)
            ?.folderId === folder.folderId,
        restartedFolderName: restartedFolders[0]?.name,
        restartedCollectionFolderPlaced:
          restartedCollections.find(({ collectionId }) => collectionId === destinationCollectionId)
            ?.folderId === folder.folderId,
        tagName: tags.find(({ tagId }) => tagId === tag.tagId)?.name,
        tagAssignmentActive: activeTagAssignments[0]?.active,
        tagAssignmentDormant: dormantTagAssignments[0]?.active,
        tagAssignmentRestored: restoredTagAssignments[0]?.active,
        tagAssignmentsAfterRemove: tagAssignmentsAfterRemove.length,
        restartedTagName: restartedTags.find(({ tagId }) => tagId === tag.tagId)?.name,
        restartedTagAssignments: restartedTagAssignments.length,
        noteTitle: notes[0]?.versions[0]?.title,
        revisedNoteBody: revisedNotes[0]?.versions[0]?.body,
        deletedNoteState: deletedNotes[0]?.state,
        restoredNoteState: restoredNotes[0]?.state,
        restoredNoteBody: restoredNotes[0]?.versions[0]?.body,
        restartedNoteTitle: restartedNotes[0]?.versions[0]?.title,
        restartedNoteBody: restartedNotes[0]?.versions[0]?.body,
        restartedForkCaptureCount: restartedForkLibrary.length,
        restartedForkNoteBody: restartedForkNotes[0]?.versions[0]?.body,
        searchCapture:
          searchCapture === undefined
            ? undefined
            : { kind: searchCapture.kind, title: searchCapture.title },
        searchNote:
          searchNote === undefined
            ? undefined
            : {
                kind: searchNote.kind,
                title: searchNote.title,
                snippet: searchNote.snippet,
              },
        searchCoverage,
        searchCacheCount: searchCaches.length,
        searchCacheExcludesPlaintext: searchCaches.every(({ bytes }) => {
          const ciphertext = new TextDecoder().decode(bytes);
          return !ciphertext.includes("Facade capture") && !ciphertext.includes("Revised body.");
        }),
        vacuumIdempotent:
          vacuum.vacuumEventRecordId === repeatedVacuum.vacuumEventRecordId &&
          vacuum.successorBaselineId === repeatedVacuum.successorBaselineId,
        vacuumInvalidatedCaches:
          postVacuumSearchCaches.length === 0 && postVacuumLibraryCaches.length === 0,
        postVacuumCaptureCount: postVacuumLibrary.length,
        postVacuumNoteBody: postVacuumNotes[0]?.versions[0]?.body,
        secondVacuumAdvancedGeneration:
          secondVacuum.predecessorGenerationId === vacuum.successorGenerationId &&
          secondVacuum.successorGenerationId !== secondVacuum.predecessorGenerationId,
        postSecondVacuumCaptureCount: postSecondVacuumLibrary.length,
        postSecondVacuumNoteBody: postSecondVacuumNotes[0]?.versions[0]?.body,
        forkRecoveryWordCount: forkSetup.recoveryPhrase.split(" ").length,
        forkIdentityFresh: fork.vaultId !== first.vaultId,
        forkCaptureCount: forkLibrary.length,
        forkNoteBody: forkNotes[0]?.versions[0]?.body,
        sourceCaptureCountAfterFork: sourceLibraryAfterFork.length,
        closureIdempotent: closure.eventRecordId === repeatedClosure.eventRecordId,
        closedWriteRejected,
        restartedClosedSearchNote:
          restartedClosedSearchNote === undefined
            ? undefined
            : {
                kind: restartedClosedSearchNote.kind,
                title: restartedClosedSearchNote.title,
                snippet: restartedClosedSearchNote.snippet,
              },
        recordCount: records.length,
        restartSelected: restartedState.vaults.find(({ selected }) => selected)?.label,
        restartVaultCount: restartedState.vaults.length,
      };
    } finally {
      await restartedStorage.close();
    }
  } finally {
    await storage.close().catch(() => undefined);
    await deleteBrowserDatabase(databaseName);
  }
}

async function canonicalOpfsArtifactScenario(): Promise<unknown> {
  const store = new CanonicalOpfsArtifactStore();
  const payload = new Uint8Array(FRAME_PLAINTEXT_LIMIT + 97);
  for (let offset = 0; offset < payload.byteLength; offset += 65_536) {
    crypto.getRandomValues(payload.subarray(offset, Math.min(offset + 65_536, payload.byteLength)));
  }
  const vaultId = randomIdentifier("Vault");
  const keyEpochKey = crypto.getRandomValues(new Uint8Array(32));
  const keyEpochId = deriveKeyEpochId(vaultId, keyEpochKey);
  const artifactId = identifier("Artifact", crypto.getRandomValues(new Uint8Array(32)));
  const plaintextDigest = await digestArtifactPayload({
    plaintextLength: payload.byteLength,
    source: chunkedSource(payload, 101_003),
  });
  const input = {
    vaultId,
    keyEpochId,
    keyEpochKey,
    artifactId,
    contract: { plaintextLength: payload.byteLength, plaintextDigest },
    source: chunkedSource(payload, 77_777),
    protectionParameters: new Uint8Array(64).fill(42),
  } as const;
  const prepared = await store.prepare(input);
  const beforePromotion = await store.has(prepared.storageItemId);
  await prepared.promote();
  await prepared.promote();
  const promoted = await store.has(prepared.storageItemId);
  await prepared.discard();
  const retainedAfterDiscard = await store.has(prepared.storageItemId);
  const opened = await store.open(prepared.storageItemId);
  const openedBytes = new Uint8Array(await new Response(opened).arrayBuffer());
  const envelope = decodeOpaqueEnvelope(openedBytes);
  await store.remove(prepared.storageItemId);
  const imported = await store.prepareOpaque({
    artifactId,
    storageItemId: prepared.storageItemId,
    envelopeByteLength: openedBytes.byteLength,
    source: new Blob([Uint8Array.from(openedBytes)]).stream(),
  });
  const importedBeforePromotion = await store.has(prepared.storageItemId);
  await imported.promote();
  const importedPresent = await store.has(prepared.storageItemId);
  const tamperedBytes = Uint8Array.from(openedBytes);
  tamperedBytes[tamperedBytes.byteLength - 1] = (tamperedBytes.at(-1) ?? 0) ^ 1;
  let opaqueTamperRejected = false;
  try {
    await store.prepareOpaque({
      artifactId,
      storageItemId: prepared.storageItemId,
      envelopeByteLength: tamperedBytes.byteLength,
      source: new Blob([tamperedBytes]).stream(),
    });
  } catch {
    opaqueTamperRejected = true;
  }

  const root = await navigator.storage.getDirectory();
  const items = await (
    await root.getDirectoryHandle("awsm-canonical-artifacts")
  ).getDirectoryHandle("items");
  const name = `${bytesKey(prepared.storageItemId)}.opaque`;
  const corruptHandle = await items.getFileHandle(name);
  const corruptWritable = await corruptHandle.createWritable({ keepExistingData: false });
  await corruptWritable.write(Uint8Array.of(1, 2, 3).buffer);
  await corruptWritable.close();
  const corruptionDetected = !(await store.has(prepared.storageItemId));

  const repaired = await store.prepare({ ...input, source: chunkedSource(payload, 53_003) });
  await repaired.promote();
  const repairedPresent = await store.has(repaired.storageItemId);
  const orphanPayload = Uint8Array.of(9, 8, 7, 6);
  const orphanDigest = await digestArtifactPayload({
    plaintextLength: orphanPayload.byteLength,
    source: chunkedSource(orphanPayload),
  });
  const orphan = await store.prepare({
    ...input,
    artifactId: identifier("Artifact", crypto.getRandomValues(new Uint8Array(32))),
    contract: { plaintextLength: orphanPayload.byteLength, plaintextDigest: orphanDigest },
    source: chunkedSource(orphanPayload),
    protectionParameters: new Uint8Array(64).fill(43),
  });
  await orphan.promote();
  await store.reconcile(new Set([bytesKey(repaired.storageItemId)]));
  const orphanRemoved = !(await store.has(orphan.storageItemId));
  await store.remove(repaired.storageItemId);
  return {
    beforePromotion,
    promoted,
    retainedAfterDiscard,
    frameCount: prepared.stream.frameCount,
    envelopeStorageIdMatches: sameBytes(envelope.storageItemId, prepared.storageItemId),
    importedBeforePromotion,
    importedPresent,
    opaqueTamperRejected,
    corruptionDetected,
    repairedPresent,
    orphanRemoved,
    removed: !(await store.has(repaired.storageItemId)),
  };
}

const canonicalScenarios = new Map<string, () => Promise<unknown>>([
  ["canonical-storage", canonicalStorageScenario],
  ["canonical-pull-job", canonicalPullJobScenario],
  ["canonical-hosted-pull", canonicalHostedPullScenario],
  ["canonical-hosted-artifact-hydration", canonicalHostedArtifactHydrationScenario],
  ["canonical-vault-initialization", canonicalVaultInitializationScenario],
  ["canonical-complete-import", canonicalCompleteImportScenario],
  ["canonical-vault-ceremony", canonicalVaultCeremonyScenario],
  ["canonical-member-recovery", canonicalMemberRecoveryScenario],
  ["canonical-capture-commit", canonicalCaptureCommitScenario],
  ["canonical-library-projection", canonicalLibraryProjectionScenario],
  ["canonical-client-runtime", canonicalClientRuntimeScenario],
  ["canonical-opfs-artifact", canonicalOpfsArtifactScenario],
]);

async function run(): Promise<void> {
  const scenario = new URL(location.href).searchParams.get("scenario");
  const scenarioFunction = scenario === null ? undefined : canonicalScenarios.get(scenario);
  const result =
    scenarioFunction === undefined ? { error: "unknown scenario" } : await scenarioFunction();
  const output = document.querySelector("#result");
  if (output !== null) {
    output.textContent = JSON.stringify(result);
    output.setAttribute("data-complete", "true");
  }
}

void run().catch((error: unknown) => {
  const output = document.querySelector("#result");
  if (output !== null) {
    output.textContent = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
    output.setAttribute("data-complete", "true");
  }
});

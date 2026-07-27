import {
  type AtomicRegistrationV1,
  IndexedDbAccountRepository,
  IndexedDbDetachmentRepository,
  IndexedDbDeviceRepository,
  IndexedDbDriver,
  IndexedDbImportRepository,
  IndexedDbSearchRepository,
  IndexedDbServerSwitchRepository,
  IndexedDbStorageReliefRepository,
  IndexedDbVaultReplacementRepository,
  IndexedDbVaultRepository,
  IndexedDbWorkspaceRepository,
  type ServerSwitchJobV1,
  type ServerSwitchReplicaPromotion,
  type StoredBundleDescriptorObjectV1,
  type StoredObjectV1,
  UiPreferencesRepository,
  vaultKey,
  vaultSingletonKey,
} from "../../../src/drivers/indexeddb";
import type {
  StorageReliefCheckpointV1,
  StorageReliefJobV1,
} from "../../../src/drivers/indexeddb/storage-relief-schema";
import { OpfsArtifactStore } from "../../../src/hosts/shared/artifact-store";
import { VaultImportHost } from "../../../src/hosts/shared/import";
import { prepareVaultEpochStorage } from "../../../src/runtime/import/credentials";
import {
  createDeviceCertificate,
  createDeviceIdentity,
  createDeviceKeyEnvelope,
} from "../../../src/runtime/recovery/device";
import { createRecoveryKit } from "../../../src/runtime/recovery/kit";
import { buildSearchDocument } from "../../../src/runtime/search/documents";
import { SearchKeywordIndexer } from "../../../src/runtime/search/indexer";
import { buildKeywordRow } from "../../../src/runtime/search/keyword";
import { CacheStorageLocalModelStore } from "../../../src/runtime/search/local-model/cache-store";
import { LocalModelDownloader } from "../../../src/runtime/search/local-model/download";
import {
  LOCAL_MINILM_MANIFEST,
  type LocalMiniLmManifest,
} from "../../../src/runtime/search/local-model/manifest";
import { localMiniLmProvider } from "../../../src/runtime/search/local-model/provider";
import {
  deriveSearchKeywordLookupKey,
  keywordPostingEntries,
} from "../../../src/runtime/search/postings";
import { parseSearchQuery } from "../../../src/runtime/search/query";
import { remoteSearchEndpointPathHash } from "../../../src/runtime/search/remote-endpoint";
import {
  buildSemanticMaterializations,
  normalizeEmbedding,
  providerIdentityHash,
} from "../../../src/runtime/search/semantic";
import { SearchCoordinator } from "../../../src/runtime/search/service";
import {
  createKeywordStatistics,
  projectionGeneration,
} from "../../../src/runtime/search/statistics";
import type { StorageReliefFaults } from "../../../src/runtime/storage-relief/contracts";
import { StorageReliefJobRunner } from "../../../src/runtime/storage-relief/runner";
import { InterruptedStaleDiscardReconciler } from "../../../src/runtime/synchronization/recovery-reconciliation";
import { serverSwitchStartupDecision } from "../../../src/runtime/synchronization/server-switch-startup";
import {
  encryptWorkspaceVaultName,
  prepareVaultNameChange,
  VaultService,
  WorkspaceService,
} from "../../../src/runtime/vault";
import type { VaultRecordsV1 } from "../../../src/runtime/vault/contracts";
import { unwrapDeviceSlot } from "../../../src/runtime/vault/slots";
import { TEST_KEY_EPOCH_ID, testKeyring } from "../../helpers/keyring";

function id(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}

async function localMiniLmInferenceScenario(): Promise<unknown> {
  const store = new CacheStorageLocalModelStore();
  const generationName = `awsm-search-model-proof-${crypto.randomUUID()}`;
  try {
    for (const file of LOCAL_MINILM_MANIFEST.files) {
      const response = await fetch(`/model/${file.path}`);
      if (!response.ok) throw new Error(`Missing local model proof file: ${file.path}`);
      await store.putFile(generationName, file.path, response);
    }
    await store.promote(LOCAL_MINILM_MANIFEST.manifestId, generationName);
    const provider = localMiniLmProvider(store, {
      factoryUrl: `${location.origin}/vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs`,
      wasmUrl: `${location.origin}/vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm`,
    });
    try {
      const vectors = await provider.embed({
        purpose: "Query",
        texts: ["private local archive", "garden weather"],
        signal: AbortSignal.timeout(60_000),
      });
      const first = vectors[0];
      const second = vectors[1];
      if (first === undefined || second === undefined)
        throw new Error("MiniLM returned no vector.");
      const norm = (vector: Float32Array) => Math.hypot(...vector);
      const cosine = first.reduce((sum, value, index) => sum + value * (second[index] ?? 0), 0);
      return {
        dimensions: first.length,
        finite: [...first, ...second].every(Number.isFinite),
        normalized: Math.abs(norm(first) - 1) < 0.0001 && Math.abs(norm(second) - 1) < 0.0001,
        distinct: cosine < 0.99,
      };
    } finally {
      await provider.dispose();
    }
  } finally {
    await store.deleteCurrent();
  }
}

function object(objectId: string, byte: number): StoredBundleDescriptorObjectV1 {
  return {
    version: 1,
    objectId,
    objectType: "BundleDescriptor",
    envelopeBytes: new Uint8Array([byte]),
  };
}

async function seedCandidateDeviceSession(
  databaseName: string,
  vaultId: string,
  accountId: string,
  username: string,
): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const transaction = database.transaction("device_sessions", "readwrite");
  transaction.objectStore("device_sessions").put(
    {
      version: 1,
      accountId,
      vaultId,
      deviceId: id("999"),
      sessionId: id("998"),
      username,
      scope: "VaultDevice",
      refreshNonce: new Uint8Array(12),
      refreshCiphertext: new Uint8Array(16),
    },
    `${vaultId}:server-switch-candidate`,
  );
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
  database.close();
}

async function accountPersistenceScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const repository = new IndexedDbAccountRepository(databaseName);
  const accountId = id("810");
  const sessionId = id("811");
  await repository.saveAuthenticated({
    metadata: {
      version: 1,
      accountId,
      sessionId,
      username: "reader_test",
      inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
      scope: "Account",
    },
    refreshToken: "refresh-token-secret",
  });

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const seed = database.transaction("objects", "readwrite");
  seed.objectStore("objects").put({ localVaultData: true }, [id("813"), id("814")]);
  await new Promise<void>((resolve, reject) => {
    seed.addEventListener("complete", () => resolve(), { once: true });
    seed.addEventListener("error", () => reject(seed.error), { once: true });
  });
  database.close();

  const afterRestart = await new IndexedDbAccountRepository(databaseName).loadAuthenticated();
  await repository.logout();
  const afterLogout = await repository.loadAuthenticated();
  const retainedMetadata = await repository.loadMetadata();
  const reauthenticatedRepository = new IndexedDbAccountRepository(databaseName);
  await reauthenticatedRepository.saveAuthenticated({
    metadata: {
      version: 1,
      accountId: id("811"),
      sessionId: id("815"),
      username: "reader_test",
      inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
      scope: "Account",
    },
    refreshToken: "replacement-refresh-token",
  });
  const afterReauthentication = await reauthenticatedRepository.loadAuthenticated();
  if (afterRestart === undefined || afterReauthentication === undefined)
    throw new Error("Account reauthentication proof is incomplete.");
  const proofNonce = crypto.getRandomValues(new Uint8Array(12));
  const proofPlaintext = new TextEncoder().encode("retained reauthentication key");
  const proofCiphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: proofNonce },
    afterRestart.sessionKey,
    proofPlaintext,
  );
  const proofRoundTrip = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: proofNonce },
    afterReauthentication.sessionKey,
    proofCiphertext,
  );
  const reopened = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const read = reopened.transaction("objects", "readonly");
  const localObjectCount = await new Promise<number>((resolve, reject) => {
    const request = read.objectStore("objects").count();
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  reopened.close();

  return {
    username: afterRestart?.metadata.username,
    refreshRestored: afterRestart?.refreshToken === "refresh-token-secret",
    sessionKeyExtractable: afterRestart?.sessionKey.extractable,
    signedOut: afterLogout === undefined,
    retainedUsername: retainedMetadata?.username,
    refreshReplaced: afterReauthentication?.refreshToken === "replacement-refresh-token",
    sessionKeyReused: new TextDecoder().decode(proofRoundTrip) === "retained reauthentication key",
    localObjectCount,
  };
}

async function accountScopeIsolationScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const repository = new IndexedDbAccountRepository(databaseName);
  const credentials = (
    seed: string,
    username: string,
    _byte: number,
  ): Parameters<IndexedDbAccountRepository["saveAuthenticated"]>[0] => ({
    metadata: {
      version: 1,
      accountId: id(`${seed}0`),
      sessionId: id(`${seed}1`),
      username,
      inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
      scope: "Account",
    },
    refreshToken: `refresh-${username}`,
  });
  await repository.saveAuthenticated(credentials("82", "active_test", 0x41), "active");
  await repository.saveAuthenticated(
    credentials("83", "candidate_test", 0x43),
    "server-switch-candidate",
  );
  await repository.saveAccountVault(
    {
      version: 1,
      accountId: id("830"),
      vaultId: id("834"),
      activeRecoveryGenerationId: id("832"),
      activeKeyEpochId: id("833"),
      remoteGenerationId: id("835"),
      remoteGenerationNumber: 4,
      deliveryCursor: 7,
    },
    "server-switch-candidate",
  );
  const [active, candidate, activePresentBeforeLogout, candidatePresentBeforeLogout] =
    await Promise.all([
      repository.loadAuthenticated("active"),
      repository.loadAuthenticated("server-switch-candidate"),
      repository.hasAuthenticatedSecrets("active"),
      repository.hasAuthenticatedSecrets("server-switch-candidate"),
    ]);
  await repository.logout();
  const reopened = new IndexedDbAccountRepository(databaseName);
  const [activePresentAfterLogout, candidatePresentAfterLogout, restoredCandidate, candidateVault] =
    await Promise.all([
      reopened.hasAuthenticatedSecrets("active"),
      reopened.hasAuthenticatedSecrets("server-switch-candidate"),
      reopened.loadAuthenticated("server-switch-candidate"),
      reopened.loadAccountVault("server-switch-candidate"),
    ]);
  await reopened.eraseAuthenticated("server-switch-candidate");
  return {
    activeUsername: active?.metadata.username,
    candidateUsername: candidate?.metadata.username,
    activePresentBeforeLogout,
    candidatePresentBeforeLogout,
    activePresentAfterLogout,
    candidatePresentAfterLogout,
    candidateRefreshRestored: restoredCandidate?.refreshToken === "refresh-candidate_test",
    candidateVaultId: candidateVault?.vaultId,
    candidatePresentAfterErase: await reopened.hasAuthenticatedSecrets("server-switch-candidate"),
  };
}

async function serverSwitchPromotionScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const accounts = new IndexedDbAccountRepository(databaseName);
  const switches = new IndexedDbServerSwitchRepository(databaseName);
  const credentials = (account: string, username: string, _byte: number) => ({
    metadata: {
      version: 1 as const,
      accountId: id(`${account}0`),
      sessionId: id(`${account}1`),
      username,
      inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
      scope: "Account" as const,
    },
    refreshToken: `refresh-${username}`,
  });
  await accounts.saveConfiguration({
    version: 1,
    mode: "Configured",
    serverOrigin: "https://source.example",
    registration: { enabled: false },
  });
  await accounts.saveAuthenticated(credentials("84", "source_test", 0x44), "active");
  const candidate = credentials("85", "candidate_test", 0x45);
  await accounts.saveAuthenticated(candidate, "server-switch-candidate");
  const vaultId = id("854");
  const generationId = id("855");
  await accounts.saveAccountVault(
    {
      version: 1,
      accountId: candidate.metadata.accountId,
      vaultId,
      activeRecoveryGenerationId: id("852"),
      activeKeyEpochId: id("853"),
      remoteGenerationId: generationId,
      remoteGenerationNumber: 9,
      deliveryCursor: 21,
    },
    "server-switch-candidate",
  );
  await seedCandidateDeviceSession(
    databaseName,
    vaultId,
    candidate.metadata.accountId,
    candidate.metadata.username,
  );
  const job = {
    version: 1 as const,
    jobId: id("856"),
    sourceOrigin: "https://source.example",
    candidateOrigin: "https://candidate.example",
    candidateRegistration: { enabled: false } as const,
    vaultId,
    state: "Running" as const,
    stage: "PromoteContext" as const,
    direction: "PublishLocal" as const,
    expectedLocalHead: {
      version: 1 as const,
      vaultId,
      generationId,
      generationNumber: 9,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    completedItems: 0,
    totalItems: 0,
    processedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
    candidateAuthorityChanged: true,
    attachIdempotencyKey: id("857"),
    candidateIdempotencyKey: id("858"),
  };
  await switches.saveJob(job);
  await accounts.promoteServerSwitch({
    job,
    candidateOrigin: "https://candidate.example",
    now: "2026-07-20T00:01:00.000Z",
  });
  const reopened = new IndexedDbAccountRepository(databaseName);
  const [configuration, active, prior, candidateAfter, registration, synchronizationJob, nextJob] =
    await Promise.all([
      reopened.loadConfiguration(),
      reopened.loadAuthenticated("active"),
      reopened.loadAuthenticated("server-switch-prior"),
      reopened.loadAuthenticated("server-switch-candidate"),
      reopened.loadAccountVault("active"),
      reopened.latestSynchronizationJob(),
      new IndexedDbServerSwitchRepository(databaseName).loadJob(),
    ]);
  return {
    serverOrigin: configuration.mode === "Configured" ? configuration.serverOrigin : undefined,
    activeUsername: active?.metadata.username,
    activeRefresh: active?.refreshToken,
    priorUsername: prior?.metadata.username,
    priorRefresh: prior?.refreshToken,
    candidateRemoved: candidateAfter === undefined,
    registrationAccountId: registration?.accountId,
    synchronizationStage: synchronizationJob?.stage,
    synchronizationCursor: synchronizationJob?.snapshotCursor,
    switchStage: nextJob?.stage,
  };
}

async function serverSwitchReplicaPromotionAttempt(failAt?: number): Promise<{
  readonly writes: number;
  readonly atomic: boolean;
}> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const accounts = new IndexedDbAccountRepository(databaseName);
  const switches = new IndexedDbServerSwitchRepository(databaseName);
  const vaultId = id("860");
  const oldGenerationId = id("861");
  const newGenerationId = id("862");
  const oldEventId = id("863");
  const newEventId = id("864");
  const oldObjectId = id("865");
  const newObjectId = id("866");
  const credentials = (seed: string, username: string, _byte: number) => ({
    metadata: {
      version: 1 as const,
      accountId: id(`${seed}0`),
      sessionId: id(`${seed}1`),
      username,
      inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
      scope: "Account" as const,
    },
    refreshToken: `refresh-${username}`,
  });
  const source = credentials("87", "source_test", 0x47);
  const candidate = credentials("88", "candidate_test", 0x48);
  await accounts.saveConfiguration({
    version: 1,
    mode: "Configured",
    serverOrigin: "https://source.example",
    registration: { enabled: false },
  });
  await accounts.saveAuthenticated(source, "active");
  await accounts.saveAuthenticated(candidate, "server-switch-candidate");
  await accounts.saveAccountVault(
    {
      version: 1,
      accountId: candidate.metadata.accountId,
      vaultId,
      activeRecoveryGenerationId: id("882"),
      activeKeyEpochId: id("883"),
      remoteGenerationId: newGenerationId,
      remoteGenerationNumber: 1,
      deliveryCursor: 31,
    },
    "server-switch-candidate",
  );
  await seedCandidateDeviceSession(
    databaseName,
    vaultId,
    candidate.metadata.accountId,
    candidate.metadata.username,
  );
  const oldHead = {
    version: 1 as const,
    vaultId,
    generationId: oldGenerationId,
    generationNumber: 0,
    appendedObjectIds: [oldObjectId],
    appendedEventIds: [oldEventId],
  };
  const job: ServerSwitchJobV1 = {
    version: 1,
    jobId: id("869"),
    sourceOrigin: "https://source.example",
    candidateOrigin: "https://candidate.example",
    candidateRegistration: { enabled: false },
    vaultId,
    state: "Running",
    stage: "PromoteContext",
    direction: "FastForwardLocal",
    expectedLocalHead: oldHead,
    candidateGenerationId: newGenerationId,
    candidateGenerationNumber: 1,
    candidatePredecessorGenerationId: oldGenerationId,
    candidateHeadCursor: 31,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    completedItems: 0,
    totalItems: 0,
    processedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
    candidateAuthorityChanged: false,
    attachIdempotencyKey: id("870"),
    candidateIdempotencyKey: id("871"),
  };
  await switches.saveJob(job);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const seed = database.transaction(
    [
      "vault_generations",
      "vault_head",
      "events",
      "objects",
      "library_projection",
      "collection_projection",
      "vault_name_projection",
      "vault_name_cache",
      "artifact_availability",
      "storage_relief_jobs",
      "storage_relief_checkpoints",
    ],
    "readwrite",
  );
  seed.objectStore("vault_generations").put(
    {
      version: 1,
      generationId: oldGenerationId,
      generationNumber: 0,
      envelopeBytes: new Uint8Array([1]),
    },
    vaultKey(vaultId, oldGenerationId),
  );
  seed.objectStore("vault_head").put(oldHead, vaultSingletonKey(vaultId, "active"));
  seed.objectStore("events").put(
    {
      version: 1,
      vaultId,
      eventId: oldEventId,
      referencedObjectIds: [oldObjectId],
      orderingTimestamp: "2026-07-20T00:00:00.000Z",
      envelopeBytes: new Uint8Array([2]),
    },
    vaultKey(vaultId, oldEventId),
  );
  seed.objectStore("objects").put(object(oldObjectId, 3), vaultKey(vaultId, oldObjectId));
  seed
    .objectStore("library_projection")
    .put(
      { version: 1, bundleId: id("867"), envelopeBytes: new Uint8Array([4]) },
      vaultKey(vaultId, id("867")),
    );
  seed
    .objectStore("collection_projection")
    .put(
      { version: 1, projectionId: vaultId, envelopeBytes: new Uint8Array([5]) },
      vaultSingletonKey(vaultId, "active"),
    );
  seed.objectStore("vault_name_projection").put(
    {
      version: 1,
      vaultId,
      sourceEventId: oldEventId,
      envelopeBytes: new Uint8Array([6]),
    },
    vaultSingletonKey(vaultId, "active"),
  );
  seed.objectStore("vault_name_cache").put(
    {
      version: 1,
      vaultId,
      sourceEventId: oldEventId,
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array([7]),
    },
    vaultId,
  );
  const reliefJobId = id("872");
  seed.objectStore("artifact_availability").put(
    {
      version: 1,
      vaultId,
      artifactObjectId: oldObjectId,
      markedAt: "2026-07-20T00:00:00.000Z",
    },
    vaultKey(vaultId, oldObjectId),
  );
  seed.objectStore("storage_relief_jobs").put(
    {
      version: 1,
      vaultId,
      jobId: reliefJobId,
      state: "Succeeded",
      stage: "Checkpoint",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      expectedServerOrigin: "https://source.example.test",
      expectedAccountId: source.metadata.accountId,
      expectedLocalHead: oldHead,
      expectedGenerationId: oldGenerationId,
      expectedGenerationNumber: 0,
      candidateArtifacts: 1,
      candidateBytes: 3,
      verifiedArtifacts: 1,
      verifiedBytes: 3,
      evictedArtifacts: 1,
      freedBytes: 3,
      skippedArtifacts: 0,
      skippedBytes: 0,
      cancellationRequested: false,
    },
    vaultKey(vaultId, reliefJobId),
  );
  seed.objectStore("storage_relief_checkpoints").put(
    {
      version: 1,
      vaultId,
      jobId: reliefJobId,
      artifactObjectId: oldObjectId,
      keyEpochId: "00000000-0000-4000-8000-000000000009",
      envelopeByteLength: 3,
      envelopeChecksum: new Uint8Array(32),
      state: "Evicted",
      remoteGenerationId: oldGenerationId,
      remoteGenerationNumber: 0,
    },
    [vaultId, reliefJobId, oldObjectId],
  );
  await new Promise<void>((resolve, reject) => {
    seed.addEventListener("complete", () => resolve(), { once: true });
    seed.addEventListener("error", () => reject(seed.error), { once: true });
  });
  database.close();
  const replica: ServerSwitchReplicaPromotion = {
    generation: {
      version: 1,
      generationId: newGenerationId,
      generationNumber: 1,
      predecessorGenerationId: oldGenerationId,
      envelopeBytes: new Uint8Array([11]),
    },
    head: {
      version: 1,
      vaultId,
      generationId: newGenerationId,
      generationNumber: 1,
      appendedObjectIds: [newObjectId],
      appendedEventIds: [newEventId],
    },
    events: [
      {
        version: 1,
        vaultId,
        eventId: newEventId,
        referencedObjectIds: [newObjectId],
        orderingTimestamp: "2026-07-20T00:01:00.000Z",
        envelopeBytes: new Uint8Array([12]),
      },
    ],
    objects: [object(newObjectId, 13)],
    libraryProjections: [{ version: 1, bundleId: id("868"), envelopeBytes: new Uint8Array([14]) }],
    collectionProjection: {
      version: 1,
      projectionId: vaultId,
      envelopeBytes: new Uint8Array([15]),
    },
    vaultNameProjection: {
      version: 1,
      vaultId,
      sourceEventId: newEventId,
      envelopeBytes: new Uint8Array([16]),
    },
    nameCache: {
      version: 1,
      vaultId,
      sourceEventId: newEventId,
      nonce: new Uint8Array(12).fill(1),
      ciphertext: new Uint8Array([17]),
    },
    clearArtifactAvailability: true,
  };
  const originalPut = IDBObjectStore.prototype.put;
  const originalDelete = IDBObjectStore.prototype.delete;
  const originalClear = IDBObjectStore.prototype.clear;
  let writes = 0;
  const beforeWrite = (): void => {
    writes += 1;
    if (writes === failAt) throw new DOMException("Injected promotion failure", "AbortError");
  };
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    beforeWrite();
    return originalPut.call(this, value, key);
  };
  IDBObjectStore.prototype.delete = function (query: IDBValidKey | IDBKeyRange) {
    beforeWrite();
    return originalDelete.call(this, query);
  };
  IDBObjectStore.prototype.clear = function () {
    beforeWrite();
    return originalClear.call(this);
  };
  let rejected = false;
  try {
    await accounts.promoteServerSwitchWithReplica({
      job,
      candidateOrigin: "https://candidate.example",
      now: "2026-07-20T00:02:00.000Z",
      replica,
    });
  } catch {
    rejected = true;
  } finally {
    IDBObjectStore.prototype.put = originalPut;
    IDBObjectStore.prototype.delete = originalDelete;
    IDBObjectStore.prototype.clear = originalClear;
  }
  const driver = new IndexedDbDriver(databaseName, vaultId);
  const reopened = new IndexedDbAccountRepository(databaseName);
  const [
    configuration,
    active,
    candidateAfter,
    head,
    events,
    objects,
    projections,
    collection,
    name,
    storedJob,
  ] = await Promise.all([
    reopened.loadConfiguration(),
    reopened.loadAuthenticated("active"),
    reopened.loadAuthenticated("server-switch-candidate"),
    driver.getVaultHead(),
    driver.listStoredEvents(),
    driver.listStoredObjects(),
    driver.listEncryptedProjections(),
    driver.getCollectionProjection(),
    driver.getVaultNameProjection(),
    new IndexedDbServerSwitchRepository(databaseName).loadJob(),
  ]);
  const failed = failAt !== undefined;
  const availabilityRepository = new IndexedDbStorageReliefRepository(databaseName);
  const availability = await availabilityRepository.listRemoteOnlyArtifacts(vaultId);
  const reliefJob = await availabilityRepository.latestStorageReliefJob(vaultId);
  await availabilityRepository.close();
  const availabilityAtomic = failed
    ? availability.length === 1 && reliefJob?.jobId === reliefJobId
    : availability.length === 0 && reliefJob === undefined;
  const atomic = failed
    ? rejected &&
      configuration.mode === "Configured" &&
      configuration.serverOrigin === "https://source.example" &&
      active?.metadata.username === "source_test" &&
      candidateAfter?.metadata.username === "candidate_test" &&
      head?.generationId === oldGenerationId &&
      events[0]?.eventId === oldEventId &&
      objects[0]?.objectId === oldObjectId &&
      projections[0]?.bundleId === id("867") &&
      collection?.envelopeBytes[0] === 5 &&
      name?.sourceEventId === oldEventId &&
      storedJob?.stage === "PromoteContext" &&
      availabilityAtomic
    : !rejected &&
      configuration.mode === "Configured" &&
      configuration.serverOrigin === "https://candidate.example" &&
      active?.metadata.username === "candidate_test" &&
      candidateAfter === undefined &&
      head?.generationId === newGenerationId &&
      events[0]?.eventId === newEventId &&
      objects[0]?.objectId === newObjectId &&
      projections[0]?.bundleId === id("868") &&
      collection?.envelopeBytes[0] === 15 &&
      name?.sourceEventId === newEventId &&
      storedJob?.stage === "RevokePriorSession" &&
      availabilityAtomic;
  await driver.close();
  await reopened.close();
  await accounts.close();
  return { writes, atomic };
}

async function serverSwitchReplicaPromotionAtomicityScenario(): Promise<unknown> {
  const baseline = await serverSwitchReplicaPromotionAttempt();
  const results: boolean[] = [];
  for (let failAt = 1; failAt <= baseline.writes; failAt += 1)
    results.push((await serverSwitchReplicaPromotionAttempt(failAt)).atomic);
  return {
    successAtomic: baseline.atomic,
    failurePoints: results.length,
    allAtomic: results.every(Boolean),
  };
}

async function serverSwitchPersistenceScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const jobId = id("840");
  const entityId = id("841");
  const baseJob: ServerSwitchJobV1 = {
    version: 1,
    jobId,
    sourceOrigin: "https://source.example.test",
    candidateOrigin: "https://candidate.example.test",
    candidateRegistration: { enabled: false },
    vaultId: id("842"),
    state: "Running",
    stage: "PrepareRemote",
    direction: "FastForwardCandidate",
    expectedLocalHead: {
      version: 1,
      vaultId: id("842"),
      generationId: id("843"),
      generationNumber: 2,
      appendedObjectIds: [id("844")],
      appendedEventIds: [id("845")],
    },
    candidateGenerationId: id("846"),
    candidateGenerationNumber: 1,
    candidateHeadCursor: 7,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:01.000Z",
    completedItems: 1,
    totalItems: 4,
    processedBytes: 10,
    totalBytes: 40,
    retryCount: 0,
    candidateAuthorityChanged: false,
    attachIdempotencyKey: id("847"),
    candidateIdempotencyKey: id("848"),
  };
  const restartStages: readonly {
    stage: ServerSwitchJobV1["stage"];
    state: ServerSwitchJobV1["state"];
  }[] = [
    { stage: "AuthenticateCandidate", state: "AuthenticationRequired" },
    { stage: "Compare", state: "Running" },
    { stage: "PrepareRemote", state: "Running" },
    { stage: "ActivateRemote", state: "Running" },
    { stage: "PrepareLocal", state: "Running" },
    { stage: "ActivateLocal", state: "WaitingForUnlock" },
    { stage: "PromoteContext", state: "Running" },
    { stage: "RevokePriorSession", state: "Running" },
    { stage: "Terminal", state: "Succeeded" },
  ];
  const reopenedStages: string[] = [];
  const startupDecisions: string[] = [];
  let repeatedStagesStable = true;
  for (const restart of restartStages) {
    const writer = new IndexedDbServerSwitchRepository(databaseName);
    await writer.saveJob({ ...baseJob, ...restart });
    await writer.close();
    for (let restartCount = 0; restartCount < 2; restartCount += 1) {
      const reader = new IndexedDbServerSwitchRepository(databaseName);
      const loaded = await reader.loadJob();
      const observed = `${loaded?.state}:${loaded?.stage}`;
      if (restartCount === 0) {
        reopenedStages.push(observed);
        if (loaded !== undefined) startupDecisions.push(serverSwitchStartupDecision(loaded, true));
      } else repeatedStagesStable &&= observed === `${restart.state}:${restart.stage}`;
      await reader.close();
    }
  }
  const repository = new IndexedDbServerSwitchRepository(databaseName);
  await repository.saveJob(baseJob);
  await repository.saveCheckpoint({
    version: 1,
    jobId,
    kind: "Generation",
    entityId,
    state: "Durable",
    createIdempotencyKey: id("849"),
    completeIdempotencyKey: id("850"),
    uploadId: id("851"),
    receivedParts: [0, 1],
  });
  const reopened = new IndexedDbServerSwitchRepository(databaseName);
  const [job, checkpoint] = await Promise.all([
    reopened.loadJob(),
    reopened.loadCheckpoint(jobId, "Generation", entityId),
  ]);
  const staleDeleteRejected = !(await reopened.deleteJob(id("899")));
  const matchingDeleteSucceeded = await reopened.deleteJob(jobId);
  const [removedJob, removedCheckpoint] = await Promise.all([
    reopened.loadJob(),
    reopened.loadCheckpoint(jobId, "Generation", entityId),
  ]);

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const corrupt = database.transaction("server_switch_jobs", "readwrite");
  corrupt.objectStore("server_switch_jobs").put({ version: 2 }, "active");
  await new Promise<void>((resolve, reject) => {
    corrupt.addEventListener("complete", () => resolve(), { once: true });
    corrupt.addEventListener("error", () => reject(corrupt.error), {
      once: true,
    });
  });
  database.close();
  let corruptJobRejected = false;
  try {
    await reopened.loadJob();
  } catch {
    corruptJobRejected = true;
  }
  return {
    direction: job?.direction,
    checkpointState: checkpoint?.state,
    staleDeleteRejected,
    matchingDeleteSucceeded,
    jobRemoved: removedJob === undefined,
    checkpointRemoved: removedCheckpoint === undefined,
    corruptJobRejected,
    reopenedStages,
    repeatedStagesStable,
    startupDecisions,
  };
}

function registration(
  seed: number,
): AtomicRegistrationV1 & { readonly object: StoredBundleDescriptorObjectV1 } {
  const descriptor = object(id(String(seed)), seed);
  const artifact: StoredObjectV1 = {
    version: 1,
    objectId: id(String(seed + 200)),
    objectType: "Artifact",
    keyEpochId: "00000000-0000-4000-8000-000000000009",
    envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
    envelopeByteLength: seed + 10,
    envelopeChecksumAlgorithm: "hash:sha256:v1",
    envelopeChecksum: new Uint8Array(32).fill(seed),
  };
  return {
    object: descriptor,
    objects: [descriptor, artifact],
    graph: {
      bundleId: id(String(seed + 300)),
      descriptorObjectId: descriptor.objectId,
      artifactObjectIds: [artifact.objectId],
    },
    event: {
      version: 1,
      vaultId: "00000000-0000-4000-8000-000000000000",
      eventId: id(String(seed + 100)),
      referencedObjectIds: [descriptor.objectId, artifact.objectId].toSorted(),
      orderingTimestamp: "2026-07-16T17:00:00.000Z",
      envelopeBytes: new Uint8Array([seed + 1]),
    },
    projection: {
      version: 1,
      bundleId: id(String(seed + 300)),
      envelopeBytes: new Uint8Array([seed + 2]),
    },
    outcome: {
      version: 1,
      commandId: id(String(seed + 400)),
      status: "Succeeded",
      bundleId: id(String(seed + 300)),
      descriptorObjectId: id(String(seed)),
      eventId: id(String(seed + 100)),
    },
  };
}

async function seedHead(driver: IndexedDbDriver): Promise<void> {
  await driver.getVaultHead();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(driver.databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const transaction = database.transaction("vault_head", "readwrite");
  transaction.objectStore("vault_head").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      generationId: id("990"),
      generationNumber: 0,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    vaultSingletonKey(driver.vaultId, "active"),
  );
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    });
  });
  database.close();
}

async function vaultScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const repository = new IndexedDbVaultRepository(databaseName);
  const deviceKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
  const records: VaultRecordsV1 = {
    metadata: {
      version: 1,
      vaultId: id("1"),
      activeKeyEpochId: id("9"),
      deviceId: id("2"),
      createdAt: "2026-07-16T17:00:00.000Z",
      manuallyLocked: false,
      verifier: {
        version: 1,
        nonce: new Uint8Array(24),
        ciphertext: new Uint8Array(38),
      },
    },
    deviceSlot: {
      version: 1,
      slotId: id("3"),
      vaultId: id("1"),
      keyEpochId: id("9"),
      deviceId: id("2"),
      algorithm: "wrap:aes-kw-256:device:v1",
      wrappedRootKey: new Uint8Array(40),
    },
    deviceKey,
    generation: {
      version: 1,
      generationId: id("4"),
      generationNumber: 0,
      envelopeBytes: new Uint8Array([1]),
    },
    head: {
      version: 1,
      vaultId: id("1"),
      generationId: id("4"),
      generationNumber: 0,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
  };
  await seedVaultRecords(databaseName, records);
  await repository.setManualLock(records.metadata.vaultId, true);
  const loaded = await repository.load(records.metadata.vaultId);
  await repository.deleteDatabase();
  return {
    deviceKeyExtractable: loaded?.deviceKey.extractable,
    wrappedRootKeyBytes: loaded?.deviceSlot.wrappedRootKey.byteLength,
    manuallyLocked: loaded?.metadata.manuallyLocked,
  };
}

async function makeVaultRecords(seed: number): Promise<VaultRecordsV1> {
  const deviceKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
  const vaultId = id(String(seed));
  const deviceId = id(String(seed + 1));
  const generationId = id(String(seed + 3));
  return {
    metadata: {
      version: 1,
      vaultId,
      activeKeyEpochId: id(String(seed + 8)),
      deviceId,
      createdAt: "2026-07-16T17:00:00.000Z",
      manuallyLocked: false,
      verifier: {
        version: 1,
        nonce: new Uint8Array(24),
        ciphertext: new Uint8Array(38),
      },
    },
    deviceSlot: {
      version: 1,
      slotId: id(String(seed + 2)),
      vaultId,
      keyEpochId: id(String(seed + 8)),
      deviceId,
      algorithm: "wrap:aes-kw-256:device:v1",
      wrappedRootKey: new Uint8Array(40),
    },
    deviceKey,
    generation: {
      version: 1,
      generationId,
      generationNumber: 0,
      envelopeBytes: new Uint8Array([seed]),
    },
    head: {
      version: 1,
      vaultId,
      generationId,
      generationNumber: 0,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
  };
}

async function seedVaultRecords(databaseName: string, records: VaultRecordsV1): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const transaction = database.transaction(
    ["vault_metadata", "key_slots", "device_keys", "vault_generations", "vault_head"],
    "readwrite",
  );
  const vaultId = records.metadata.vaultId;
  transaction
    .objectStore("vault_metadata")
    .add(records.metadata, vaultSingletonKey(vaultId, "metadata"));
  transaction
    .objectStore("key_slots")
    .add(records.deviceSlot, vaultSingletonKey(vaultId, "device"));
  transaction
    .objectStore("device_keys")
    .add(records.deviceKey, vaultSingletonKey(vaultId, "device"));
  transaction
    .objectStore("vault_generations")
    .add(records.generation, vaultKey(vaultId, records.generation.generationId));
  transaction.objectStore("vault_head").add(records.head, vaultSingletonKey(vaultId, "active"));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    });
  });
  database.close();
}

async function vaultRecordIsolationScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const repository = new IndexedDbVaultRepository(databaseName);
  const first = await makeVaultRecords(1);
  const second = await makeVaultRecords(101);
  await seedVaultRecords(databaseName, first);
  await seedVaultRecords(databaseName, second);
  await repository.setManualLock(first.metadata.vaultId, true);
  const firstLoaded = await repository.load(first.metadata.vaultId);
  const secondLoaded = await repository.load(second.metadata.vaultId);
  await repository.deleteDatabase();
  return {
    firstVaultId: firstLoaded?.metadata.vaultId,
    secondVaultId: secondLoaded?.metadata.vaultId,
    firstLocked: firstLoaded?.metadata.manuallyLocked,
    secondLocked: secondLoaded?.metadata.manuallyLocked,
  };
}

async function workspaceScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const repository = new IndexedDbWorkspaceRepository(databaseName);
  const first = await repository.bootstrap("2026-07-18T12:00:00.000Z");
  const second = await repository.bootstrap("2026-07-18T13:00:00.000Z");
  const loaded = await repository.load();
  await repository.deleteDatabase();
  return {
    version: loaded?.metadata.version,
    sameWorkspace: first.metadata.workspaceId === second.metadata.workspaceId,
    activeVaultId: loaded?.metadata.activeVaultId ?? null,
    nameKeyExtractable: loaded?.nameCacheKey.extractable,
  };
}

async function atomicVaultCreateScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  const workspace = await workspaceRepository.bootstrap("2026-07-18T15:00:00.000Z");
  const vaultRepository = new IndexedDbVaultRepository(databaseName);
  const vaultService = new VaultService(vaultRepository);
  const prepared = await vaultService.prepareCreate({
    name: "Amber Archive",
    createdAt: "2026-07-18T15:01:00.000Z",
  });
  const records = prepared.records;
  const vaultId = records.metadata.vaultId;
  const eventId = id("952");
  const nameChange = await prepareVaultNameChange({
    keyring: prepared.keyring,
    eventType: "VaultCreated",
    vaultId,
    deviceId: records.metadata.deviceId,
    eventId,
    timestamp: records.metadata.createdAt,
    name: prepared.name,
  });
  const cache = await encryptWorkspaceVaultName({
    key: workspace.nameCacheKey,
    workspaceId: workspace.metadata.workspaceId,
    vaultId,
    sourceEventId: eventId,
    name: prepared.name,
  });
  await workspaceRepository.commitVaultCreate({
    records,
    event: nameChange.event,
    projection: nameChange.projection,
    cache,
  });
  const state = await new WorkspaceService(workspaceRepository).state({
    unlockedVaultId: vaultId,
  });
  const driver = new IndexedDbDriver(databaseName, vaultId);
  const directory = await workspaceRepository.listVaultDirectory();
  const result = {
    activeMatchesCreated: state.activeVaultId === vaultId,
    name: state.vaults[0]?.name,
    eventCount: (await driver.listStoredEvents()).length,
    headEventCount: (await driver.getVaultHead())?.appendedEventIds.length,
    directoryHasPlaintextName: Object.keys(directory[0] ?? {}).includes("name"),
  };
  await workspaceRepository.close();
  await vaultRepository.close();
  await driver.deleteDatabase();
  return result;
}

async function atomicVaultCreateFailureScenario(): Promise<unknown> {
  const results: boolean[] = [];
  for (let failAt = 1; failAt <= 11; failAt += 1) {
    const databaseName = `awsm-integration-${crypto.randomUUID()}`;
    const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
    const workspace = await workspaceRepository.bootstrap("2026-07-18T16:00:00.000Z");
    const firstVaultId = await prepareAndCommitVault(
      databaseName,
      workspaceRepository,
      "Amber Archive",
      "2026-07-18T16:01:00.000Z",
    );
    const vaultRepository = new IndexedDbVaultRepository(databaseName);
    const prepared = await new VaultService(vaultRepository).prepareCreate({
      name: "Quiet Folio",
      createdAt: "2026-07-18T16:02:00.000Z",
    });
    const secondVaultId = prepared.records.metadata.vaultId;
    const eventId = crypto.randomUUID();
    const nameChange = await prepareVaultNameChange({
      keyring: prepared.keyring,
      eventType: "VaultCreated",
      vaultId: secondVaultId,
      deviceId: prepared.records.metadata.deviceId,
      eventId,
      timestamp: "2026-07-18T16:02:00.000Z",
      name: "Quiet Folio",
    });
    const cache = await encryptWorkspaceVaultName({
      key: workspace.nameCacheKey,
      workspaceId: workspace.metadata.workspaceId,
      vaultId: secondVaultId,
      sourceEventId: eventId,
      name: "Quiet Folio",
    });
    const originalAdd = IDBObjectStore.prototype.add;
    const originalPut = IDBObjectStore.prototype.put;
    let write = 0;
    const inject = <T extends typeof originalAdd | typeof originalPut>(original: T) =>
      function (this: IDBObjectStore, ...args: Parameters<T>): IDBRequest<IDBValidKey> {
        write += 1;
        if (write === failAt) throw new DOMException("Injected write failure", "AbortError");
        return original.apply(this, args) as IDBRequest<IDBValidKey>;
      };
    IDBObjectStore.prototype.add = inject(originalAdd);
    IDBObjectStore.prototype.put = inject(originalPut);
    try {
      await workspaceRepository.commitVaultCreate({
        expectedActiveVaultId: firstVaultId,
        records: prepared.records,
        event: nameChange.event,
        projection: nameChange.projection,
        cache,
      });
    } catch {
      // The injected write is expected to abort the complete transaction.
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
      IDBObjectStore.prototype.put = originalPut;
    }
    const [after, directory, first, second] = await Promise.all([
      workspaceRepository.load(),
      workspaceRepository.listVaultDirectory(),
      vaultRepository.load(firstVaultId),
      vaultRepository.load(secondVaultId),
    ]);
    results.push(
      write === failAt &&
        after?.metadata.activeVaultId === firstVaultId &&
        directory.length === 1 &&
        directory[0]?.vaultId === firstVaultId &&
        first?.metadata.manuallyLocked === false &&
        second === undefined,
    );
    await vaultRepository.close();
    await workspaceRepository.deleteDatabase();
  }
  return { failurePoints: results.length, allAtomic: results.every(Boolean) };
}

async function prepareAndCommitVault(
  databaseName: string,
  workspaceRepository: IndexedDbWorkspaceRepository,
  name: string,
  createdAt: string,
  expectedActiveVaultId?: string,
): Promise<string> {
  const workspace = await workspaceRepository.load();
  if (workspace === undefined) throw new Error("Workspace is not initialized.");
  const vaultRepository = new IndexedDbVaultRepository(databaseName);
  const service = new VaultService(vaultRepository);
  const prepared = await service.prepareCreate({ name, createdAt });
  const vaultId = prepared.records.metadata.vaultId;
  const eventId = crypto.randomUUID();
  const nameChange = await prepareVaultNameChange({
    keyring: prepared.keyring,
    eventType: "VaultCreated",
    vaultId,
    deviceId: prepared.records.metadata.deviceId,
    eventId,
    timestamp: createdAt,
    name,
  });
  const cache = await encryptWorkspaceVaultName({
    key: workspace.nameCacheKey,
    workspaceId: workspace.metadata.workspaceId,
    vaultId,
    sourceEventId: eventId,
    name,
  });
  await workspaceRepository.commitVaultCreate({
    ...(expectedActiveVaultId === undefined ? {} : { expectedActiveVaultId }),
    records: prepared.records,
    event: nameChange.event,
    projection: nameChange.projection,
    cache,
  });
  await vaultRepository.close();
  return vaultId;
}

async function atomicVaultSelectScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  await workspaceRepository.bootstrap("2026-07-18T16:00:00.000Z");
  const firstVaultId = await prepareAndCommitVault(
    databaseName,
    workspaceRepository,
    "Amber Archive",
    "2026-07-18T16:01:00.000Z",
  );
  const secondVaultId = await prepareAndCommitVault(
    databaseName,
    workspaceRepository,
    "Quiet Folio",
    "2026-07-18T16:02:00.000Z",
    firstVaultId,
  );
  await workspaceRepository.commitVaultSelect({
    expectedActiveVaultId: secondVaultId,
    vaultId: secondVaultId,
  });
  const vaultRepository = new IndexedDbVaultRepository(databaseName);
  const sameTarget = await vaultRepository.load(secondVaultId);
  let missingErrorId = "";
  try {
    await workspaceRepository.commitVaultSelect({
      expectedActiveVaultId: secondVaultId,
      vaultId: id("999"),
    });
  } catch (error) {
    missingErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  const busyDriver = new IndexedDbDriver(databaseName, secondVaultId);
  const busyJob = {
    version: 1 as const,
    vaultId: secondVaultId,
    jobId: id("980"),
    commandId: id("981"),
    tabId: 7,
    state: "Running" as const,
    stage: "Snapshot" as const,
    createdAt: "2026-07-18T16:02:00.000Z",
    updatedAt: "2026-07-18T16:02:01.000Z",
  };
  await busyDriver.saveCaptureJob(busyJob);
  let busyErrorId = "";
  try {
    await workspaceRepository.commitVaultSelect({
      expectedActiveVaultId: secondVaultId,
      vaultId: firstVaultId,
    });
  } catch (error) {
    busyErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  await busyDriver.saveCaptureJob({
    ...busyJob,
    state: "Succeeded",
    stage: "Commit",
  });
  await busyDriver.close();
  await workspaceRepository.commitVaultSelect({
    expectedActiveVaultId: secondVaultId,
    vaultId: firstVaultId,
  });
  const selected = await workspaceRepository.load();
  const first = await vaultRepository.load(firstVaultId);
  const second = await vaultRepository.load(secondVaultId);
  let staleErrorId = "";
  try {
    await workspaceRepository.commitVaultSelect({
      expectedActiveVaultId: secondVaultId,
      vaultId: secondVaultId,
    });
  } catch (error) {
    staleErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  const afterStale = await workspaceRepository.load();
  const result = {
    activeIsFirst: selected?.metadata.activeVaultId === firstVaultId,
    firstLocked: first?.metadata.manuallyLocked,
    secondLocked: second?.metadata.manuallyLocked,
    staleErrorId,
    unchangedAfterStaleRequest: afterStale?.metadata.activeVaultId === firstVaultId,
    sameTargetStayedUnlocked: sameTarget?.metadata.manuallyLocked === false,
    missingErrorId,
    busyErrorId,
  };
  await vaultRepository.close();
  await workspaceRepository.deleteDatabase();
  return result;
}

async function atomicVaultSelectFailureScenario(): Promise<unknown> {
  const results: boolean[] = [];
  for (let failAt = 1; failAt <= 3; failAt += 1) {
    const databaseName = `awsm-integration-${crypto.randomUUID()}`;
    const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
    await workspaceRepository.bootstrap("2026-07-18T16:00:00.000Z");
    const firstVaultId = await prepareAndCommitVault(
      databaseName,
      workspaceRepository,
      "Amber Archive",
      "2026-07-18T16:01:00.000Z",
    );
    const secondVaultId = await prepareAndCommitVault(
      databaseName,
      workspaceRepository,
      "Quiet Folio",
      "2026-07-18T16:02:00.000Z",
      firstVaultId,
    );
    const originalPut = IDBObjectStore.prototype.put;
    let write = 0;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<typeof originalPut>
    ): IDBRequest<IDBValidKey> {
      write += 1;
      if (write === failAt) throw new DOMException("Injected write failure", "AbortError");
      return originalPut.apply(this, args);
    };
    try {
      await workspaceRepository.commitVaultSelect({
        expectedActiveVaultId: secondVaultId,
        vaultId: firstVaultId,
      });
    } catch {
      // Expected injected transaction abort.
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    const vaultRepository = new IndexedDbVaultRepository(databaseName);
    const [workspace, first, second] = await Promise.all([
      workspaceRepository.load(),
      vaultRepository.load(firstVaultId),
      vaultRepository.load(secondVaultId),
    ]);
    results.push(
      write === failAt &&
        workspace?.metadata.activeVaultId === secondVaultId &&
        first?.metadata.manuallyLocked === true &&
        second?.metadata.manuallyLocked === false,
    );
    await vaultRepository.close();
    await workspaceRepository.deleteDatabase();
  }
  return { failurePoints: results.length, allAtomic: results.every(Boolean) };
}

async function atomicVaultRenameScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  const workspace = await workspaceRepository.bootstrap("2026-07-18T17:00:00.000Z");
  const vaultRepository = new IndexedDbVaultRepository(databaseName);
  const service = new VaultService(vaultRepository);
  const created = await service.prepareCreate({
    name: "Amber Archive",
    createdAt: "2026-07-18T17:01:00.000Z",
  });
  const vaultId = created.records.metadata.vaultId;
  const createdEventId = crypto.randomUUID();
  const createdName = await prepareVaultNameChange({
    keyring: created.keyring,
    eventType: "VaultCreated",
    vaultId,
    deviceId: created.records.metadata.deviceId,
    eventId: createdEventId,
    timestamp: "2026-07-18T17:01:00.000Z",
    name: "Amber Archive",
  });
  await workspaceRepository.commitVaultCreate({
    records: created.records,
    event: createdName.event,
    projection: createdName.projection,
    cache: await encryptWorkspaceVaultName({
      key: workspace.nameCacheKey,
      workspaceId: workspace.metadata.workspaceId,
      vaultId,
      sourceEventId: createdEventId,
      name: "Amber Archive",
    }),
  });
  const renamedEventId = crypto.randomUUID();
  const renamed = await prepareVaultNameChange({
    keyring: created.keyring,
    eventType: "VaultRenamed",
    vaultId,
    deviceId: created.records.metadata.deviceId,
    eventId: renamedEventId,
    timestamp: "2026-07-18T17:02:00.000Z",
    name: "Quiet Folio",
  });
  await workspaceRepository.commitVaultRename({
    expectedActiveVaultId: vaultId,
    vaultId,
    event: renamed.event,
    projection: renamed.projection,
    cache: await encryptWorkspaceVaultName({
      key: workspace.nameCacheKey,
      workspaceId: workspace.metadata.workspaceId,
      vaultId,
      sourceEventId: renamedEventId,
      name: "Quiet Folio",
    }),
  });
  const driver = new IndexedDbDriver(databaseName, vaultId);
  const result = {
    name: await workspaceRepository.readVaultName(
      workspace.nameCacheKey,
      workspace.metadata.workspaceId,
      vaultId,
    ),
    eventIds: (await driver.listStoredEvents()).map((event) => event.eventId),
    headEventIds: (await driver.getVaultHead())?.appendedEventIds,
  };
  await driver.close();
  await vaultRepository.close();
  await workspaceRepository.deleteDatabase();
  return result;
}

async function atomicVaultRenameFailureScenario(): Promise<unknown> {
  const results: boolean[] = [];
  for (let failAt = 1; failAt <= 4; failAt += 1) {
    const databaseName = `awsm-integration-${crypto.randomUUID()}`;
    const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
    const workspace = await workspaceRepository.bootstrap("2026-07-18T17:00:00.000Z");
    const vaultRepository = new IndexedDbVaultRepository(databaseName);
    const created = await new VaultService(vaultRepository).prepareCreate({
      name: "Amber Archive",
      createdAt: "2026-07-18T17:01:00.000Z",
    });
    const vaultId = created.records.metadata.vaultId;
    const createdEventId = crypto.randomUUID();
    const createdName = await prepareVaultNameChange({
      keyring: created.keyring,
      eventType: "VaultCreated",
      vaultId,
      deviceId: created.records.metadata.deviceId,
      eventId: createdEventId,
      timestamp: "2026-07-18T17:01:00.000Z",
      name: "Amber Archive",
    });
    await workspaceRepository.commitVaultCreate({
      records: created.records,
      event: createdName.event,
      projection: createdName.projection,
      cache: await encryptWorkspaceVaultName({
        key: workspace.nameCacheKey,
        workspaceId: workspace.metadata.workspaceId,
        vaultId,
        sourceEventId: createdEventId,
        name: "Amber Archive",
      }),
    });
    const renamedEventId = crypto.randomUUID();
    const renamed = await prepareVaultNameChange({
      keyring: created.keyring,
      eventType: "VaultRenamed",
      vaultId,
      deviceId: created.records.metadata.deviceId,
      eventId: renamedEventId,
      timestamp: "2026-07-18T17:02:00.000Z",
      name: "Quiet Folio",
    });
    const cache = await encryptWorkspaceVaultName({
      key: workspace.nameCacheKey,
      workspaceId: workspace.metadata.workspaceId,
      vaultId,
      sourceEventId: renamedEventId,
      name: "Quiet Folio",
    });
    const originalAdd = IDBObjectStore.prototype.add;
    const originalPut = IDBObjectStore.prototype.put;
    let write = 0;
    const inject = <T extends typeof originalAdd | typeof originalPut>(original: T) =>
      function (this: IDBObjectStore, ...args: Parameters<T>): IDBRequest<IDBValidKey> {
        write += 1;
        if (write === failAt) throw new DOMException("Injected write failure", "AbortError");
        return original.apply(this, args) as IDBRequest<IDBValidKey>;
      };
    IDBObjectStore.prototype.add = inject(originalAdd);
    IDBObjectStore.prototype.put = inject(originalPut);
    try {
      await workspaceRepository.commitVaultRename({
        expectedActiveVaultId: vaultId,
        vaultId,
        event: renamed.event,
        projection: renamed.projection,
        cache,
      });
    } catch {
      // Expected injected transaction abort.
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
      IDBObjectStore.prototype.put = originalPut;
    }
    const driver = new IndexedDbDriver(databaseName, vaultId);
    results.push(
      write === failAt &&
        (await workspaceRepository.readVaultName(
          workspace.nameCacheKey,
          workspace.metadata.workspaceId,
          vaultId,
        )) === "Amber Archive" &&
        (await driver.listStoredEvents()).length === 1 &&
        (await driver.getVaultHead())?.appendedEventIds.length === 1,
    );
    await driver.close();
    await vaultRepository.close();
    await workspaceRepository.deleteDatabase();
  }
  return { failurePoints: results.length, allAtomic: results.every(Boolean) };
}

async function immutableScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  const record = object(id("1"), 7);
  await driver.putImmutableObject(record);
  await driver.putImmutableObject(record);
  let conflictId = "";
  try {
    await driver.putImmutableObject(object(id("1"), 8));
  } catch (error) {
    conflictId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  const counts = await driver.counts();
  await driver.deleteDatabase();
  return { conflictId, objectCount: counts.objects };
}

async function vaultIsolationScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const first = new IndexedDbDriver(databaseName, id("1"));
  const second = new IndexedDbDriver(databaseName, id("2"));
  const objectId = id("99");
  await first.putImmutableObject(object(objectId, 7));
  await second.putImmutableObject(object(objectId, 8));
  const firstObject = await first.getStoredObject(objectId);
  const secondObject = await second.getStoredObject(objectId);
  const result = {
    firstByte:
      firstObject?.objectType === "BundleDescriptor" ? firstObject.envelopeBytes[0] : undefined,
    secondByte:
      secondObject?.objectType === "BundleDescriptor" ? secondObject.envelopeBytes[0] : undefined,
    firstCounts: await first.counts(),
    secondCounts: await second.counts(),
  };
  await second.close();
  await first.deleteDatabase();
  return result;
}

async function eventVaultMismatchScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("1"));
  await seedHead(driver);
  let rejected = false;
  try {
    await driver.commitRegistration(registration(1));
  } catch {
    rejected = true;
  }
  const counts = await driver.counts();
  await driver.deleteDatabase();
  return { rejected, counts };
}

async function atomicScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(driver);
  const input = registration(1);
  const first = await driver.commitRegistration(input);
  const duplicate = await driver.commitRegistration(input);
  const counts = await driver.counts();
  const head = await driver.getVaultHead();
  await driver.deleteDatabase();
  return {
    first,
    duplicate,
    counts,
    appendedObjects: head?.appendedObjectIds.length,
    appendedEvents: head?.appendedEventIds.length,
  };
}

async function rollbackScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(driver);
  const first = registration(1);
  await driver.commitRegistration(first);
  const second = registration(2);
  const conflicting: AtomicRegistrationV1 = {
    ...second,
    event: { ...second.event, eventId: first.event.eventId },
  };
  let errorId = "";
  try {
    await driver.commitRegistration(conflicting);
  } catch (error) {
    errorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  const rolledBackObject = await driver.hasObject(second.object.objectId);
  const counts = await driver.counts();
  const head = await driver.getVaultHead();
  await driver.deleteDatabase();
  return {
    errorId,
    rolledBackObject,
    counts,
    appendedObjects: head?.appendedObjectIds.length,
    appendedEvents: head?.appendedEventIds.length,
  };
}

async function staleEpochReplayCommitScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const driver = new IndexedDbDriver(databaseName, id("0"));
  await seedHead(driver);
  const stale = registration(1);
  await driver.commitRegistration(stale);
  const expectedHead = await driver.getVaultHead();
  if (expectedHead === undefined) throw new Error("Seeded Vault head is missing.");
  const replay = registration(2);
  await driver.commitStaleEpochCaptureReplays({
    expectedHead,
    retainedObjectIds: [],
    retainedEventIds: [],
    replays: [
      {
        oldBundleId: stale.graph.bundleId,
        oldEventId: stale.event.eventId,
        registration: replay,
      },
    ],
  });
  const head = await driver.getVaultHead();
  const projections = await driver.listEncryptedProjections();
  const success = {
    immutableObjectCount: (await driver.listStoredObjects()).length,
    immutableEventCount: (await driver.listStoredEvents()).length,
    headObjectIds: head?.appendedObjectIds,
    headEventIds: head?.appendedEventIds,
    projectionBundleIds: projections.map((projection) => projection.bundleId),
  };
  await driver.deleteDatabase();

  const rollback = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(rollback);
  await rollback.commitRegistration(stale);
  const rollbackHead = await rollback.getVaultHead();
  if (rollbackHead === undefined) throw new Error("Rollback Vault head is missing.");
  const conflicting: AtomicRegistrationV1 = {
    ...replay,
    event: { ...replay.event, eventId: stale.event.eventId },
  };
  let rejected = false;
  try {
    await rollback.commitStaleEpochCaptureReplays({
      expectedHead: rollbackHead,
      retainedObjectIds: [],
      retainedEventIds: [],
      replays: [
        {
          oldBundleId: stale.graph.bundleId,
          oldEventId: stale.event.eventId,
          registration: conflicting,
        },
      ],
    });
  } catch {
    rejected = true;
  }
  const finalHead = await rollback.getVaultHead();
  const finalProjections = await rollback.listEncryptedProjections();
  const rollbackResult = {
    rejected,
    newObjectsAbsent: replay.objects.every(
      (entry) => !finalHead?.appendedObjectIds.includes(entry.objectId),
    ),
    oldHeadRetained:
      finalHead?.appendedObjectIds.join("\n") === rollbackHead.appendedObjectIds.join("\n") &&
      finalHead?.appendedEventIds.join("\n") === rollbackHead.appendedEventIds.join("\n"),
    oldProjectionRetained:
      finalProjections.length === 1 && finalProjections[0]?.bundleId === stale.projection.bundleId,
  };
  await rollback.deleteDatabase();
  return { success, rollback: rollbackResult };
}

async function vaultReplacementPersistenceScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const repository = new IndexedDbVaultReplacementRepository(databaseName);
  const sourceVaultId = id("880");
  const createdAt = "2026-07-25T23:00:00.000Z";
  const sourceHead = {
    version: 1 as const,
    vaultId: sourceVaultId,
    generationId: id("881"),
    generationNumber: 2,
    appendedObjectIds: [id("882")],
    appendedEventIds: [id("883")],
  };
  const created = {
    version: 1 as const,
    jobId: id("884"),
    accountId: id("885"),
    sourceVaultId,
    sourceHead,
    sourceHeadCursor: 9,
    verifiedExportJobId: id("886"),
    safelyStoredConfirmed: true as const,
    candidateIdempotencyKey: id("910"),
    generationUploadCompleteIdempotencyKey: id("911"),
    candidateCompleteIdempotencyKey: id("912"),
    activationIdempotencyKey: id("913"),
    state: "Created" as const,
    stage: "ExportGate" as const,
    createdAt,
    updatedAt: createdAt,
    completedItems: 0,
    totalItems: 0,
    processedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
  };
  await repository.create(created);
  const running = {
    ...created,
    state: "Running" as const,
    stage: "Rewrite" as const,
    updatedAt: "2026-07-25T23:00:01.000Z",
    targetVaultId: id("887"),
    targetDeviceId: id("888"),
    targetRecoveryGenerationId: id("889"),
    targetKeyEpochId: id("890"),
    targetGenerationId: id("891"),
    targetGenerationNumber: 0,
  };
  await repository.save(running, created.updatedAt);
  const plaintext = new Uint8Array([1, 2, 3, 4]);
  await repository.sealCheckpoint({
    job: running,
    targetVaultId: running.targetVaultId,
    plaintext,
    updatedAt: "2026-07-25T23:00:02.000Z",
  });
  await repository.close();

  const reopened = new IndexedDbVaultReplacementRepository(databaseName);
  const loaded = await reopened.latest(sourceVaultId);
  if (loaded === undefined) throw new Error("Replacement Job did not persist.");
  const opened = await reopened.openCheckpoint(loaded);
  let staleCasRejected = false;
  try {
    await reopened.save({ ...running, retryCount: 1 }, created.updatedAt);
  } catch {
    staleCasRejected = true;
  }

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const transaction = database.transaction("vault_replacement_checkpoints", "readwrite");
  const key = vaultKey(sourceVaultId, running.jobId);
  const store = transaction.objectStore("vault_replacement_checkpoints");
  const checkpoint = (await new Promise<unknown>((resolve, reject) => {
    const request = store.get(key);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  })) as { ciphertext: Uint8Array };
  checkpoint.ciphertext = Uint8Array.from(checkpoint.ciphertext);
  checkpoint.ciphertext[0] = (checkpoint.ciphertext[0] ?? 0) ^ 1;
  store.put(checkpoint, key);
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    });
  });
  database.close();
  let tamperErrorId = "";
  try {
    await reopened.openCheckpoint(loaded);
  } catch (error) {
    tamperErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  await reopened.clearSensitive(loaded);
  const cleared = await reopened.openCheckpoint(loaded);
  await reopened.close();
  const cleanup = new IndexedDbDriver(databaseName, sourceVaultId);
  await cleanup.deleteDatabase();
  return {
    state: loaded.state,
    stage: loaded.stage,
    plaintextRestored: opened?.join(",") === plaintext.join(","),
    staleCasRejected,
    tamperErrorId,
    sensitiveStateCleared: cleared === undefined,
  };
}

async function vaultReplacementHiddenStageScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  await workspaceRepository.bootstrap("2026-07-25T23:10:00.000Z");
  const sourceVaultId = await prepareAndCommitVault(
    databaseName,
    workspaceRepository,
    "Source archive",
    "2026-07-25T23:11:00.000Z",
  );
  const sourceRepository = new IndexedDbVaultRepository(databaseName);
  const source = await sourceRepository.load(sourceVaultId);
  if (source === undefined) throw new Error("Source Vault is unavailable.");

  const targetPreparationRepository = new IndexedDbVaultRepository(databaseName);
  const target = await new VaultService(targetPreparationRepository).prepareCreate({
    name: "Replacement archive",
    createdAt: "2026-07-25T23:12:00.000Z",
  });
  const targetVaultId = target.records.metadata.vaultId;
  const targetEventId = id("892");
  const targetName = await prepareVaultNameChange({
    keyring: target.keyring,
    eventType: "VaultCreated",
    vaultId: targetVaultId,
    deviceId: target.records.metadata.deviceId,
    eventId: targetEventId,
    timestamp: target.records.metadata.createdAt,
    name: target.name,
  });
  const targetRecords: VaultRecordsV1 = {
    ...target.records,
    head: {
      ...target.records.head,
      appendedEventIds: [targetEventId],
    },
  };
  const replacementRepository = new IndexedDbVaultReplacementRepository(databaseName);
  const createdAt = "2026-07-25T23:13:00.000Z";
  const created = {
    version: 1 as const,
    jobId: id("893"),
    accountId: id("894"),
    sourceVaultId,
    sourceHead: source.head,
    sourceHeadCursor: 5,
    verifiedExportJobId: id("895"),
    safelyStoredConfirmed: true as const,
    candidateIdempotencyKey: id("914"),
    generationUploadCompleteIdempotencyKey: id("915"),
    candidateCompleteIdempotencyKey: id("916"),
    activationIdempotencyKey: id("917"),
    state: "Created" as const,
    stage: "ExportGate" as const,
    createdAt,
    updatedAt: createdAt,
    completedItems: 0,
    totalItems: 1,
    processedBytes: 0,
    totalBytes: targetName.event.envelopeBytes.byteLength,
    retryCount: 0,
  };
  await replacementRepository.create(created);
  const staging = {
    ...created,
    state: "Running" as const,
    stage: "StageRemote" as const,
    updatedAt: "2026-07-25T23:14:00.000Z",
    targetVaultId,
    targetDeviceId: target.records.metadata.deviceId,
    targetRecoveryGenerationId: id("896"),
    targetKeyEpochId: target.records.metadata.activeKeyEpochId,
    targetGenerationId: target.records.generation.generationId,
    targetGenerationNumber: 0,
  };
  await replacementRepository.save(staging, created.updatedAt);
  const stage = {
    job: staging,
    records: targetRecords,
    events: [targetName.event],
    objects: [],
    libraryProjections: [],
    collectionProjection: {
      version: 1 as const,
      projectionId: targetVaultId,
      envelopeBytes: new Uint8Array([1, 2, 3]),
    },
    vaultNameProjection: targetName.projection,
    preparedArtifactObjectIds: [],
  };
  await workspaceRepository.stageVaultReplacement(stage);
  await workspaceRepository.close();
  await replacementRepository.close();
  await sourceRepository.close();
  await targetPreparationRepository.close();

  const reopenedWorkspace = new IndexedDbWorkspaceRepository(databaseName);
  const reopenedTarget = new IndexedDbVaultRepository(databaseName);
  const targetDriver = new IndexedDbDriver(databaseName, targetVaultId);
  const [workspace, directory, staged, targetLoaded, targetEvents] = await Promise.all([
    reopenedWorkspace.load(),
    reopenedWorkspace.listVaultDirectory(),
    reopenedWorkspace.hasStagedVaultReplacement({
      sourceVaultId,
      targetVaultId,
      jobId: staging.jobId,
    }),
    reopenedTarget.load(targetVaultId),
    targetDriver.listStoredEvents(),
  ]);
  let collisionErrorId = "";
  try {
    await reopenedWorkspace.stageVaultReplacement(stage);
  } catch (error) {
    collisionErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  await reopenedWorkspace.discardStagedVaultReplacement(staging);
  const [discardedTarget, retainedSource] = await Promise.all([
    reopenedTarget.load(targetVaultId),
    reopenedTarget.load(sourceVaultId),
  ]);
  const result = {
    activeVaultUnchanged: workspace?.metadata.activeVaultId === sourceVaultId,
    directoryContainsOnlySource: directory.length === 1 && directory[0]?.vaultId === sourceVaultId,
    hiddenStageRestored: staged,
    targetRecordsRestored:
      targetLoaded?.head.appendedEventIds[0] === targetEventId &&
      targetEvents[0]?.eventId === targetEventId,
    collisionErrorId,
    discardRemovedOnlyTarget:
      discardedTarget === undefined && retainedSource?.metadata.vaultId === sourceVaultId,
  };
  await reopenedWorkspace.close();
  await reopenedTarget.close();
  await targetDriver.deleteDatabase();
  return result;
}

async function vaultReplacementPromotionScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  const workspace = await workspaceRepository.bootstrap("2026-07-25T23:40:00.000Z");
  const sourceVaultId = await prepareAndCommitVault(
    databaseName,
    workspaceRepository,
    "Source archive",
    "2026-07-25T23:41:00.000Z",
  );
  const sourceRepository = new IndexedDbVaultRepository(databaseName);
  const source = await sourceRepository.load(sourceVaultId);
  if (source === undefined) throw new Error("Source Vault is unavailable.");
  const targetPreparationRepository = new IndexedDbVaultRepository(databaseName);
  const target = await new VaultService(targetPreparationRepository).prepareCreate({
    name: "Replacement archive",
    createdAt: "2026-07-25T23:42:00.000Z",
  });
  const targetVaultId = target.records.metadata.vaultId;
  const targetEventId = id("897");
  const targetName = await prepareVaultNameChange({
    keyring: target.keyring,
    eventType: "VaultCreated",
    vaultId: targetVaultId,
    deviceId: target.records.metadata.deviceId,
    eventId: targetEventId,
    timestamp: target.records.metadata.createdAt,
    name: target.name,
  });
  const targetRecords: VaultRecordsV1 = {
    ...target.records,
    head: {
      ...target.records.head,
      appendedEventIds: [targetEventId],
    },
  };
  const accountId = id("898");
  const replacementRepository = new IndexedDbVaultReplacementRepository(databaseName);
  const createdAt = "2026-07-25T23:43:00.000Z";
  const created = {
    version: 1 as const,
    jobId: id("900"),
    accountId,
    sourceVaultId,
    sourceHead: source.head,
    sourceHeadCursor: 8,
    verifiedExportJobId: id("901"),
    safelyStoredConfirmed: true as const,
    candidateIdempotencyKey: id("918"),
    generationUploadCompleteIdempotencyKey: id("919"),
    candidateCompleteIdempotencyKey: id("920"),
    activationIdempotencyKey: id("921"),
    state: "Created" as const,
    stage: "ExportGate" as const,
    createdAt,
    updatedAt: createdAt,
    completedItems: 0,
    totalItems: 1,
    processedBytes: 0,
    totalBytes: targetName.event.envelopeBytes.byteLength,
    retryCount: 0,
  };
  await replacementRepository.create(created);
  const recoveryGenerationId = id("907");
  const targetRootKey = await unwrapDeviceSlot(target.records.deviceSlot, target.records.deviceKey);
  const identity = {
    deviceId: target.records.metadata.deviceId,
    signingPublicKey: new Uint8Array(32).fill(1),
    signingSecretKey: new Uint8Array(64).fill(2),
    wrappingPublicKey: new Uint8Array(32).fill(3),
    wrappingSecretKey: new Uint8Array(32).fill(4),
  };
  const certificate = {
    content: {
      version: 1 as const,
      certificateId: id("908"),
      vaultId: targetVaultId,
      recoveryGenerationId,
      deviceId: identity.deviceId,
      displayName: "Firefox",
      clientKind: "FirefoxExtension" as const,
      signingAlgorithm: "sign:ed25519:device:v1" as const,
      signingPublicKey: identity.signingPublicKey,
      wrappingAlgorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1" as const,
      wrappingPublicKey: identity.wrappingPublicKey,
      issuedAt: "2026-07-25T23:43:30.000Z",
    },
    contentCbor: new Uint8Array([1]),
    recoveryAdministratorPublicKey: new Uint8Array(32).fill(5),
    signature: new Uint8Array(64).fill(6),
  };
  const envelope = {
    metadata: {
      version: 1 as const,
      vaultId: targetVaultId,
      recoveryGenerationId,
      keyEpochId: target.records.metadata.activeKeyEpochId,
      deviceId: identity.deviceId,
      algorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1" as const,
      ephemeralPublicKey: new Uint8Array(32).fill(7),
      nonce: new Uint8Array(24).fill(8),
      ciphertextLength: 48,
    },
    ciphertext: new Uint8Array(48).fill(9),
    ciphertextSha256: new Uint8Array(32).fill(10),
    administratorSignature: new Uint8Array(64).fill(11),
  };
  const recoveryKit = {
    metadata: {
      version: 1 as const,
      vaultId: targetVaultId,
      recoveryGenerationId,
      derivationAlgorithm: "kdf:hkdf-sha256:recovery-entropy:v1" as const,
      wrappingAlgorithm: "wrap:xchacha20poly1305:recovery-kit:v1" as const,
      administratorSigningAlgorithm: "sign:ed25519:recovery-administrator:v1" as const,
      administratorPublicKey: new Uint8Array(32).fill(5),
      nonce: new Uint8Array(24).fill(12),
      ciphertextLength: 48,
      ciphertextSha256: new Uint8Array(32).fill(13),
    },
    ciphertext: new Uint8Array(48).fill(14),
  };
  const staging = {
    ...created,
    state: "Running" as const,
    stage: "StageRemote" as const,
    updatedAt: "2026-07-25T23:44:00.000Z",
    targetVaultId,
    targetDeviceId: target.records.metadata.deviceId,
    targetRecoveryGenerationId: recoveryGenerationId,
    targetKeyEpochId: target.records.metadata.activeKeyEpochId,
    targetGenerationId: target.records.generation.generationId,
    targetGenerationNumber: 0,
  };
  await replacementRepository.save(staging, created.updatedAt);
  await workspaceRepository.stageVaultReplacement({
    job: staging,
    records: targetRecords,
    events: [targetName.event],
    objects: [],
    libraryProjections: [],
    collectionProjection: {
      version: 1,
      projectionId: targetVaultId,
      envelopeBytes: new Uint8Array([4, 5, 6]),
    },
    vaultNameProjection: targetName.projection,
    preparedArtifactObjectIds: [],
  });
  const accountRepository = new IndexedDbAccountRepository(databaseName);
  await accountRepository.saveSynchronizationCheckpoint({
    version: 1,
    vaultId: targetVaultId,
    entityId: targetEventId,
    kind: "Event",
    state: "Committed",
    createIdempotencyKey: id("902"),
    completeIdempotencyKey: id("903"),
    commitIdempotencyKey: id("904"),
    receivedParts: [0],
  });
  const promotion = {
    ...staging,
    stage: "PromoteLocal" as const,
    updatedAt: "2026-07-25T23:45:00.000Z",
    targetHeadCursor: 2,
    purgeId: id("905"),
  };
  await replacementRepository.save(promotion, staging.updatedAt);
  const cache = await encryptWorkspaceVaultName({
    key: workspace.nameCacheKey,
    workspaceId: workspace.metadata.workspaceId,
    vaultId: targetVaultId,
    sourceEventId: targetEventId,
    name: target.name,
  });
  const promoted = await workspaceRepository.commitVaultReplacement({
    job: promotion,
    authority: {
      accountId,
      vaultId: targetVaultId,
      recoveryGenerationId,
      identity,
      certificate,
      envelopes: [envelope],
      keyEpochs: [
        {
          keyEpochId: target.records.metadata.activeKeyEpochId,
          ordinal: 0,
          rootKey: targetRootKey,
        },
      ],
      recoveryKit,
      remoteGenerationId: target.records.generation.generationId,
      remoteGenerationNumber: 0,
      remoteHeadCursor: 2,
      session: {
        account: {
          accountId,
          username: "owner_test",
          inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
        },
        sessionId: id("906"),
        scope: "VaultDevice",
        accessToken: "replacement-access",
        accessExpiresAt: "2026-07-26T00:45:00.000Z",
        refreshToken: "replacement-refresh",
        refreshExpiresAt: "2026-08-25T23:45:00.000Z",
      },
    },
    nameCache: cache,
    promotedAt: "2026-07-25T23:46:00.000Z",
  });
  await workspaceRepository.close();
  await replacementRepository.close();
  await sourceRepository.close();
  await targetPreparationRepository.close();
  await accountRepository.close();

  const reopenedWorkspace = new IndexedDbWorkspaceRepository(databaseName);
  const reopenedVaults = new IndexedDbVaultRepository(databaseName);
  const reopenedAccount = new IndexedDbAccountRepository(databaseName);
  const reopenedDevices = new IndexedDbDeviceRepository(databaseName);
  const [workspaceAfter, directory, sourceAfter, targetAfter, registration, device, deviceSession] =
    await Promise.all([
      reopenedWorkspace.load(),
      reopenedWorkspace.listVaultDirectory(),
      reopenedVaults.load(sourceVaultId),
      reopenedVaults.load(targetVaultId),
      reopenedAccount.loadAccountVault(),
      reopenedDevices.loadDeviceAuthority(targetVaultId),
      reopenedDevices.loadDeviceSession(targetVaultId),
    ]);
  const result = {
    activeReplacement:
      workspaceAfter?.metadata.activeVaultId === targetVaultId &&
      directory.length === 1 &&
      directory[0]?.vaultId === targetVaultId,
    sourceRemoved: sourceAfter === undefined,
    targetRetained: targetAfter?.head.appendedEventIds[0] === targetEventId,
    registrationPromoted:
      registration?.vaultId === targetVaultId && registration.deliveryCursor === 2,
    deviceAuthorityRestored:
      device?.identity.deviceId === target.records.metadata.deviceId &&
      device.keyEpochs.length === 1 &&
      deviceSession?.refreshToken === "replacement-refresh",
    purgeTrackingRetained:
      promoted.job.stage === "PurgeSource" && promoted.job.purgeId === id("905"),
  };
  await reopenedWorkspace.close();
  await reopenedVaults.close();
  await reopenedAccount.close();
  await reopenedDevices.close();
  const cleanup = new IndexedDbDriver(databaseName, targetVaultId);
  await cleanup.deleteDatabase();
  return result;
}

async function projectionScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(driver);
  await driver.commitRegistration(registration(1));
  await driver.clearLibraryProjection();
  const counts = await driver.counts();
  await driver.deleteDatabase();
  return counts;
}

async function interruptionScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(driver);
  const beforeCommit = registration(1);
  const afterCommit = registration(2);
  await driver.saveCaptureJob({
    version: 1,
    vaultId: driver.vaultId,
    jobId: id("701"),
    commandId: beforeCommit.outcome.commandId,
    tabId: 7,
    state: "Running",
    stage: "Snapshot",
    createdAt: "2026-07-16T17:00:00.000Z",
    updatedAt: "2026-07-16T17:00:01.000Z",
  });
  await driver.saveCaptureJob({
    version: 1,
    vaultId: driver.vaultId,
    jobId: id("702"),
    commandId: afterCommit.outcome.commandId,
    tabId: 8,
    state: "Running",
    stage: "Commit",
    createdAt: "2026-07-16T17:00:00.000Z",
    updatedAt: "2026-07-16T17:00:02.000Z",
  });
  await driver.commitRegistration(afterCommit);
  await driver.reconcileInterruptedJobs("2026-07-16T17:01:00.000Z");
  const result = {
    beforeCommit: await driver.getCaptureJob(id("701")),
    afterCommit: await driver.getCaptureJob(id("702")),
  };
  await driver.deleteDatabase();
  return result;
}

async function dismissalScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  const jobId = id("801");
  await driver.saveCaptureJob({
    version: 1,
    vaultId: driver.vaultId,
    jobId,
    commandId: id("802"),
    tabId: 7,
    state: "Succeeded",
    stage: "Commit",
    createdAt: "2026-07-16T17:00:00.000Z",
    updatedAt: "2026-07-16T17:00:01.000Z",
  });
  await driver.dismissCaptureNotice(jobId);
  const dismissed = await driver.getCaptureJob(jobId);
  await driver.deleteDatabase();
  return dismissed;
}

async function captureJobVaultIsolationScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const firstVaultId = id("901");
  const secondVaultId = id("902");
  const jobId = id("903");
  const first = new IndexedDbDriver(databaseName, firstVaultId);
  const second = new IndexedDbDriver(databaseName, secondVaultId);
  const base = {
    version: 1 as const,
    jobId,
    commandId: id("904"),
    state: "Succeeded" as const,
    stage: "Commit" as const,
    createdAt: "2026-07-18T14:00:00.000Z",
    updatedAt: "2026-07-18T14:00:01.000Z",
  };
  await first.saveCaptureJob({ ...base, vaultId: firstVaultId, tabId: 7 });
  await second.saveCaptureJob({ ...base, vaultId: secondVaultId, tabId: 8 });
  const firstTabId = (await first.getCaptureJob(jobId))?.tabId;
  const secondTabId = (await second.getCaptureJob(jobId))?.tabId;

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const transaction = database.transaction("capture_jobs", "readwrite");
  transaction
    .objectStore("capture_jobs")
    .put({ ...base, vaultId: secondVaultId, tabId: 9 }, vaultKey(firstVaultId, jobId));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    });
  });
  database.close();
  let mismatchedReadRejected = false;
  try {
    await first.getCaptureJob(jobId);
  } catch {
    mismatchedReadRejected = true;
  }
  first.close();
  await second.deleteDatabase();
  return { firstTabId, secondTabId, mismatchedReadRejected };
}

async function libraryStateScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(driver);
  const first = registration(1);
  const second = registration(2);
  await driver.commitRegistration(first);
  await driver.commitRegistration(second);
  await driver.commitLibraryState(
    {
      version: 1,
      vaultId: driver.vaultId,
      eventId: id("901"),
      referencedObjectIds: [second.object.objectId],
      orderingTimestamp: "2026-07-16T18:00:00.000Z",
      envelopeBytes: new Uint8Array([9]),
    },
    [
      { ...first.projection, envelopeBytes: new Uint8Array([7]) },
      { ...second.projection, envelopeBytes: new Uint8Array([8]) },
    ],
  );
  const result = {
    counts: await driver.counts(),
    firstObject: await driver.hasObject(first.object.objectId),
    secondObject: await driver.hasObject(second.object.objectId),
  };
  await driver.deleteDatabase();
  return result;
}

async function vacuumRollbackScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const driver = new IndexedDbDriver(databaseName, id("0"));
  await seedHead(driver);
  const input = registration(1);
  await driver.commitRegistration(input);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const corrupt = database.transaction(
    ["command_outcomes", "vault_head", "vacuum_jobs"],
    "readwrite",
  );
  corrupt
    .objectStore("command_outcomes")
    .put({ invalid: true }, vaultKey(driver.vaultId, "corrupt"));
  corrupt.objectStore("vault_head").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      generationId: id("990"),
      generationNumber: 0,
      appendedObjectIds: [input.object.objectId],
      appendedEventIds: [input.event.eventId],
    },
    vaultSingletonKey(driver.vaultId, "active"),
  );
  corrupt.objectStore("vacuum_jobs").put(
    {
      version: 1,
      jobId: id("989"),
      sourceGenerationId: id("990"),
      stage: "Preflight",
      createdAt: "2026-07-16T18:00:00.000Z",
    },
    vaultKey(driver.vaultId, id("989")),
  );
  await new Promise<void>((resolve, reject) => {
    corrupt.addEventListener("complete", () => resolve(), { once: true });
    corrupt.addEventListener("error", () => reject(corrupt.error), {
      once: true,
    });
  });
  database.close();
  let failed = false;
  try {
    await driver.commitVacuum({
      jobId: id("989"),
      objectIds: [input.object.objectId],
      eventIds: [input.event.eventId],
      eventsToAdd: [],
      bundleIds: [input.projection.bundleId],
      expectedGenerationId: id("990"),
      generation: {
        version: 1,
        generationId: id("991"),
        generationNumber: 1,
        envelopeBytes: new Uint8Array([1]),
      },
      head: {
        version: 1,
        vaultId: driver.vaultId,
        generationId: id("991"),
        generationNumber: 1,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
    });
  } catch {
    failed = true;
  }
  const result = {
    failed,
    objectRetained: await driver.hasObject(input.object.objectId),
    counts: await driver.counts(),
  };
  await driver.deleteDatabase();
  return result;
}

async function vacuumAvailabilityCleanupScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const driver = new IndexedDbDriver(databaseName, id("0"));
  await seedHead(driver);
  const input = registration(1);
  await driver.commitRegistration(input);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const jobId = id("987");
  const generationId = id("990");
  const reliefJobId = id("986");
  const seed = database.transaction(
    [
      "vault_head",
      "vacuum_jobs",
      "artifact_availability",
      "storage_relief_jobs",
      "storage_relief_checkpoints",
    ],
    "readwrite",
  );
  const head = {
    version: 1 as const,
    vaultId: driver.vaultId,
    generationId,
    generationNumber: 0,
    appendedObjectIds: [input.object.objectId],
    appendedEventIds: [input.event.eventId],
  };
  seed.objectStore("vault_head").put(head, vaultSingletonKey(driver.vaultId, "active"));
  seed.objectStore("vacuum_jobs").put(
    {
      version: 1,
      jobId,
      sourceGenerationId: generationId,
      stage: "Preflight",
      createdAt: "2026-07-21T02:00:00.000Z",
    },
    vaultKey(driver.vaultId, jobId),
  );
  seed.objectStore("artifact_availability").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      artifactObjectId: input.object.objectId,
      markedAt: "2026-07-21T02:00:00.000Z",
    },
    vaultKey(driver.vaultId, input.object.objectId),
  );
  seed.objectStore("storage_relief_jobs").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      jobId: reliefJobId,
      state: "Succeeded",
      stage: "Checkpoint",
      createdAt: "2026-07-21T01:00:00.000Z",
      updatedAt: "2026-07-21T01:01:00.000Z",
      expectedServerOrigin: "https://sync.example.test",
      expectedAccountId: id("985"),
      expectedLocalHead: head,
      expectedGenerationId: generationId,
      expectedGenerationNumber: 0,
      candidateArtifacts: 1,
      candidateBytes: 3,
      verifiedArtifacts: 1,
      verifiedBytes: 3,
      evictedArtifacts: 1,
      freedBytes: 3,
      skippedArtifacts: 0,
      skippedBytes: 0,
      cancellationRequested: false,
    },
    vaultKey(driver.vaultId, reliefJobId),
  );
  seed.objectStore("storage_relief_checkpoints").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      jobId: reliefJobId,
      artifactObjectId: input.object.objectId,
      keyEpochId: "00000000-0000-4000-8000-000000000009",
      envelopeByteLength: 3,
      envelopeChecksum: new Uint8Array(32),
      state: "Evicted",
      remoteGenerationId: generationId,
      remoteGenerationNumber: 0,
    },
    [driver.vaultId, reliefJobId, input.object.objectId],
  );
  await new Promise<void>((resolve, reject) => {
    seed.addEventListener("complete", () => resolve(), { once: true });
    seed.addEventListener("error", () => reject(seed.error), { once: true });
  });
  database.close();
  await driver.commitVacuum({
    jobId,
    objectIds: [input.object.objectId],
    eventIds: [input.event.eventId],
    eventsToAdd: [],
    bundleIds: [input.projection.bundleId],
    expectedGenerationId: generationId,
    generation: {
      version: 1,
      generationId: id("991"),
      generationNumber: 1,
      predecessorGenerationId: generationId,
      envelopeBytes: new Uint8Array([1]),
    },
    head: {
      version: 1,
      vaultId: driver.vaultId,
      generationId: id("991"),
      generationNumber: 1,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
  });
  const reopened = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const inspect = reopened.transaction(
    ["artifact_availability", "storage_relief_jobs", "storage_relief_checkpoints"],
    "readonly",
  );
  const counts = await Promise.all(
    ["artifact_availability", "storage_relief_jobs", "storage_relief_checkpoints"].map(
      (storeName) =>
        new Promise<number>((resolve, reject) => {
          const request = inspect.objectStore(storeName).count();
          request.addEventListener("success", () => resolve(request.result), {
            once: true,
          });
          request.addEventListener("error", () => reject(request.error), {
            once: true,
          });
        }),
    ),
  );
  reopened.close();
  const result = {
    objectRetained: await driver.hasObject(input.object.objectId),
    availabilityRows: counts[0],
    reliefJobs: counts[1],
    reliefCheckpoints: counts[2],
  };
  await driver.deleteDatabase();
  return result;
}

async function vacuumCasConflictScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const driver = new IndexedDbDriver(databaseName, id("0"));
  await seedHead(driver);
  const input = registration(1);
  await driver.commitRegistration(input);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const transaction = database.transaction(["vault_head", "vacuum_jobs"], "readwrite");
  transaction.objectStore("vault_head").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      generationId: id("990"),
      generationNumber: 2,
      appendedObjectIds: [input.object.objectId],
      appendedEventIds: [input.event.eventId],
    },
    vaultSingletonKey(driver.vaultId, "active"),
  );
  transaction.objectStore("vacuum_jobs").put(
    {
      version: 1,
      jobId: id("988"),
      sourceGenerationId: id("989"),
      stage: "Preflight",
      createdAt: "2026-07-16T18:00:00.000Z",
    },
    vaultKey(driver.vaultId, id("988")),
  );
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    });
  });
  database.close();
  let failed = false;
  try {
    await driver.commitVacuum({
      jobId: id("988"),
      objectIds: [input.object.objectId],
      eventIds: [input.event.eventId],
      eventsToAdd: [],
      bundleIds: [input.projection.bundleId],
      expectedGenerationId: id("989"),
      generation: {
        version: 1,
        generationId: id("991"),
        generationNumber: 2,
        envelopeBytes: new Uint8Array([1]),
      },
      head: {
        version: 1,
        vaultId: driver.vaultId,
        generationId: id("991"),
        generationNumber: 2,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
    });
  } catch {
    failed = true;
  }
  const result = {
    failed,
    objectRetained: await driver.hasObject(input.object.objectId),
    activeGenerationId: (await driver.getVaultHead())?.generationId,
  };
  await driver.deleteDatabase();
  return result;
}

async function vacuumLeaseScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(driver.databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const transaction = database.transaction("vault_head", "readwrite");
  transaction.objectStore("vault_head").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      generationId: id("990"),
      generationNumber: 0,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    vaultSingletonKey(driver.vaultId, "active"),
  );
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    });
  });
  database.close();
  await driver.acquireVacuum(id("989"), "2026-07-16T18:00:00.000Z");
  let blocked = false;
  try {
    await driver.commitRegistration(registration(1));
  } catch {
    blocked = true;
  }
  await driver.reconcileInterruptedVacuum();
  await driver.commitRegistration(registration(1));
  const result = {
    blocked,
    committedAfterRecovery: await driver.hasObject(id("1")),
  };
  await driver.deleteDatabase();
  return result;
}

async function synchronizedVacuumJournalScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const vaultId = id("0");
  const jobId = id("984");
  const first = new IndexedDbDriver(databaseName, vaultId);
  await seedHead(first);
  await first.acquireVacuum(jobId, "2026-07-19T03:00:00.000Z");
  const candidate = {
    jobId,
    objectIds: [] as string[],
    eventIds: [] as string[],
    eventsToAdd: [],
    bundleIds: [] as string[],
    expectedGenerationId: id("990"),
    generation: {
      version: 1 as const,
      generationId: id("985"),
      generationNumber: 1,
      predecessorGenerationId: id("990"),
      envelopeBytes: new Uint8Array([9, 8, 5]),
    },
    head: {
      version: 1 as const,
      vaultId,
      generationId: id("985"),
      generationNumber: 1,
      appendedObjectIds: [] as string[],
      appendedEventIds: [] as string[],
    },
    deletedArtifactObjectIds: [] as string[],
  };
  await first.persistSynchronizedVacuumCandidate(jobId, candidate);
  await first.close();

  const afterRemoteIntent = new IndexedDbDriver(databaseName, vaultId);
  await afterRemoteIntent.reconcileInterruptedVacuum();
  const remoteIntent = await afterRemoteIntent.latestVacuumJob();
  await afterRemoteIntent.markSynchronizedVacuumActivated(jobId, 17);
  await afterRemoteIntent.close();

  const afterRemoteActivation = new IndexedDbDriver(databaseName, vaultId);
  await afterRemoteActivation.reconcileInterruptedVacuum();
  const localPending = await afterRemoteActivation.latestVacuumJob();
  await afterRemoteActivation.discardSynchronizedVacuum(jobId);
  const discarded = await afterRemoteActivation.latestVacuumJob();
  const result = {
    remoteIntentStage: remoteIntent?.stage,
    candidateGenerationId: remoteIntent?.candidate?.generation.generationId,
    localPendingStage: localPending?.stage,
    activatedHeadCursor: localPending?.activatedHeadCursor,
    discarded: discarded === undefined,
  };
  await afterRemoteActivation.deleteDatabase();
  return result;
}

async function collectionOperationScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(driver);
  const first = registration(1);
  const second = registration(2);
  await driver.commitRegistration(first);
  await driver.commitRegistration(second);
  const event = {
    version: 1 as const,
    vaultId: driver.vaultId,
    eventId: id("850"),
    referencedObjectIds: [first.object.objectId],
    orderingTimestamp: "2026-07-18T12:00:00.000Z",
    envelopeBytes: new Uint8Array([8, 5, 0]),
  };
  await driver.commitCollectionOperation({
    event,
    projections: [
      {
        version: 1,
        bundleId: first.projection.bundleId,
        envelopeBytes: new Uint8Array([8, 5, 1]),
      },
    ],
    collectionProjection: {
      version: 1,
      projectionId: id("992"),
      envelopeBytes: new Uint8Array([8, 5, 2]),
    },
  });
  const rebuiltTopology = {
    version: 1 as const,
    projectionId: id("992"),
    envelopeBytes: new Uint8Array([9, 9, 2]),
  };
  await driver.clearLibraryProjection();
  await driver.replaceLibraryProjections([first.projection, second.projection], rebuiltTopology, {
    version: 1,
    vaultId: driver.vaultId,
    sourceEventId: id("850"),
    envelopeBytes: new Uint8Array([9, 9, 3]),
  });
  const result = {
    counts: await driver.counts(),
    topologyStored: (await driver.getCollectionProjection())?.projectionId,
    appendedEvents: (await driver.getVaultHead())?.appendedEventIds.length,
  };
  await driver.deleteDatabase();
  return result;
}

async function managementBusyScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await seedHead(driver);
  const job = {
    version: 1 as const,
    vaultId: driver.vaultId,
    jobId: id("970"),
    commandId: id("971"),
    tabId: 7,
    state: "Running" as const,
    stage: "Snapshot" as const,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:01.000Z",
  };
  await driver.saveCaptureJob(job);
  const captureBusy = await driver.managementBusy();
  let vacuumWhileCaptureErrorId = "";
  try {
    await driver.acquireVacuum(id("972"), "2026-07-18T12:00:02.000Z");
  } catch (error) {
    vacuumWhileCaptureErrorId =
      error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  await driver.saveCaptureJob({ ...job, state: "Succeeded", stage: "Commit" });
  await driver.acquireVacuum(id("973"), "2026-07-18T12:00:03.000Z");
  const vacuumBusy = await driver.managementBusy();
  await driver.deleteDatabase();
  return { captureBusy, vacuumWhileCaptureErrorId, vacuumBusy };
}

async function exportLeaseScenario(): Promise<unknown> {
  const driver = new IndexedDbDriver(`awsm-integration-${crypto.randomUUID()}`, id("0"));
  await driver.getVaultHead();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(driver.databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const setup = database.transaction(
    ["workspace_metadata", "vault_metadata", "vault_head"],
    "readwrite",
  );
  setup.objectStore("workspace_metadata").put(
    {
      version: 1,
      workspaceId: id("999"),
      createdAt: "2026-07-18T12:59:00.000Z",
      activeVaultId: driver.vaultId,
    },
    "local",
  );
  setup.objectStore("vault_metadata").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      activeKeyEpochId: TEST_KEY_EPOCH_ID,
      deviceId: id("998"),
      createdAt: "2026-07-18T12:59:00.000Z",
      manuallyLocked: false,
      verifier: {
        version: 1,
        nonce: new Uint8Array(24),
        ciphertext: new Uint8Array(38),
      },
    },
    vaultSingletonKey(driver.vaultId, "metadata"),
  );
  setup.objectStore("vault_head").put(
    {
      version: 1,
      vaultId: driver.vaultId,
      generationId: id("990"),
      generationNumber: 0,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    vaultSingletonKey(driver.vaultId, "active"),
  );
  await new Promise<void>((resolve, reject) => {
    setup.addEventListener("complete", () => resolve(), { once: true });
    setup.addEventListener("error", () => reject(setup.error), { once: true });
  });
  const createdAt = "2026-07-18T13:00:00.000Z";
  const job = {
    version: 1 as const,
    vaultId: driver.vaultId,
    jobId: id("960"),
    packageId: id("961"),
    state: "Created" as const,
    stage: "Preflight" as const,
    createdAt,
    updatedAt: createdAt,
    completedEntries: 0,
    totalEntries: 0,
    processedBytes: 0,
    totalBytes: 0,
    cancellationRequested: false,
  };
  const updateContext = async (activeVaultId: string, manuallyLocked: boolean): Promise<void> => {
    const transaction = database.transaction(["workspace_metadata", "vault_metadata"], "readwrite");
    transaction.objectStore("workspace_metadata").put(
      {
        version: 1,
        workspaceId: id("999"),
        createdAt: "2026-07-18T12:59:00.000Z",
        activeVaultId,
      },
      "local",
    );
    transaction.objectStore("vault_metadata").put(
      {
        version: 1,
        vaultId: driver.vaultId,
        activeKeyEpochId: TEST_KEY_EPOCH_ID,
        deviceId: id("998"),
        createdAt: "2026-07-18T12:59:00.000Z",
        manuallyLocked,
        verifier: {
          version: 1,
          nonce: new Uint8Array(24),
          ciphertext: new Uint8Array(38),
        },
      },
      vaultSingletonKey(driver.vaultId, "metadata"),
    );
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), {
        once: true,
      });
    });
  };
  let inactiveErrorId = "";
  await updateContext(id("997"), false);
  try {
    await driver.acquireExport(job);
  } catch (error) {
    inactiveErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  let lockedErrorId = "";
  await updateContext(driver.vaultId, true);
  try {
    await driver.acquireExport(job);
  } catch (error) {
    lockedErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  await updateContext(driver.vaultId, false);
  database.close();
  await driver.acquireExport(job);
  const busy = await driver.managementBusy();
  let registrationBlocked = false;
  let captureBlocked = false;
  let vacuumBlocked = false;
  try {
    await driver.commitRegistration(registration(1));
  } catch {
    registrationBlocked = true;
  }
  try {
    await driver.saveCaptureJob({
      version: 1,
      vaultId: driver.vaultId,
      jobId: id("962"),
      commandId: id("963"),
      tabId: 1,
      state: "Created",
      stage: "Preflight",
      createdAt,
      updatedAt: createdAt,
    });
  } catch {
    captureBlocked = true;
  }
  try {
    await driver.acquireVacuum(id("964"), createdAt);
  } catch {
    vacuumBlocked = true;
  }
  const cancelled = await driver.requestExportCancellation(job.jobId, "2026-07-18T13:00:01.000Z");
  await driver.updateExportJob({
    ...cancelled,
    state: "Cancelled",
    updatedAt: "2026-07-18T13:00:02.000Z",
  });
  await driver.commitRegistration(registration(1));

  const second = {
    ...job,
    jobId: id("965"),
    packageId: id("966"),
    updatedAt: "2026-07-18T13:00:03.000Z",
  };
  await driver.acquireExport(second);
  await driver.updateExportJob({
    ...second,
    state: "Running",
    stage: "Package",
  });
  const reconciled = await driver.reconcileInterruptedExports("2026-07-18T13:00:04.000Z");
  const latest = await driver.latestExportJob();
  const result = {
    busy,
    inactiveErrorId,
    lockedErrorId,
    registrationBlocked,
    captureBlocked,
    vacuumBlocked,
    committedAfterCancellation: await driver.hasObject(id("1")),
    reconciled,
    interruptedState: latest?.state,
    interruptedErrorId: latest?.errorId,
  };
  await driver.deleteDatabase();
  return result;
}

async function importLeaseScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const vaultId = id("0");
  const driver = new IndexedDbDriver(databaseName, vaultId);
  const imports = new IndexedDbImportRepository(databaseName);
  const vaults = new IndexedDbVaultRepository(databaseName);
  await driver.getVaultHead();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const setup = database.transaction(
    ["workspace_metadata", "vault_metadata", "vault_head"],
    "readwrite",
  );
  setup.objectStore("workspace_metadata").put(
    {
      version: 1,
      workspaceId: id("999"),
      createdAt: "2026-07-19T00:00:00.000Z",
      activeVaultId: vaultId,
    },
    "local",
  );
  setup.objectStore("vault_metadata").put(
    {
      version: 1,
      vaultId,
      deviceId: id("998"),
      createdAt: "2026-07-19T00:00:00.000Z",
      manuallyLocked: false,
      verifier: {
        version: 1,
        nonce: new Uint8Array(24),
        ciphertext: new Uint8Array(38),
      },
    },
    vaultSingletonKey(vaultId, "metadata"),
  );
  setup.objectStore("vault_head").put(
    {
      version: 1,
      vaultId,
      generationId: id("990"),
      generationNumber: 0,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    vaultSingletonKey(vaultId, "active"),
  );
  await new Promise<void>((resolve, reject) => {
    setup.addEventListener("complete", () => resolve(), { once: true });
    setup.addEventListener("error", () => reject(setup.error), { once: true });
  });
  database.close();

  const createdAt = "2026-07-19T00:01:00.000Z";
  const job = await imports.begin({
    jobId: id("701"),
    sourceByteLength: 100,
    createdAt,
  });
  let secondErrorId = "";
  try {
    await imports.begin({ jobId: id("702"), sourceByteLength: 100, createdAt });
  } catch (error) {
    secondErrorId = error instanceof Error && "id" in error ? String(error.id) : "unexpected";
  }
  let captureBlocked = false;
  let registrationBlocked = false;
  let vacuumBlocked = false;
  let exportBlocked = false;
  let lockBlocked = false;
  try {
    await driver.saveCaptureJob({
      version: 1,
      vaultId,
      jobId: id("703"),
      commandId: id("704"),
      tabId: 1,
      state: "Created",
      stage: "Preflight",
      createdAt,
      updatedAt: createdAt,
    });
  } catch {
    captureBlocked = true;
  }
  try {
    await driver.commitRegistration(registration(1));
  } catch {
    registrationBlocked = true;
  }
  try {
    await driver.acquireVacuum(id("705"), createdAt);
  } catch {
    vacuumBlocked = true;
  }
  try {
    await driver.acquireExport({
      version: 1,
      vaultId,
      jobId: id("706"),
      packageId: id("707"),
      state: "Created",
      stage: "Preflight",
      createdAt,
      updatedAt: createdAt,
      completedEntries: 0,
      totalEntries: 0,
      processedBytes: 0,
      totalBytes: 0,
      cancellationRequested: false,
    });
  } catch {
    exportBlocked = true;
  }
  try {
    await vaults.setManualLock(vaultId, true);
  } catch {
    lockBlocked = true;
  }
  await imports.cancel(job.jobId, "2026-07-19T00:02:00.000Z");
  const busyAfterCancellation = await imports.isBusy();
  const result = {
    stage: job.stage,
    busy: await imports.isBusy(),
    secondErrorId,
    captureBlocked,
    registrationBlocked,
    vacuumBlocked,
    exportBlocked,
    lockBlocked,
    busyAfterCancellation,
  };
  await imports.close();
  await vaults.close();
  await driver.deleteDatabase();
  return { ...result, busy: true };
}

async function importJobLifecycleScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const imports = new IndexedDbImportRepository(databaseName);
  const createdAt = "2026-07-19T01:00:00.000Z";
  const first = await imports.begin({
    jobId: id("710"),
    sourceByteLength: 100,
    createdAt,
  });
  await imports.reportAcquired(first.jobId, 60, "2026-07-19T01:00:01.000Z");
  let regressiveProgressErrorId = "";
  let oversizedProgressErrorId = "";
  let prematureStagingErrorId = "";
  try {
    await imports.reportAcquired(first.jobId, 59, "2026-07-19T01:00:02.000Z");
  } catch (error) {
    regressiveProgressErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  try {
    await imports.reportAcquired(first.jobId, 101, "2026-07-19T01:00:02.000Z");
  } catch (error) {
    oversizedProgressErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  try {
    await imports.completeStaging(first.jobId, 60, "2026-07-19T01:00:03.000Z");
  } catch (error) {
    prematureStagingErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  await imports.reportAcquired(first.jobId, 100, "2026-07-19T01:00:04.000Z");
  const authenticate = await imports.completeStaging(first.jobId, 100, "2026-07-19T01:00:05.000Z");
  const retry = await imports.authenticationFailed(first.jobId, "2026-07-19T01:00:06.000Z");
  const running = await imports.authenticationSucceeded(
    first.jobId,
    id("711"),
    "2026-07-19T01:00:07.000Z",
  );
  const prepared = await imports.advance(first.jobId, {
    stage: "Prepare",
    completedEntries: 2,
    totalEntries: 3,
    processedBytes: 40,
    totalBytes: 80,
    updatedAt: "2026-07-19T01:00:08.000Z",
  });
  let regressiveExecutionErrorId = "";
  try {
    await imports.advance(first.jobId, {
      stage: "Prepare",
      completedEntries: 1,
      totalEntries: 3,
      processedBytes: 39,
      totalBytes: 80,
      updatedAt: "2026-07-19T01:00:08.500Z",
    });
  } catch (error) {
    regressiveExecutionErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  const cancelled = await imports.cancel(first.jobId, "2026-07-19T01:00:09.000Z");
  const repeatedCancellation = await imports.cancel(first.jobId, "2026-07-19T01:00:10.000Z");
  const second = await imports.begin({
    jobId: id("712"),
    sourceByteLength: 10,
    createdAt: "2026-07-19T01:00:11.000Z",
  });
  await imports.reportAcquired(second.jobId, 10, "2026-07-19T01:00:12.000Z");
  await imports.completeStaging(second.jobId, 10, "2026-07-19T01:00:13.000Z");
  const reconciled = await imports.reconcileInterrupted("2026-07-19T01:00:14.000Z");
  const interrupted = await imports.latest();
  const result = {
    regressiveProgressErrorId,
    oversizedProgressErrorId,
    prematureStagingErrorId,
    authenticateStage: authenticate.stage,
    retryState: retry.state,
    runningStage: running.stage,
    preparedEntries: prepared.completedEntries,
    regressiveExecutionErrorId,
    cancelledState: cancelled.state,
    repeatedCancellationState: repeatedCancellation.state,
    reconciled,
    interruptedState: interrupted?.state,
    interruptedErrorId: interrupted?.errorId,
    busyAfterInterruption: await imports.isBusy(),
  };
  await imports.close();
  const driver = new IndexedDbDriver(databaseName, id("0"));
  await driver.deleteDatabase();
  return result;
}

async function atomicVaultImportScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  const workspace = await workspaceRepository.bootstrap("2026-07-19T02:00:00.000Z");
  const imports = new IndexedDbImportRepository(databaseName);
  const baseRecords = await makeVaultRecords(720);
  const vaultId = baseRecords.metadata.vaultId;
  const eventId = id("730");
  const objectId = id("731");
  const records: VaultRecordsV1 = {
    ...baseRecords,
    metadata: { ...baseRecords.metadata, manuallyLocked: true },
    head: {
      ...baseRecords.head,
      appendedEventIds: [eventId],
      appendedObjectIds: [objectId],
    },
  };
  const event = {
    version: 1 as const,
    vaultId,
    eventId,
    referencedObjectIds: [objectId],
    orderingTimestamp: "2026-07-19T02:00:00.000Z",
    envelopeBytes: new Uint8Array([1, 2, 3]),
  };
  const storedObject = object(objectId, 9);
  const nameCache = await encryptWorkspaceVaultName({
    key: workspace.nameCacheKey,
    workspaceId: workspace.metadata.workspaceId,
    vaultId,
    sourceEventId: eventId,
    name: "Imported Archive",
  });
  async function runningCommit(jobId: string, minute: string) {
    const job = await imports.begin({
      jobId,
      sourceByteLength: 1,
      createdAt: `2026-07-19T02:${minute}:00.000Z`,
    });
    await imports.reportAcquired(job.jobId, 1, `2026-07-19T02:${minute}:01.000Z`);
    await imports.completeStaging(job.jobId, 1, `2026-07-19T02:${minute}:02.000Z`);
    await imports.authenticationSucceeded(job.jobId, vaultId, `2026-07-19T02:${minute}:03.000Z`);
    return imports.advance(job.jobId, {
      stage: "Commit",
      completedEntries: 0,
      totalEntries: 0,
      processedBytes: 0,
      totalBytes: 0,
      updatedAt: `2026-07-19T02:${minute}:04.000Z`,
    });
  }
  const input = {
    records,
    epochStorage: await prepareVaultEpochStorage(vaultId, [
      {
        keyEpochId: id("727"),
        ordinal: 0,
        rootKey: new Uint8Array(32).fill(6),
      },
      {
        keyEpochId: records.metadata.activeKeyEpochId,
        ordinal: 1,
        rootKey: new Uint8Array(32).fill(7),
      },
    ]),
    events: [event],
    objects: [storedObject],
    libraryProjections: [
      {
        version: 1 as const,
        bundleId: id("733"),
        envelopeBytes: new Uint8Array([4]),
      },
    ],
    collectionProjection: {
      version: 1 as const,
      projectionId: vaultId,
      envelopeBytes: new Uint8Array([5]),
    },
    vaultNameProjection: {
      version: 1 as const,
      vaultId,
      sourceEventId: eventId,
      envelopeBytes: new Uint8Array([6]),
    },
    nameCache,
    preparedArtifactObjectIds: [],
  };
  const first = await runningCommit(id("732"), "01");
  const rollbackVaultRepository = new IndexedDbVaultRepository(databaseName);
  const rollbackResults: boolean[] = [];
  for (let failAt = 1; failAt <= 16; failAt += 1) {
    const originalAdd = IDBObjectStore.prototype.add;
    const originalPut = IDBObjectStore.prototype.put;
    let write = 0;
    const inject = <T extends typeof originalAdd | typeof originalPut>(original: T) =>
      function (this: IDBObjectStore, ...args: Parameters<T>): IDBRequest<IDBValidKey> {
        write += 1;
        if (write === failAt) throw new DOMException("Injected Import write failure", "AbortError");
        return original.apply(this, args) as IDBRequest<IDBValidKey>;
      };
    IDBObjectStore.prototype.add = inject(originalAdd);
    IDBObjectStore.prototype.put = inject(originalPut);
    try {
      await workspaceRepository.commitVaultImport({ job: first, ...input });
    } catch {
      // Every injected request failure must abort the complete activation transaction.
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
      IDBObjectStore.prototype.put = originalPut;
    }
    const rollbackDriver = new IndexedDbDriver(databaseName, vaultId);
    const [after, directory, loaded, latest, events, objects, projections] = await Promise.all([
      workspaceRepository.load(),
      workspaceRepository.listVaultDirectory(),
      rollbackVaultRepository.load(vaultId),
      imports.latest(),
      rollbackDriver.listStoredEvents(),
      rollbackDriver.listStoredObjects(),
      rollbackDriver.listEncryptedProjections(),
    ]);
    rollbackResults.push(
      write === failAt &&
        after?.metadata.activeVaultId === undefined &&
        directory.length === 0 &&
        loaded === undefined &&
        latest?.state === "Running" &&
        events.length === 0 &&
        objects.length === 0 &&
        projections.length === 0,
    );
    await rollbackDriver.close();
  }
  await workspaceRepository.commitVaultImport({ job: first, ...input });
  const firstSucceeded = await imports.latest();
  const driver = new IndexedDbDriver(databaseName, vaultId);
  const state = await new WorkspaceService(workspaceRepository).state({});
  const vaultRepository = new IndexedDbVaultRepository(databaseName);
  const loaded = await vaultRepository.load(vaultId);
  const deviceRepository = new IndexedDbDeviceRepository(databaseName);
  const persistedEpochs = await deviceRepository.loadEpochKeys(vaultId);
  let collisionErrorId = "";
  const second = await runningCommit(id("734"), "02");
  try {
    await workspaceRepository.commitVaultImport({
      job: second,
      ...input,
      libraryProjections: [],
    });
  } catch (error) {
    collisionErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  const result = {
    selectedInEmptyWorkspace: state.activeVaultId === vaultId,
    importedLocked: loaded?.metadata.manuallyLocked,
    eventCount: (await driver.listStoredEvents()).length,
    objectCount: (await driver.listStoredObjects()).length,
    projectionCount: (await driver.listEncryptedProjections()).length,
    jobState: firstSucceeded?.state,
    collisionErrorId,
    directoryCountAfterCollision: (await workspaceRepository.listVaultDirectory()).length,
    persistedEpochOrdinals: persistedEpochs?.map((epoch) => epoch.ordinal),
    persistedHistoricalRootByte: persistedEpochs?.[0]?.rootKey[0],
    persistedActiveRootByte: persistedEpochs?.[1]?.rootKey[0],
    rollbackFailurePoints: rollbackResults.length,
    rollbackAlwaysAtomic: rollbackResults.every(Boolean),
  };
  await imports.close();
  await rollbackVaultRepository.close();
  await vaultRepository.close();
  await deviceRepository.close();
  await workspaceRepository.close();
  await driver.deleteDatabase();
  return result;
}

async function atomicStaleDiscardScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  const workspace = await workspaceRepository.bootstrap("2026-07-19T04:00:00.000Z");
  const staleVaultId = await prepareAndCommitVault(
    databaseName,
    workspaceRepository,
    "Stale source",
    "2026-07-19T04:01:00.000Z",
  );
  const vaultRepository = new IndexedDbVaultRepository(databaseName);
  const originalRecords = await vaultRepository.load(staleVaultId);
  if (originalRecords === undefined) throw new Error("Stale source is unavailable");
  const staleDriver = new IndexedDbDriver(databaseName, staleVaultId);
  const originalEvents = await staleDriver.listStoredEvents();
  const remoteGenerationId = id("850");
  const remoteEventId = id("851");
  const remoteObjectId = id("852");
  const remoteGeneration = {
    version: 1 as const,
    generationId: remoteGenerationId,
    generationNumber: 1,
    predecessorGenerationId: originalRecords.generation.generationId,
    envelopeBytes: new Uint8Array([8, 5, 0]),
  };
  const remoteHead = {
    version: 1 as const,
    vaultId: staleVaultId,
    generationId: remoteGenerationId,
    generationNumber: 1,
    appendedObjectIds: [remoteObjectId],
    appendedEventIds: [remoteEventId],
  };
  const remoteEvent = {
    version: 1 as const,
    vaultId: staleVaultId,
    eventId: remoteEventId,
    referencedObjectIds: [remoteObjectId],
    orderingTimestamp: "2026-07-19T04:02:00.000Z",
    envelopeBytes: new Uint8Array([8, 5, 1]),
  };
  const remoteObject = object(remoteObjectId, 85);
  const remoteNameCache = await encryptWorkspaceVaultName({
    key: workspace.nameCacheKey,
    workspaceId: workspace.metadata.workspaceId,
    vaultId: staleVaultId,
    sourceEventId: remoteEventId,
    name: "Server source",
  });
  const registration = {
    version: 1 as const,
    accountId: id("880"),
    vaultId: staleVaultId,
    activeRecoveryGenerationId: id("881"),
    activeKeyEpochId: id("889"),
    remoteGenerationId,
    remoteGenerationNumber: 1,
    deliveryCursor: 9,
  };
  const job = {
    version: 1 as const,
    jobId: id("882"),
    accountId: registration.accountId,
    vaultId: staleVaultId,
    generationId: remoteGenerationId,
    generationNumber: 1,
    state: "Running" as const,
    stage: "ActivateServerReplacement" as const,
    createdAt: "2026-07-19T04:04:00.000Z",
    updatedAt: "2026-07-19T04:04:00.000Z",
    snapshotCursor: 9,
    completedItems: 0,
    totalItems: 0,
    processedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
    attachIdempotencyKey: id("883"),
  };
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const seed = database.transaction(["vault_sync_state", "synchronization_jobs"], "readwrite");
  seed.objectStore("vault_sync_state").put(registration, "active");
  seed.objectStore("synchronization_jobs").put(job, "active");
  await new Promise<void>((resolve, reject) => {
    seed.addEventListener("complete", () => resolve(), { once: true });
    seed.addEventListener("error", () => reject(seed.error), { once: true });
  });
  database.close();
  const accountRepository = new IndexedDbAccountRepository(databaseName);
  const input = {
    job,
    expectedStaleGenerationId: originalRecords.head.generationId,
    registration,
    originalRecords,
    remoteGeneration,
    remoteHead,
    remoteEvents: [remoteEvent],
    remoteObjects: [remoteObject],
    remoteLibraryProjections: [
      {
        version: 1 as const,
        bundleId: id("853"),
        envelopeBytes: new Uint8Array([8, 5, 3]),
      },
    ],
    remoteCollectionProjection: {
      version: 1 as const,
      projectionId: staleVaultId,
      envelopeBytes: new Uint8Array([8, 5, 4]),
    },
    remoteVaultNameProjection: {
      version: 1 as const,
      vaultId: staleVaultId,
      sourceEventId: remoteEventId,
      envelopeBytes: new Uint8Array([8, 5, 5]),
    },
    remoteNameCache,
  };
  const rollbackResults: boolean[] = [];
  let committedDuringProbe = false;
  for (let failAt = 1; failAt <= 64; failAt += 1) {
    const originalAdd = IDBObjectStore.prototype.add;
    const originalPut = IDBObjectStore.prototype.put;
    let write = 0;
    const inject = <T extends typeof originalAdd | typeof originalPut>(original: T) =>
      function (this: IDBObjectStore, ...args: Parameters<T>): IDBRequest<IDBValidKey> {
        write += 1;
        if (write === failAt) throw new DOMException("Injected recovery failure", "AbortError");
        return original.apply(this, args) as IDBRequest<IDBValidKey>;
      };
    IDBObjectStore.prototype.add = inject(originalAdd);
    IDBObjectStore.prototype.put = inject(originalPut);
    try {
      await workspaceRepository.commitStaleDiscard(input);
      committedDuringProbe = true;
    } catch {
      // Every injected request failure must abort the complete recovery activation.
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
      IDBObjectStore.prototype.put = originalPut;
    }
    if (committedDuringProbe) break;
    const [afterWorkspace, afterOriginal, afterEvents, afterJob] = await Promise.all([
      workspaceRepository.load(),
      vaultRepository.load(staleVaultId),
      staleDriver.listStoredEvents(),
      accountRepository.latestSynchronizationJob(),
    ]);
    rollbackResults.push(
      write === failAt &&
        afterWorkspace?.metadata.activeVaultId === staleVaultId &&
        afterOriginal?.head.generationId === originalRecords.head.generationId &&
        afterEvents.map((event) => event.eventId).join("\n") ===
          originalEvents.map((event) => event.eventId).join("\n") &&
        afterJob?.state === "Running" &&
        afterJob.stage === "ActivateServerReplacement",
    );
  }
  if (!committedDuringProbe) await workspaceRepository.commitStaleDiscard(input);
  const [afterOriginal, finalJob] = await Promise.all([
    vaultRepository.load(staleVaultId),
    accountRepository.latestSynchronizationJob(),
  ]);
  const result = {
    rollbackFailurePoints: rollbackResults.length,
    rollbackAlwaysAtomic: rollbackResults.every(Boolean),
    originalUsesServerGeneration: afterOriginal?.head.generationId === remoteGenerationId,
    originalEventIds: (await staleDriver.listStoredEvents()).map((event) => event.eventId),
    additionalVaultCreated: false,
    jobState: finalJob?.state,
  };
  await staleDriver.close();
  await accountRepository.close();
  await vaultRepository.close();
  await workspaceRepository.close();
  await new IndexedDbDriver(databaseName, staleVaultId).deleteDatabase();
  return result;
}

async function remoteReconciliationFenceScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const workspaceRepository = new IndexedDbWorkspaceRepository(databaseName);
  const workspace = await workspaceRepository.bootstrap("2026-07-20T08:00:00.000Z");
  const vaultId = await prepareAndCommitVault(
    databaseName,
    workspaceRepository,
    "Reconciliation fence",
    "2026-07-20T08:01:00.000Z",
  );
  const driver = new IndexedDbDriver(databaseName, vaultId);
  const [head, events, objects, vaultNameProjection] = await Promise.all([
    driver.getVaultHead(),
    driver.listStoredEvents(),
    driver.listStoredObjects(),
    driver.getVaultNameProjection(),
  ]);
  if (head === undefined || vaultNameProjection === undefined)
    throw new Error("Reconciliation authority is unavailable");
  const registration = {
    version: 1 as const,
    accountId: id("910"),
    vaultId,
    activeRecoveryGenerationId: id("911"),
    activeKeyEpochId: id("919"),
    remoteGenerationId: head.generationId,
    remoteGenerationNumber: head.generationNumber,
    deliveryCursor: 4,
  };
  const job = {
    version: 1 as const,
    jobId: id("912"),
    accountId: registration.accountId,
    vaultId,
    generationId: head.generationId,
    generationNumber: head.generationNumber,
    state: "Running" as const,
    stage: "FetchChanges" as const,
    createdAt: "2026-07-20T08:02:00.000Z",
    updatedAt: "2026-07-20T08:02:00.000Z",
    snapshotCursor: 4,
    completedItems: 0,
    totalItems: 0,
    processedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
    attachIdempotencyKey: id("913"),
  };
  const nameCache = await encryptWorkspaceVaultName({
    key: workspace.nameCacheKey,
    workspaceId: workspace.metadata.workspaceId,
    vaultId,
    sourceEventId: vaultNameProjection.sourceEventId,
    name: "Reconciliation fence",
  });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const installedArtifactId = id("915");
  const retainedRemoteOnlyId = id("916");
  const seed = database.transaction(
    ["vault_sync_state", "synchronization_jobs", "artifact_availability"],
    "readwrite",
  );
  seed.objectStore("vault_sync_state").put(registration, "active");
  seed.objectStore("synchronization_jobs").put(job, "active");
  for (const artifactObjectId of [installedArtifactId, retainedRemoteOnlyId])
    seed.objectStore("artifact_availability").put(
      {
        version: 1,
        vaultId,
        artifactObjectId,
        markedAt: "2026-07-20T08:02:00.000Z",
      },
      [vaultId, artifactObjectId],
    );
  await new Promise<void>((resolve, reject) => {
    seed.addEventListener("complete", () => resolve(), { once: true });
    seed.addEventListener("error", () => reject(seed.error), { once: true });
  });
  const baseInput = {
    expectedGenerationId: head.generationId,
    expectedDeliveryCursor: registration.deliveryCursor,
    expectedLocalHead: head,
    registration: { ...registration, deliveryCursor: 5 },
    job: { ...job, snapshotCursor: 5 },
    events,
    objects,
    libraryProjections: [],
    collectionProjection: {
      version: 1 as const,
      projectionId: vaultId,
      envelopeBytes: new Uint8Array([9, 1, 4]),
    },
    vaultNameProjection,
    nameCache,
    installedArtifactObjectIds: [],
  };
  let omissionErrorId = "";
  try {
    await workspaceRepository.commitRemoteReconciliation({
      ...baseInput,
      head: { ...head, appendedEventIds: [] },
    });
  } catch (error) {
    omissionErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  const appendedEventId = id("914");
  const changedHead = {
    ...head,
    appendedEventIds: [...head.appendedEventIds, appendedEventId].toSorted(),
  };
  const mutate = database.transaction("vault_head", "readwrite");
  mutate.objectStore("vault_head").put(changedHead, vaultSingletonKey(vaultId, "active"));
  await new Promise<void>((resolve, reject) => {
    mutate.addEventListener("complete", () => resolve(), { once: true });
    mutate.addEventListener("error", () => reject(mutate.error), {
      once: true,
    });
  });
  database.close();
  let changedHeadErrorId = "";
  try {
    await workspaceRepository.commitRemoteReconciliation({
      ...baseInput,
      head,
    });
  } catch (error) {
    changedHeadErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  const accountRepository = new IndexedDbAccountRepository(databaseName);
  const [storedHead, storedJob] = await Promise.all([
    driver.getVaultHead(),
    accountRepository.latestSynchronizationJob(),
  ]);
  const resetDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const reset = resetDatabase.transaction("vault_head", "readwrite");
  reset.objectStore("vault_head").put(head, vaultSingletonKey(vaultId, "active"));
  await new Promise<void>((resolve, reject) => {
    reset.addEventListener("complete", () => resolve(), { once: true });
    reset.addEventListener("error", () => reject(reset.error), { once: true });
  });
  resetDatabase.close();
  await workspaceRepository.commitRemoteReconciliation({
    ...baseInput,
    head,
    installedArtifactObjectIds: [installedArtifactId],
  });
  const availabilityRepository = new IndexedDbStorageReliefRepository(databaseName);
  const availability = await availabilityRepository.listRemoteOnlyArtifacts(vaultId);
  const result = {
    omissionErrorId,
    changedHeadErrorId,
    localMutationPreserved: storedHead?.appendedEventIds.includes(appendedEventId),
    jobStillRunning: storedJob?.state === "Running" && storedJob.snapshotCursor === 4,
    retainedRemoteOnlyIds: availability.map((value) => value.artifactObjectId),
  };
  await availabilityRepository.close();
  await accountRepository.close();
  await workspaceRepository.close();
  await driver.deleteDatabase();
  return result;
}

async function staleDiscardRestartScenario(): Promise<unknown> {
  const stages = ["PrepareServerReplacement", "ActivateServerReplacement"] as const;
  const results: Record<string, unknown> = {};
  for (const [index, stage] of stages.entries()) {
    const databaseName = `awsm-integration-${crypto.randomUUID()}`;
    const repository = new IndexedDbAccountRepository(databaseName);
    const preparedArtifactObjectId = id(String(930 + index));
    await repository.saveSynchronizationJob({
      version: 1,
      jobId: id(String(920 + index)),
      accountId: id("925"),
      vaultId: id("926"),
      generationId: id("927"),
      generationNumber: 1,
      state: "Running",
      stage,
      createdAt: "2026-07-20T09:00:00.000Z",
      updatedAt: "2026-07-20T09:00:00.000Z",
      snapshotCursor: 7,
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: id("928"),
      preparedArtifactObjectIds: [preparedArtifactObjectId],
    });
    await repository.close();
    const reopened = new IndexedDbAccountRepository(databaseName);
    const reconciledArtifacts: string[] = [];
    const reconciler = new InterruptedStaleDiscardReconciler(reopened, {
      remove: async (_vaultId, objectId) => {
        reconciledArtifacts.push(objectId);
      },
    });
    const reconciled = await reconciler.execute("2026-07-20T09:01:00.000Z");
    const job = await reopened.latestSynchronizationJob();
    results[stage] = {
      reconciled,
      state: job?.state,
      stage: job?.stage,
      preparedIdsCleared: job?.preparedArtifactObjectIds === undefined,
      artifactsRemoved: reconciledArtifacts.includes(preparedArtifactObjectId),
    };
    await reopened.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.addEventListener("success", () => resolve(), { once: true });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
  }
  return results;
}

async function artifactStoreScenario(): Promise<unknown> {
  const store = new OpfsArtifactStore();
  const vaultId = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  const rootKey = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const plaintext = new TextEncoder().encode("known plaintext artifact");
  async function* source(): AsyncGenerator<Uint8Array> {
    yield plaintext.subarray(0, 3);
    yield plaintext.subarray(3);
  }
  const prepared = await store.prepare({
    vaultId,
    objectId,
    keyring: testKeyring(rootKey),
    plaintext: source(),
    noncePrefix: new Uint8Array(16).fill(7),
  });
  const encryptedReader = (await store.openEncrypted(vaultId, objectId)).getReader();
  const encryptedParts: Uint8Array[] = [];
  while (true) {
    const next = await encryptedReader.read();
    if (next.done) break;
    encryptedParts.push(next.value);
  }
  const encryptedText = new TextDecoder().decode(
    Uint8Array.from(encryptedParts.flatMap((value) => [...value])),
  );
  const encryptedBytes = Uint8Array.from(encryptedParts.flatMap((value) => [...value]));
  const wrapperPresent = await store.has(vaultId, objectId);
  const wrapperVerified = await store.verifyEncrypted(vaultId, prepared.object);
  const importedVaultId = crypto.randomUUID();
  await store.prepareEncrypted({
    vaultId: importedVaultId,
    object: prepared.object,
    encrypted: new Blob([encryptedBytes.buffer]).stream(),
  });
  await store.prepareEncrypted({
    vaultId: importedVaultId,
    object: prepared.object,
    encrypted: new Blob([encryptedBytes.buffer]).stream(),
  });
  const importedEncrypted = new Uint8Array(
    await new Response(await store.openEncrypted(importedVaultId, objectId)).arrayBuffer(),
  );
  const encryptedImportCopiedExactly =
    importedEncrypted.length === encryptedBytes.length &&
    importedEncrypted.every((byte, index) => byte === encryptedBytes[index]);
  let corruptEncryptedImportRejected = false;
  const corruptVaultId = crypto.randomUUID();
  try {
    await store.prepareEncrypted({
      vaultId: corruptVaultId,
      object: prepared.object,
      encrypted: new Blob([Uint8Array.from(encryptedBytes.subarray(1)).buffer]).stream(),
    });
  } catch {
    corruptEncryptedImportRejected = true;
  }
  const quotaVaultId = crypto.randomUUID();
  let quotaErrorId = "";
  let quotaArtifactRemoved = false;
  const originalCreateWritable = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = () =>
    Promise.reject(new DOMException("Injected quota failure", "QuotaExceededError"));
  try {
    await store.prepareEncrypted({
      vaultId: quotaVaultId,
      object: prepared.object,
      encrypted: new Blob([encryptedBytes.buffer]).stream(),
    });
  } catch (error) {
    quotaErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  } finally {
    FileSystemFileHandle.prototype.createWritable = originalCreateWritable;
  }
  try {
    await store.openEncrypted(quotaVaultId, objectId);
  } catch {
    quotaArtifactRemoved = true;
  }
  const plaintextReader = (
    await store.openPlaintext({
      vaultId,
      object: prepared.object,
      reference: {
        artifactVersion: 1,
        artifactObjectId: objectId,
        kind: "CAPTURE",
        role: "PRIMARY",
        mimeType: "application/vnd.awsm.web-page+zip",
        acquiredAt: "2026-07-18T00:00:00.000Z",
        plaintextByteLength: prepared.plaintextByteLength,
        checksumAlgorithm: "hash:sha256:v1",
        plaintextChecksum: prepared.plaintextChecksum,
      },
      keyring: testKeyring(rootKey),
    })
  ).getReader();
  const recovered: Uint8Array[] = [];
  while (true) {
    const next = await plaintextReader.read();
    if (next.done) break;
    recovered.push(next.value);
  }
  let collisionRejected = false;
  try {
    await store.prepare({
      vaultId,
      objectId,
      keyring: testKeyring(rootKey),
      plaintext: source(),
    });
  } catch {
    collisionRejected = true;
  }
  await store.reconcile(vaultId, new Set());
  const wrapperAbsentAfterRemoval = !(await store.has(vaultId, objectId));
  let orphanRemoved = false;
  try {
    await store.openEncrypted(vaultId, objectId);
  } catch {
    orphanRemoved = true;
  }
  return {
    objectType: prepared.object.objectType,
    rootKeyExtractable: rootKey.extractable,
    ciphertextExcludesPlaintext: !encryptedText.includes("known plaintext artifact"),
    recovered: new TextDecoder().decode(Uint8Array.from(recovered.flatMap((value) => [...value]))),
    collisionRejected,
    orphanRemoved,
    encryptedImportCopiedExactly,
    encryptedImportReplaySucceeded: true,
    corruptEncryptedImportRejected,
    wrapperPresent,
    wrapperVerified,
    wrapperAbsentAfterRemoval,
    quotaErrorId,
    quotaArtifactRemoved,
  };
}

async function importSourceStagingScenario(): Promise<unknown> {
  const host = new VaultImportHost();
  const jobId = crypto.randomUUID();
  const source = new Uint8Array(700_000);
  for (let offset = 0; offset < source.byteLength; offset += 65_536) {
    crypto.getRandomValues(source.subarray(offset, Math.min(offset + 65_536, source.byteLength)));
  }
  const progress: number[] = [];
  await host.stage({
    jobId,
    source: new Blob([source.buffer]),
    onProgress: (acquiredBytes) => {
      progress.push(acquiredBytes);
    },
  });
  const stored = new Uint8Array(await (await host.open(jobId)).arrayBuffer());
  const progressMonotonic = progress.every(
    (value, index) => index === 0 || value >= (progress[index - 1] ?? 0),
  );
  const result = {
    storedBytes: stored.byteLength,
    finalProgress: progress.at(-1),
    progressMonotonic,
    bytesMatch: stored.every((byte, index) => byte === source[index]),
    cleanupRemoved: false,
  };
  await host.cleanup(jobId);
  try {
    await host.open(jobId);
  } catch {
    result.cleanupRemoved = true;
  }
  const quotaJobId = crypto.randomUUID();
  let quotaErrorId = "";
  let quotaSourceRemoved = false;
  const originalCreateWritable = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = () =>
    Promise.reject(new DOMException("Injected quota failure", "QuotaExceededError"));
  try {
    await host.stage({
      jobId: quotaJobId,
      source: new Blob([new Uint8Array([1]).buffer]),
      onProgress: () => undefined,
    });
  } catch (error) {
    quotaErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  } finally {
    FileSystemFileHandle.prototype.createWritable = originalCreateWritable;
  }
  try {
    await host.open(quotaJobId);
  } catch {
    quotaSourceRemoved = true;
  }
  return { ...result, quotaErrorId, quotaSourceRemoved };
}

async function storageReliefSchemaScenario(): Promise<unknown> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const driver = new IndexedDbDriver(databaseName, id("990"));
  await driver.counts();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const result = {
    databaseVersion: database.version,
    stores: Array.from(database.objectStoreNames).filter(
      (name) => name === "artifact_availability" || name.startsWith("storage_relief_"),
    ),
  };
  database.close();
  await driver.close();
  return result;
}

async function uiPreferencesScenario(): Promise<unknown> {
  const databaseName = `awsm-ui-preferences-${crypto.randomUUID()}`;
  const repository = new UiPreferencesRepository(databaseName);
  const defaults = await repository.getLibraryPreferences();
  await repository.replaceLibraryPreferences({
    version: 1,
    sort: "TitleAscending",
    view: "List",
  });
  const restored = await new UiPreferencesRepository(databaseName).getLibraryPreferences();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const transaction = database.transaction("ui_preferences", "readonly");
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = transaction.objectStore("ui_preferences").getAllKeys();
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const result = {
    databaseVersion: database.version,
    storePresent: database.objectStoreNames.contains("ui_preferences"),
    defaults,
    restored,
    keys,
  };
  database.close();
  return result;
}

async function searchKeywordPersistenceScenario(): Promise<unknown> {
  const databaseName = `awsm-search-${crypto.randomUUID()}`;
  const repository = new IndexedDbSearchRepository(databaseName);
  const vaultId = id("960");
  const bundleId = id("961");
  const keywordRow = buildKeywordRow(
    await buildSearchDocument({
      vaultId,
      bundleId,
      collectionId: id("962"),
      collectionTitle: "Research",
      status: "Active",
      title: "Private Search",
      canonicalUrl: "https://example.test/search",
      knownUrls: ["https://example.test/search"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: id("963"),
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: "Find the right Capture passage." },
    }),
  );
  const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "HKDF", false, [
    "deriveBits",
  ]);
  const keyring = testKeyring(rootKey);
  await repository.saveKeywordRow(keyring, keywordRow);
  const lookupKey = await deriveSearchKeywordLookupKey(keyring, vaultId);
  const termEntry = (await keywordPostingEntries(lookupKey, keywordRow)).find(
    ({ namespace, value }) => namespace === "term" && value === "private",
  );
  if (termEntry === undefined) throw new Error("Expected private Search posting.");
  await repository.saveKeywordPosting(keyring, vaultId, {
    namespace: termEntry.namespace,
    opaqueMac: termEntry.opaqueMac,
    Active: [bundleId],
    Deleted: [],
  });
  const postingCandidates = (
    await repository.loadKeywordPostings(keyring, vaultId, [termEntry.opaqueMac])
  ).flatMap(({ Active }) => Active);
  const reopenedRepository = new IndexedDbSearchRepository(databaseName);
  const restored = await reopenedRepository.loadKeywordRow(keyring, vaultId, bundleId);
  await reopenedRepository.close();

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const read = database.transaction("search_keyword_rows", "readonly");
  const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = read.objectStore("search_keyword_rows").get([vaultId, bundleId]);
    request.addEventListener("success", () => resolve(request.result as Record<string, unknown>), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const ciphertextContainsPlaintext = new TextDecoder()
    .decode(stored.ciphertext as Uint8Array)
    .includes("Private Search");
  const write = database.transaction("search_keyword_rows", "readwrite");
  write
    .objectStore("search_keyword_rows")
    .put({ ...stored, sourceRevision: "ff".repeat(32) }, [vaultId, bundleId]);
  await new Promise<void>((resolve, reject) => {
    write.addEventListener("complete", () => resolve(), { once: true });
    write.addEventListener("error", () => reject(write.error), { once: true });
  });
  let tamperingRejected = false;
  try {
    await repository.loadKeywordRow(keyring, vaultId, bundleId);
  } catch {
    tamperingRejected = true;
  }
  const searchStoreCount = Array.from(database.objectStoreNames).filter((name) =>
    name.startsWith("search_"),
  ).length;
  database.close();
  await repository.deleteDatabase();
  return {
    restoredTitle: restored?.document.title,
    ciphertextContainsPlaintext,
    tamperingRejected,
    postingCandidates,
    searchStoreCount,
  };
}

async function searchKeywordAtomicCommitScenario(): Promise<unknown> {
  const databaseName = `awsm-search-atomic-${crypto.randomUUID()}`;
  const repository = new IndexedDbSearchRepository(databaseName);
  const vaultId = id("949");
  const generationId = id("950");
  const bundleId = id("951");
  const jobId = id("952");
  const initialStatistics = createKeywordStatistics(generationId);
  const initialJob = {
    version: 1,
    jobId,
    vaultId,
    state: "Created",
    stage: "Keyword",
    projectionGeneration: projectionGeneration(initialStatistics),
    completedCaptures: 0,
    totalCaptures: 1,
    failedCaptures: 0,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  } as const;
  const pendingCheckpoint = {
    version: 1,
    vaultId,
    jobId,
    bundleId,
    sourceRevision: "00".repeat(32),
    keywordState: "Pending",
    semanticState: "NotConfigured",
    attemptCount: 0,
    updatedAt: "2026-07-26T00:00:00.000Z",
  } as const;
  const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(9), "HKDF", false, [
    "deriveBits",
  ]);
  const keyring = testKeyring(rootKey);
  await repository.createKeywordGeneration({
    keyring,
    vaultId,
    statistics: initialStatistics,
    job: initialJob,
    checkpoints: [pendingCheckpoint],
  });
  const keywordRow = buildKeywordRow(
    await buildSearchDocument({
      vaultId,
      bundleId,
      collectionId: id("953"),
      collectionTitle: "Research",
      status: "Active",
      title: "Private Search",
      canonicalUrl: "https://example.test/search",
      knownUrls: ["https://example.test/search"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: id("954"),
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: "Private local Search passage." },
    }),
  );
  const committedCheckpoint = {
    ...pendingCheckpoint,
    sourceRevision: keywordRow.document.sourceRevision,
    keywordState: "Committed",
    attemptCount: 1,
    updatedAt: "2026-07-26T00:00:01.000Z",
  } as const;
  const committedJob = {
    ...initialJob,
    state: "Running",
    projectionGeneration: `${generationId}:1`,
    completedCaptures: 1,
    updatedAt: "2026-07-26T00:00:01.000Z",
    leaseOwner: "library-instance",
    leaseExpiresAt: "2026-07-26T00:00:31.000Z",
  } as const;
  await repository.commitKeywordCapture({
    keyring,
    row: keywordRow,
    expectedProjectionGeneration: `${generationId}:0`,
    job: committedJob,
    checkpoint: committedCheckpoint,
  });
  const statistics = await repository.loadKeywordStatistics(keyring, vaultId);
  const job = await repository.loadSearchIndexJob(vaultId, jobId);
  const checkpoint = await repository.loadSearchIndexCheckpoint(vaultId, jobId, bundleId);
  const lookupKey = await deriveSearchKeywordLookupKey(keyring, vaultId);
  const privateEntry = (await keywordPostingEntries(lookupKey, keywordRow)).find(
    ({ namespace, value }) => namespace === "term" && value === "private",
  );
  if (privateEntry === undefined) throw new Error("Expected private Search posting.");
  const privatePostingCandidates = (
    await repository.loadKeywordPostings(keyring, vaultId, [privateEntry.opaqueMac])
  ).flatMap(({ Active }) => Active);
  const queryCandidateIds = (
    await repository.keywordCandidateBundleIds(
      keyring,
      vaultId,
      parseSearchQuery('"private local" Search'),
      "Active",
    )
  ).ordinary;
  let staleConcurrentCommitRejected = false;
  try {
    await repository.commitKeywordCapture({
      keyring,
      row: keywordRow,
      expectedProjectionGeneration: `${generationId}:0`,
      job: committedJob,
      checkpoint: committedCheckpoint,
    });
  } catch {
    staleConcurrentCommitRejected = true;
  }
  const coordinator = new SearchCoordinator({
    repository,
    providerFor: async () => {
      throw new Error("Semantic provider must not be loaded.");
    },
  });
  const searchPage = await coordinator.search({
    keyring,
    vaultId,
    vaultGeneration: generationId,
    clientInstanceId: "AAAAAAAAAAAAAAAAAAAAAA",
    query: '"private local" Search',
    filters: { scope: "Active", hosts: [], collectionIds: [] },
    signal: new AbortController().signal,
  });
  const result = {
    projectionGeneration: statistics === undefined ? undefined : projectionGeneration(statistics),
    completedCaptures: job?.completedCaptures,
    checkpointState: checkpoint?.keywordState,
    privatePostingCandidates,
    queryCandidateIds,
    activeDocumentCount: statistics?.Active.documentCount,
    staleConcurrentCommitRejected,
    coordinatorResult: searchPage.results.map(({ bundleId: resultBundleId, match, snippet }) => ({
      bundleId: resultBundleId,
      match,
      snippet,
    })),
    semanticState: searchPage.semantic.state,
  };
  await repository.deleteDatabase();
  return result;
}

async function searchSemanticAtomicCommitScenario(): Promise<unknown> {
  const databaseName = `awsm-search-semantic-${crypto.randomUUID()}`;
  const repository = new IndexedDbSearchRepository(databaseName);
  const vaultId = id("970");
  const generationId = id("971");
  const bundleId = id("972");
  const jobId = id("973");
  const provider = {
    version: 1,
    kind: "LocalMiniLm",
    model: "Xenova/all-MiniLM-L6-v2",
    modelRevision: "fixture-revision",
    dimensions: 2,
    pooling: "Mean",
    normalized: true,
  } as const;
  const identityHash = await providerIdentityHash(provider);
  const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(11), "HKDF", false, [
    "deriveBits",
  ]);
  const keyring = testKeyring(rootKey);
  await repository.saveSearchSettings(
    keyring,
    vaultId,
    {
      version: 1,
      semantic: "Local",
      provider,
      disclosureVersion: 1,
    },
    { localManifestId: "fixture-manifest" },
  );
  const modelReferencesAfterConfigure =
    await repository.countSearchModelReferences("fixture-manifest");
  await repository.saveSearchSettings(
    keyring,
    vaultId,
    {
      version: 1,
      semantic: "Local",
      provider,
      disclosureVersion: 1,
    },
    { localManifestId: "fixture-manifest" },
  );
  const modelReferencesAfterRepeatedConfigure =
    await repository.countSearchModelReferences("fixture-manifest");
  const keywordRow = buildKeywordRow(
    await buildSearchDocument({
      vaultId,
      bundleId,
      collectionId: id("974"),
      collectionTitle: "Research",
      status: "Active",
      title: "Semantic Search",
      canonicalUrl: "https://example.test/semantic",
      knownUrls: ["https://example.test/semantic"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: id("975"),
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: "The best matching passage is here." },
    }),
  );
  const statistics = createKeywordStatistics(generationId);
  const createdJob = {
    version: 1,
    jobId,
    vaultId,
    state: "Created",
    stage: "Keyword",
    projectionGeneration: projectionGeneration(statistics),
    providerIdentityHash: identityHash,
    completedCaptures: 0,
    totalCaptures: 1,
    failedCaptures: 0,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  } as const;
  const pending = {
    version: 1,
    vaultId,
    jobId,
    bundleId,
    sourceRevision: keywordRow.document.sourceRevision,
    keywordState: "Pending",
    semanticState: "Pending",
    attemptCount: 0,
    updatedAt: "2026-07-26T00:00:00.000Z",
  } as const;
  await repository.createKeywordGeneration({
    keyring,
    vaultId,
    statistics,
    job: createdJob,
    checkpoints: [pending],
  });
  const keywordCheckpoint = {
    ...pending,
    keywordState: "Committed",
    attemptCount: 1,
    updatedAt: "2026-07-26T00:00:01.000Z",
  } as const;
  const semanticJob = {
    ...createdJob,
    state: "Running",
    stage: "Semantic",
    projectionGeneration: `${generationId}:1`,
    updatedAt: "2026-07-26T00:00:01.000Z",
    leaseOwner: "library-instance",
    leaseExpiresAt: "2026-07-26T00:00:31.000Z",
  } as const;
  await repository.commitKeywordCapture({
    keyring,
    row: keywordRow,
    expectedProjectionGeneration: `${generationId}:0`,
    job: semanticJob,
    checkpoint: keywordCheckpoint,
  });
  const semantic = buildSemanticMaterializations({
    document: keywordRow.document,
    providerIdentityHash: identityHash,
    embeddings: keywordRow.document.passages.map((passage, passageOrdinal) => ({
      passageId: passage.passageId,
      passageOrdinal,
      vector: normalizeEmbedding([passageOrdinal + 1, 1]),
    })),
  });
  const committedCheckpoint = {
    ...keywordCheckpoint,
    semanticState: "Committed",
    attemptCount: 2,
    updatedAt: "2026-07-26T00:00:02.000Z",
  } as const;
  const committedJob = {
    ...semanticJob,
    completedCaptures: 1,
    updatedAt: "2026-07-26T00:00:02.000Z",
    leaseExpiresAt: "2026-07-26T00:00:32.000Z",
  } as const;
  await repository.commitSemanticCapture({
    keyring,
    ...semantic,
    job: committedJob,
    checkpoint: committedCheckpoint,
  });
  const restoredCapture = await repository.loadSemanticCapture(keyring, vaultId, bundleId);
  const restoredPassages = await repository.loadSemanticPassages(keyring, vaultId, bundleId);
  const scanned: string[] = [];
  await repository.scanSemanticCaptures(
    keyring,
    vaultId,
    async (batch) => {
      scanned.push(...batch.map(({ bundleId: candidate }) => candidate));
    },
    1,
  );
  let staleRejected = false;
  try {
    await repository.commitSemanticCapture({
      keyring,
      ...semantic,
      job: committedJob,
      checkpoint: committedCheckpoint,
    });
  } catch {
    staleRejected = true;
  }
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const transaction = database.transaction("search_semantic_rows", "readonly");
  const stored = (await new Promise<unknown>((resolve, reject) => {
    const request = transaction.objectStore("search_semantic_rows").get([vaultId, bundleId]);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  })) as { ciphertext: Uint8Array };
  const ciphertextText = new TextDecoder().decode(stored.ciphertext);
  database.close();
  const result = {
    restoredBundleId: restoredCapture?.bundleId,
    passageCount: restoredPassages?.passages.length,
    providerIdentityHash: restoredCapture?.providerIdentityHash,
    scanned,
    ciphertextContainsTitle: ciphertextText.includes("Semantic Search"),
    checkpointState: (await repository.loadSearchIndexCheckpoint(vaultId, jobId, bundleId))
      ?.semanticState,
    staleRejected,
    modelReferencesAfterConfigure,
    modelReferencesAfterRepeatedConfigure,
  };
  await repository.saveSearchSettings(keyring, vaultId, { version: 1, semantic: "Disabled" });
  const indexedVaultGeneration = `${id("979")}:12`;
  await repository.saveIndexedVaultGeneration(vaultId, indexedVaultGeneration);
  Object.assign(result, {
    semanticCleared:
      (await repository.loadSemanticCapture(keyring, vaultId, bundleId)) === undefined &&
      (await repository.loadSemanticPassages(keyring, vaultId, bundleId)) === undefined,
    modelReferencesAfterDisable: await repository.countSearchModelReferences("fixture-manifest"),
    indexedVaultGeneration: await repository.loadIndexedVaultGeneration(vaultId),
  });
  const remoteEndpoint = "https://embeddings.example.test/v1/embeddings?route=private";
  const remoteSettings = {
    version: 1,
    semantic: "Remote",
    provider: {
      version: 1,
      kind: "RemoteOpenAiCompatible",
      endpointOrigin: "https://embeddings.example.test",
      endpointPathHash: remoteSearchEndpointPathHash(remoteEndpoint),
      model: "resolved-model",
      dimensions: 2,
      pooling: "Mean",
      normalized: true,
    },
    endpoint: remoteEndpoint,
    protectedCredentialId: "search-fixture-credential",
    disclosureVersion: 1,
  } as const;
  await repository.saveSearchSettings(keyring, vaultId, remoteSettings, {
    remoteApiKey: new TextEncoder().encode("fixture-api-key"),
  });
  Object.assign(result, {
    remoteCredential: new TextDecoder().decode(
      await repository.loadRemoteSearchApiKey(vaultId, remoteSettings),
    ),
  });
  await repository.saveSearchSettings(keyring, vaultId, { version: 1, semantic: "Disabled" });
  let remoteCredentialDeleted = false;
  try {
    await repository.loadRemoteSearchApiKey(vaultId, remoteSettings);
  } catch {
    remoteCredentialDeleted = true;
  }
  Object.assign(result, { remoteCredentialDeleted });
  await repository.deleteDatabase();
  return result;
}

async function searchIndexLeaseScenario(): Promise<unknown> {
  const databaseName = `awsm-search-lease-${crypto.randomUUID()}`;
  const repository = new IndexedDbSearchRepository(databaseName);
  const vaultId = id("940");
  const generationId = id("941");
  const jobId = id("942");
  const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(11), "HKDF", false, [
    "deriveBits",
  ]);
  const keyring = testKeyring(rootKey);
  const statistics = createKeywordStatistics(generationId);
  await repository.createKeywordGeneration({
    keyring,
    vaultId,
    statistics,
    job: {
      version: 1,
      jobId,
      vaultId,
      state: "Created",
      stage: "Discover",
      projectionGeneration: projectionGeneration(statistics),
      completedCaptures: 0,
      totalCaptures: 0,
      failedCaptures: 0,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
    checkpoints: [],
  });
  const first = await repository.claimSearchIndexLease(
    vaultId,
    jobId,
    "library-a",
    "2026-07-26T00:00:01.000Z",
  );
  const competingRepository = new IndexedDbSearchRepository(databaseName);
  const contention = await competingRepository.claimSearchIndexLease(
    vaultId,
    jobId,
    "library-b",
    "2026-07-26T00:00:30.999Z",
  );
  await competingRepository.close();
  const takeover = await repository.claimSearchIndexLease(
    vaultId,
    jobId,
    "library-b",
    "2026-07-26T00:00:31.000Z",
  );
  const renewed = await repository.renewSearchIndexLease(
    vaultId,
    jobId,
    "library-b",
    "2026-07-26T00:00:40.000Z",
  );
  const waiting = await repository.releaseSearchIndexLease(
    vaultId,
    jobId,
    "library-b",
    "WaitingForLibrary",
    "2026-07-26T00:00:41.000Z",
  );
  const result = {
    firstOwner: first?.leaseOwner,
    contentionRejected: contention === undefined,
    takeoverOwner: takeover?.leaseOwner,
    renewedUntil: renewed.leaseExpiresAt,
    waitingState: waiting.state,
    leaseCleared: waiting.leaseOwner === undefined && waiting.leaseExpiresAt === undefined,
  };
  await repository.deleteDatabase();
  return result;
}

async function searchIndexFailureResumeScenario(): Promise<unknown> {
  const databaseName = `awsm-search-failure-${crypto.randomUUID()}`;
  const repository = new IndexedDbSearchRepository(databaseName);
  const vaultId = id("925");
  const bundleId = id("926");
  const jobId = id("927");
  const generationId = id("928");
  const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(17), "HKDF", false, [
    "deriveBits",
  ]);
  const keyring = testKeyring(rootKey);
  const statistics = createKeywordStatistics(generationId);
  await repository.createKeywordGeneration({
    keyring,
    vaultId,
    statistics,
    job: {
      version: 1,
      jobId,
      vaultId,
      state: "Created",
      stage: "Keyword",
      projectionGeneration: projectionGeneration(statistics),
      completedCaptures: 0,
      totalCaptures: 1,
      failedCaptures: 0,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
    checkpoints: [
      {
        version: 1,
        vaultId,
        jobId,
        bundleId,
        sourceRevision: "cd".repeat(32),
        keywordState: "Pending",
        semanticState: "NotConfigured",
        attemptCount: 0,
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  });
  await repository.claimSearchIndexLease(vaultId, jobId, "library-a", "2026-07-26T00:00:01.000Z");
  const failed = await repository.failSearchIndexCapture({
    vaultId,
    jobId,
    bundleId,
    owner: "library-a",
    stage: "Keyword",
    errorId: "SEARCH_PROVIDER_UNAVAILABLE",
    now: "2026-07-26T00:00:02.000Z",
    retryAt: "2026-07-26T00:05:02.000Z",
  });
  const failedCheckpoint = await repository.loadSearchIndexCheckpoint(vaultId, jobId, bundleId);
  const resumed = await repository.resumeLatestSearchIndexJob(vaultId, "2026-07-26T00:00:03.000Z");
  const resumedCheckpoint = await repository.loadSearchIndexCheckpoint(vaultId, jobId, bundleId);
  const result = {
    failedState: failed.state,
    failedCaptures: failed.failedCaptures,
    retryAt: failed.retryAt,
    failedCheckpointState: failedCheckpoint?.keywordState,
    failedAttemptCount: failedCheckpoint?.attemptCount,
    failedCheckpointError: failedCheckpoint?.errorId,
    resumedState: resumed.state,
    resumedFailedCaptures: resumed.failedCaptures,
    resumedCheckpointState: resumedCheckpoint?.keywordState,
    resumedCheckpointError: resumedCheckpoint?.errorId,
  };
  await repository.deleteDatabase();
  return result;
}

async function searchKeywordIndexerScenario(): Promise<unknown> {
  const databaseName = `awsm-search-indexer-${crypto.randomUUID()}`;
  const repository = new IndexedDbSearchRepository(databaseName);
  const vaultId = id("930");
  const bundleId = id("931");
  const jobId = id("932");
  const generationId = id("933");
  const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(13), "HKDF", false, [
    "deriveBits",
  ]);
  const keyring = testKeyring(rootKey);
  const row = buildKeywordRow(
    await buildSearchDocument({
      vaultId,
      bundleId,
      collectionId: id("934"),
      collectionTitle: "Research",
      status: "Active",
      title: "Private Search",
      canonicalUrl: "https://example.test/search",
      knownUrls: ["https://example.test/search"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: id("935"),
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: "Private local Search passage." },
    }),
  );
  const statistics = createKeywordStatistics(generationId);
  await repository.createKeywordGeneration({
    keyring,
    vaultId,
    statistics,
    job: {
      version: 1,
      jobId,
      vaultId,
      state: "Created",
      stage: "Keyword",
      projectionGeneration: projectionGeneration(statistics),
      completedCaptures: 0,
      totalCaptures: 1,
      failedCaptures: 0,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
    checkpoints: [
      {
        version: 1,
        vaultId,
        jobId,
        bundleId,
        sourceRevision: row.document.sourceRevision,
        keywordState: "Pending",
        semanticState: "NotConfigured",
        attemptCount: 0,
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  });
  let invalidations = 0;
  const indexer = new SearchKeywordIndexer({
    repository,
    source: {
      loadKeywordRow: async (_vaultId, _bundleId, signal) => {
        signal.throwIfAborted();
        return row;
      },
    },
    gate: async () => ({
      connected: true,
      visible: true,
      expectedVaultActive: true,
      unlocked: true,
      paused: false,
      permissionPresent: true,
      online: true,
    }),
    now: () => "2026-07-26T00:00:01.000Z",
    onCommitted: async () => {
      invalidations += 1;
    },
  });
  const result = await indexer.run({
    vaultId,
    jobId,
    owner: "library-instance",
    keyring,
    signal: new AbortController().signal,
  });
  const checkpoint = await repository.loadSearchIndexCheckpoint(vaultId, jobId, bundleId);
  const indexed = await repository.loadKeywordRow(keyring, vaultId, bundleId);
  const output = {
    state: result.state,
    completedCaptures: result.completedCaptures,
    checkpointState: checkpoint?.keywordState,
    indexedTitle: indexed?.document.title,
    invalidations,
  };
  await repository.deleteDatabase();
  return output;
}

async function searchLocalModelCacheScenario(): Promise<unknown> {
  const manifest = {
    manifestId: "fixture-manifest",
    model: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    dtype: "int8",
    dimensions: 384,
    maximumWordpieces: 256,
    pooling: "Mean",
    normalization: "L2",
    language: "English",
    license: "Apache-2.0",
    totalBytes: 3,
    files: [
      {
        path: "config.json",
        bytes: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
    ],
  } satisfies LocalMiniLmManifest;
  const response = (body: string): Response => {
    const value = new Response(body, {
      headers: {
        "content-length": String(body.length),
        "content-type": "application/octet-stream",
      },
    });
    Object.defineProperty(value, "url", {
      value: "https://cdn-lfs.hf.co/fixture",
    });
    return value;
  };
  const store = new CacheStorageLocalModelStore();
  await store.deleteCurrent();
  await new LocalModelDownloader({
    store,
    manifest,
    fetcher: async () => response("abc"),
    createGenerationId: () => "browser-valid",
  }).download({
    signal: new AbortController().signal,
    onProgress: () => undefined,
  });
  const pointerBefore = await store.current();
  const ready = await store.isReady(manifest);
  const cachedText = await (await store.file("config.json"))?.text();
  let corruptPromotionRejected = false;
  try {
    await new LocalModelDownloader({
      store,
      manifest,
      fetcher: async () => response("abd"),
      createGenerationId: () => "browser-corrupt",
    }).download({
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
  } catch {
    corruptPromotionRejected = true;
  }
  const pointerAfter = await store.current();
  await store.deleteCurrent();
  const removed = !(await store.isReady(manifest));
  const cacheNamesAfterRemoval = await caches.keys();
  return {
    ready,
    cachedText,
    pointerManifest: pointerBefore?.manifestId,
    corruptPromotionRejected,
    pointerUnchanged: pointerBefore?.generationName === pointerAfter?.generationName,
    removed,
    cacheNamesAfterRemoval,
  };
}

async function storageReliefPersistenceScenario(): Promise<unknown> {
  const databaseName = `awsm-storage-relief-${crypto.randomUUID()}`;
  const repository = new IndexedDbStorageReliefRepository(databaseName);
  const vaultId = id("970");
  const jobId = id("971");
  const artifactObjectId = id("972");
  const generationId = id("973");
  const accountId = id("974");
  const head = {
    version: 1,
    vaultId,
    generationId,
    generationNumber: 4,
    appendedObjectIds: [],
    appendedEventIds: [],
  } as const;
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const seed = database.transaction("vault_head", "readwrite");
  seed.objectStore("vault_head").put(head, vaultSingletonKey(vaultId, "active"));
  await new Promise<void>((resolve, reject) => {
    seed.addEventListener("complete", () => resolve(), { once: true });
    seed.addEventListener("error", () => reject(seed.error), { once: true });
  });
  database.close();
  const candidate = {
    version: 1,
    vaultId,
    jobId,
    artifactObjectId,
    keyEpochId: TEST_KEY_EPOCH_ID,
    envelopeByteLength: 4096,
    envelopeChecksum: new Uint8Array(32).fill(7),
    state: "Candidate",
  } satisfies StorageReliefCheckpointV1;
  const created = {
    version: 1,
    vaultId,
    jobId,
    state: "Created",
    stage: "Synchronize",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    expectedServerOrigin: "https://sync.example.test",
    expectedAccountId: accountId,
    candidateArtifacts: 1,
    candidateBytes: 4096,
    verifiedArtifacts: 0,
    verifiedBytes: 0,
    evictedArtifacts: 0,
    freedBytes: 0,
    skippedArtifacts: 0,
    skippedBytes: 0,
    cancellationRequested: false,
  } satisfies StorageReliefJobV1;
  await repository.createStorageReliefJob({
    job: created,
    expectedLocalHead: head,
    expectedAvailability: [],
    candidates: [candidate],
  });
  let driftErrorId = "";
  try {
    await repository.createStorageReliefJob({
      job: { ...created, jobId: id("975") },
      expectedLocalHead: { ...head, generationNumber: 5 },
      expectedAvailability: [],
      candidates: [{ ...candidate, jobId: id("975") }],
    });
  } catch (error) {
    driftErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  const fenced = {
    ...created,
    state: "Running",
    stage: "Preflight",
    updatedAt: "2026-07-21T00:00:01.000Z",
    expectedLocalHead: head,
    expectedGenerationId: generationId,
    expectedGenerationNumber: 4,
  } satisfies StorageReliefJobV1;
  await repository.saveStorageReliefJob(fenced);
  const verified = {
    ...candidate,
    state: "Verified",
    remoteGenerationId: generationId,
    remoteGenerationNumber: 4,
  } satisfies StorageReliefCheckpointV1;
  await repository.saveStorageReliefCheckpoint(verified, "2026-07-21T00:00:02.000Z");
  const evicting = {
    ...verified,
    state: "Evicting",
  } satisfies StorageReliefCheckpointV1;
  await repository.saveStorageReliefCheckpoint(evicting, "2026-07-21T00:00:03.000Z");
  let mismatchedAvailabilityRejected = false;
  try {
    await repository.markArtifactRemoteOnly({
      checkpoint: { ...evicting, state: "Evicted" },
      availability: {
        version: 1,
        vaultId,
        artifactObjectId: id("976"),
        markedAt: "2026-07-21T00:00:04.000Z",
      },
      updatedAt: "2026-07-21T00:00:04.000Z",
    });
  } catch {
    mismatchedAvailabilityRejected = true;
  }
  const stateAfterRejectedCommit = (
    await repository.listStorageReliefCheckpoints(vaultId, jobId)
  )[0]?.state;
  await repository.markArtifactRemoteOnly({
    checkpoint: { ...evicting, state: "Evicted" },
    availability: {
      version: 1,
      vaultId,
      artifactObjectId,
      markedAt: "2026-07-21T00:00:04.000Z",
    },
    updatedAt: "2026-07-21T00:00:04.000Z",
  });
  await repository.close();
  const reopened = new IndexedDbStorageReliefRepository(databaseName);
  const job = await reopened.latestStorageReliefJob(vaultId);
  const checkpoints = await reopened.listStorageReliefCheckpoints(vaultId, jobId);
  const remoteBeforeClear = await reopened.isArtifactRemoteOnly(vaultId, artifactObjectId);
  const cancellationPersisted = await reopened.requestStorageReliefCancellation(
    vaultId,
    jobId,
    "2026-07-21T00:00:05.000Z",
  );
  await reopened.clearArtifactRemoteOnly(vaultId, artifactObjectId);
  const remoteAfterClear = await reopened.isArtifactRemoteOnly(vaultId, artifactObjectId);
  const jobAfterClear = await reopened.latestStorageReliefJob(vaultId);
  await reopened.close();
  return {
    state: job?.state,
    checkpointState: checkpoints[0]?.state,
    verifiedArtifacts: job?.verifiedArtifacts,
    evictedArtifacts: job?.evictedArtifacts,
    freedBytes: job?.freedBytes,
    remoteBeforeClear,
    remoteAfterClear,
    jobStateAfterClear: jobAfterClear?.state,
    cancellationPersisted,
    driftErrorId,
    mismatchedAvailabilityRejected,
    stateAfterRejectedCommit,
  };
}

async function storageReliefLeaseScenario(): Promise<unknown> {
  const databaseName = `awsm-storage-relief-lease-${crypto.randomUUID()}`;
  const vaultId = id("980");
  const driver = new IndexedDbDriver(databaseName, vaultId);
  await seedHead(driver);
  const head = await driver.getVaultHead();
  if (head === undefined) throw new Error("missing head");
  const repository = new IndexedDbStorageReliefRepository(databaseName);
  const jobId = id("981");
  const artifactObjectId = id("982");
  const createdAt = "2026-07-21T00:00:00.000Z";
  const job = {
    version: 1,
    vaultId,
    jobId,
    state: "Created",
    stage: "Synchronize",
    createdAt,
    updatedAt: createdAt,
    expectedServerOrigin: "https://sync.example.test",
    expectedAccountId: id("983"),
    candidateArtifacts: 1,
    candidateBytes: 128,
    verifiedArtifacts: 0,
    verifiedBytes: 0,
    evictedArtifacts: 0,
    freedBytes: 0,
    skippedArtifacts: 0,
    skippedBytes: 0,
    cancellationRequested: false,
  } satisfies StorageReliefJobV1;
  await repository.createStorageReliefJob({
    job,
    expectedLocalHead: head,
    expectedAvailability: [],
    candidates: [
      {
        version: 1,
        vaultId,
        jobId,
        artifactObjectId,
        keyEpochId: TEST_KEY_EPOCH_ID,
        envelopeByteLength: 128,
        envelopeChecksum: new Uint8Array(32),
        state: "Candidate",
      },
    ],
  });
  const busy = await driver.managementBusy();
  let captureErrorId = "";
  let vacuumErrorId = "";
  try {
    await driver.saveCaptureJob({
      version: 1,
      vaultId,
      jobId: id("984"),
      commandId: id("985"),
      tabId: 1,
      state: "Created",
      stage: "Preflight",
      createdAt,
      updatedAt: createdAt,
    });
  } catch (error) {
    captureErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  try {
    await driver.acquireVacuum(id("986"), createdAt);
  } catch (error) {
    vacuumErrorId = error instanceof Error && "id" in error ? String(error.id) : "";
  }
  await repository.saveStorageReliefJob({ ...job, state: "WaitingForUnlock" });
  const busyWhileWaiting = await driver.managementBusy();
  await repository.close();
  await driver.deleteDatabase();
  return {
    busy,
    captureErrorId,
    vacuumErrorId,
    busyWhileWaiting: busyWhileWaiting ?? null,
  };
}

type StorageReliefBoundary =
  | "afterSynchronization"
  | "afterVerifiedCheckpoint"
  | "afterEvictingCheckpoint"
  | "afterWrapperRemoved"
  | "afterRemoteOnlyCommit";

function crashingStorageReliefFault(boundary: StorageReliefBoundary): StorageReliefFaults {
  const crash = async (): Promise<void> => {
    throw new DOMException("simulated Worker termination", "AbortError");
  };
  switch (boundary) {
    case "afterSynchronization":
      return { afterSynchronization: crash };
    case "afterVerifiedCheckpoint":
      return { afterVerifiedCheckpoint: crash };
    case "afterEvictingCheckpoint":
      return { afterEvictingCheckpoint: crash };
    case "afterWrapperRemoved":
      return { afterWrapperRemoved: crash };
    case "afterRemoteOnlyCommit":
      return { afterRemoteOnlyCommit: crash };
  }
}

async function storageReliefRunnerScenario(fault?: StorageReliefBoundary): Promise<unknown> {
  const databaseName = `awsm-storage-relief-runner-${crypto.randomUUID()}`;
  const vaultId = crypto.randomUUID();
  const driver = new IndexedDbDriver(databaseName, vaultId);
  await driver.counts();
  const artifactObjectId = crypto.randomUUID();
  const descriptorObjectId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const store = new OpfsArtifactStore();
  const rootKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(4),
    { name: "HKDF" },
    false,
    ["deriveBits", "deriveKey"],
  );
  const prepared = await store.prepare({
    vaultId,
    objectId: artifactObjectId,
    keyring: testKeyring(rootKey),
    plaintext: (async function* () {
      yield new TextEncoder().encode("storage relief integration payload");
    })(),
  });
  const head = {
    version: 1,
    vaultId,
    generationId,
    generationNumber: 2,
    appendedObjectIds: [],
    appendedEventIds: [],
  } as const;
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    });
  });
  const seed = database.transaction("vault_head", "readwrite");
  seed.objectStore("vault_head").put(head, vaultSingletonKey(vaultId, "active"));
  await new Promise<void>((resolve, reject) => {
    seed.addEventListener("complete", () => resolve(), { once: true });
    seed.addEventListener("error", () => reject(seed.error), { once: true });
  });
  database.close();
  let repository = new IndexedDbStorageReliefRepository(databaseName);
  const createdAt = "2026-07-21T00:00:00.000Z";
  await repository.createStorageReliefJob({
    job: {
      version: 1,
      vaultId,
      jobId,
      state: "Created",
      stage: "Synchronize",
      createdAt,
      updatedAt: createdAt,
      expectedServerOrigin: "https://sync.example.test",
      expectedAccountId: accountId,
      candidateArtifacts: 1,
      candidateBytes: prepared.object.envelopeByteLength,
      verifiedArtifacts: 0,
      verifiedBytes: 0,
      evictedArtifacts: 0,
      freedBytes: 0,
      skippedArtifacts: 0,
      skippedBytes: 0,
      cancellationRequested: false,
    },
    expectedLocalHead: head,
    expectedAvailability: [],
    candidates: [
      {
        version: 1,
        vaultId,
        jobId,
        artifactObjectId,
        keyEpochId: prepared.object.keyEpochId,
        envelopeByteLength: prepared.object.envelopeByteLength,
        envelopeChecksum: prepared.object.envelopeChecksum,
        state: "Candidate",
      },
    ],
  });
  let synchronized = false;
  const runtime = {
    current: async () => ({
      vaultId,
      accountId,
      serverOrigin: "https://sync.example.test",
      unlocked: true,
      authenticated: true,
      head,
    }),
    synchronize: async () => {
      synchronized = true;
    },
    prove: async () => ({
      generationId,
      generationNumber: 2,
      records: new Map([
        [
          artifactObjectId,
          {
            objectType: "Artifact" as const,
            keyEpochId: prepared.object.keyEpochId,
            byteLength: prepared.object.envelopeByteLength,
            sha256: prepared.object.envelopeChecksum,
          },
        ],
        [
          descriptorObjectId,
          {
            objectType: "BundleDescriptor" as const,
            keyEpochId: TEST_KEY_EPOCH_ID,
            byteLength: 1,
            sha256: new Uint8Array(32),
          },
        ],
        [
          eventId,
          {
            objectType: "Event" as const,
            keyEpochId: TEST_KEY_EPOCH_ID,
            byteLength: 1,
            sha256: new Uint8Array(32),
            dependencyObjectIds: [artifactObjectId, descriptorObjectId].toSorted(),
          },
        ],
      ]),
      closures: new Map([
        [
          artifactObjectId,
          {
            descriptorObjectId,
            registrationEventId: eventId,
            dependencyObjectIds: [artifactObjectId, descriptorObjectId].toSorted(),
          },
        ],
      ]),
    }),
    recheckRemoteFence: async () => ({ generationId, generationNumber: 2 }),
  };
  let interrupted = false;
  try {
    await new StorageReliefJobRunner(
      repository,
      store,
      runtime,
      fault === undefined ? {} : crashingStorageReliefFault(fault),
    ).run(vaultId, "2026-07-21T00:00:01.000Z");
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    interrupted = true;
  }
  const interruptedCheckpoint = (await repository.listStorageReliefCheckpoints(vaultId, jobId))[0];
  const localAfterInterruption = await store.has(vaultId, artifactObjectId);
  const remoteOnlyAfterInterruption = await repository.isArtifactRemoteOnly(
    vaultId,
    artifactObjectId,
  );
  if (fault !== undefined) {
    await repository.close();
    repository = new IndexedDbStorageReliefRepository(databaseName);
    await new StorageReliefJobRunner(repository, store, runtime).run(
      vaultId,
      "2026-07-21T00:00:02.000Z",
    );
  }
  const job = await repository.latestStorageReliefJob(vaultId);
  const result = {
    synchronized,
    localPresent: await store.has(vaultId, artifactObjectId),
    remoteOnly: await repository.isArtifactRemoteOnly(vaultId, artifactObjectId),
    state: job?.state,
    freedBytes: job?.freedBytes,
    ...(fault === undefined
      ? {}
      : {
          interrupted,
          interruptedCheckpointState: interruptedCheckpoint?.state,
          localAfterInterruption,
          remoteOnlyAfterInterruption,
        }),
  };
  await repository.close();
  await driver.deleteDatabase();
  await store.reconcile(vaultId, new Set());
  return result;
}

async function storageReliefFaultMatrixScenario(): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const boundary of [
    "afterSynchronization",
    "afterVerifiedCheckpoint",
    "afterEvictingCheckpoint",
    "afterWrapperRemoved",
    "afterRemoteOnlyCommit",
  ] as const)
    result[boundary] = await storageReliefRunnerScenario(boundary);
  return result;
}

async function seedAttachedAuthority(databaseName: string): Promise<{
  readonly accountId: string;
  readonly vaultId: string;
  readonly records: VaultRecordsV1;
}> {
  const records = (
    await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Detached Archive",
      createdAt: "2026-07-27T12:00:00.000Z",
    })
  ).records;
  const accountId = crypto.randomUUID();
  const accountSessionId = crypto.randomUUID();
  const metadata = {
    version: 1 as const,
    accountId,
    sessionId: accountSessionId,
    username: "detached_test",
    inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
    scope: "Account" as const,
  };
  const accounts = new IndexedDbAccountRepository(databaseName);
  await accounts.saveConfiguration({
    version: 1,
    mode: "Configured",
    serverOrigin: "https://coordination.example",
    registration: { enabled: false },
  });
  await accounts.saveAuthenticated(
    {
      metadata,
      refreshToken: "account-refresh",
    },
    "active",
  );
  await accounts.close();

  const rootKey = await unwrapDeviceSlot(records.deviceSlot, records.deviceKey);
  const recoveryGenerationId = crypto.randomUUID();
  const administratorSeed = crypto.getRandomValues(new Uint8Array(32));
  const identity = await createDeviceIdentity({ deviceId: records.metadata.deviceId });
  const certificate = await createDeviceCertificate({
    certificateId: crypto.randomUUID(),
    vaultId: records.metadata.vaultId,
    recoveryGenerationId,
    identity,
    displayName: "Firefox on laptop",
    clientKind: "FirefoxExtension",
    issuedAt: "2026-07-27T12:05:00.000Z",
    recoveryAdministratorSeed: administratorSeed,
  });
  const envelope = await createDeviceKeyEnvelope({
    certificate,
    keyEpochId: records.metadata.activeKeyEpochId,
    epochRootKey: rootKey,
    recoveryAdministratorSeed: administratorSeed,
  });
  const recoveryKit = await createRecoveryKit({
    keyring: {
      version: 1,
      vaultId: records.metadata.vaultId,
      recoveryGenerationId,
      activeKeyEpochId: records.metadata.activeKeyEpochId,
      keyEpochs: [
        {
          keyEpochId: records.metadata.activeKeyEpochId,
          ordinal: 0,
          rootKey,
        },
      ],
    },
    recoveryKitWrappingKey: crypto.getRandomValues(new Uint8Array(32)),
    recoveryAdministratorSeed: administratorSeed,
  });
  const devices = new IndexedDbDeviceRepository(databaseName);
  await devices.saveInitialDevice({
    accountId,
    vaultId: records.metadata.vaultId,
    recoveryGenerationId,
    identity,
    certificate,
    envelopes: [envelope],
    keyEpochs: [
      {
        keyEpochId: records.metadata.activeKeyEpochId,
        ordinal: 0,
        rootKey,
      },
    ],
    recoveryKit,
    remoteGenerationId: records.generation.generationId,
    remoteGenerationNumber: 0,
    remoteHeadCursor: 1,
    session: {
      account: {
        accountId,
        username: "detached_test",
        inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
      },
      sessionId: crypto.randomUUID(),
      scope: "VaultDevice",
      accessToken: "device-access",
      accessExpiresAt: "2026-07-27T13:00:00.000Z",
      refreshToken: "device-refresh",
      refreshExpiresAt: "2026-08-26T12:00:00.000Z",
    },
  });
  await devices.close();
  return { accountId, vaultId: records.metadata.vaultId, records };
}

function installIndexedDbWriteFault(failAt?: number): {
  readonly writes: () => number;
  readonly restore: () => void;
} {
  const originalPut = IDBObjectStore.prototype.put;
  const originalDelete = IDBObjectStore.prototype.delete;
  const originalClear = IDBObjectStore.prototype.clear;
  let writes = 0;
  const beforeWrite = () => {
    writes += 1;
    if (writes === failAt)
      throw new DOMException("Injected authority transition failure", "AbortError");
  };
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    beforeWrite();
    return originalPut.call(this, value, key);
  };
  IDBObjectStore.prototype.delete = function (query: IDBValidKey | IDBKeyRange) {
    beforeWrite();
    return originalDelete.call(this, query);
  };
  IDBObjectStore.prototype.clear = function () {
    beforeWrite();
    return originalClear.call(this);
  };
  return {
    writes: () => writes,
    restore: () => {
      IDBObjectStore.prototype.put = originalPut;
      IDBObjectStore.prototype.delete = originalDelete;
      IDBObjectStore.prototype.clear = originalClear;
    },
  };
}

async function detachmentAttempt(failAt?: number): Promise<{
  readonly writes: number;
  readonly atomic: boolean;
}> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const seeded = await seedAttachedAuthority(databaseName);
  const detachments = new IndexedDbDetachmentRepository(databaseName);
  const prepared = await detachments.prepare(seeded.vaultId);
  const fault = installIndexedDbWriteFault(failAt);
  let rejected = false;
  try {
    await detachments.commit({
      expectedAccountId: seeded.accountId,
      expectedVaultId: seeded.vaultId,
      authority: prepared.authority,
    });
  } catch {
    rejected = true;
  } finally {
    fault.restore();
    await detachments.close();
  }

  const reopenedAccounts = new IndexedDbAccountRepository(databaseName);
  const reopenedDevices = new IndexedDbDeviceRepository(databaseName);
  const [configuration, account, registration, detached, bound, session] = await Promise.all([
    reopenedAccounts.loadConfiguration(),
    reopenedAccounts.loadAuthenticated("active"),
    reopenedAccounts.loadAccountVault(),
    reopenedDevices.loadDetachedVaultAuthority(seeded.vaultId),
    reopenedDevices.loadDeviceAuthority(seeded.vaultId),
    reopenedDevices.loadDeviceSession(seeded.vaultId),
  ]);
  const failed = failAt !== undefined;
  const atomic = failed
    ? rejected &&
      configuration.mode === "Configured" &&
      account?.metadata.accountId === seeded.accountId &&
      registration?.vaultId === seeded.vaultId &&
      detached === undefined &&
      bound?.vaultId === seeded.vaultId &&
      session?.metadata.accountId === seeded.accountId
    : !rejected &&
      configuration.mode === "LocalOnly" &&
      account === undefined &&
      registration === undefined &&
      detached?.vaultId === seeded.vaultId &&
      bound === undefined &&
      session === undefined;
  await reopenedAccounts.close();
  await reopenedDevices.close();
  const cleanup = new IndexedDbDriver(databaseName, seeded.vaultId);
  await cleanup.deleteDatabase();
  return { writes: fault.writes(), atomic };
}

async function reattachmentAttempt(failAt?: number): Promise<{
  readonly writes: number;
  readonly atomic: boolean;
}> {
  const databaseName = `awsm-integration-${crypto.randomUUID()}`;
  const seeded = await seedAttachedAuthority(databaseName);
  const detachments = new IndexedDbDetachmentRepository(databaseName);
  const prepared = await detachments.prepare(seeded.vaultId);
  await detachments.commit({
    expectedAccountId: seeded.accountId,
    expectedVaultId: seeded.vaultId,
    authority: prepared.authority,
  });
  await detachments.close();
  const devices = new IndexedDbDeviceRepository(databaseName);
  const detached = await devices.loadDetachedVaultAuthority(seeded.vaultId);
  if (detached === undefined) throw new Error("Detached authority was not retained.");
  const destinationAccountId = crypto.randomUUID();
  const authority = {
    accountId: destinationAccountId,
    vaultId: detached.vaultId,
    recoveryGenerationId: detached.recoveryGenerationId,
    identity: detached.identity,
    certificate: detached.certificate,
    envelopes: detached.envelopes,
    keyEpochs: detached.keyEpochs,
    recoveryKit: detached.recoveryKit,
    remoteGenerationId: seeded.records.generation.generationId,
    remoteGenerationNumber: 0,
    remoteHeadCursor: 1,
    session: {
      account: {
        accountId: destinationAccountId,
        username: "destination_test",
        inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
      },
      sessionId: crypto.randomUUID(),
      scope: "VaultDevice" as const,
      accessToken: "destination-access",
      accessExpiresAt: "2026-07-27T13:00:00.000Z",
      refreshToken: "destination-refresh",
      refreshExpiresAt: "2026-08-26T12:00:00.000Z",
    },
  };
  const fault = installIndexedDbWriteFault(failAt);
  let rejected = false;
  try {
    await devices.saveReattachedDevice(authority);
  } catch {
    rejected = true;
  } finally {
    fault.restore();
    await devices.close();
  }

  const reopenedAccounts = new IndexedDbAccountRepository(databaseName);
  const reopenedDevices = new IndexedDbDeviceRepository(databaseName);
  const [registration, retainedDetached, bound, session] = await Promise.all([
    reopenedAccounts.loadAccountVault(),
    reopenedDevices.loadDetachedVaultAuthority(seeded.vaultId),
    reopenedDevices.loadDeviceAuthority(seeded.vaultId),
    reopenedDevices.loadDeviceSession(seeded.vaultId),
  ]);
  const failed = failAt !== undefined;
  const atomic = failed
    ? rejected &&
      registration === undefined &&
      retainedDetached?.vaultId === seeded.vaultId &&
      bound === undefined &&
      session === undefined
    : !rejected &&
      registration?.accountId === destinationAccountId &&
      retainedDetached === undefined &&
      bound?.accountId === destinationAccountId &&
      session?.metadata.accountId === destinationAccountId;
  await reopenedAccounts.close();
  await reopenedDevices.close();
  const cleanup = new IndexedDbDriver(databaseName, seeded.vaultId);
  await cleanup.deleteDatabase();
  return { writes: fault.writes(), atomic };
}

async function detachedAuthorityAtomicityScenario(): Promise<unknown> {
  const detachmentBaseline = await detachmentAttempt();
  const detachmentFailures = [];
  for (let failAt = 1; failAt <= detachmentBaseline.writes; failAt += 1)
    detachmentFailures.push((await detachmentAttempt(failAt)).atomic);
  const reattachmentBaseline = await reattachmentAttempt();
  const reattachmentFailures = [];
  for (let failAt = 1; failAt <= reattachmentBaseline.writes; failAt += 1)
    reattachmentFailures.push((await reattachmentAttempt(failAt)).atomic);
  return {
    detachmentWrites: detachmentBaseline.writes,
    detachmentAtomic:
      detachmentBaseline.atomic &&
      detachmentFailures.length > 0 &&
      detachmentFailures.every(Boolean),
    reattachmentWrites: reattachmentBaseline.writes,
    reattachmentAtomic:
      reattachmentBaseline.atomic &&
      reattachmentFailures.length > 0 &&
      reattachmentFailures.every(Boolean),
  };
}

async function run(): Promise<void> {
  const parameters = new URL(location.href).searchParams;
  const scenario = parameters.get("scenario");
  if (parameters.get("delayCrypto") === "true") {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, "encrypt", {
      configurable: true,
      value: async (...input: Parameters<SubtleCrypto["encrypt"]>) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return encrypt(...input);
      },
    });
  }
  const result =
    scenario === "ui-preferences"
      ? await uiPreferencesScenario()
      : scenario === "search-keyword-persistence"
        ? await searchKeywordPersistenceScenario()
        : scenario === "search-keyword-atomic-commit"
          ? await searchKeywordAtomicCommitScenario()
          : scenario === "search-semantic-atomic-commit"
            ? await searchSemanticAtomicCommitScenario()
            : scenario === "search-index-lease"
              ? await searchIndexLeaseScenario()
              : scenario === "search-index-failure-resume"
                ? await searchIndexFailureResumeScenario()
                : scenario === "search-keyword-indexer"
                  ? await searchKeywordIndexerScenario()
                  : scenario === "search-local-minilm-inference"
                    ? await localMiniLmInferenceScenario()
                    : scenario === "search-local-model-cache"
                      ? await searchLocalModelCacheScenario()
                      : scenario === "storage-relief-fault-matrix"
                        ? await storageReliefFaultMatrixScenario()
                        : scenario === "detached-authority-atomicity"
                          ? await detachedAuthorityAtomicityScenario()
                          : scenario === "storage-relief-runner"
                            ? await storageReliefRunnerScenario()
                            : scenario === "storage-relief-lease"
                              ? await storageReliefLeaseScenario()
                              : scenario === "storage-relief-persistence"
                                ? await storageReliefPersistenceScenario()
                                : scenario === "storage-relief-schema"
                                  ? await storageReliefSchemaScenario()
                                  : scenario === "account-persistence"
                                    ? await accountPersistenceScenario()
                                    : scenario === "account-scope-isolation"
                                      ? await accountScopeIsolationScenario()
                                      : scenario === "server-switch-promotion"
                                        ? await serverSwitchPromotionScenario()
                                        : scenario === "server-switch-replica-promotion-atomicity"
                                          ? await serverSwitchReplicaPromotionAtomicityScenario()
                                          : scenario === "server-switch-persistence"
                                            ? await serverSwitchPersistenceScenario()
                                            : scenario === "vault"
                                              ? await vaultScenario()
                                              : scenario === "workspace"
                                                ? await workspaceScenario()
                                                : scenario === "atomic-vault-create"
                                                  ? await atomicVaultCreateScenario()
                                                  : scenario === "atomic-vault-create-failures"
                                                    ? await atomicVaultCreateFailureScenario()
                                                    : scenario === "atomic-vault-select"
                                                      ? await atomicVaultSelectScenario()
                                                      : scenario === "atomic-vault-select-failures"
                                                        ? await atomicVaultSelectFailureScenario()
                                                        : scenario === "atomic-vault-rename"
                                                          ? await atomicVaultRenameScenario()
                                                          : scenario ===
                                                              "atomic-vault-rename-failures"
                                                            ? await atomicVaultRenameFailureScenario()
                                                            : scenario === "vault-record-isolation"
                                                              ? await vaultRecordIsolationScenario()
                                                              : scenario === "immutable"
                                                                ? await immutableScenario()
                                                                : scenario === "vault-isolation"
                                                                  ? await vaultIsolationScenario()
                                                                  : scenario ===
                                                                      "capture-job-vault-isolation"
                                                                    ? await captureJobVaultIsolationScenario()
                                                                    : scenario ===
                                                                        "event-vault-mismatch"
                                                                      ? await eventVaultMismatchScenario()
                                                                      : scenario === "atomic"
                                                                        ? await atomicScenario()
                                                                        : scenario === "rollback"
                                                                          ? await rollbackScenario()
                                                                          : scenario ===
                                                                              "stale-epoch-replay-commit"
                                                                            ? await staleEpochReplayCommitScenario()
                                                                            : scenario ===
                                                                                "vault-replacement-persistence"
                                                                              ? await vaultReplacementPersistenceScenario()
                                                                              : scenario ===
                                                                                  "vault-replacement-hidden-stage"
                                                                                ? await vaultReplacementHiddenStageScenario()
                                                                                : scenario ===
                                                                                    "vault-replacement-promotion"
                                                                                  ? await vaultReplacementPromotionScenario()
                                                                                  : scenario ===
                                                                                      "projection"
                                                                                    ? await projectionScenario()
                                                                                    : scenario ===
                                                                                        "interruption"
                                                                                      ? await interruptionScenario()
                                                                                      : scenario ===
                                                                                          "dismissal"
                                                                                        ? await dismissalScenario()
                                                                                        : scenario ===
                                                                                            "library-state"
                                                                                          ? await libraryStateScenario()
                                                                                          : scenario ===
                                                                                              "vacuum-rollback"
                                                                                            ? await vacuumRollbackScenario()
                                                                                            : scenario ===
                                                                                                "vacuum-availability-cleanup"
                                                                                              ? await vacuumAvailabilityCleanupScenario()
                                                                                              : scenario ===
                                                                                                  "vacuum-cas-conflict"
                                                                                                ? await vacuumCasConflictScenario()
                                                                                                : scenario ===
                                                                                                    "vacuum-lease"
                                                                                                  ? await vacuumLeaseScenario()
                                                                                                  : scenario ===
                                                                                                      "synchronized-vacuum-journal"
                                                                                                    ? await synchronizedVacuumJournalScenario()
                                                                                                    : scenario ===
                                                                                                        "collection-operation"
                                                                                                      ? await collectionOperationScenario()
                                                                                                      : scenario ===
                                                                                                          "management-busy"
                                                                                                        ? await managementBusyScenario()
                                                                                                        : scenario ===
                                                                                                            "export-lease"
                                                                                                          ? await exportLeaseScenario()
                                                                                                          : scenario ===
                                                                                                              "import-lease"
                                                                                                            ? await importLeaseScenario()
                                                                                                            : scenario ===
                                                                                                                "artifact-store"
                                                                                                              ? await artifactStoreScenario()
                                                                                                              : scenario ===
                                                                                                                  "import-source-staging"
                                                                                                                ? await importSourceStagingScenario()
                                                                                                                : scenario ===
                                                                                                                    "import-job-lifecycle"
                                                                                                                  ? await importJobLifecycleScenario()
                                                                                                                  : scenario ===
                                                                                                                      "atomic-vault-import"
                                                                                                                    ? await atomicVaultImportScenario()
                                                                                                                    : scenario ===
                                                                                                                        "atomic-stale-discard"
                                                                                                                      ? await atomicStaleDiscardScenario()
                                                                                                                      : scenario ===
                                                                                                                          "remote-reconciliation-fence"
                                                                                                                        ? await remoteReconciliationFenceScenario()
                                                                                                                        : scenario ===
                                                                                                                            "stale-discard-restart"
                                                                                                                          ? await staleDiscardRestartScenario()
                                                                                                                          : {
                                                                                                                              error:
                                                                                                                                "unknown scenario",
                                                                                                                            };
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

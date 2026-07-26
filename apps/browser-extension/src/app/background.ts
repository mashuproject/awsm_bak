import { browser } from "wxt/browser";
import { decodeEncryptedEnvelopeBytes } from "../crypto/envelope";
import { wipe } from "../crypto/sodium";
import { RUNTIME_ERROR_IDS, type RuntimeErrorId } from "../domain/contracts";
import { canonicalRecord, integer, uuid } from "../domain/validation";
import {
  IndexedDbAccountRepository,
  IndexedDbDeviceRepository,
  IndexedDbDriver,
  IndexedDbImportRepository,
  IndexedDbServerSwitchRepository,
  IndexedDbStorageReliefRepository,
  IndexedDbVaultReplacementRepository,
  IndexedDbVaultRepository,
  IndexedDbWorkspaceRepository,
  type ServerSwitchReplicaPromotion,
} from "../drivers/indexeddb";
import { ChromeAccountServerHost } from "../hosts/chrome/account-server";
import { ChromeCaptureHost, ChromeScreenshotHost } from "../hosts/chrome/api";
import { ChromeMhtmlDownloadHost, mhtmlDownloadFilename } from "../hosts/chrome/artifact-download";
import { preflightCapture } from "../hosts/chrome/capture";
import { ChromeVaultExportHost } from "../hosts/chrome/export";
import { FirefoxAccountServerHost } from "../hosts/firefox/account-server";
import { FirefoxCaptureHost, FirefoxScreenshotHost } from "../hosts/firefox/api";
import { FirefoxMhtmlDownloadHost } from "../hosts/firefox/artifact-download";
import { FirefoxVaultExportHost } from "../hosts/firefox/export";
import {
  type FirefoxSynchronizationPermissionApi,
  firefoxServerPermissionPattern,
  hasFirefoxSynchronizationPermission,
} from "../hosts/firefox/synchronization-permission";
import { OpfsArtifactStore } from "../hosts/shared/artifact-store";
import { VaultImportHost } from "../hosts/shared/import";
import { acquireBestEffortScreenshot } from "../hosts/shared/screenshot";
import { reconcileTemporaryFiles, stagePlaintextFile } from "../hosts/shared/temporary-file";
import { TestingFaultCheckpoint } from "../hosts/testing/fault-checkpoint";
import { DeviceSessionManager, establishDeviceSession } from "../runtime/account/device-session";
import { CoordinationAccountHttp, decodeAuthenticatedSession } from "../runtime/account/http";
import { configureSyncServer, validateSyncServer } from "../runtime/account/server";
import { AccountAuthenticationService } from "../runtime/account/service";
import { AccountSessionManager } from "../runtime/account/session";
import { bytesToBase64Url } from "../runtime/account/wire";
import { ArtifactResolver } from "../runtime/artifact";
import { CaptureRuntime, defaultPrepareRegistration } from "../runtime/capture/service";
import { VaultExportService, vaultExportFilename } from "../runtime/export";
import { noRuntimeFaultCheckpoint } from "../runtime/fault-checkpoint";
import { VaultImportService } from "../runtime/import/service";
import { prepareLibraryStateChange, selectLibraryItems } from "../runtime/library/lifecycle";
import {
  decodeCollectionOperationEvent,
  invertCaptureMoves,
  planCaptureMove,
  planCollectionMerge,
  prepareCollectionOperation,
} from "../runtime/library/management";
import { LibraryProjectionRebuilder } from "../runtime/library/rebuild";
import { LibraryService } from "../runtime/library/service";
import {
  objectIdsForBundles,
  storedObjectByteLength,
  type VacuumCandidate,
  type VacuumRepository,
  VaultVacuumService,
} from "../runtime/library/vacuum";
import { validatePageSnapshot, writePageSnapshot } from "../runtime/page-snapshot";
import { DeviceAuthorityRefreshService } from "../runtime/recovery/authority-refresh";
import {
  createDeviceEnrollmentProof,
  deviceCertificateToWire,
  deviceKeyEnvelopeToWire,
} from "../runtime/recovery/device";
import { RecoveredDeviceEnrollmentService } from "../runtime/recovery/enrollment";
import { FutureProtectionService } from "../runtime/recovery/future-protection";
import { InitialVaultAttachmentService } from "../runtime/recovery/initial-attachment";
import { recoveryKitToWire } from "../runtime/recovery/kit";
import { VaultReplacementLocalState } from "../runtime/recovery/replacement-local";
import { VaultReplacementLocalPromoter } from "../runtime/recovery/replacement-promotion";
import { VaultReplacementRemote } from "../runtime/recovery/replacement-remote";
import { VaultReplacementRunner } from "../runtime/recovery/replacement-runner";
import { VaultReplacementService } from "../runtime/recovery/replacement-service";
import { VaultReplacementGraphUploader } from "../runtime/recovery/replacement-upload";
import { VaultReplacementRemoteValidator } from "../runtime/recovery/replacement-validation";
import { StorageReliefCandidateEnumerator } from "../runtime/storage-relief/candidates";
import { ActiveGenerationStorageReliefProver } from "../runtime/storage-relief/proof";
import { StorageReliefJobRunner } from "../runtime/storage-relief/runner";
import { StorageReliefService } from "../runtime/storage-relief/service";
import { storageReliefJobView } from "../runtime/storage-relief/view";
import { RemoteBootstrapRunner } from "../runtime/synchronization/bootstrap";
import { CableHintSubscriber } from "../runtime/synchronization/cable";
import { SynchronizationCoordinator } from "../runtime/synchronization/coordinator";
import { AccountVaultDiscovery } from "../runtime/synchronization/discovery";
import {
  RemoteReplicaDownloader,
  verifyPreparedRemoteReplica,
} from "../runtime/synchronization/download";
import { SynchronizationHttp } from "../runtime/synchronization/http";
import { IncrementalPullRunner } from "../runtime/synchronization/pull";
import { StaleReplicaDiscardService } from "../runtime/synchronization/recovery";
import { InterruptedStaleDiscardReconciler } from "../runtime/synchronization/recovery-reconciliation";
import { ServerSwitchService } from "../runtime/synchronization/server-switch";
import { classifyServerSwitch } from "../runtime/synchronization/server-switch-classifier";
import { shouldFailUncommittedServerSwitch } from "../runtime/synchronization/server-switch-failure";
import { ServerSwitchCandidateInspector } from "../runtime/synchronization/server-switch-inspection";
import { serverSwitchRaceDisposition } from "../runtime/synchronization/server-switch-race";
import { ServerSwitchRecoveryProver } from "../runtime/synchronization/server-switch-recovery";
import { ServerSwitchRemoteApplicator } from "../runtime/synchronization/server-switch-remote";
import { serverSwitchStartupDecision } from "../runtime/synchronization/server-switch-startup";
import { prepareStaleCaptureReplay } from "../runtime/synchronization/stale-epoch-replay";
import { UploadRunner } from "../runtime/synchronization/upload";
import { SynchronizedVacuumActivator } from "../runtime/synchronization/vacuum";
import {
  encryptWorkspaceVaultName,
  VaultService,
  WorkspaceContextManager,
  WorkspaceService,
} from "../runtime/vault";
import { verifyVaultGeneration } from "../runtime/vault/generation";
import { unwrapDeviceSlot } from "../runtime/vault/slots";
import { recentCaptureMatchesActiveUrl } from "../ui/popup-view";
import { bytesToBase64 } from "./base64";
import {
  type AppRequest,
  type AppResponse,
  type AppState,
  isAppRequest,
  type LibraryOperationReceipt,
} from "./protocol";

const databaseName = "awsm-client";
const vaultRepository = new IndexedDbVaultRepository();
const workspaceRepository = new IndexedDbWorkspaceRepository();
const accountRepository = new IndexedDbAccountRepository();
const deviceRepository = new IndexedDbDeviceRepository();
const serverSwitchRepository = new IndexedDbServerSwitchRepository();
const storageReliefRepository = new IndexedDbStorageReliefRepository();
const vaultReplacementRepository = new IndexedDbVaultReplacementRepository();
const storageReliefControllers = new Map<string, AbortController>();
const firefoxHost = browser.runtime.getManifest().browser_specific_settings?.gecko !== undefined;
const mhtmlDownloadHost = firefoxHost
  ? new FirefoxMhtmlDownloadHost()
  : new ChromeMhtmlDownloadHost();
const liveStorageReliefRepository = {
  latestStorageReliefJob: (vaultId: string) =>
    storageReliefRepository.latestStorageReliefJob(vaultId),
  listStorageReliefCheckpoints: (vaultId: string, jobId: string) =>
    storageReliefRepository.listStorageReliefCheckpoints(vaultId, jobId),
  saveStorageReliefJob: async (
    job: import("../drivers/indexeddb/storage-relief-schema").StorageReliefJobV1,
  ) => {
    await storageReliefRepository.saveStorageReliefJob(job);
    await notifyAppStateChanged();
  },
  saveStorageReliefCheckpoint: async (
    checkpoint: import("../drivers/indexeddb/storage-relief-schema").StorageReliefCheckpointV1,
    updatedAt: string,
  ) => {
    await storageReliefRepository.saveStorageReliefCheckpoint(checkpoint, updatedAt);
    await notifyAppStateChanged();
  },
  markArtifactRemoteOnly: async (
    input: Parameters<IndexedDbStorageReliefRepository["markArtifactRemoteOnly"]>[0],
  ) => {
    await storageReliefRepository.markArtifactRemoteOnly(input);
    await notifyAppStateChanged();
  },
};
const liveServerSwitchRepository = {
  loadJob: () => serverSwitchRepository.loadJob(),
  saveJob: async (job: import("../drivers/indexeddb").ServerSwitchJobV1) => {
    await serverSwitchRepository.saveJob(job);
    await notifyAppStateChanged();
  },
  loadCheckpoint: (
    jobId: string,
    kind: import("../drivers/indexeddb").ServerSwitchCheckpointV1["kind"],
    entityId: string,
  ) => serverSwitchRepository.loadCheckpoint(jobId, kind, entityId),
  saveCheckpoint: (checkpoint: import("../drivers/indexeddb").ServerSwitchCheckpointV1) =>
    serverSwitchRepository.saveCheckpoint(checkpoint),
};
const accountServerHost = firefoxHost
  ? new FirefoxAccountServerHost((configuration) =>
      accountRepository.saveConfiguration(configuration),
    )
  : new ChromeAccountServerHost((configuration) =>
      accountRepository.saveConfiguration(configuration),
    );
let initialDeviceAccessToken: string | undefined;
const initialAttachmentTransport = {
  reset(): void {
    initialDeviceAccessToken = undefined;
  },
  useDeviceAccessToken(accessToken: string): void {
    initialDeviceAccessToken = accessToken;
  },
  async request(method: string, path: string, body: unknown, idempotencyKey: string) {
    const configuration = await accountRepository.loadConfiguration();
    if (configuration.mode !== "Configured")
      throw Object.assign(new Error("No synchronization server is configured."), {
        id: "SERVER_INCOMPATIBLE",
      });
    const accessToken = initialDeviceAccessToken;
    const tokens =
      accessToken === undefined ? await sessionManager() : { accessToken: async () => accessToken };
    return new SynchronizationHttp(configuration.serverOrigin, tokens).request(
      method,
      path,
      body,
      idempotencyKey,
    );
  },
  async putTransfer(url: string, part: number, bytes: Uint8Array) {
    const configuration = await accountRepository.loadConfiguration();
    if (configuration.mode !== "Configured")
      throw Object.assign(new Error("No synchronization server is configured."), {
        id: "SERVER_INCOMPATIBLE",
      });
    const accessToken = initialDeviceAccessToken;
    const tokens =
      accessToken === undefined ? await sessionManager() : { accessToken: async () => accessToken };
    return new SynchronizationHttp(configuration.serverOrigin, tokens).putTransfer(
      url,
      part,
      bytes,
    );
  },
};
const initialAttachment = new InitialVaultAttachmentService(
  initialAttachmentTransport,
  deviceRepository,
);
const futureProtection = new FutureProtectionService(
  {
    async deviceRequest(method, path, body, idempotencyKey) {
      const configuration = await accountRepository.loadConfiguration();
      if (configuration.mode !== "Configured")
        throw Object.assign(new Error("No synchronization server is configured."), {
          id: "SERVER_INCOMPATIBLE",
        });
      return new SynchronizationHttp(
        configuration.serverOrigin,
        await deviceSessionManager(),
      ).request(method, path, body, idempotencyKey);
    },
    async accountRequest(method, path, body) {
      const configuration = await accountRepository.loadConfiguration();
      if (configuration.mode !== "Configured")
        throw Object.assign(new Error("No synchronization server is configured."), {
          id: "SERVER_INCOMPATIBLE",
        });
      return new SynchronizationHttp(configuration.serverOrigin, await sessionManager()).request(
        method,
        path,
        body,
      );
    },
    useDeviceAccessToken(accessToken) {
      activeDeviceSessionManager?.setAccessToken(accessToken);
    },
  },
  deviceRepository,
);
const deviceAuthorityRefresh = new DeviceAuthorityRefreshService(
  {
    async accountRequest(method, path, body) {
      const configuration = await accountRepository.loadConfiguration();
      if (configuration.mode !== "Configured")
        throw Object.assign(new Error("No synchronization server is configured."), {
          id: "SERVER_INCOMPATIBLE",
        });
      return new SynchronizationHttp(configuration.serverOrigin, await sessionManager()).request(
        method,
        path,
        body,
      );
    },
    async deviceRequest(method, path) {
      const configuration = await accountRepository.loadConfiguration();
      if (configuration.mode !== "Configured")
        throw Object.assign(new Error("No synchronization server is configured."), {
          id: "SERVER_INCOMPATIBLE",
        });
      return new SynchronizationHttp(
        configuration.serverOrigin,
        await deviceSessionManager(),
      ).request(method, path);
    },
    useDeviceAccessToken(accessToken) {
      activeDeviceSessionManager?.setAccessToken(accessToken);
    },
  },
  deviceRepository,
);
const workspace = new WorkspaceService(workspaceRepository);
const importRepository = new IndexedDbImportRepository();
const importHost = new VaultImportHost();
const importControllers = new Map<string, AbortController>();
const serverSwitchService = new ServerSwitchService(serverSwitchRepository, accountRepository);
let activeSessionManager: AccountSessionManager | undefined;
let activeSessionOrigin: string | undefined;
let activeDeviceSessionManager: DeviceSessionManager | undefined;
let activeDeviceSessionContext: string | undefined;
let candidateSessionManager: AccountSessionManager | undefined;
let candidateSessionOrigin: string | undefined;
let serverSwitchController: AbortController | undefined;
let activeCable: CableHintSubscriber | undefined;
let activeCableContext: string | undefined;

function firefoxPermissionApi(): FirefoxSynchronizationPermissionApi {
  return browser.permissions as unknown as FirefoxSynchronizationPermissionApi;
}

async function firefoxSynchronizationPermissionGranted(origin: string): Promise<boolean> {
  if (!firefoxHost) return true;
  return hasFirefoxSynchronizationPermission(
    await firefoxPermissionApi().getAll(),
    firefoxServerPermissionPattern(origin),
  );
}

async function assertFirefoxSynchronizationPermission(origin: string): Promise<void> {
  if (await firefoxSynchronizationPermissionGranted(origin)) return;
  throw Object.assign(
    new Error("Firefox synchronization permission is required for this server."),
    { id: "SERVER_PERMISSION_DENIED" },
  );
}

async function sessionManager(): Promise<AccountSessionManager> {
  const configuration = await accountRepository.loadConfiguration();
  if (configuration.mode !== "Configured")
    throw Object.assign(new Error("No synchronization server is configured."), {
      id: "SERVER_INCOMPATIBLE",
    });
  await assertFirefoxSynchronizationPermission(configuration.serverOrigin);
  if (activeSessionManager === undefined || activeSessionOrigin !== configuration.serverOrigin) {
    activeSessionManager = new AccountSessionManager(
      new CoordinationAccountHttp(configuration.serverOrigin),
      accountRepository,
    );
    activeSessionOrigin = configuration.serverOrigin;
  }
  return activeSessionManager;
}

async function deviceSessionManager(vaultId?: string): Promise<DeviceSessionManager> {
  const [configuration, registration] = await Promise.all([
    accountRepository.loadConfiguration(),
    accountRepository.loadAccountVault(),
  ]);
  if (
    configuration.mode !== "Configured" ||
    registration === undefined ||
    (vaultId !== undefined && registration.vaultId !== vaultId)
  )
    throw Object.assign(new Error("No synchronized Device authority is configured."), {
      id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
    });
  await assertFirefoxSynchronizationPermission(configuration.serverOrigin);
  const context = `${configuration.serverOrigin}:${registration.vaultId}`;
  if (activeDeviceSessionManager === undefined || activeDeviceSessionContext !== context) {
    activeDeviceSessionManager = new DeviceSessionManager(
      new CoordinationAccountHttp(configuration.serverOrigin),
      deviceRepository,
      registration.vaultId,
    );
    activeDeviceSessionContext = context;
  }
  return activeDeviceSessionManager;
}

async function serverSwitchSession(
  origin: string,
  accessToken?: string,
): Promise<AccountSessionManager> {
  await assertFirefoxSynchronizationPermission(origin);
  if (candidateSessionManager === undefined || candidateSessionOrigin !== origin) {
    candidateSessionManager = new AccountSessionManager(
      new CoordinationAccountHttp(origin),
      accountRepository,
      "server-switch-candidate",
    );
    candidateSessionOrigin = origin;
  }
  if (accessToken !== undefined) candidateSessionManager.setAccessToken(accessToken);
  return candidateSessionManager;
}

function remoteVaultHead(value: unknown): {
  readonly vaultId: string;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly headCursor: number;
  readonly predecessorGenerationId?: string;
} {
  if (typeof value !== "object" || value === null || !Array.isArray(Reflect.get(value, "vaults")))
    throw Object.assign(new Error("Remote Vault list is invalid."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const vaults = Reflect.get(value, "vaults") as unknown[];
  const remote = vaults[0];
  if (
    vaults.length !== 1 ||
    typeof remote !== "object" ||
    remote === null ||
    typeof Reflect.get(remote, "vaultId") !== "string" ||
    typeof Reflect.get(remote, "generationId") !== "string" ||
    typeof Reflect.get(remote, "generationNumber") !== "number" ||
    !Number.isSafeInteger(Reflect.get(remote, "generationNumber")) ||
    typeof Reflect.get(remote, "headCursor") !== "number" ||
    !Number.isSafeInteger(Reflect.get(remote, "headCursor"))
  )
    throw Object.assign(new Error("Remote Vacuum head is invalid."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  return {
    vaultId: uuid(Reflect.get(remote, "vaultId"), "remoteVault.vaultId"),
    generationId: Reflect.get(remote, "generationId") as string,
    generationNumber: Reflect.get(remote, "generationNumber") as number,
    headCursor: Reflect.get(remote, "headCursor") as number,
    ...(Reflect.get(remote, "predecessorGenerationId") === undefined
      ? {}
      : {
          predecessorGenerationId: uuid(
            Reflect.get(remote, "predecessorGenerationId"),
            "remoteVault.predecessorGenerationId",
          ),
        }),
  };
}

async function resumeInterruptedSynchronizedVacuum(
  configuration: {
    readonly version: 1;
    readonly mode: "Configured";
    readonly serverOrigin: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  const context = contexts.active();
  if (context === undefined) return;
  const vacuum = await context.driver.latestVacuumJob();
  if (vacuum?.candidate === undefined) return;
  const registration = await accountRepository.loadAccountVault();
  if (
    registration?.vaultId !== context.vaultId ||
    registration.remoteGenerationId !== vacuum.candidate.expectedGenerationId
  ) {
    await context.driver.discardSynchronizedVacuum(vacuum.jobId);
    return;
  }
  let activatedHeadCursor = vacuum.activatedHeadCursor;
  if (activatedHeadCursor === undefined) {
    const transport = new SynchronizationHttp(
      configuration.serverOrigin,
      await deviceSessionManager(context.vaultId),
      fetch,
      signal,
    );
    const remote = remoteVaultHead((await transport.request("GET", "/api/vaults")).body);
    if (
      remote.generationId !== vacuum.candidate.generation.generationId ||
      remote.generationNumber !== vacuum.candidate.generation.generationNumber
    ) {
      if (remote.generationId === vacuum.candidate.expectedGenerationId) {
        await context.driver.discardSynchronizedVacuum(vacuum.jobId);
        return;
      }
      await context.driver.discardSynchronizedVacuum(vacuum.jobId);
      return;
    }
    activatedHeadCursor = remote.headCursor;
    await context.driver.markSynchronizedVacuumActivated(vacuum.jobId, activatedHeadCursor);
  }
  await context.driver.commitVacuum(vacuum.candidate);
  await accountRepository.recordActivatedGeneration({
    vaultId: context.vaultId,
    expectedGenerationId: registration.remoteGenerationId,
    generationId: vacuum.candidate.generation.generationId,
    generationNumber: vacuum.candidate.generation.generationNumber,
    deliveryCursor: activatedHeadCursor,
  });
  await Promise.all(
    vacuum.candidate.deletedArtifactObjectIds.map((objectId) =>
      artifactStore.remove(context.vaultId, objectId),
    ),
  );
  await notifyAppStateChanged();
}

async function executeSynchronization(signal?: AbortSignal): Promise<void> {
  const configuration = await accountRepository.loadConfiguration();
  if (configuration.mode !== "Configured") return;
  if (!(await firefoxSynchronizationPermissionGranted(configuration.serverOrigin))) return;
  if (!(await accountRepository.hasAuthenticatedSecrets())) return;
  try {
    await resumeInterruptedSynchronizedVacuum(configuration, signal);
    const pending = await accountRepository.latestSynchronizationJob();
    if (
      pending?.state === "AuthenticationRequired" ||
      pending?.state === "Conflict" ||
      pending?.state === "Failed" ||
      (pending?.state === "Waiting" &&
        pending.retryAt !== undefined &&
        Date.parse(pending.retryAt) > Date.now())
    )
      return;
    const job = await accountRepository.latestSynchronizationJob();
    if (
      job?.vaultId !== undefined &&
      (job.stage === "UploadObjects" || job.stage === "CommitEvents")
    ) {
      const activeKeyEpochId = await currentRemoteKeyEpochBeforeUpload(
        configuration.serverOrigin,
        job.vaultId,
        signal,
      );
      const uploadDriver = new IndexedDbDriver(databaseName, job.vaultId);
      try {
        const transport = new SynchronizationHttp(
          configuration.serverOrigin,
          await deviceSessionManager(job.vaultId),
          fetch,
          signal,
        );
        const publishedEntityIds = await replayStaleEpochCapturesBeforeUpload({
          job: { ...job, vaultId: job.vaultId },
          activeKeyEpochId,
          driver: uploadDriver,
          transport,
          ...(signal === undefined ? {} : { signal }),
        });
        const runner = new UploadRunner(
          accountRepository,
          uploadDriver,
          artifactStore,
          transport,
          undefined,
          true,
          undefined,
          storageReliefRepository,
        );
        await runner.assertPendingUploadsUseEpoch(activeKeyEpochId, publishedEntityIds);
        await runner.run(undefined, publishedEntityIds);
      } finally {
        await uploadDriver.close();
      }
    }
    const afterUpload = await accountRepository.latestSynchronizationJob();
    if (afterUpload?.stage === "DownloadRecords") {
      const activated = await new RemoteBootstrapRunner(
        accountRepository,
        deviceRepository,
        workspaceRepository,
        artifactStore,
        new RemoteReplicaDownloader(
          new SynchronizationHttp(
            configuration.serverOrigin,
            await deviceSessionManager(afterUpload.vaultId),
            fetch,
            signal,
          ),
          artifactStore,
        ),
      ).run();
      if (activated !== undefined) await contexts.reloadFromAuthority();
    }
    const pullJob = await accountRepository.latestSynchronizationJob();
    const active = contexts.active();
    if (
      pullJob?.stage === "FetchChanges" &&
      active !== undefined &&
      pullJob.vaultId === active.vaultId &&
      active.vault.isUnlocked()
    ) {
      const transport = new SynchronizationHttp(
        configuration.serverOrigin,
        await deviceSessionManager(active.vaultId),
        fetch,
        signal,
      );
      const remoteArtifacts = new ArtifactResolver(
        artifactStore,
        storageReliefRepository,
        transport,
        { online: () => navigator.onLine },
      );
      await new IncrementalPullRunner(
        accountRepository,
        active.driver,
        workspaceRepository,
        artifactStore,
        transport,
        new RemoteReplicaDownloader(transport, artifactStore),
        runtimeFaultCheckpoint,
        signal,
        storageReliefRepository,
        {
          openEncrypted: async ({ vaultId, object, generationId }) =>
            (
              await remoteArtifacts.openEncrypted({
                vaultId,
                serverOrigin: configuration.serverOrigin,
                object,
                scope: { type: "ActiveGeneration", generationId },
                retention: "Transient",
                ...(signal === undefined ? {} : { signal }),
              })
            ).stream,
        },
      ).run(active.vault.requireKeyring());
    }
  } catch (error) {
    if (signal?.aborted) return;
    testingFaultCheckpoint?.recordFailure(error);
    const job = await accountRepository.latestSynchronizationJob();
    if (job === undefined) throw error;
    const id =
      error instanceof Error && "id" in error ? String(error.id) : "SYNCHRONIZATION_INTERRUPTED";
    if (id === "VAULT_CONTEXT_CHANGED" && job.vaultId !== undefined) {
      const { errorId: _errorId, retryAt: _retryAt, ...stableJob } = job;
      await accountRepository.saveSynchronizationJob({
        ...stableJob,
        state: "Succeeded",
        stage: "Checkpoint",
        updatedAt: new Date().toISOString(),
      });
      void synchronizationCoordinator.mutation(job.vaultId);
      await notifyAppStateChanged();
      return;
    }
    if (id === "VAULT_GENERATION_SUPERSEDED") {
      const details = canonicalRecord(
        error instanceof Error && "responseBody" in error ? error.responseBody : undefined,
        "supersededGeneration",
        [
          "outcome",
          "retryable",
          "requestId",
          "currentGenerationId",
          "currentGenerationNumber",
          "headCursor",
        ],
      );
      if (
        details.outcome !== "VAULT_GENERATION_SUPERSEDED" ||
        details.retryable !== false ||
        typeof details.requestId !== "string"
      )
        throw Object.assign(new Error("Superseded Generation response is invalid"), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      uuid(details.requestId, "supersededGeneration.requestId");
      if (job.vaultId === undefined)
        throw Object.assign(new Error("Superseded Generation job is incomplete"), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      const remote = remoteVaultHead(
        (
          await new SynchronizationHttp(
            configuration.serverOrigin,
            await deviceSessionManager(job.vaultId),
            fetch,
            signal,
          ).request("GET", "/api/vaults")
        ).body,
      );
      if (
        remote.vaultId !== job.vaultId ||
        remote.generationId !== details.currentGenerationId ||
        remote.generationNumber !== details.currentGenerationNumber ||
        remote.headCursor !== details.headCursor
      )
        throw Object.assign(new Error("Superseded Generation authority changed"), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      await accountRepository.recordSupersededGeneration({
        job,
        generationId: uuid(details.currentGenerationId, "supersededGeneration.currentGenerationId"),
        generationNumber: integer(
          details.currentGenerationNumber,
          "supersededGeneration.currentGenerationNumber",
        ),
        headCursor: integer(details.headCursor, "supersededGeneration.headCursor"),
        ...(remote.predecessorGenerationId === undefined
          ? {}
          : { predecessorGenerationId: remote.predecessorGenerationId }),
        now: new Date().toISOString(),
      });
      await notifyAppStateChanged();
      return;
    }
    const terminal =
      id === "SYNCHRONIZATION_INTEGRITY_FAILED" ||
      id === "SYNCHRONIZATION_CONFLICT" ||
      id === "KEY_EPOCH_CHANGED";
    const authentication =
      id === "SYNCHRONIZATION_AUTHENTICATION_REQUIRED" || id === "AUTHENTICATION_FAILED";
    const retryCount = job.retryCount + 1;
    await accountRepository.saveSynchronizationJob({
      ...job,
      state: terminal
        ? id === "SYNCHRONIZATION_CONFLICT" || id === "KEY_EPOCH_CHANGED"
          ? "Conflict"
          : "Failed"
        : authentication
          ? "AuthenticationRequired"
          : "Waiting",
      retryCount,
      updatedAt: new Date().toISOString(),
      ...(terminal || authentication
        ? { errorId: id }
        : {
            retryAt: new Date(
              Date.now() + Math.min(5_000 * 2 ** (retryCount - 1), 15 * 60_000),
            ).toISOString(),
            errorId: "SYNCHRONIZATION_INTERRUPTED",
          }),
    });
  }
  const registration = await accountRepository.loadAccountVault();
  if (registration !== undefined) {
    const cableContext = `${configuration.serverOrigin}\n${registration.vaultId}`;
    if (activeCable === undefined || activeCableContext !== cableContext) {
      activeCable?.disconnect();
      const transport = new SynchronizationHttp(
        configuration.serverOrigin,
        await deviceSessionManager(registration.vaultId),
        fetch,
        signal,
      );
      activeCable = new CableHintSubscriber(
        configuration.serverOrigin,
        transport,
        (latestCursor) => {
          void synchronizationCoordinator.cable(latestCursor);
        },
      );
      activeCableContext = cableContext;
      await activeCable.connect(registration.vaultId).catch(() => undefined);
    }
  }
  await notifyAppStateChanged();
}

async function replayStaleEpochCapturesBeforeUpload(input: {
  readonly job: import("../drivers/indexeddb/schema").SynchronizationJobV1 & {
    readonly vaultId: string;
  };
  readonly activeKeyEpochId: string;
  readonly driver: IndexedDbDriver;
  readonly transport: SynchronizationHttp;
  readonly signal?: AbortSignal;
}): Promise<ReadonlySet<string>> {
  if (input.job.generationId === undefined || input.job.generationNumber === undefined)
    throw Object.assign(new Error("Synchronization Generation authority is unavailable."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const context = contexts.snapshot(input.job.vaultId);
  if (!context.vault.isUnlocked())
    throw Object.assign(new Error("The Vault must be unlocked to replay unpublished work."), {
      id: "VAULT_LOCKED",
    });
  const [head, events, objects, records] = await Promise.all([
    input.driver.getVaultHead(),
    input.driver.listStoredEvents(),
    input.driver.listStoredObjects(),
    vaultRepository.load(input.job.vaultId),
  ]);
  if (head === undefined || records === undefined)
    throw Object.assign(new Error("Local Vault replay authority is unavailable."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const proof = await new ActiveGenerationStorageReliefProver(input.transport).prove({
    vaultId: input.job.vaultId,
    generationId: input.job.generationId,
    generationNumber: input.job.generationNumber,
    candidates: [],
  });
  const remoteIds = new Set(proof.records.keys());
  const staleEvents = events
    .filter(
      (event) =>
        head.appendedEventIds.includes(event.eventId) &&
        !remoteIds.has(event.eventId) &&
        decodeEncryptedEnvelopeBytes(event.envelopeBytes).keyEpochId !== input.activeKeyEpochId,
    )
    .toSorted((left, right) =>
      left.orderingTimestamp === right.orderingTimestamp
        ? left.eventId.localeCompare(right.eventId)
        : left.orderingTimestamp.localeCompare(right.orderingTimestamp),
    );
  if (staleEvents.length === 0) return remoteIds;
  const objectsById = new Map(objects.map((object) => [object.objectId, object]));
  const replays: Awaited<ReturnType<typeof prepareStaleCaptureReplay>>[] = [];
  try {
    for (const event of staleEvents)
      replays.push(
        await prepareStaleCaptureReplay({
          vaultId: input.job.vaultId,
          deviceId: records.metadata.deviceId,
          event,
          objects: objectsById,
          keyring: context.vault.requireKeyring(),
          artifacts: artifactStore,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
    const replacedObjectIds = new Set(replays.flatMap((replay) => replay.oldObjectIds));
    const replacedEventIds = new Set(replays.map((replay) => replay.oldEventId));
    await input.driver.commitStaleEpochCaptureReplays({
      expectedHead: head,
      retainedObjectIds: head.appendedObjectIds.filter((id) => !replacedObjectIds.has(id)),
      retainedEventIds: head.appendedEventIds.filter((id) => !replacedEventIds.has(id)),
      replays,
    });
  } catch (error) {
    await Promise.all(
      replays.flatMap((replay) =>
        replay.preparedArtifactObjectIds.map((objectId) =>
          artifactStore.remove(input.job.vaultId, objectId),
        ),
      ),
    );
    throw error;
  }
  await notifyAppStateChanged();
  return remoteIds;
}

async function currentRemoteKeyEpochBeforeUpload(
  serverOrigin: string,
  vaultId: string,
  signal?: AbortSignal,
): Promise<string> {
  const read = async (): Promise<string> => {
    const remote = canonicalRecord(
      (
        await new SynchronizationHttp(
          serverOrigin,
          await deviceSessionManager(vaultId),
          fetch,
          signal,
        ).request("GET", `/api/vaults/${vaultId}`)
      ).body,
      "uploadVaultAuthority",
      [
        "vaultId",
        "state",
        "generationId",
        "generationNumber",
        "headCursor",
        "activeKeyEpochId",
        "predecessorGenerationId",
      ],
    );
    if (
      uuid(remote.vaultId, "uploadVaultAuthority.vaultId") !== vaultId ||
      remote.state !== "Active"
    )
      throw Object.assign(new Error("Remote Vault authority is invalid."), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    return uuid(remote.activeKeyEpochId, "uploadVaultAuthority.activeKeyEpochId");
  };
  try {
    return await read();
  } catch (error) {
    const errorId = error instanceof Error && "id" in error ? String(error.id) : undefined;
    if (
      errorId !== "AUTHENTICATION_FAILED" &&
      errorId !== "SYNCHRONIZATION_AUTHENTICATION_REQUIRED" &&
      errorId !== "DEVICE_REVOKED"
    )
      throw error;
  }
  activeDeviceSessionManager?.clearAccessToken();
  try {
    return await read();
  } catch (error) {
    const errorId = error instanceof Error && "id" in error ? String(error.id) : undefined;
    if (
      errorId !== "AUTHENTICATION_FAILED" &&
      errorId !== "SYNCHRONIZATION_AUTHENTICATION_REQUIRED" &&
      errorId !== "DEVICE_REVOKED"
    )
      throw error;
  }
  const [account, registration] = await Promise.all([
    accountRepository.loadMetadata(),
    accountRepository.loadAccountVault(),
  ]);
  if (account === undefined || account.scope !== "Account" || registration?.vaultId !== vaultId)
    throw Object.assign(new Error("Account authority is unavailable."), {
      id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
    });
  const accessToken = await deviceAuthorityRefresh.refresh({
    account,
    registration,
  });
  if (accessToken === undefined)
    throw Object.assign(new Error("Device authority is unavailable."), {
      id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
    });
  (await deviceSessionManager(vaultId)).setAccessToken(accessToken);
  await contexts.reloadFromAuthority();
  const activeKeyEpochId = await read();
  if (contexts.snapshot(vaultId).vault.requireActiveKeyEpochId() !== activeKeyEpochId)
    throw Object.assign(new Error("Local and remote key epochs differ after authority refresh."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  return activeKeyEpochId;
}

const synchronizationCoordinator = new SynchronizationCoordinator({
  execute: executeSynchronization,
  preparePassivePoll: async () => {
    await accountRepository.wakePull();
  },
  prepareInteractiveWake: async () => {
    const job = await accountRepository.latestSynchronizationJob();
    if (job?.errorId === "VAULT_GENERATION_SUPERSEDED") {
      await discoverAccountVault();
      return;
    }
    if (job?.state === "Waiting") await accountRepository.retrySynchronization();
    await accountRepository.wakePull();
  },
  prepareMutation: async (vaultId) => {
    await accountRepository.wakeSynchronization(vaultId);
  },
  prepareCableWake: async (latestCursor) => {
    const job = await accountRepository.latestSynchronizationJob();
    if (job?.state === "Waiting") await accountRepository.retrySynchronization();
    await accountRepository.wakePull(latestCursor);
  },
});

async function reconcileFirefoxSynchronizationPermission(): Promise<void> {
  if (!firefoxHost) return;
  const configuration = await accountRepository.loadConfiguration();
  if (configuration.mode !== "Configured") {
    await notifyAppStateChanged();
    return;
  }
  if (await firefoxSynchronizationPermissionGranted(configuration.serverOrigin)) {
    await notifyAppStateChanged();
    void synchronizationCoordinator.passivePoll();
    return;
  }
  serverSwitchController?.abort();
  for (const controller of storageReliefControllers.values()) controller.abort();
  activeCable?.disconnect();
  activeCable = undefined;
  activeCableContext = undefined;
  activeSessionManager = undefined;
  activeSessionOrigin = undefined;
  candidateSessionManager = undefined;
  candidateSessionOrigin = undefined;
  await synchronizationCoordinator.replaceContext(async () => undefined);
  await notifyAppStateChanged();
}

browser.permissions.onAdded.addListener(() => {
  void reconcileFirefoxSynchronizationPermission();
});
browser.permissions.onRemoved.addListener(() => {
  void reconcileFirefoxSynchronizationPermission();
});

async function storageReliefContext(expectedVaultId: string) {
  const context = contexts.snapshot(expectedVaultId);
  const [configuration, metadata, registration, authenticated, head] = await Promise.all([
    accountRepository.loadConfiguration(),
    accountRepository.loadMetadata(),
    accountRepository.loadAccountVault(),
    accountRepository.hasAuthenticatedSecrets(),
    context.driver.getVaultHead(),
  ]);
  if (
    configuration.mode !== "Configured" ||
    metadata === undefined ||
    registration?.vaultId !== context.vaultId ||
    head === undefined
  )
    throw Object.assign(new Error("The synchronized Vault context is unavailable."), {
      id: "VAULT_CONTEXT_CHANGED",
    });
  return { context, configuration, metadata, authenticated, head };
}

function storageReliefService(context: ReturnType<typeof contexts.snapshot>): StorageReliefService {
  return new StorageReliefService(
    {
      getVaultHead: () => context.driver.getVaultHead(),
      listRemoteOnlyArtifacts: (vaultId) =>
        storageReliefRepository.listRemoteOnlyArtifacts(vaultId),
      createStorageReliefJob: (input) => storageReliefRepository.createStorageReliefJob(input),
    },
    new StorageReliefCandidateEnumerator(context.driver, artifactStore, storageReliefRepository),
    () => crypto.randomUUID(),
    storageReliefCreationFaults,
  );
}

async function runStorageRelief(vaultId: string): Promise<void> {
  if (storageReliefControllers.has(vaultId)) return;
  const controller = new AbortController();
  storageReliefControllers.set(vaultId, controller);
  const resumeSynchronization = await synchronizationCoordinator.suspend();
  try {
    const runner = new StorageReliefJobRunner(
      liveStorageReliefRepository,
      artifactStore,
      {
        current: async () => {
          const current = await storageReliefContext(vaultId);
          return {
            vaultId,
            accountId: current.metadata.accountId,
            serverOrigin: current.configuration.serverOrigin,
            unlocked: current.context.vault.isUnlocked(),
            authenticated: current.authenticated,
            head: current.head,
          };
        },
        synchronize: async (signal) => {
          await accountRepository.wakeSynchronization(vaultId);
          await executeSynchronization(signal);
          const job = await accountRepository.latestSynchronizationJob();
          if (job?.state === "AuthenticationRequired")
            throw Object.assign(new Error("Authentication is required."), {
              id: "STORAGE_RELIEF_AUTHENTICATION_REQUIRED",
            });
          if (job?.state === "Conflict")
            throw Object.assign(new Error("The local Replica is stale."), {
              id: "SYNCHRONIZATION_CONFLICT",
            });
          if (job?.state === "Waiting" || job?.state === "Failed")
            throw Object.assign(new Error("Synchronization did not complete."), {
              id: job.errorId ?? "SYNCHRONIZATION_INTERRUPTED",
            });
        },
        prove: async (signal) => {
          const current = await storageReliefContext(vaultId);
          if (!current.context.vault.isUnlocked())
            throw Object.assign(new Error("The Vault is locked."), {
              id: "VAULT_LOCKED",
            });
          const candidates = await new StorageReliefCandidateEnumerator(
            current.context.driver,
            artifactStore,
            storageReliefRepository,
          ).enumerate(vaultId, current.context.vault.requireKeyring());
          return new ActiveGenerationStorageReliefProver(
            new SynchronizationHttp(
              current.configuration.serverOrigin,
              await deviceSessionManager(vaultId),
              fetch,
              signal,
            ),
          ).prove({
            vaultId,
            generationId: current.head.generationId,
            generationNumber: current.head.generationNumber,
            candidates: candidates.candidates,
          });
        },
        recheckRemoteFence: async (signal) => {
          const current = await storageReliefContext(vaultId);
          const proof = await new ActiveGenerationStorageReliefProver(
            new SynchronizationHttp(
              current.configuration.serverOrigin,
              await deviceSessionManager(vaultId),
              fetch,
              signal,
            ),
          ).prove({
            vaultId,
            generationId: current.head.generationId,
            generationNumber: current.head.generationNumber,
            candidates: [],
          });
          return {
            generationId: proof.generationId,
            generationNumber: proof.generationNumber,
          };
        },
      },
      storageReliefFaults,
    );
    await runner.run(vaultId, new Date().toISOString(), controller.signal);
    const result = await storageReliefRepository.latestStorageReliefJob(vaultId);
    if (result?.state === "AuthenticationRequired") {
      await (await sessionManager()).logout();
      activeSessionManager = undefined;
      activeSessionOrigin = undefined;
    }
  } finally {
    storageReliefControllers.delete(vaultId);
    resumeSynchronization();
    await notifyAppStateChanged();
  }
}

function runEnrollment(): Promise<void> {
  return synchronizationCoordinator.continue();
}

async function discoverAccountVault(): Promise<void> {
  const configuration = await accountRepository.loadConfiguration();
  if (configuration.mode !== "Configured") return;
  const discovery = new AccountVaultDiscovery(
    accountRepository,
    new SynchronizationHttp(configuration.serverOrigin, await sessionManager()),
  );
  await discovery.run();
}

async function notifyAppStateChanged(): Promise<void> {
  await browser.runtime.sendMessage({ type: "AppStateChanged" }).catch(() => undefined);
}

async function clearOriginPrivateFileSystem(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
}

async function resetLocalDevice(): Promise<void> {
  for (const controller of storageReliefControllers.values()) controller.abort();
  for (const controller of importControllers.values()) controller.abort();
  for (const controller of exportControllers.values()) controller.abort();
  serverSwitchController?.abort();
  activeCable?.disconnect();
  activeCable = undefined;
  activeCableContext = undefined;
  await cancelArtifactSessions();
  await synchronizationCoordinator.replaceContext(async () => {
    await activeSessionManager?.logout().catch(() => undefined);
    await candidateSessionManager?.logout().catch(() => undefined);
    activeSessionManager = undefined;
    activeSessionOrigin = undefined;
    candidateSessionManager = undefined;
    candidateSessionOrigin = undefined;
    await contexts.shutdown();
    await Promise.all([
      accountRepository.close(),
      deviceRepository.close(),
      serverSwitchRepository.close(),
      storageReliefRepository.close(),
      importRepository.close(),
      vaultReplacementRepository.close(),
      workspaceRepository.close(),
    ]);
    await vaultRepository.deleteDatabase();
    await clearOriginPrivateFileSystem();
  });
}

function wakeVaultSynchronization(vaultId: string): void {
  void synchronizationCoordinator.mutation(vaultId);
}

async function assertVaultMutationAllowed(
  vaultId: string,
  allowedReplacementJobId?: string,
): Promise<void> {
  const [serverSwitch, replacement] = await Promise.all([
    serverSwitchRepository.loadJob(),
    vaultReplacementRepository.latestForVault(vaultId),
  ]);
  if (
    serverSwitch?.vaultId === vaultId &&
    serverSwitch.state === "Running" &&
    serverSwitch.stage !== "Compare"
  )
    throw Object.assign(new Error("The Vault is applying a Server Switch."), {
      id: "VAULT_BUSY",
    });
  if (
    replacement !== undefined &&
    replacement.jobId !== allowedReplacementJobId &&
    !["Succeeded", "Failed", "Aborted"].includes(replacement.state)
  )
    throw Object.assign(new Error("The Vault is being re-encrypted."), { id: "VAULT_BUSY" });
  const job = await accountRepository.latestSynchronizationJob();
  if (job?.vaultId === vaultId && job.state === "Conflict")
    throw Object.assign(new Error("This stale Replica is read-only until it is resolved."), {
      id: "SYNCHRONIZATION_CONFLICT",
    });
}

async function assertNoApplyingServerSwitch(): Promise<void> {
  const job = await serverSwitchRepository.loadJob();
  if (job?.state === "Running" && job.stage !== "Compare")
    throw Object.assign(new Error("A Server Switch is applying."), {
      id: "VAULT_BUSY",
    });
}

async function synchronizationOriginForRequest(request: AppRequest): Promise<string | undefined> {
  switch (request.type) {
    case "ConfigureSyncServer":
      return request.serverOrigin;
    case "BeginServerSwitch":
      return request.candidateOrigin;
    case "LoginServerSwitchCandidate":
    case "RetryServerSwitch":
      return (await serverSwitchRepository.loadJob())?.candidateOrigin;
    case "WakeSynchronization":
    case "RetrySynchronization":
    case "DiscardStaleReplica":
    case "LoginAccount":
    case "PrepareAccountVault":
    case "ConfirmInitialVault":
    case "RecoverAccountVault":
    case "PrepareVaultReplacement":
    case "ConfirmVaultReplacement":
    case "RetryVaultReplacement":
    case "GetStorageReliefEstimate":
    case "StartStorageRelief": {
      const configuration = await accountRepository.loadConfiguration();
      return configuration.mode === "Configured" ? configuration.serverOrigin : undefined;
    }
    default:
      return undefined;
  }
}

const contexts = new WorkspaceContextManager({
  workspaceRepository,
  createVaultPreparer: () => new VaultService(vaultRepository),
  createVaultService: (vaultId) => new VaultService(vaultRepository, vaultId, deviceRepository),
  createDriver: (vaultId) => new IndexedDbDriver(databaseName, vaultId),
  notify: notifyAppStateChanged,
});
const captureHost = firefoxHost ? new FirefoxCaptureHost() : new ChromeCaptureHost();
const artifactStore = new OpfsArtifactStore();
const liveVaultReplacementRepository = {
  create: async (job: import("../drivers/indexeddb").VaultReplacementJobV1) => {
    await vaultReplacementRepository.create(job);
    await notifyAppStateChanged();
  },
  save: async (
    job: import("../drivers/indexeddb").VaultReplacementJobV1,
    expectedUpdatedAt: string,
  ) => {
    await vaultReplacementRepository.save(job, expectedUpdatedAt);
    await notifyAppStateChanged();
  },
  find: (jobId: string) => vaultReplacementRepository.find(jobId),
  sealCheckpoint: (input: Parameters<IndexedDbVaultReplacementRepository["sealCheckpoint"]>[0]) =>
    vaultReplacementRepository.sealCheckpoint(input),
  openCheckpoint: (job: import("../drivers/indexeddb").VaultReplacementJobV1) =>
    vaultReplacementRepository.openCheckpoint(job),
  clearSensitive: (job: import("../drivers/indexeddb").VaultReplacementJobV1) =>
    vaultReplacementRepository.clearSensitive(job),
};
let replacementAccessToken: string | undefined;
const replacementTransport = {
  useDeviceAccessToken(accessToken: string): void {
    replacementAccessToken = accessToken;
  },
  async tokens() {
    const accessToken = replacementAccessToken;
    return accessToken === undefined
      ? await deviceSessionManager()
      : { accessToken: async () => accessToken };
  },
  async request(method: string, path: string, body?: unknown, idempotencyKey?: string) {
    const configuration = await accountRepository.loadConfiguration();
    if (configuration.mode !== "Configured")
      throw Object.assign(new Error("Synchronization server is unavailable."), {
        id: "SERVER_INCOMPATIBLE",
      });
    return new SynchronizationHttp(configuration.serverOrigin, await this.tokens()).request(
      method,
      path,
      body,
      idempotencyKey,
    );
  },
  async putTransfer(url: string, part: number, bytes: Uint8Array) {
    const configuration = await accountRepository.loadConfiguration();
    if (configuration.mode !== "Configured")
      throw Object.assign(new Error("Synchronization server is unavailable."), {
        id: "SERVER_INCOMPATIBLE",
      });
    return new SynchronizationHttp(configuration.serverOrigin, await this.tokens()).putTransfer(
      url,
      part,
      bytes,
    );
  },
  async getTransfer(url: string, expectedByteLength: number) {
    const configuration = await accountRepository.loadConfiguration();
    if (configuration.mode !== "Configured")
      throw Object.assign(new Error("Synchronization server is unavailable."), {
        id: "SERVER_INCOMPATIBLE",
      });
    return new SynchronizationHttp(configuration.serverOrigin, await this.tokens()).getTransfer(
      url,
      expectedByteLength,
    );
  },
};
const vaultReplacement = new VaultReplacementService(
  liveVaultReplacementRepository,
  workspaceRepository,
  artifactStore,
);
const vaultReplacementRemote = new VaultReplacementRemote(replacementTransport);
const vaultReplacementLocal = new VaultReplacementLocalState(
  workspaceRepository,
  vaultRepository,
  (vaultId) => new IndexedDbDriver(databaseName, vaultId),
  async (vaultId) => (await deviceSessionManager(vaultId)).accessToken(),
);
const vaultReplacementPromoter = new VaultReplacementLocalPromoter(
  workspaceRepository,
  artifactStore,
  liveVaultReplacementRepository,
);
const vaultReplacementRunner = new VaultReplacementRunner(
  liveVaultReplacementRepository,
  vaultReplacementLocal,
  vaultReplacementRemote,
  {
    async run(job: import("../drivers/indexeddb").VaultReplacementJobV1, now?: string) {
      if (job.targetVaultId === undefined)
        throw Object.assign(new Error("Replacement target Vault is unavailable."), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      const driver = new IndexedDbDriver(databaseName, job.targetVaultId);
      try {
        await new VaultReplacementGraphUploader(
          accountRepository,
          driver,
          artifactStore,
          replacementTransport,
        ).run(job, now);
      } finally {
        driver.close();
      }
    },
  } as unknown as VaultReplacementGraphUploader,
  new VaultReplacementRemoteValidator(replacementTransport),
  vaultReplacementPromoter,
);

function sameVaultHead(
  left: import("../drivers/indexeddb/schema").StoredVaultHeadV1,
  right: import("../drivers/indexeddb/schema").StoredVaultHeadV1,
): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.generationId === right.generationId &&
    left.generationNumber === right.generationNumber &&
    left.appendedObjectIds.join("\n") === right.appendedObjectIds.join("\n") &&
    left.appendedEventIds.join("\n") === right.appendedEventIds.join("\n")
  );
}

async function compareServerSwitch(accessToken?: string): Promise<void> {
  const job = await serverSwitchRepository.loadJob();
  if (job?.state !== "Running" || job.stage !== "Compare") return;
  const context = contexts.snapshot(job.vaultId);
  if (!context.vault.isUnlocked()) {
    await liveServerSwitchRepository.saveJob({
      ...job,
      state: "WaitingForUnlock",
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const records = await vaultRepository.load(job.vaultId);
  const freshHead = await context.driver.getVaultHead();
  if (records === undefined || freshHead === undefined)
    throw Object.assign(new Error("Local Vault authority is unavailable"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const localGeneration = await context.driver.getVaultGeneration(freshHead.generationId);
  if (localGeneration === undefined)
    throw Object.assign(new Error("Local Generation is unavailable"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const controller = new AbortController();
  serverSwitchController?.abort();
  serverSwitchController = controller;
  const transport = new SynchronizationHttp(
    job.candidateOrigin,
    await serverSwitchSession(job.candidateOrigin, accessToken),
    fetch,
    controller.signal,
  );
  const localRootBytes = await unwrapDeviceSlot(records.deviceSlot, records.deviceKey);
  try {
    let candidateVaultTransport: SynchronizationHttp | undefined;
    const inspected = await new ServerSwitchCandidateInspector(
      accountRepository,
      transport,
      async (vaultId) => {
        if (vaultId !== job.vaultId)
          throw Object.assign(new Error("Candidate Device authority is unavailable"), {
            id: "SYNCHRONIZATION_INTEGRITY_FAILED",
          });
        candidateVaultTransport = await serverSwitchDeviceTransport(
          job,
          transport,
          controller.signal,
        );
        return candidateVaultTransport;
      },
    ).inspect(job.vaultId, localRootBytes);
    if (inspected.replica !== undefined && candidateVaultTransport === undefined)
      throw Object.assign(new Error("Candidate Vault transport is unavailable."), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    const candidateTransport =
      inspected.replica === undefined ? transport : candidateVaultTransport;
    if (candidateTransport === undefined)
      throw Object.assign(new Error("Candidate synchronization transport is unavailable."), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    const immutableIntersectionEqual = true;
    let candidateClosure: Awaited<ReturnType<typeof verifyPreparedRemoteReplica>> | undefined;
    if (inspected.replica === undefined) {
      const [metadata, activeRegistration] = await Promise.all([
        accountRepository.loadMetadata("server-switch-candidate"),
        accountRepository.loadAccountVault(),
      ]);
      if (
        metadata === undefined ||
        activeRegistration === undefined ||
        activeRegistration.vaultId !== job.vaultId ||
        activeRegistration.activeRecoveryGenerationId === undefined ||
        activeRegistration.activeKeyEpochId === undefined
      )
        throw Object.assign(new Error("Candidate Account authority is unavailable"), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      await accountRepository.saveAccountVault(
        inspected.registration ?? {
          version: 1,
          accountId: metadata.accountId,
          vaultId: job.vaultId,
          activeRecoveryGenerationId: activeRegistration.activeRecoveryGenerationId,
          activeKeyEpochId: activeRegistration.activeKeyEpochId,
          ...(activeRegistration.remoteGenerationId === undefined
            ? {}
            : { remoteGenerationId: activeRegistration.remoteGenerationId }),
          ...(activeRegistration.remoteGenerationNumber === undefined
            ? {}
            : {
                remoteGenerationNumber: activeRegistration.remoteGenerationNumber,
              }),
          deliveryCursor: 0,
        },
        "server-switch-candidate",
      );
    } else {
      const candidateGenerationId = inspected.replica.generation.generationId;
      const metadata = await accountRepository.loadMetadata("server-switch-candidate");
      if (metadata === undefined)
        throw Object.assign(new Error("Candidate Account metadata is unavailable"), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      const existing = {
        generation: localGeneration,
        events: await context.driver.listStoredEvents(),
        objects: await context.driver.listStoredObjects(),
      };
      const prepared = await new RemoteReplicaDownloader(candidateTransport, artifactStore).prepare(
        {
          version: 1,
          jobId: job.jobId,
          accountId: metadata.accountId,
          vaultId: job.vaultId,
          generationId: inspected.replica.generation.generationId,
          generationNumber: inspected.replica.generation.generationNumber,
          ...(inspected.replica.generation.predecessorGenerationId === undefined
            ? {}
            : {
                predecessorGenerationId: inspected.replica.generation.predecessorGenerationId,
              }),
          state: "Running",
          stage: "DownloadRecords",
          snapshotCursor: inspected.headCursor,
          createdAt: job.createdAt,
          updatedAt: new Date().toISOString(),
          completedItems: 0,
          totalItems: 0,
          processedBytes: 0,
          totalBytes: 0,
          retryCount: 0,
          attachIdempotencyKey: job.attachIdempotencyKey,
        },
        context.vault.requireKeyring(),
        existing,
      );
      candidateClosure = await verifyPreparedRemoteReplica({
        vaultId: job.vaultId,
        prepared,
        keyring: context.vault.requireKeyring(),
        artifacts: artifactStore,
        openArtifact: (object) =>
          new ArtifactResolver(artifactStore, storageReliefRepository, candidateTransport, {
            online: () => navigator.onLine,
          }).openRemoteEncrypted({
            vaultId: job.vaultId,
            serverOrigin: job.candidateOrigin,
            object,
            scope: {
              type: "ActiveGeneration",
              generationId: candidateGenerationId,
            },
            retention: "Transient",
          }),
      });
      if (inspected.registration !== undefined)
        await accountRepository.saveAccountVault(inspected.registration, "server-switch-candidate");
    }
    const finalHead = await context.driver.getVaultHead();
    if (finalHead === undefined || !sameVaultHead(freshHead, finalHead))
      throw Object.assign(new Error("Local Vault changed during comparison"), {
        id: "VAULT_CONTEXT_CHANGED",
      });
    const localClosure = {
      generation: localGeneration,
      head: freshHead,
      events: await context.driver.listStoredEvents(),
      objects: await context.driver.listStoredObjects(),
    };
    const sourceRecovery =
      inspected.replica !== undefined &&
      candidateClosure !== undefined &&
      localGeneration.predecessorGenerationId === inspected.replica.generation.generationId
        ? await new ServerSwitchRecoveryProver(
            new SynchronizationHttp(job.sourceOrigin, await deviceSessionManager(job.vaultId)),
            artifactStore,
          ).prove({
            vaultId: job.vaultId,
            expected: candidateClosure,
            keyring: context.vault.requireKeyring(),
          })
        : undefined;
    const candidateRecovery =
      inspected.replica !== undefined &&
      candidateClosure !== undefined &&
      inspected.replica.generation.predecessorGenerationId === localGeneration.generationId
        ? await new ServerSwitchRecoveryProver(candidateTransport, artifactStore).prove({
            vaultId: job.vaultId,
            expected: localClosure,
            keyring: context.vault.requireKeyring(),
          })
        : undefined;
    const classification = classifyServerSwitch({
      local: {
        vaultId: job.vaultId,
        generation: {
          generationId: localGeneration.generationId,
          generationNumber: localGeneration.generationNumber,
          ...(localGeneration.predecessorGenerationId === undefined
            ? {}
            : {
                predecessorGenerationId: localGeneration.predecessorGenerationId,
              }),
        },
      },
      ...(inspected.replica === undefined ? {} : { candidate: inspected.replica }),
      rootKeysEqual: true,
      immutableIntersectionEqual,
      ...(sourceRecovery === undefined ? {} : { sourceRecovery }),
      ...(candidateRecovery === undefined ? {} : { candidateRecovery }),
    });
    if (classification.kind === "Conflict") {
      await accountRepository.eraseAuthenticated("server-switch-candidate");
      await accountRepository.eraseAccountVault("server-switch-candidate");
      await serverSwitchRepository.clearCheckpoints(job.jobId);
      await liveServerSwitchRepository.saveJob({
        ...job,
        expectedLocalHead: freshHead,
        state: "Conflict",
        stage: "Terminal",
        errorId: classification.errorId,
        conflictReason: classification.reason,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (classification.kind === "Failure")
      throw Object.assign(new Error(classification.errorId), {
        id: classification.errorId,
      });
    await liveServerSwitchRepository.saveJob({
      ...job,
      expectedLocalHead: freshHead,
      state: "Running",
      stage: classification.direction === "FastForwardLocal" ? "PrepareLocal" : "PrepareRemote",
      direction: classification.direction,
      ...(inspected.replica === undefined
        ? {}
        : {
            candidateGenerationId: inspected.replica.generation.generationId,
            candidateGenerationNumber: inspected.replica.generation.generationNumber,
            ...(inspected.replica.generation.predecessorGenerationId === undefined
              ? {}
              : {
                  candidatePredecessorGenerationId:
                    inspected.replica.generation.predecessorGenerationId,
                }),
            candidateHeadCursor: inspected.headCursor,
          }),
      updatedAt: new Date().toISOString(),
    });
    await runtimeFaultCheckpoint.reach("server-switch:after-classification");
    if (classification.direction === "PublishLocal")
      await new ServerSwitchRemoteApplicator(
        liveServerSwitchRepository,
        accountRepository,
        {
          getVaultHead: () => context.driver.getVaultHead(),
          listStoredObjects: () => context.driver.listStoredObjects(),
          listStoredEvents: () => context.driver.listStoredEvents(),
        },
        sourceArtifactReader(context, freshHead.generationId, controller.signal),
        candidateTransport,
        runtimeFaultCheckpoint,
        serverSwitchRelayFaults,
        serverSwitchAttachmentAuthority,
      ).publishLocal(records);
    if (classification.direction === "FastForwardCandidate")
      await new ServerSwitchRemoteApplicator(
        liveServerSwitchRepository,
        accountRepository,
        {
          getVaultHead: () => context.driver.getVaultHead(),
          listStoredObjects: () => context.driver.listStoredObjects(),
          listStoredEvents: () => context.driver.listStoredEvents(),
        },
        sourceArtifactReader(context, freshHead.generationId, controller.signal),
        candidateTransport,
        runtimeFaultCheckpoint,
        serverSwitchRelayFaults,
        serverSwitchAttachmentAuthority,
      ).fastForwardCandidate(records);
    if (classification.direction === "Union")
      await new ServerSwitchRemoteApplicator(
        liveServerSwitchRepository,
        accountRepository,
        {
          getVaultHead: () => context.driver.getVaultHead(),
          listStoredObjects: () => context.driver.listStoredObjects(),
          listStoredEvents: () => context.driver.listStoredEvents(),
        },
        sourceArtifactReader(context, freshHead.generationId, controller.signal),
        candidateTransport,
        runtimeFaultCheckpoint,
        serverSwitchRelayFaults,
        serverSwitchAttachmentAuthority,
      ).union(records);
    if (
      classification.direction === "PublishLocal" ||
      classification.direction === "FastForwardCandidate"
    )
      await verifyAndPromoteUnchangedLocal(context, candidateTransport, localRootBytes);
    if (classification.direction === "Union" || classification.direction === "FastForwardLocal")
      await applyCandidateReplica(context, candidateTransport);
  } finally {
    localRootBytes.fill(0);
    if (serverSwitchController === controller) serverSwitchController = undefined;
  }
}

function sourceArtifactReader(
  context: ReturnType<typeof contexts.snapshot>,
  generationId: string,
  signal?: AbortSignal,
): Pick<typeof artifactStore, "openEncrypted"> {
  return {
    openEncrypted: async (vaultId, objectId) => {
      const [configuration, object] = await Promise.all([
        accountRepository.loadConfiguration(),
        context.driver.getStoredObject(objectId),
      ]);
      if (configuration.mode !== "Configured" || object?.objectType !== "Artifact")
        throw Object.assign(new Error("Source Artifact context is unavailable."), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      return (
        await new ArtifactResolver(
          artifactStore,
          storageReliefRepository,
          new SynchronizationHttp(
            configuration.serverOrigin,
            await deviceSessionManager(vaultId),
            fetch,
            signal,
          ),
          { online: () => navigator.onLine },
        ).openEncrypted({
          vaultId,
          serverOrigin: configuration.serverOrigin,
          object,
          scope: { type: "ActiveGeneration", generationId },
          retention: "Transient",
          ...(signal === undefined ? {} : { signal }),
        })
      ).stream;
    },
  };
}

async function serverSwitchAttachmentAuthority(vaultId: string, activeKeyEpochId: string) {
  const [candidateAccount, authority, recoveryKit] = await Promise.all([
    accountRepository.loadMetadata("server-switch-candidate"),
    deviceRepository.loadDeviceAuthority(vaultId),
    accountRepository.loadRecoveryKit(vaultId),
  ]);
  if (
    candidateAccount === undefined ||
    candidateAccount.scope !== "Account" ||
    authority === undefined ||
    recoveryKit === undefined ||
    authority.vaultId !== vaultId ||
    authority.recoveryGenerationId !== recoveryKit.recoveryGenerationId
  )
    throw Object.assign(new Error("Server Switch attachment authority is unavailable."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const envelope = authority.envelopes.find(
    (candidate) => candidate.metadata.keyEpochId === activeKeyEpochId,
  );
  if (envelope === undefined)
    throw Object.assign(new Error("Server Switch active Key Epoch envelope is unavailable."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  try {
    return {
      recoveryGeneration: recoveryKitToWire(recoveryKit),
      deviceCertificate: deviceCertificateToWire(authority.certificate),
      deviceKeyEnvelope: deviceKeyEnvelopeToWire(envelope),
      deviceProofSignature: bytesToBase64Url(
        await createDeviceEnrollmentProof({
          certificate: authority.certificate,
          accountSessionId: candidateAccount.sessionId,
          deviceSigningSecretKey: authority.identity.signingSecretKey,
        }),
      ),
      acceptDeviceSession: async (value: unknown) => {
        const session = decodeAuthenticatedSession(value);
        if (
          session.scope !== "VaultDevice" ||
          session.account.accountId !== candidateAccount.accountId
        )
          throw Object.assign(new Error("Server Switch Device session identity changed."), {
            id: "SYNCHRONIZATION_INTEGRITY_FAILED",
          });
        await deviceRepository.saveServerSwitchCandidateSession(vaultId, session);
      },
    };
  } finally {
    await Promise.all([
      wipe(authority.identity.signingSecretKey),
      wipe(authority.identity.wrappingSecretKey),
      ...authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
    ]);
  }
}

async function serverSwitchDeviceTransport(
  job: import("../drivers/indexeddb").ServerSwitchJobV1,
  accountTransport: SynchronizationHttp,
  signal?: AbortSignal,
): Promise<SynchronizationHttp> {
  const [candidateAccount, authority] = await Promise.all([
    accountRepository.loadMetadata("server-switch-candidate"),
    deviceRepository.loadDeviceAuthority(job.vaultId),
  ]);
  if (
    candidateAccount === undefined ||
    candidateAccount.scope !== "Account" ||
    authority === undefined ||
    authority.vaultId !== job.vaultId
  )
    throw Object.assign(new Error("Candidate Device authority is unavailable"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  try {
    const session = await establishDeviceSession({
      transport: accountTransport,
      accountId: candidateAccount.accountId,
      accountSessionId: candidateAccount.sessionId,
      vaultId: job.vaultId,
      deviceId: authority.identity.deviceId,
      deviceSigningSecretKey: authority.identity.signingSecretKey,
    }).catch(async (error) => {
      if (!(error instanceof Error) || !("id" in error) || error.id !== "AUTHENTICATION_FAILED")
        throw error;
      const proof = await createDeviceEnrollmentProof({
        certificate: authority.certificate,
        accountSessionId: candidateAccount.sessionId,
        deviceSigningSecretKey: authority.identity.signingSecretKey,
      });
      return decodeAuthenticatedSession(
        (
          await accountTransport.request(
            "POST",
            `/api/vaults/${job.vaultId}/devices`,
            {
              deviceCertificate: deviceCertificateToWire(authority.certificate),
              deviceKeyEnvelopes: authority.envelopes.map(deviceKeyEnvelopeToWire),
              deviceProofSignature: bytesToBase64Url(proof),
            },
            crypto.randomUUID(),
          )
        ).body,
      );
    });
    if (session.scope !== "VaultDevice" || session.account.accountId !== candidateAccount.accountId)
      throw Object.assign(new Error("Candidate Device session identity changed"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    await deviceRepository.saveServerSwitchCandidateSession(job.vaultId, session);
    return new SynchronizationHttp(
      job.candidateOrigin,
      { accessToken: async () => session.accessToken },
      fetch,
      signal,
    );
  } finally {
    await Promise.all([
      wipe(authority.identity.signingSecretKey),
      wipe(authority.identity.wrappingSecretKey),
      ...authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
    ]);
  }
}

async function verifyAndPromoteUnchangedLocal(
  context: ReturnType<typeof contexts.snapshot>,
  transport: SynchronizationHttp,
  localRootBytes?: Uint8Array,
): Promise<void> {
  const job = await serverSwitchRepository.loadJob();
  if (
    job?.state !== "Running" ||
    job.stage !== "PromoteContext" ||
    !job.candidateAuthorityChanged ||
    (job.direction !== "PublishLocal" && job.direction !== "FastForwardCandidate")
  )
    throw Object.assign(new Error("Candidate activation was not recorded"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const records = await vaultRepository.load(job.vaultId);
  const localGeneration = await context.driver.getVaultGeneration(
    job.expectedLocalHead.generationId,
  );
  const currentHead = await context.driver.getVaultHead();
  if (
    records === undefined ||
    localGeneration === undefined ||
    currentHead === undefined ||
    !sameVaultHead(currentHead, job.expectedLocalHead)
  )
    throw Object.assign(new Error("Local authority changed before promotion"), {
      id: "VAULT_CONTEXT_CHANGED",
    });
  const ownedRootBytes =
    localRootBytes ?? (await unwrapDeviceSlot(records.deviceSlot, records.deviceKey));
  try {
    const accountTransport = new SynchronizationHttp(
      job.candidateOrigin,
      await serverSwitchSession(job.candidateOrigin),
    );
    const verified = await new ServerSwitchCandidateInspector(
      accountRepository,
      accountTransport,
      async () => transport,
    ).inspect(job.vaultId, ownedRootBytes);
    if (
      verified.replica?.generation.generationId !== currentHead.generationId ||
      verified.replica.generation.generationNumber !== currentHead.generationNumber
    )
      throw Object.assign(new Error("Candidate activation differs from local authority"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    if (verified.registration !== undefined)
      await accountRepository.saveAccountVault(verified.registration, "server-switch-candidate");
    const candidateMetadata = await accountRepository.loadMetadata("server-switch-candidate");
    if (candidateMetadata === undefined)
      throw Object.assign(new Error("Candidate Account metadata is unavailable"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    const prepared = await new RemoteReplicaDownloader(transport, artifactStore).prepare(
      {
        version: 1,
        jobId: job.jobId,
        accountId: candidateMetadata.accountId,
        vaultId: job.vaultId,
        generationId: currentHead.generationId,
        generationNumber: currentHead.generationNumber,
        state: "Running",
        stage: "DownloadRecords",
        snapshotCursor: verified.headCursor,
        createdAt: job.createdAt,
        updatedAt: new Date().toISOString(),
        completedItems: 0,
        totalItems: 0,
        processedBytes: 0,
        totalBytes: 0,
        retryCount: 0,
        attachIdempotencyKey: job.attachIdempotencyKey,
      },
      context.vault.requireKeyring(),
      {
        generation: localGeneration,
        events: await context.driver.listStoredEvents(),
        objects: await context.driver.listStoredObjects(),
      },
    );
    await verifyPreparedRemoteReplica({
      vaultId: job.vaultId,
      prepared,
      keyring: context.vault.requireKeyring(),
      artifacts: artifactStore,
      openArtifact: async (object) =>
        (
          await new ArtifactResolver(artifactStore, storageReliefRepository, transport, {
            online: () => navigator.onLine,
          }).openEncrypted({
            vaultId: job.vaultId,
            serverOrigin: job.candidateOrigin,
            object,
            scope: {
              type: "ActiveGeneration",
              generationId: currentHead.generationId,
            },
            retention: "Transient",
          })
        ).stream,
    });
    await promoteServerSwitch(job);
  } finally {
    if (localRootBytes === undefined) ownedRootBytes.fill(0);
  }
}

async function applyCandidateReplica(
  context: ReturnType<typeof contexts.snapshot>,
  transport: SynchronizationHttp,
): Promise<void> {
  let job = await serverSwitchRepository.loadJob();
  if (
    job?.state !== "Running" ||
    job.stage !== "PrepareLocal" ||
    (job.direction !== "Union" && job.direction !== "FastForwardLocal") ||
    job.candidateGenerationId === undefined ||
    job.candidateGenerationNumber === undefined ||
    job.candidateHeadCursor === undefined
  )
    throw Object.assign(new Error("Candidate local application context is incomplete"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const [metadata, registration, localGeneration, localHead, events, objects, remoteOnly] =
    await Promise.all([
      accountRepository.loadMetadata("server-switch-candidate"),
      accountRepository.loadAccountVault("server-switch-candidate"),
      context.driver.getVaultGeneration(job.expectedLocalHead.generationId),
      context.driver.getVaultHead(),
      context.driver.listStoredEvents(),
      context.driver.listStoredObjects(),
      storageReliefRepository.listRemoteOnlyArtifacts(job.vaultId),
    ]);
  if (
    metadata === undefined ||
    registration === undefined ||
    localGeneration === undefined ||
    localHead === undefined ||
    !sameVaultHead(localHead, job.expectedLocalHead)
  )
    throw Object.assign(new Error("Local authority changed before candidate application"), {
      id: "VAULT_CONTEXT_CHANGED",
    });
  const direction = job.direction;
  const remoteOnlyIds = new Set(remoteOnly.map((entry) => entry.artifactObjectId));
  const reusableObjects = objects.filter(
    (object) =>
      object.objectType !== "Artifact" ||
      (direction === "Union" && !remoteOnlyIds.has(object.objectId)),
  );
  const prepared = await new RemoteReplicaDownloader(transport, artifactStore).prepare(
    {
      version: 1,
      jobId: job.jobId,
      accountId: metadata.accountId,
      vaultId: job.vaultId,
      generationId: job.candidateGenerationId,
      generationNumber: job.candidateGenerationNumber,
      ...(job.candidatePredecessorGenerationId === undefined
        ? {}
        : { predecessorGenerationId: job.candidatePredecessorGenerationId }),
      state: "Running",
      stage: "DownloadRecords",
      snapshotCursor: job.candidateHeadCursor,
      createdAt: job.createdAt,
      updatedAt: new Date().toISOString(),
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: job.attachIdempotencyKey,
    },
    context.vault.requireKeyring(),
    {
      generation: localGeneration,
      events,
      objects: reusableObjects,
    },
  );
  const verified = await verifyPreparedRemoteReplica({
    vaultId: job.vaultId,
    prepared,
    keyring: context.vault.requireKeyring(),
    artifacts: artifactStore,
  });
  if (
    job.direction === "Union" &&
    (job.expectedLocalHead.appendedObjectIds.some(
      (objectId) => !verified.head.appendedObjectIds.includes(objectId),
    ) ||
      job.expectedLocalHead.appendedEventIds.some(
        (eventId) => !verified.head.appendedEventIds.includes(eventId),
      ))
  )
    throw Object.assign(new Error("Candidate union omitted local authority"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const allObjects = new Map(verified.objects.map((entry) => [entry.objectId, entry]));
  const projections = await new LibraryProjectionRebuilder(
    {
      listStoredEvents: () => Promise.resolve(verified.events),
      getStoredObject: (objectId) => Promise.resolve(allObjects.get(objectId)),
      replaceLibraryProjections: () => Promise.resolve(),
    },
    context.vault.requireKeyring(),
    job.vaultId,
    artifactStore,
  ).prepare(new AbortController().signal);
  const workspaceRecords = await workspaceRepository.load();
  if (workspaceRecords === undefined)
    throw Object.assign(new Error("Workspace is unavailable"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const nameCache = await encryptWorkspaceVaultName({
    key: workspaceRecords.nameCacheKey,
    workspaceId: workspaceRecords.metadata.workspaceId,
    vaultId: job.vaultId,
    sourceEventId: projections.vaultNameProjection.sourceEventId,
    name: verified.currentVaultName,
  });
  if (!context.vault.isUnlocked()) {
    await liveServerSwitchRepository.saveJob({
      ...job,
      state: "WaitingForUnlock",
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const finalHead = await context.driver.getVaultHead();
  if (finalHead === undefined || !sameVaultHead(finalHead, job.expectedLocalHead))
    throw Object.assign(new Error("Local authority changed before activation"), {
      id: "VAULT_CONTEXT_CHANGED",
    });
  job = {
    ...job,
    stage: "ActivateLocal",
    updatedAt: new Date().toISOString(),
  };
  await liveServerSwitchRepository.saveJob(job);
  await runtimeFaultCheckpoint.reach("server-switch:before-local-activation");
  job = {
    ...job,
    stage: "PromoteContext",
    updatedAt: new Date().toISOString(),
  };
  await liveServerSwitchRepository.saveJob(job);
  await promoteServerSwitch(job, {
    generation: verified.generation,
    head: verified.head,
    events: verified.events,
    objects: verified.objects,
    libraryProjections: projections.itemProjections,
    collectionProjection: projections.collectionProjection,
    vaultNameProjection: projections.vaultNameProjection,
    nameCache,
    clearArtifactAvailability: job.direction === "FastForwardLocal",
  });
  await artifactStore
    .reconcile(
      job.vaultId,
      new Set(
        verified.objects
          .filter((object) => object.objectType === "Artifact")
          .map((object) => object.objectId),
      ),
    )
    .catch(() => undefined);
}

async function promoteServerSwitch(
  job: import("../drivers/indexeddb").ServerSwitchJobV1,
  replica?: ServerSwitchReplicaPromotion,
): Promise<void> {
  await synchronizationCoordinator.replaceContext(async () => {
    activeCable?.disconnect();
    activeCable = undefined;
    activeCableContext = undefined;
    if (replica === undefined)
      await accountRepository.promoteServerSwitch({
        job,
        candidateOrigin: job.candidateOrigin,
        now: new Date().toISOString(),
      });
    else
      await accountRepository.promoteServerSwitchWithReplica({
        job,
        candidateOrigin: job.candidateOrigin,
        now: new Date().toISOString(),
        replica,
      });
    activeSessionManager = undefined;
    activeSessionOrigin = undefined;
    candidateSessionManager = undefined;
    candidateSessionOrigin = undefined;
    serverSwitchController = undefined;
  });
  const promoted = await serverSwitchRepository.loadJob();
  if (promoted?.stage !== "RevokePriorSession")
    throw Object.assign(new Error("Candidate Account promotion is incomplete"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  await runtimeFaultCheckpoint.reach("server-switch:after-promotion");
  await completePriorRevocation(promoted);
  void synchronizationCoordinator.continue();
}

async function completePriorRevocation(
  job: import("../drivers/indexeddb").ServerSwitchJobV1,
): Promise<void> {
  await new AccountSessionManager(
    new CoordinationAccountHttp(job.sourceOrigin),
    accountRepository,
    "server-switch-prior",
  ).logout();
  await serverSwitchRepository.clearCheckpoints(job.jobId);
  await liveServerSwitchRepository.saveJob({
    ...job,
    state: "Succeeded",
    stage: "Terminal",
    updatedAt: new Date().toISOString(),
  });
}

async function compareServerSwitchSafely(
  accessToken: string,
  afterAuthentication = false,
): Promise<void> {
  try {
    if (afterAuthentication)
      await runtimeFaultCheckpoint.reach("server-switch:after-candidate-authentication");
    const current = await serverSwitchRepository.loadJob();
    if (
      (current?.state === "Running" || current?.state === "WaitingForUnlock") &&
      current.stage !== "Compare"
    ) {
      await serverSwitchSession(current.candidateOrigin, accessToken);
      await reconcileServerSwitchOnStartup(contexts.snapshot(current.vaultId));
    } else await compareServerSwitch(accessToken);
  } catch (error) {
    const job = await serverSwitchRepository.loadJob();
    if (
      firefoxHost &&
      job !== undefined &&
      !(await firefoxSynchronizationPermissionGranted(job.candidateOrigin))
    )
      return;
    testingFaultCheckpoint?.recordFailure(error);
    const errorId =
      error instanceof Error && "id" in error && typeof error.id === "string"
        ? error.id
        : "SYNCHRONIZATION_INTERRUPTED";
    if (job?.state === "Running" && errorId === "SYNCHRONIZATION_AUTHENTICATION_REQUIRED") {
      await accountRepository.eraseAuthenticationSecrets("server-switch-candidate");
      await liveServerSwitchRepository.saveJob({
        ...job,
        state: "AuthenticationRequired",
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const race = serverSwitchRaceDisposition(job, errorId);
    if (job?.state === "Running" && race !== undefined) {
      if (race.kind === "Recompare") {
        if (job.direction === "FastForwardCandidate")
          await new SynchronizationHttp(
            job.candidateOrigin,
            await serverSwitchSession(job.candidateOrigin, accessToken),
          )
            .request(
              "DELETE",
              `/api/vaults/${job.vaultId}/generation-candidates/${job.expectedLocalHead.generationId}`,
              undefined,
              job.candidateIdempotencyKey,
            )
            .catch(() => undefined);
        await serverSwitchRepository.clearCheckpoints(job.jobId);
        const {
          direction: _direction,
          candidateGenerationId: _candidateGenerationId,
          candidateGenerationNumber: _candidateGenerationNumber,
          candidatePredecessorGenerationId: _candidatePredecessorGenerationId,
          candidateHeadCursor: _candidateHeadCursor,
          ...comparable
        } = job;
        await liveServerSwitchRepository.saveJob({
          ...comparable,
          stage: "Compare",
          retryCount: 1,
          updatedAt: new Date().toISOString(),
        });
        await compareServerSwitchSafely(accessToken);
        return;
      }
      await accountRepository.eraseAuthenticated("server-switch-candidate");
      await accountRepository.eraseAccountVault("server-switch-candidate");
      await serverSwitchRepository.clearCheckpoints(job.jobId);
      await liveServerSwitchRepository.saveJob({
        ...job,
        state: "Conflict",
        stage: "Terminal",
        errorId: "SERVER_SWITCH_CONFLICT",
        conflictReason: "DivergedGeneration",
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (shouldFailUncommittedServerSwitch(job)) {
      await accountRepository.eraseAuthenticated("server-switch-candidate");
      await accountRepository.eraseAccountVault("server-switch-candidate");
      await serverSwitchRepository.clearCheckpoints(job.jobId);
      await liveServerSwitchRepository.saveJob({
        ...job,
        state: "Failed",
        stage: "Terminal",
        errorId,
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}
const testingFaultCheckpoint =
  import.meta.env.MODE === "e2e" ? new TestingFaultCheckpoint() : undefined;
const runtimeFaultCheckpoint = testingFaultCheckpoint ?? noRuntimeFaultCheckpoint;
const serverSwitchRelayFaults =
  testingFaultCheckpoint === undefined
    ? undefined
    : {
        beforeSourceArtifactRead: () =>
          testingFaultCheckpoint.reach("server-switch-relay:before-source-artifact-read"),
        afterCandidateUploadPart: () =>
          testingFaultCheckpoint.reach("server-switch-relay:after-candidate-upload-part"),
      };
const storageReliefCreationFaults =
  testingFaultCheckpoint === undefined
    ? undefined
    : {
        afterJobCreated: (signal?: AbortSignal) =>
          testingFaultCheckpoint.reach("storage-relief:after-job-created", signal),
        afterCandidateCheckpoint: (signal?: AbortSignal) =>
          testingFaultCheckpoint.reach("storage-relief:after-candidate-checkpoint", signal),
      };
const storageReliefFaults =
  testingFaultCheckpoint === undefined
    ? undefined
    : {
        afterSynchronization: (signal?: AbortSignal) =>
          testingFaultCheckpoint.reach("storage-relief:after-synchronization", signal),
        afterVerifiedCheckpoint: (signal?: AbortSignal) =>
          testingFaultCheckpoint.reach("storage-relief:after-verified-checkpoint", signal),
        afterEvictingCheckpoint: (signal?: AbortSignal) =>
          testingFaultCheckpoint.reach("storage-relief:after-evicting-checkpoint", signal),
        afterWrapperRemoved: (signal?: AbortSignal) =>
          testingFaultCheckpoint.reach("storage-relief:after-wrapper-removed", signal),
        afterRemoteOnlyCommit: (signal?: AbortSignal) =>
          testingFaultCheckpoint.reach("storage-relief:after-remote-only-commit", signal),
      };
const staleDiscardFaults =
  testingFaultCheckpoint === undefined
    ? undefined
    : {
        prepareServerReplacement: () =>
          testingFaultCheckpoint.reach("stale-discard:prepare-server-replacement"),
        serverReplacementPrepared: () =>
          testingFaultCheckpoint.reach("stale-discard:server-replacement-prepared"),
        beforeActivation: () => testingFaultCheckpoint.reach("stale-discard:before-activation"),
        afterActivation: () => testingFaultCheckpoint.reach("stale-discard:after-activation"),
      };
const artifactRetrievalFaults =
  testingFaultCheckpoint === undefined
    ? undefined
    : {
        afterPartialLocalWrite: () =>
          testingFaultCheckpoint.reach("artifact-retrieval:after-partial-local-write"),
        afterLocalVerify: () =>
          testingFaultCheckpoint.reach("artifact-retrieval:after-local-verify"),
        beforeAvailabilityClear: () =>
          testingFaultCheckpoint.reach("artifact-retrieval:before-availability-clear"),
      };
const exportDownloadFault =
  testingFaultCheckpoint === undefined
    ? undefined
    : () => testingFaultCheckpoint.reach("export-download:before-download");
const exportHost = firefoxHost
  ? new FirefoxVaultExportHost(exportDownloadFault)
  : new ChromeVaultExportHost(exportDownloadFault);
const exportControllers = new Map<string, AbortController>();
const ARTIFACT_MESSAGE_CHUNK_BYTES = 256 * 1024;
interface ArtifactSession {
  readonly vaultId: string;
  readonly bundleId: string;
  readonly role: import("../domain/artifact-graph").ArtifactRole;
  readonly artifactObjectId: string;
  readonly wasRemote: boolean;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  pending?: Uint8Array;
}
const artifactSessions = new Map<string, ArtifactSession>();

async function cancelArtifactSessions(): Promise<void> {
  const sessions = [...artifactSessions.values()];
  artifactSessions.clear();
  await Promise.all(sessions.map((session) => session.reader.cancel().catch(() => undefined)));
}

function artifactFilename(
  bundleId: string,
  role: import("../domain/artifact-graph").ArtifactRole,
): string {
  const extension =
    role === "PRIMARY"
      ? "awsm-page"
      : role === "TEXT_EXTRACTED"
        ? "txt"
        : role === "CONTENT_STRUCTURED"
          ? "cborseq"
          : "webp";
  return `awsm-${bundleId.slice(0, 8)}-${role.toLowerCase().replaceAll("_", "-")}.${extension}`;
}

async function reconcileServerSwitchOnStartup(
  context: ReturnType<typeof contexts.snapshot>,
): Promise<void> {
  let job = await serverSwitchRepository.loadJob();
  if (job === undefined) return;
  let decision = serverSwitchStartupDecision(job, context.vault.isUnlocked());
  if (decision === "PresentAuthentication") return;
  if (decision === "CleanupFailure") {
    await accountRepository.eraseAuthenticated("server-switch-candidate");
    await accountRepository.eraseAccountVault("server-switch-candidate");
    await serverSwitchRepository.clearCheckpoints(job.jobId);
    return;
  }
  if (decision === "CleanupSuccess") {
    const configuration = await accountRepository.loadConfiguration();
    if (
      configuration.mode === "Configured" &&
      configuration.serverOrigin === job.candidateOrigin &&
      !(await accountRepository.hasAuthenticatedSecrets("server-switch-prior"))
    )
      await serverSwitchRepository.deleteJob(job.jobId);
    return;
  }
  if (decision === "WaitForUnlock") {
    if (job.state !== "WaitingForUnlock")
      await liveServerSwitchRepository.saveJob({
        ...job,
        state: "WaitingForUnlock",
        updatedAt: new Date().toISOString(),
      });
    return;
  }
  if (job.state === "WaitingForUnlock") {
    job = { ...job, state: "Running", updatedAt: new Date().toISOString() };
    await liveServerSwitchRepository.saveJob(job);
  }
  decision = serverSwitchStartupDecision(job, true);
  serverSwitchController ??= new AbortController();
  const transport = new SynchronizationHttp(
    job.candidateOrigin,
    await serverSwitchSession(job.candidateOrigin),
    fetch,
    serverSwitchController.signal,
  );
  if (decision === "Compare") {
    await compareServerSwitch();
    return;
  }
  if (decision === "ApplyRemote") {
    const records = await vaultRepository.load(job.vaultId);
    if (records === undefined)
      throw Object.assign(new Error("Server Switch Vault is unavailable"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    const applicator = new ServerSwitchRemoteApplicator(
      liveServerSwitchRepository,
      accountRepository,
      {
        getVaultHead: () => context.driver.getVaultHead(),
        listStoredObjects: () => context.driver.listStoredObjects(),
        listStoredEvents: () => context.driver.listStoredEvents(),
      },
      sourceArtifactReader(
        context,
        job.expectedLocalHead.generationId,
        serverSwitchController.signal,
      ),
      transport,
      runtimeFaultCheckpoint,
      serverSwitchRelayFaults,
      serverSwitchAttachmentAuthority,
    );
    if (job.direction === "PublishLocal") await applicator.publishLocal(records);
    else if (job.direction === "FastForwardCandidate")
      await applicator.fastForwardCandidate(records);
    else if (job.direction === "Union") await applicator.union(records);
    else
      throw Object.assign(new Error("Remote Server Switch direction is invalid"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    job = (await serverSwitchRepository.loadJob()) ?? job;
    decision = serverSwitchStartupDecision(job, true);
  }
  if (decision === "CompleteRemoteActivation") {
    if (!job.candidateAuthorityChanged)
      throw Object.assign(new Error("Remote activation journal is incomplete"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    job = {
      ...job,
      stage: "PromoteContext",
      updatedAt: new Date().toISOString(),
    };
    await liveServerSwitchRepository.saveJob(job);
    decision = serverSwitchStartupDecision(job, true);
  }
  if (
    decision === "ApplyLocal" &&
    job.stage === "PromoteContext" &&
    (job.direction === "Union" || job.direction === "FastForwardLocal")
  ) {
    job = {
      ...job,
      stage: "PrepareLocal",
      updatedAt: new Date().toISOString(),
    };
    await liveServerSwitchRepository.saveJob(job);
  }
  if (decision === "ApplyLocal" && job.stage === "ActivateLocal") {
    job = {
      ...job,
      stage: "PrepareLocal",
      updatedAt: new Date().toISOString(),
    };
    await liveServerSwitchRepository.saveJob(job);
  }
  if (decision === "ApplyLocal" && job.stage === "PrepareLocal") {
    await applyCandidateReplica(
      context,
      await serverSwitchDeviceTransport(job, transport, serverSwitchController.signal),
    );
    return;
  }
  if (decision === "PromoteUnchangedLocal") {
    await verifyAndPromoteUnchangedLocal(
      context,
      await serverSwitchDeviceTransport(job, transport, serverSwitchController.signal),
    );
    return;
  }
  if (decision === "RevokePriorSession") await completePriorRevocation(job);
}

const startup = contexts.initialize().then(async () => {
  await reconcileTemporaryFiles();
  await mhtmlDownloadHost.cleanupOrphans();
  await browser.alarms.create("awsm:synchronization-poll", {
    periodInMinutes: 1,
  });
  if (await new InterruptedStaleDiscardReconciler(accountRepository, artifactStore).execute())
    await notifyAppStateChanged();
  const interruptedImport = await importRepository.latest();
  if (await importRepository.reconcileInterrupted(new Date().toISOString())) {
    if (interruptedImport !== undefined) {
      if (
        interruptedImport.destinationVaultId !== undefined &&
        !(await workspaceRepository.hasVaultDirectoryEntry(interruptedImport.destinationVaultId))
      ) {
        await artifactStore
          .reconcile(interruptedImport.destinationVaultId, new Set())
          .catch(() => undefined);
      }
      await importHost.cleanup(interruptedImport.jobId).catch(() => undefined);
    }
    await notifyAppStateChanged();
  }
  const context = contexts.active();
  if (context === undefined) {
    await synchronizationCoordinator.passivePoll();
    return;
  }
  const interruptedReplacement = await vaultReplacementRepository.latestForVault(context.vaultId);
  if (
    interruptedReplacement !== undefined &&
    !["Succeeded", "Failed", "Aborted"].includes(interruptedReplacement.state)
  ) {
    if (interruptedReplacement.state === "Running") {
      const account = await accountRepository.loadMetadata();
      if (account?.scope === "Account")
        await runVaultReplacement(interruptedReplacement, account).catch(async (error) => {
          await notifyAppStateChanged();
          testingFaultCheckpoint?.recordFailure(error);
        });
    }
    return;
  }
  await reconcileServerSwitchOnStartup(context).catch(async (error) => {
    const job = await serverSwitchRepository.loadJob();
    if (job?.state === "WaitingForUnlock") return;
    if (
      firefoxHost &&
      job !== undefined &&
      !(await firefoxSynchronizationPermissionGranted(job.candidateOrigin))
    )
      return;
    if (job?.state === "Running") {
      await accountRepository.eraseAuthenticated("server-switch-candidate");
      await accountRepository.eraseAccountVault("server-switch-candidate");
      await liveServerSwitchRepository.saveJob({
        ...job,
        state: "Failed",
        errorId:
          error instanceof Error && "id" in error && typeof error.id === "string"
            ? error.id
            : "SYNCHRONIZATION_INTERRUPTED",
        updatedAt: new Date().toISOString(),
      });
      await notifyAppStateChanged();
    }
  });
  await context.driver.reconcileInterruptedVacuum();
  await context.driver.reconcileInterruptedJobs(new Date().toISOString());
  const authoritativeObjects = await context.driver.listStoredObjects();
  await artifactStore.reconcile(
    context.vaultId,
    new Set(
      authoritativeObjects
        .filter((object) => object.objectType === "Artifact")
        .map((object) => object.objectId),
    ),
  );
  const interruptedExport = await context.driver.latestExportJob();
  if (await context.driver.reconcileInterruptedExports(new Date().toISOString())) {
    if (interruptedExport?.state === "Created" || interruptedExport?.state === "Running") {
      await exportHost.cleanup(interruptedExport.packageId).catch(() => undefined);
    }
    await notifyAppStateChanged();
  }
  const storageReliefJob = await storageReliefRepository.latestStorageReliefJob(context.vaultId);
  if (storageReliefJob?.state === "Created" || storageReliefJob?.state === "Running")
    void runStorageRelief(context.vaultId).catch((error) =>
      testingFaultCheckpoint?.recordFailure(error),
    );
  await synchronizationCoordinator.passivePoll();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "awsm:synchronization-poll") return;
  void (async () => {
    const activeVaultId = contexts.active()?.vaultId;
    const replacement =
      activeVaultId === undefined
        ? undefined
        : await vaultReplacementRepository.latestForVault(activeVaultId);
    if (replacement === undefined || ["Succeeded", "Failed", "Aborted"].includes(replacement.state))
      await synchronizationCoordinator.passivePoll();
  })();
});

function isRuntimeErrorId(value: unknown): value is RuntimeErrorId {
  return typeof value === "string" && (RUNTIME_ERROR_IDS as readonly string[]).includes(value);
}

function safeError(error: unknown): AppResponse {
  const candidate =
    typeof error === "object" && error !== null && "id" in error ? error.id : undefined;
  const id = isRuntimeErrorId(candidate) ? candidate : "STORAGE_TRANSACTION_FAILED";
  const messages: Partial<Record<RuntimeErrorId, string>> = {
    VAULT_LOCKED: "Unlock the Vault to continue.",
    UNSUPPORTED_URL: "Only regular HTTP and HTTPS pages can be captured.",
    PERMISSION_DENIED: "The browser did not grant capture permission.",
    PAGE_SNAPSHOT_FAILED: "The rendered page could not be collected.",
    PAGE_SNAPSHOT_TOO_LARGE: "The rendered page exceeds the Capture size limit.",
    PAGE_PACKAGE_FAILED: "The page snapshot could not be packaged safely.",
    MHTML_DOWNLOAD_FAILED: "The MHTML archive could not be downloaded.",
    CAPTURE_INTERRUPTED: "Capture was interrupted. Retry it manually.",
    BUNDLE_INVALID: "The archived capture is missing or corrupt.",
    CRYPTO_AUTHENTICATION_FAILED: "Local Vault encryption could not be initialized.",
    INVALID_VAULT_NAME: "Use a Vault name between 1 and 64 characters without controls.",
    VAULT_NOT_FOUND: "The selected Vault no longer exists.",
    VAULT_CONTEXT_CHANGED: "The active Vault changed. Refresh and try again.",
    VAULT_BUSY: "Wait for the active Vault operation to finish.",
    LIBRARY_STATE_CHANGED: "The Library changed. Refresh it and try again.",
    INVALID_EXPORT_PASSPHRASE: "Use at least 12 characters for the Export passphrase.",
    EXPORT_AUTHENTICATION_FAILED: "The Export could not be authenticated.",
    EXPORT_PACKAGE_INVALID: "The Vault could not be proven safe to export.",
    EXPORT_INTERRUPTED: "Export was interrupted. Retry it manually.",
    EXPORT_DOWNLOAD_FAILED: "The encrypted Vault Package could not be downloaded.",
    IMPORT_AUTHENTICATION_FAILED:
      "The Vault Package could not be authenticated. Check the Export passphrase and try again.",
    IMPORT_PACKAGE_INVALID: "This Vault Package is incomplete, corrupt, or unsupported.",
    SELECTIVE_IMPORT_UNSUPPORTED: "This version can import only Complete Vault Packages.",
    VAULT_ALREADY_EXISTS: "This Vault already exists on this device.",
    IMPORT_INTERRUPTED:
      "Import was interrupted before the Vault was added. Select the package and try again.",
    STORAGE_QUOTA_EXCEEDED: "There is not enough local storage to import this Vault.",
    ACCOUNT_INPUT_INVALID: "Review the Account details and try again.",
    ACCOUNT_UNAVAILABLE:
      "This Account cannot be created. It may already exist; try signing in instead or use a different email.",
    AUTHENTICATION_FAILED: "The email or password was not accepted.",
    AUTHORIZATION_FAILED: "This session is not authorized for that operation.",
    REGISTRATION_DISABLED: "Account creation is disabled on this server.",
    SESSION_EXPIRED: "Your session expired. Sign in again.",
    RECOVERY_PHRASE_INVALID: "That Recovery Phrase is not valid. Check all 12 words and try again.",
    RECOVERY_GENERATION_CHANGED: "Recovery authority changed. Start the ceremony again.",
    KEY_EPOCH_CHANGED: "Vault encryption authority changed. Synchronize before publishing.",
    DEVICE_REVOKED:
      "This Device was removed from synchronization. Its existing local Vault remains available.",
    DEVICE_ENROLLMENT_INVALID: "The Device authority could not be verified.",
    VAULT_REPLACEMENT_CONFLICT: "The synchronized Vault changed before replacement activation.",
    VAULT_REPLACEMENT_EXPORT_REQUIRED:
      "Create a current Complete Export and confirm it is safely stored before replacing this Vault.",
    SERVER_INCOMPATIBLE:
      "Use a different compatible AWSM coordination server. The current server cannot be selected again.",
    SERVER_PERMISSION_DENIED: "The browser did not grant access to that synchronization server.",
    SYNCHRONIZATION_AUTHENTICATION_REQUIRED: "Sign in again to continue synchronization.",
    SYNCHRONIZATION_INTERRUPTED:
      "The synchronization server is unavailable. Local data remains usable.",
    SYNCHRONIZATION_INTEGRITY_FAILED: "Downloaded synchronization data could not be verified.",
    SYNCHRONIZATION_CONFLICT:
      "This stale Replica is read-only until you preserve it and use the server version.",
    STORAGE_RELIEF_AUTHENTICATION_REQUIRED: "Sign in to continue freeing browser storage safely.",
    STORAGE_RELIEF_ESTIMATE_CHANGED:
      "Browser storage changed. Review the updated estimate and confirm again.",
    SERVER_SWITCH_CONFLICT:
      "AWSM could not prove a safe fast-forward. Your current synchronization server is unchanged.",
    SERVER_SWITCH_VAULT_MISMATCH:
      "That Account owns a different Vault. Your current synchronization server is unchanged.",
  };
  return {
    ok: false,
    error: {
      id,
      message: messages[id] ?? "The operation could not be completed safely.",
    },
  };
}

async function state(): Promise<AppState> {
  const activeVaultId = contexts.active()?.vaultId;
  const [
    accountConfiguration,
    accountMetadata,
    authenticated,
    synchronizationJob,
    serverSwitchJob,
    storageReliefJob,
    vaultReplacementJob,
  ] = await Promise.all([
    accountRepository.loadConfiguration(),
    accountRepository.loadMetadata(),
    accountRepository.hasAuthenticatedSecrets(),
    accountRepository.latestSynchronizationJob(),
    serverSwitchRepository.loadJob(),
    activeVaultId === undefined
      ? Promise.resolve(undefined)
      : storageReliefRepository.latestStorageReliefJob(activeVaultId),
    activeVaultId === undefined
      ? Promise.resolve(undefined)
      : vaultReplacementRepository.latestForVault(activeVaultId),
  ]);
  const context = contexts.active();
  const records = context === undefined ? undefined : await vaultRepository.load(context.vaultId);
  let latestJob = context === undefined ? undefined : await context.driver.latestCaptureJob();
  let latestWarnings: AppState["latestWarnings"];
  let recentCapture: AppState["recentCapture"];
  const busyOperation = context === undefined ? undefined : await context.driver.managementBusy();
  const latestExportJob =
    context === undefined ? undefined : await context.driver.latestExportJob();
  const latestImportJob = await importRepository.latest();
  const synchronizationPermissionGranted =
    accountConfiguration.mode !== "Configured" ||
    (await firefoxSynchronizationPermissionGranted(accountConfiguration.serverOrigin));
  if (
    records !== undefined &&
    context?.vault.isUnlocked() &&
    latestJob?.state === "Succeeded" &&
    latestJob.noticeDismissed !== true
  ) {
    const outcome = await context.driver.findCommandOutcome(latestJob.commandId);
    if (outcome !== undefined) {
      const libraryService = new LibraryService(
        context.driver,
        context.vault.requireKeyring(),
        records.metadata.vaultId,
        artifactStore,
        storageReliefRepository,
      );
      const detail = await libraryService.detail(outcome.bundleId);
      const [activeTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (recentCaptureMatchesActiveUrl(detail.item.originalUrl, activeTab?.url)) {
        latestWarnings = detail.item.warnings;
        recentCapture = {
          vaultId: records.metadata.vaultId,
          jobId: latestJob.jobId,
          bundleId: detail.item.bundleId,
          title: detail.item.title,
          warnings: detail.item.warnings,
          ...(detail.item.thumbnailWebp === undefined
            ? {}
            : { screenshotBase64: bytesToBase64(detail.item.thumbnailWebp) }),
        };
      } else {
        await context.driver.dismissCaptureNotice(latestJob.jobId);
        latestJob = { ...latestJob, noticeDismissed: true };
      }
    }
  }
  return {
    account: {
      configuration:
        accountConfiguration.mode === "Configured"
          ? {
              mode: "Configured",
              serverOrigin: accountConfiguration.serverOrigin,
              registration: accountConfiguration.registration,
            }
          : { mode: accountConfiguration.mode },
      ...(accountMetadata === undefined ? {} : { email: accountMetadata.email }),
      accountState: authenticated ? "Authenticated" : "SignedOut",
      vaultSyncState:
        accountConfiguration.mode === "Configured"
          ? !synchronizationPermissionGranted
            ? "PermissionRequired"
            : !authenticated
              ? "AuthenticationRequired"
              : synchronizationJob?.errorId === "ACCOUNT_VAULT_SELECTION_REQUIRED"
                ? "SetupRequired"
                : synchronizationJob?.errorId === "RECOVERY_PHRASE_REQUIRED"
                  ? "RecoveryRequired"
                  : synchronizationJob?.errorId === "DEVICE_REVOKED"
                    ? "DeviceRevoked"
                    : synchronizationJob?.state === "Conflict"
                      ? "Conflict"
                      : synchronizationJob?.state === "Failed"
                        ? "Failed"
                        : synchronizationJob?.state === "AuthenticationRequired"
                          ? "AuthenticationRequired"
                          : synchronizationJob?.state === "Waiting"
                            ? "Offline"
                            : synchronizationJob === undefined ||
                                synchronizationJob.state === "Succeeded"
                              ? "UpToDate"
                              : synchronizationJob.stage === "FetchChanges" ||
                                  synchronizationJob.stage === "DownloadRecords" ||
                                  synchronizationJob.stage === "ActivateLocal"
                                ? "Downloading"
                                : synchronizationJob.stage === "EnrollVault"
                                  ? "Enrolling"
                                  : "Uploading"
          : "LocalOnly",
      ...(synchronizationJob?.errorId === undefined ? {} : { errorId: synchronizationJob.errorId }),
      ...(synchronizationJob?.state === "Conflict" ? { staleResolutionRequired: true } : {}),
    },
    workspace: await workspace.state({
      ...(records !== undefined && context?.vault.isUnlocked()
        ? { unlockedVaultId: records.metadata.vaultId }
        : {}),
      ...(latestImportJob?.state === "Created" || latestImportJob?.state === "Running"
        ? { busy: { operation: "Import" as const } }
        : vaultReplacementJob !== undefined &&
            !["Succeeded", "Failed", "Aborted"].includes(vaultReplacementJob.state)
          ? {
              busy: {
                vaultId: activeVaultId ?? vaultReplacementJob.sourceVaultId,
                operation: "Vault replacement" as const,
              },
            }
          : serverSwitchJob?.state === "Running" && serverSwitchJob.stage !== "Compare"
            ? {
                busy: {
                  vaultId: serverSwitchJob.vaultId,
                  operation: "Server Switch" as const,
                },
              }
            : context === undefined || busyOperation === undefined
              ? {}
              : { busy: { vaultId: context.vaultId, operation: busyOperation } }),
    }),
    ...(serverSwitchJob === undefined || serverSwitchJob.state === "Succeeded"
      ? {}
      : {
          serverSwitch: {
            jobId: serverSwitchJob.jobId,
            candidateOrigin: serverSwitchJob.candidateOrigin,
            state:
              serverSwitchJob.state === "AuthenticationRequired"
                ? ("AuthenticationRequired" as const)
                : serverSwitchJob.state === "WaitingForUnlock"
                  ? ("VaultLocked" as const)
                  : serverSwitchJob.state === "Conflict"
                    ? ("Conflict" as const)
                    : serverSwitchJob.state === "Failed"
                      ? ("Failed" as const)
                      : serverSwitchJob.stage === "Compare"
                        ? ("Comparing" as const)
                        : ("Applying" as const),
            completedItems: serverSwitchJob.completedItems,
            totalItems: serverSwitchJob.totalItems,
            processedBytes: serverSwitchJob.processedBytes,
            totalBytes: serverSwitchJob.totalBytes,
            ...(serverSwitchJob.direction === undefined
              ? {}
              : { direction: serverSwitchJob.direction }),
            ...(serverSwitchJob.errorId === undefined ? {} : { errorId: serverSwitchJob.errorId }),
            ...(serverSwitchJob.conflictReason === undefined
              ? {}
              : { reason: serverSwitchJob.conflictReason }),
            ...(serverSwitchJob.state === "Conflict" && serverSwitchJob.candidateAuthorityChanged
              ? { candidateAuthorityChanged: true }
              : {}),
          },
        }),
    ...(vaultReplacementJob === undefined
      ? {}
      : {
          vaultReplacement: {
            jobId: vaultReplacementJob.jobId,
            sourceVaultId: vaultReplacementJob.sourceVaultId,
            ...(vaultReplacementJob.targetVaultId === undefined
              ? {}
              : { targetVaultId: vaultReplacementJob.targetVaultId }),
            state: vaultReplacementJob.state,
            stage: vaultReplacementJob.stage,
            completedItems: vaultReplacementJob.completedItems,
            totalItems: vaultReplacementJob.totalItems,
            processedBytes: vaultReplacementJob.processedBytes,
            totalBytes: vaultReplacementJob.totalBytes,
            ...(vaultReplacementJob.errorId === undefined
              ? {}
              : { errorId: vaultReplacementJob.errorId }),
          },
        }),
    ...(latestJob === undefined ? {} : { latestJob }),
    ...(latestWarnings === undefined ? {} : { latestWarnings }),
    ...(recentCapture === undefined ? {} : { recentCapture }),
    ...(latestExportJob === undefined ? {} : { latestExportJob }),
    ...(latestImportJob === undefined ? {} : { latestImportJob }),
    ...(storageReliefJob === undefined
      ? {}
      : { latestStorageReliefJob: storageReliefJobView(storageReliefJob) }),
    ...(activeVaultId === undefined
      ? {}
      : {
          remoteOnlyArtifactCount: (
            await storageReliefRepository.listRemoteOnlyArtifacts(activeVaultId)
          ).length,
        }),
  };
}

async function accountService(): Promise<AccountAuthenticationService> {
  const configuration = await accountRepository.loadConfiguration();
  if (configuration.mode !== "Configured") {
    throw Object.assign(new Error("No synchronization server is configured."), {
      id: "SERVER_INCOMPATIBLE",
    });
  }
  return new AccountAuthenticationService(
    new CoordinationAccountHttp(configuration.serverOrigin),
    accountRepository,
  );
}

async function prepareAccountVault(input: {
  readonly existingVaultId?: string;
  readonly newVaultName?: string;
}): Promise<{
  readonly setupId: string;
  readonly recoveryPhrase: string;
  readonly recoveryFileBase64: string;
  readonly recoveryFilename: string;
}> {
  if (input.newVaultName !== undefined) {
    const current = contexts.active();
    await contexts.create({
      name: input.newVaultName,
      ...(current === undefined ? {} : { expectedActiveVaultId: current.vaultId }),
    });
  } else if (
    input.existingVaultId !== undefined &&
    contexts.active()?.vaultId !== input.existingVaultId
  ) {
    const current = contexts.active();
    if (current === undefined)
      throw Object.assign(new Error("Vault not found"), {
        id: "VAULT_NOT_FOUND",
      });
    await contexts.select({
      expectedActiveVaultId: current.vaultId,
      vaultId: input.existingVaultId,
    });
  }
  if (input.existingVaultId !== undefined && !contexts.active()?.vault.isUnlocked())
    await contexts.unlockWithDevice(input.existingVaultId);
  const synchronized = contexts.active();
  if (synchronized === undefined)
    throw Object.assign(new Error("Vault not found"), {
      id: "VAULT_NOT_FOUND",
    });
  const [metadata, records] = await Promise.all([
    accountRepository.loadMetadata(),
    vaultRepository.load(synchronized.vaultId),
  ]);
  if (metadata === undefined || records === undefined || metadata.scope !== "Account")
    throw Object.assign(new Error("Initial synchronization context is incomplete"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  initialAttachmentTransport.reset();
  const prepared = await initialAttachment.prepare({
    metadata,
    records,
    displayName: firefoxHost ? "Firefox extension" : "Chrome extension",
    clientKind: firefoxHost ? "FirefoxExtension" : "ChromeExtension",
  });
  return {
    setupId: prepared.setupId,
    recoveryPhrase: prepared.phrase,
    recoveryFileBase64: bytesToBase64(prepared.recoveryFile),
    recoveryFilename: `awsm-${synchronized.vaultId}.awsm-recovery`,
  };
}

async function recoverAccountVault(input: {
  readonly recoveryPhrase: string;
  readonly confirmationPhrase: string;
}): Promise<void> {
  const [configuration, metadata, registration] = await Promise.all([
    accountRepository.loadConfiguration(),
    accountRepository.loadMetadata(),
    accountRepository.loadAccountVault(),
  ]);
  if (
    configuration.mode !== "Configured" ||
    metadata === undefined ||
    metadata.scope !== "Account" ||
    registration === undefined ||
    registration.activeRecoveryGenerationId === undefined
  )
    throw Object.assign(new Error("Recovery context is incomplete"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const recoveryKit = await accountRepository.loadRecoveryKit(registration.vaultId);
  if (recoveryKit === undefined)
    throw Object.assign(new Error("Recovery Kit is unavailable"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const accountTransport = new SynchronizationHttp(
    configuration.serverOrigin,
    await sessionManager(),
  );
  const accessToken = await new RecoveredDeviceEnrollmentService(
    {
      request: (method, path, body, idempotencyKey) =>
        accountTransport.request(method, path, body, idempotencyKey),
    },
    deviceRepository,
  ).enroll({
    accountId: metadata.accountId,
    accountSessionId: metadata.sessionId,
    recoveryKit,
    phrase: input.recoveryPhrase,
    confirmationPhrase: input.confirmationPhrase,
    displayName: firefoxHost ? "Firefox extension" : "Chrome extension",
    clientKind: firefoxHost ? "FirefoxExtension" : "ChromeExtension",
  });
  (await deviceSessionManager(registration.vaultId)).setAccessToken(accessToken);
  const deviceTransport = new SynchronizationHttp(configuration.serverOrigin, {
    accessToken: async () => accessToken,
  });
  const remote = canonicalRecord(
    (await deviceTransport.request("GET", `/api/vaults/${registration.vaultId}`)).body,
    "recoveredVault",
    [
      "vaultId",
      "state",
      "generationId",
      "generationNumber",
      "headCursor",
      "activeKeyEpochId",
      "predecessorGenerationId",
    ],
  );
  const vaultId = uuid(remote.vaultId, "recoveredVault.vaultId");
  if (vaultId !== registration.vaultId || remote.state !== "Active")
    throw Object.assign(new Error("Recovered Vault authority changed"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  await accountRepository.beginRecoveredBootstrap({
    accountId: metadata.accountId,
    vaultId,
    generationId: uuid(remote.generationId, "recoveredVault.generationId"),
    generationNumber: integer(remote.generationNumber, "recoveredVault.generationNumber"),
    deliveryCursor: integer(remote.headCursor, "recoveredVault.headCursor"),
    now: new Date().toISOString(),
  });
  const activated = await new RemoteBootstrapRunner(
    accountRepository,
    deviceRepository,
    workspaceRepository,
    artifactStore,
    new RemoteReplicaDownloader(deviceTransport, artifactStore),
  ).run();
  if (activated !== undefined) await contexts.reloadFromAuthority();
}

function validateExportPassphrase(passphrase: string): void {
  const codePoints = Array.from(passphrase).length;
  const bytes = new TextEncoder().encode(passphrase).byteLength;
  if (codePoints < 12 || bytes > 1024) {
    throw Object.assign(new Error("Invalid Export passphrase."), {
      id: "INVALID_EXPORT_PASSPHRASE",
    });
  }
}

async function exportVault(
  expectedVaultId: string,
  passphrase: string,
): Promise<{ jobId: string; filename: string }> {
  validateExportPassphrase(passphrase);
  const context = contexts.snapshot(expectedVaultId);
  const records = await vaultRepository.load(context.vaultId);
  if (records === undefined || !context.vault.isUnlocked()) {
    throw Object.assign(new Error("Vault locked"), { id: "VAULT_LOCKED" });
  }
  const createdAt = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const packageId = crypto.randomUUID();
  const filename = vaultExportFilename(createdAt);
  let job: import("../drivers/indexeddb/schema").ExportJobV1 = {
    version: 1,
    vaultId: context.vaultId,
    jobId,
    packageId,
    state: "Created",
    stage: "Preflight",
    createdAt,
    updatedAt: createdAt,
    completedEntries: 0,
    totalEntries: 0,
    processedBytes: 0,
    totalBytes: 0,
    cancellationRequested: false,
  };
  await context.driver.acquireExport(job);
  await notifyAppStateChanged();
  const controller = new AbortController();
  exportControllers.set(jobId, controller);
  const save = async (
    changes: Partial<import("../drivers/indexeddb/schema").ExportJobV1>,
  ): Promise<void> => {
    job = { ...job, ...changes, updatedAt: new Date().toISOString() };
    await context.driver.updateExportJob(job);
    await notifyAppStateChanged();
  };
  try {
    await save({ state: "Running", stage: "Snapshot" });
    await save({ stage: "Verify" });
    const prepared = await new VaultExportService(context.driver, context.vault, context.vaultId, {
      openEncrypted: async (vaultId, _objectId, object) => {
        const [configuration, registration, synchronizationJob] = await Promise.all([
          accountRepository.loadConfiguration(),
          accountRepository.loadAccountVault(),
          accountRepository.latestSynchronizationJob(),
        ]);
        if (configuration.mode !== "Configured" || registration?.vaultId !== vaultId)
          return artifactStore.openEncrypted(vaultId, object.objectId);
        const scope =
          synchronizationJob?.state === "Conflict" && synchronizationJob.vaultId === vaultId
            ? {
                type: "RecoveryGeneration" as const,
                generationId: records.head.generationId,
              }
            : {
                type: "ActiveGeneration" as const,
                generationId: records.head.generationId,
              };
        return (
          await new ArtifactResolver(
            artifactStore,
            storageReliefRepository,
            new SynchronizationHttp(
              configuration.serverOrigin,
              await deviceSessionManager(vaultId),
              fetch,
            ),
            { online: () => navigator.onLine },
          ).openEncrypted({
            vaultId,
            serverOrigin: configuration.serverOrigin,
            object,
            scope,
            retention: "Transient",
            signal: controller.signal,
          })
        ).stream;
      },
    }).prepare({
      packageId,
      createdAt,
      passphrase,
      salt: crypto.getRandomValues(new Uint8Array(16)),
      nonce: crypto.getRandomValues(new Uint8Array(24)),
    });
    const totalBytes = prepared.manifest.entries.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
    await save({
      stage: "Package",
      totalEntries: prepared.manifest.entries.length + 2,
      totalBytes,
    });
    await exportHost.writeAndValidate(packageId, prepared, passphrase, controller.signal);
    await save({
      stage: "Download",
      completedEntries: prepared.manifest.entries.length + 2,
      processedBytes: totalBytes,
    });
    await exportHost.download(packageId, filename, controller.signal);
    const verifiedAt = new Date().toISOString();
    await prepared.assertSnapshotCurrent();
    const verifiedHead = await context.driver.getVaultHead();
    if (
      verifiedHead === undefined ||
      prepared.manifest.coverage !== "Complete" ||
      verifiedHead.generationId !== prepared.manifest.generationId ||
      verifiedHead.generationNumber !== prepared.manifest.generationNumber
    )
      throw Object.assign(new Error("Complete Export snapshot changed before completion."), {
        id: "EXPORT_SOURCE_CHANGED",
      });
    await save({
      state: "Succeeded",
      verifiedSnapshot: {
        vaultId: context.vaultId,
        generationId: verifiedHead.generationId,
        generationNumber: verifiedHead.generationNumber,
        appendedObjectIds: verifiedHead.appendedObjectIds,
        appendedEventIds: verifiedHead.appendedEventIds,
        coverage: "Complete",
        verifiedAt,
        downloadedAt: verifiedAt,
      },
    });
    return { jobId, filename };
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const errorId =
      error instanceof Error && "id" in error && typeof error.id === "string"
        ? (error.id as RuntimeErrorId)
        : "EXPORT_PACKAGE_INVALID";
    if (cancelled) {
      await save({ state: "Cancelled", cancellationRequested: true });
    } else {
      await save({
        state: "Failed",
        cancellationRequested: job.cancellationRequested,
        errorId,
      });
    }
    throw error;
  } finally {
    exportControllers.delete(jobId);
    await exportHost.cleanup(packageId).catch(() => undefined);
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "awsm:popup-lifetime") return;
  let visibleCapture: { readonly vaultId: string; readonly jobId: string } | undefined;
  port.onMessage.addListener((message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("vaultId" in message) ||
      !("jobId" in message)
    )
      return;
    visibleCapture =
      typeof message.vaultId === "string" && typeof message.jobId === "string"
        ? { vaultId: message.vaultId, jobId: message.jobId }
        : undefined;
  });
  port.onDisconnect.addListener(() => {
    if (visibleCapture === undefined) return;
    const active = contexts.active();
    if (active?.vaultId === visibleCapture.vaultId) {
      void active.driver.dismissCaptureNotice(visibleCapture.jobId).catch(() => undefined);
      return;
    }
    const scopedDriver = new IndexedDbDriver(databaseName, visibleCapture.vaultId);
    void scopedDriver
      .dismissCaptureNotice(visibleCapture.jobId)
      .catch(() => undefined)
      .finally(() => scopedDriver.close());
  });
});

async function library(expectedVaultId: string): Promise<LibraryService> {
  const context = contexts.snapshot(expectedVaultId);
  const records = await vaultRepository.load(context.vaultId);
  if (records === undefined) throw Object.assign(new Error("Vault locked"), { id: "VAULT_LOCKED" });
  const service = new LibraryService(
    context.driver,
    context.vault.requireKeyring(),
    records.metadata.vaultId,
    {
      openPlaintext: async (input) => {
        if (
          !(await storageReliefRepository.isArtifactRemoteOnly(
            input.vaultId,
            input.object.objectId,
          ))
        )
          return artifactStore.openPlaintext(input);
        const [configuration, registration, head] = await Promise.all([
          accountRepository.loadConfiguration(),
          accountRepository.loadAccountVault(),
          context.driver.getVaultHead(),
        ]);
        if (
          configuration.mode !== "Configured" ||
          registration?.vaultId !== input.vaultId ||
          head === undefined
        )
          throw Object.assign(new Error("Sign in to retrieve this Artifact."), {
            id: "REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED",
          });
        return (
          await new ArtifactResolver(
            artifactStore,
            storageReliefRepository,
            new SynchronizationHttp(
              configuration.serverOrigin,
              await deviceSessionManager(input.vaultId),
              fetch,
            ),
            { online: () => navigator.onLine },
            () => void notifyAppStateChanged(),
            artifactRetrievalFaults,
          ).openPlaintext({
            ...input,
            serverOrigin: configuration.serverOrigin,
            scope: {
              type: "ActiveGeneration",
              generationId: head.generationId,
            },
            retention: "RestoreLocal",
          })
        ).stream;
      },
    },
    storageReliefRepository,
  );
  const [projections, events] = await Promise.all([
    context.driver.listEncryptedProjections(),
    context.driver.listStoredEvents(),
  ]);
  if (projections.length === 0 && events.length > 0) {
    await new LibraryProjectionRebuilder(
      context.driver,
      context.vault.requireKeyring(),
      records.metadata.vaultId,
      artifactStore,
    ).execute();
  }
  return service;
}

async function libraryGroups(
  expectedVaultId: string,
  status: "Active" | "Deleted" = "Active",
): Promise<import("./protocol").LibraryPageGroupMessage[]> {
  const service = await library(expectedVaultId);
  const groups = status === "Active" ? await service.groups() : await service.deletedGroups();
  return Promise.all(
    groups.map(async (group) => {
      const captureThumbnails = await Promise.all(
        group.captures.map(async (capture) => ({
          bundleId: capture.bundleId,
          ...(capture.thumbnailWebp === undefined
            ? {}
            : { thumbnailBase64: bytesToBase64(capture.thumbnailWebp) }),
        })),
      );
      return {
        ...group,
        captureThumbnails,
      };
    }),
  );
}

async function changeLibraryState(
  expectedVaultId: string,
  bundleIds: readonly string[],
  operation: "Delete" | "Restore",
): Promise<void> {
  await assertVaultMutationAllowed(expectedVaultId);
  const context = contexts.snapshot(expectedVaultId);
  const records = await vaultRepository.load(context.vaultId);
  if (records === undefined) throw Object.assign(new Error("Vault locked"), { id: "VAULT_LOCKED" });
  const service = await library(expectedVaultId);
  const expected = operation === "Delete" ? "Active" : "Deleted";
  const items = await service.list();
  let selected: readonly import("../domain/contracts").LibraryItemV1[];
  try {
    selected = selectLibraryItems(items, bundleIds, expected);
  } catch {
    throw Object.assign(new Error("Missing capture in expected state"), {
      id: "BUNDLE_INVALID",
    });
  }
  const timestamp = new Date().toISOString();
  const prepared = await prepareLibraryStateChange({
    keyring: context.vault.requireKeyring(),
    vaultId: records.metadata.vaultId,
    deviceId: records.metadata.deviceId,
    eventId: crypto.randomUUID(),
    timestamp,
    operation,
    items: selected,
  });
  contexts.assertCurrent(context);
  await context.driver.commitLibraryState(prepared.event, prepared.projections);
  wakeVaultSynchronization(context.vaultId);
}

async function vacuumEstimate(expectedVaultId: string): Promise<{
  readonly deletedCaptureCount: number;
  readonly reclaimableBytes: number;
}> {
  const context = contexts.snapshot(expectedVaultId);
  const service = await library(expectedVaultId);
  const deleted = await service.listDeleted();
  const [objects, events] = await Promise.all([
    context.driver.listStoredObjects(),
    context.driver.listStoredEvents(),
  ]);
  const objectIds = await objectIdsForBundles(
    events,
    new Set(deleted.map((item) => item.bundleId)),
    context.vault.requireKeyring(),
    context.vaultId,
  );
  return {
    deletedCaptureCount: deleted.length,
    reclaimableBytes: objects
      .filter((object) => objectIds.has(object.objectId))
      .reduce((total, object) => total + storedObjectByteLength(object), 0),
  };
}

async function captureActivePage(
  expectedVaultId: string,
  tabId?: number,
): Promise<{ readonly bundleId: string }> {
  await assertVaultMutationAllowed(expectedVaultId);
  const context = contexts.snapshot(expectedVaultId);
  const records = await vaultRepository.load(context.vaultId);
  if (records === undefined) throw Object.assign(new Error("Vault locked"), { id: "VAULT_LOCKED" });
  const tab =
    tabId === undefined ? await captureHost.getActiveTab() : await captureHost.getTab(tabId);
  if (tab?.id === undefined || tab.url === undefined) {
    throw Object.assign(new Error("Unsupported page"), {
      id: "UNSUPPORTED_URL",
    });
  }
  const commandId = crypto.randomUUID();
  const command = {
    commandId,
    commandType: "CapturePage" as const,
    commandVersion: 1 as const,
    issuingDeviceId: records.metadata.deviceId,
    createdAt: new Date().toISOString(),
    tabId: tab.id,
    observedUrl: tab.url,
    captureProfileId: "WebPageSnapshot-v1" as const,
    idempotencyKey: commandId,
  };
  const selectedHost = {
    getActiveTab: async () => tab,
    hasCapturePermission: () => captureHost.hasCapturePermission(),
  };
  const runtime = new CaptureRuntime({
    vaultId: records.metadata.vaultId,
    deviceId: records.metadata.deviceId,
    clientVersion: browser.runtime.getManifest().version,
    isVaultUnlocked: () => context.vault.isUnlocked(),
    keyring: () => context.vault.requireKeyring(),
    findOutcome: (id) => context.driver.findCommandOutcome(id),
    saveJob: async (job) => {
      await context.driver.saveCaptureJob(job);
      await notifyAppStateChanged();
    },
    commitRegistration: async (input) => {
      contexts.assertCurrent(context);
      await assertVaultMutationAllowed(context.vaultId);
      const outcome = await context.driver.commitRegistration(input);
      wakeVaultSynchronization(context.vaultId);
      return outcome;
    },
    preflight: () => preflightCapture(selectedHost, context.vault.isUnlocked()),
    collectSnapshot: (captureCommand, preflight, capturedAt, onFrozen) =>
      captureHost.collectPageSnapshot(
        preflight.tabId,
        captureCommand,
        capturedAt,
        browser.runtime.getManifest().version,
        onFrozen,
      ),
    packageSnapshot: (input) =>
      stagePlaintextFile(".awsm-page.tmp", async (output) => {
        await writePageSnapshot(input, output);
      }).then(async (staged) => {
        try {
          await validatePageSnapshot(staged.blob);
          return staged;
        } catch (error) {
          await staged.cleanup();
          throw error;
        }
      }),
    acquireScreenshot: async (tabId) => {
      try {
        return await acquireBestEffortScreenshot(
          firefoxHost
            ? await FirefoxScreenshotHost.create(tabId)
            : await ChromeScreenshotHost.create(tabId),
        );
      } catch {
        return { warnings: ["SCREENSHOT_UNAVAILABLE"] };
      }
    },
    collectionContext: async () => {
      const service = await library(expectedVaultId);
      const [items, topology] = await Promise.all([service.list(), service.topology()]);
      return { items, topology };
    },
    prepareRegistration: defaultPrepareRegistration,
    prepareArtifact: (objectId, plaintext) =>
      artifactStore.prepare({
        vaultId: records.metadata.vaultId,
        objectId,
        keyring: context.vault.requireKeyring(),
        plaintext: (async function* () {
          if (plaintext instanceof Blob) {
            const reader = plaintext.stream().getReader();
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                yield next.value;
              }
            } finally {
              reader.releaseLock();
            }
          } else {
            const size = 1024 * 1024;
            for (let offset = 0; offset < plaintext.byteLength; offset += size)
              yield plaintext.subarray(offset, Math.min(offset + size, plaintext.byteLength));
          }
        })(),
      }),
    removeArtifact: (objectId) => artifactStore.remove(records.metadata.vaultId, objectId),
    uuid: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  });
  const outcome = await runtime.execute(command);
  return { bundleId: outcome.bundleId };
}

type CollectionManagementRequest = Extract<
  AppRequest,
  {
    readonly type: "MergeCollections" | "MoveCaptures" | "ExtractCaptures" | "UndoLibraryOperation";
  }
>;

async function manageCollections(
  request: CollectionManagementRequest,
): Promise<LibraryOperationReceipt> {
  await assertVaultMutationAllowed(request.expectedVaultId);
  const context = contexts.snapshot(request.expectedVaultId);
  const records = await vaultRepository.load(context.vaultId);
  if (records === undefined) throw Object.assign(new Error("Vault locked"), { id: "VAULT_LOCKED" });
  const service = await library(request.expectedVaultId);
  const [items, topology] = await Promise.all([service.list(), service.topology()]);
  const eventId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  let fact: Parameters<typeof prepareCollectionOperation>[0]["fact"];
  let destinationCollectionId: string;
  if (request.type === "MergeCollections") {
    fact = planCollectionMerge(
      items,
      topology,
      request.destinationCollectionId,
      request.sourceCollectionIds,
      eventId,
    );
    destinationCollectionId = fact.destinationCollectionId;
  } else if (request.type === "MoveCaptures") {
    const moves = planCaptureMove(
      items,
      topology,
      request.bundleIds,
      request.destinationCollectionId,
    );
    fact = { eventType: "CapturesMoved", moves };
    destinationCollectionId = moves[0]?.toCollectionId ?? request.destinationCollectionId;
  } else if (request.type === "ExtractCaptures") {
    destinationCollectionId = crypto.randomUUID();
    const moves = planCaptureMove(items, topology, request.bundleIds, destinationCollectionId, {
      allowNewDestination: true,
    });
    fact = { eventType: "CapturesMoved", moves };
  } else {
    const original = await context.driver.getStoredEvent(request.operationEventId);
    if (original === undefined) {
      throw Object.assign(new Error("Library operation missing"), {
        id: "LIBRARY_STATE_CHANGED",
      });
    }
    const decoded = await decodeCollectionOperationEvent(
      original,
      context.vault.requireKeyring(),
      records.metadata.vaultId,
    );
    if (decoded.eventType === "CapturesMoved") {
      const moves = invertCaptureMoves(items, topology, decoded.moves);
      fact = {
        eventType: "CapturesMoved",
        moves,
        revertsEventId: original.eventId,
      };
      destinationCollectionId = moves[0]?.toCollectionId ?? records.metadata.vaultId;
    } else {
      const activeMerge = topology.some(
        (candidate) =>
          candidate.eventType === "CollectionsMerged" && candidate.eventId === original.eventId,
      );
      const alreadyReverted = topology.some(
        (candidate) =>
          candidate.eventType === "CollectionMergeReverted" &&
          candidate.mergeEventId === original.eventId,
      );
      if (!activeMerge || alreadyReverted) {
        throw Object.assign(new Error("Merge state changed"), {
          id: "LIBRARY_STATE_CHANGED",
        });
      }
      fact = {
        eventId,
        eventType: "CollectionMergeReverted",
        mergeEventId: original.eventId,
      };
      destinationCollectionId = decoded.sourceCollectionIds[0] ?? decoded.destinationCollectionId;
    }
  }
  const prepared = await prepareCollectionOperation({
    keyring: context.vault.requireKeyring(),
    vaultId: records.metadata.vaultId,
    deviceId: records.metadata.deviceId,
    eventId,
    timestamp,
    items,
    topology,
    fact,
  });
  contexts.assertCurrent(context);
  await context.driver.commitCollectionOperation(prepared);
  wakeVaultSynchronization(context.vaultId);
  return { operationEventId: eventId, destinationCollectionId };
}

async function replacementPreparation(
  expectedVaultId: string,
  allowedReplacementJobId?: string,
): Promise<{
  readonly account: NonNullable<Awaited<ReturnType<IndexedDbAccountRepository["loadMetadata"]>>>;
  readonly source: import("../runtime/recovery/replacement-service").ReplacementSourceSnapshot;
  readonly latestExport: Awaited<ReturnType<IndexedDbDriver["latestExportJob"]>>;
  readonly vaultName: string;
}> {
  await assertVaultMutationAllowed(expectedVaultId, allowedReplacementJobId);
  const context = contexts.snapshot(expectedVaultId);
  const [
    account,
    registration,
    records,
    head,
    events,
    objects,
    latestExport,
    busy,
    synchronizationJob,
    serverSwitchJob,
    importJob,
    workspaceState,
  ] = await Promise.all([
    accountRepository.loadMetadata(),
    accountRepository.loadAccountVault(),
    vaultRepository.load(context.vaultId),
    context.driver.getVaultHead(),
    context.driver.listStoredEvents(),
    context.driver.listStoredObjects(),
    context.driver.latestExportJob(),
    context.driver.managementBusy(),
    accountRepository.latestSynchronizationJob(),
    serverSwitchRepository.loadJob(),
    importRepository.latest(),
    workspace.state({
      ...(context.vault.isUnlocked() ? { unlockedVaultId: context.vaultId } : {}),
    }),
  ]);
  if (
    account === undefined ||
    account.scope !== "Account" ||
    head === undefined ||
    registration?.vaultId !== context.vaultId ||
    registration.remoteGenerationId !== head.generationId ||
    registration.remoteGenerationNumber !== head.generationNumber
  )
    throw Object.assign(new Error("Synchronized Account authority is incomplete."), {
      id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
    });
  if (records === undefined)
    throw Object.assign(new Error("Vault authority is unavailable."), {
      id: "VAULT_LOCKED",
    });
  if (!context.vault.isUnlocked())
    throw Object.assign(new Error("Unlock the Vault before replacing it."), { id: "VAULT_LOCKED" });
  if (
    busy !== undefined ||
    (synchronizationJob !== undefined && synchronizationJob.state !== "Succeeded") ||
    (serverSwitchJob !== undefined && serverSwitchJob.state === "Running") ||
    (importJob !== undefined && (importJob.state === "Created" || importJob.state === "Running"))
  )
    throw Object.assign(new Error("Finish other Vault operations before re-encrypting."), {
      id: "VAULT_BUSY",
    });
  await (await sessionManager()).accessToken();
  await (await deviceSessionManager(context.vaultId)).accessToken();
  const retained = await verifyVaultGeneration(
    context.vault.requireKeyring(),
    context.vaultId,
    records.generation,
  );
  const eventIds = new Set([...retained.retainedEventIds, ...head.appendedEventIds]);
  const objectIds = new Set([...retained.retainedObjectIds, ...head.appendedObjectIds]);
  const sourceEvents = events.filter((event) => eventIds.has(event.eventId));
  const sourceObjects = objects.filter((object) => objectIds.has(object.objectId));
  if (sourceEvents.length !== eventIds.size || sourceObjects.length !== objectIds.size)
    throw Object.assign(new Error("The complete active Vault is not locally available."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  const vaultName = workspaceState.vaults.find((vault) => vault.vaultId === context.vaultId)?.name;
  if (vaultName === undefined)
    throw Object.assign(new Error("Vault name is unavailable."), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  return {
    account,
    source: {
      records,
      head,
      headCursor: registration.deliveryCursor,
      keyring: context.vault.requireKeyring(),
      events: sourceEvents,
      objects: sourceObjects,
    },
    latestExport,
    vaultName,
  };
}

async function runVaultReplacement(
  job: import("../drivers/indexeddb").VaultReplacementJobV1,
  account: NonNullable<Awaited<ReturnType<IndexedDbAccountRepository["loadMetadata"]>>>,
): Promise<import("../drivers/indexeddb").VaultReplacementJobV1> {
  replacementAccessToken = undefined;
  const result = await vaultReplacementRunner.run(job, account);
  if (result.stage === "PurgeSource" || result.stage === "Terminal") {
    await contexts.reloadFromAuthority();
    activeDeviceSessionManager?.clearAccessToken();
    activeDeviceSessionManager = undefined;
    activeDeviceSessionContext = undefined;
  }
  await notifyAppStateChanged();
  return result;
}

async function handle(request: AppRequest): Promise<AppResponse> {
  await startup;
  try {
    const synchronizationOrigin = await synchronizationOriginForRequest(request);
    if (synchronizationOrigin !== undefined)
      await assertFirefoxSynchronizationPermission(synchronizationOrigin);
    switch (request.type) {
      case "GetState":
        return { ok: true, value: await state() };
      case "WakeSynchronization":
        void synchronizationCoordinator.interactiveWake();
        return { ok: true, value: await state() };
      case "ChooseLocalOnly":
        await assertNoApplyingServerSwitch();
        await accountRepository.saveConfiguration({
          version: 1,
          mode: "LocalOnly",
        });
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      case "ConfigureSyncServer":
        await assertNoApplyingServerSwitch();
        await configureSyncServer(request.serverOrigin, accountServerHost);
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      case "BeginServerSwitch": {
        const configuration = await accountRepository.loadConfiguration();
        if (configuration.mode !== "Configured")
          throw Object.assign(new Error("No synchronized source Account is active"), {
            id: "VAULT_CONTEXT_CHANGED",
          });
        const context = contexts.snapshot(request.expectedVaultId);
        if (!context.vault.isUnlocked())
          throw Object.assign(new Error("Unlock the synchronized Vault"), {
            id: "VAULT_LOCKED",
          });
        const registration = await accountRepository.loadAccountVault();
        if (registration?.vaultId !== context.vaultId)
          throw Object.assign(new Error("The active Vault is not the synchronized Vault"), {
            id: "VAULT_CONTEXT_CHANGED",
          });
        if ((await context.driver.managementBusy()) !== undefined)
          throw Object.assign(new Error("The Vault is busy"), {
            id: "VAULT_BUSY",
          });
        const head = await context.driver.getVaultHead();
        if (head === undefined)
          throw Object.assign(new Error("The active Vault head is unavailable"), {
            id: "SYNCHRONIZATION_INTEGRITY_FAILED",
          });
        const candidate = await validateSyncServer(request.candidateOrigin, accountServerHost);
        await serverSwitchService.begin({
          sourceOrigin: configuration.serverOrigin,
          candidateOrigin: candidate.serverOrigin,
          candidateRegistration: candidate.registration,
          vaultId: context.vaultId,
          expectedLocalHead: head,
        });
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      }
      case "LoginServerSwitchCandidate": {
        const accessToken = await serverSwitchService.authenticate(request);
        await compareServerSwitchSafely(accessToken, true);
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      }
      case "CancelServerSwitch":
        await serverSwitchService.cancel(request.jobId);
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      case "RetryServerSwitch":
        await serverSwitchService.retry(request.jobId);
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      case "RetrySynchronization": {
        const retryJob = await accountRepository.latestSynchronizationJob();
        if (retryJob?.state === "Waiting" || retryJob?.state === "Failed") {
          const [account, registration] = await Promise.all([
            accountRepository.loadMetadata(),
            accountRepository.loadAccountVault(),
          ]);
          const refreshed =
            account !== undefined &&
            account.scope === "Account" &&
            registration !== undefined &&
            (await deviceAuthorityRefresh.refresh({ account, registration })) !== undefined;
          if (refreshed) {
            await contexts.reloadFromAuthority();
            await accountRepository.retrySynchronization();
          } else {
            try {
              await discoverAccountVault();
            } catch (error) {
              const errorId =
                error instanceof Error && "id" in error && typeof error.id === "string"
                  ? error.id
                  : undefined;
              if (errorId !== undefined && errorId !== "SYNCHRONIZATION_INTERRUPTED") throw error;
              await accountRepository.retrySynchronization();
            }
          }
          void synchronizationCoordinator.interactiveWake();
        }
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      }
      case "DiscardStaleReplica": {
        const context = contexts.snapshot(request.expectedVaultId);
        const records = await vaultRepository.load(context.vaultId);
        if (records === undefined)
          throw Object.assign(new Error("Unlock the stale Vault before resolving it."), {
            id: "VAULT_LOCKED",
          });
        const configuration = await accountRepository.loadConfiguration();
        if (configuration.mode !== "Configured")
          throw Object.assign(new Error("The synchronization server is unavailable."), {
            id: "SERVER_INCOMPATIBLE",
          });
        const transport = new SynchronizationHttp(
          configuration.serverOrigin,
          await deviceSessionManager(context.vaultId),
        );
        try {
          await new StaleReplicaDiscardService(
            accountRepository,
            workspaceRepository,
            {
              listStoredEvents: () => context.driver.listStoredEvents(),
              listStoredObjects: async () => {
                const [objects, remoteOnly] = await Promise.all([
                  context.driver.listStoredObjects(),
                  storageReliefRepository.listRemoteOnlyArtifacts(context.vaultId),
                ]);
                const absent = new Set(remoteOnly.map((entry) => entry.artifactObjectId));
                return objects.filter(
                  (object) => object.objectType !== "Artifact" || !absent.has(object.objectId),
                );
              },
              getVaultGeneration: (generationId) => context.driver.getVaultGeneration(generationId),
            },
            records,
            context.vault.requireKeyring(),
            new RemoteReplicaDownloader(transport, artifactStore),
            artifactStore,
            staleDiscardFaults,
          ).execute();
        } catch (error) {
          testingFaultCheckpoint?.recordFailure(error);
          throw error;
        }
        await contexts.reloadFromAuthority();
        await notifyAppStateChanged();
        return { ok: true, value: null };
      }
      case "LoginAccount":
        await assertNoApplyingServerSwitch();
        {
          const access = await (await accountService()).login({
            email: request.email,
            password: request.password,
          });
          (await sessionManager()).setAccessToken(access);
        }
        await discoverAccountVault();
        {
          const [account, registration] = await Promise.all([
            accountRepository.loadMetadata(),
            accountRepository.loadAccountVault(),
          ]);
          if (account !== undefined && account.scope === "Account" && registration !== undefined) {
            try {
              const deviceAccess = await deviceAuthorityRefresh.refresh({
                account,
                registration,
              });
              if (deviceAccess !== undefined) {
                (await deviceSessionManager(registration.vaultId)).setAccessToken(deviceAccess);
                const job = await accountRepository.latestSynchronizationJob();
                if (job?.state === "AuthenticationRequired")
                  await accountRepository.retrySynchronization();
              }
            } catch (error) {
              const errorId =
                error instanceof Error && "id" in error ? String(error.id) : undefined;
              if (errorId !== "AUTHENTICATION_FAILED") throw error;
              const job = await accountRepository.latestSynchronizationJob();
              if (job !== undefined)
                await accountRepository.saveSynchronizationJob({
                  ...job,
                  state: "AuthenticationRequired",
                  updatedAt: new Date().toISOString(),
                  errorId: "DEVICE_REVOKED",
                });
              await deviceRepository.eraseDeviceSession(registration.vaultId);
              activeDeviceSessionManager?.clearAccessToken();
            }
          }
        }
        await runEnrollment();
        {
          const current = contexts.active();
          if (current !== undefined) {
            const relief = await storageReliefRepository.latestStorageReliefJob(current.vaultId);
            if (relief?.state === "AuthenticationRequired")
              void runStorageRelief(current.vaultId).catch((error) =>
                testingFaultCheckpoint?.recordFailure(error),
              );
          }
        }
        void synchronizationCoordinator.interactiveWake();
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      case "PrepareAccountVault":
        await assertNoApplyingServerSwitch();
        {
          const prepared = await prepareAccountVault(request);
          await notifyAppStateChanged();
          return { ok: true, value: prepared };
        }
      case "ConfirmInitialVault":
        await assertNoApplyingServerSwitch();
        await initialAttachment.attach(request.setupId, request.recoveryPhrase);
        {
          const registration = await accountRepository.loadAccountVault();
          if (registration !== undefined && initialDeviceAccessToken !== undefined)
            (await deviceSessionManager(registration.vaultId)).setAccessToken(
              initialDeviceAccessToken,
            );
        }
        initialDeviceAccessToken = undefined;
        await notifyAppStateChanged();
        void synchronizationCoordinator.interactiveWake();
        return { ok: true, value: await state() };
      case "CancelInitialVault":
        await initialAttachment.cancel(request.setupId);
        initialDeviceAccessToken = undefined;
        await notifyAppStateChanged();
        return { ok: true, value: null };
      case "RecoverAccountVault":
        await assertNoApplyingServerSwitch();
        try {
          await recoverAccountVault(request);
        } catch (error) {
          testingFaultCheckpoint?.recordFailure(error);
          throw error;
        }
        await notifyAppStateChanged();
        void synchronizationCoordinator.interactiveWake();
        return { ok: true, value: await state() };
      case "ListVaultDevices":
        contexts.snapshot(request.expectedVaultId);
        return {
          ok: true,
          value: await futureProtection.listDevices(request.expectedVaultId),
        };
      case "RemoveVaultDevice": {
        const context = contexts.snapshot(request.expectedVaultId);
        const authority = await deviceRepository.loadDeviceAuthority(context.vaultId);
        if (authority?.identity.deviceId === request.deviceId)
          throw Object.assign(
            new Error("Use the explicit Remove this Device flow for the current Device."),
            { id: "DEVICE_ENROLLMENT_INVALID" },
          );
        const configuration = await accountRepository.loadConfiguration();
        if (configuration.mode !== "Configured")
          throw Object.assign(new Error("Synchronization server is unavailable."), {
            id: "SERVER_INCOMPATIBLE",
          });
        await new SynchronizationHttp(
          configuration.serverOrigin,
          await deviceSessionManager(context.vaultId),
        ).request("DELETE", `/api/vaults/${context.vaultId}/devices/${request.deviceId}`);
        await notifyAppStateChanged();
        return { ok: true, value: null };
      }
      case "RemoveCurrentDevice": {
        const context = contexts.snapshot(request.expectedVaultId);
        const authority = await deviceRepository.loadDeviceAuthority(context.vaultId);
        if (authority === undefined)
          throw Object.assign(new Error("Current Device authority is unavailable."), {
            id: "SYNCHRONIZATION_INTEGRITY_FAILED",
          });
        const configuration = await accountRepository.loadConfiguration();
        if (configuration.mode !== "Configured")
          throw Object.assign(new Error("Synchronization server is unavailable."), {
            id: "SERVER_INCOMPATIBLE",
          });
        try {
          await new SynchronizationHttp(
            configuration.serverOrigin,
            await deviceSessionManager(context.vaultId),
          ).request(
            "DELETE",
            `/api/vaults/${context.vaultId}/devices/${authority.identity.deviceId}`,
          );
        } finally {
          await Promise.all([
            wipe(authority.identity.signingSecretKey),
            wipe(authority.identity.wrappingSecretKey),
            ...authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
          ]);
        }
        await deviceRepository.eraseDeviceSession(context.vaultId);
        activeDeviceSessionManager?.clearAccessToken();
        activeCable?.disconnect();
        activeCable = undefined;
        activeCableContext = undefined;
        await (await sessionManager()).logout();
        activeSessionManager = undefined;
        activeSessionOrigin = undefined;
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      }
      case "PrepareFutureProtection": {
        await assertVaultMutationAllowed(request.expectedVaultId);
        contexts.snapshot(request.expectedVaultId);
        await (await sessionManager()).accessToken();
        const [account, registration] = await Promise.all([
          accountRepository.loadMetadata(),
          accountRepository.loadAccountVault(),
        ]);
        if (
          account === undefined ||
          account.scope !== "Account" ||
          registration?.vaultId !== request.expectedVaultId
        )
          throw Object.assign(new Error("Future Protection authority is incomplete."), {
            id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
          });
        const result = await futureProtection.prepare({
          account,
          registration,
          targetDeviceId: request.targetDeviceId,
        });
        await notifyAppStateChanged();
        return {
          ok: true,
          value: {
            protectionId: result.protectionId,
            recoveryPhrase: result.phrase,
            recoveryFileBase64: bytesToBase64(result.recoveryFile),
            recoveryFilename: `awsm-${registration.vaultId}.awsm-recovery`,
          },
        };
      }
      case "ConfirmFutureProtection": {
        const accessToken = await futureProtection.protect(
          request.protectionId,
          request.recoveryPhrase,
        );
        (await deviceSessionManager()).setAccessToken(accessToken);
        await contexts.reloadFromAuthority();
        await notifyAppStateChanged();
        void synchronizationCoordinator.interactiveWake();
        return { ok: true, value: await state() };
      }
      case "CancelFutureProtection":
        await futureProtection.cancel(request.protectionId);
        await notifyAppStateChanged();
        return { ok: true, value: null };
      case "PrepareVaultReplacement": {
        const preparation = await replacementPreparation(request.expectedVaultId);
        replacementAccessToken = undefined;
        const prepared = await vaultReplacement.prepare({
          account: preparation.account,
          source: preparation.source,
          latestExport: preparation.latestExport,
          safelyStoredConfirmed: request.safelyStoredConfirmed,
          vaultName: preparation.vaultName,
          displayName: firefoxHost ? "Firefox" : "Chrome",
          clientKind: firefoxHost ? "FirefoxExtension" : "ChromeExtension",
        });
        activeCable?.disconnect();
        activeCable = undefined;
        activeCableContext = undefined;
        return {
          ok: true,
          value: {
            replacementId: prepared.replacementId,
            recoveryPhrase: prepared.recoveryPhrase,
            recoveryFileBase64: bytesToBase64(prepared.recoveryFile),
            recoveryFilename: `awsm-${prepared.replacementId}.awsm-recovery`,
          },
        };
      }
      case "ConfirmVaultReplacement": {
        const account = await accountRepository.loadMetadata();
        const active = contexts.active();
        if (account === undefined || account.scope !== "Account" || active === undefined)
          throw Object.assign(new Error("Replacement Account authority is unavailable."), {
            id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
          });
        const preparation = await replacementPreparation(active.vaultId, request.replacementId);
        const staged = await vaultReplacement.confirmAndStage({
          replacementId: request.replacementId,
          recoveryPhrase: request.recoveryPhrase,
          source: preparation.source,
        });
        await runVaultReplacement(staged, account);
        return { ok: true, value: await state() };
      }
      case "CancelVaultReplacement":
        await vaultReplacement.cancel(request.replacementId);
        await notifyAppStateChanged();
        void synchronizationCoordinator.interactiveWake();
        return { ok: true, value: null };
      case "RetryVaultReplacement": {
        contexts.snapshot(request.expectedVaultId);
        const [account, job] = await Promise.all([
          accountRepository.loadMetadata(),
          vaultReplacementRepository.latestForVault(request.expectedVaultId),
        ]);
        if (
          account === undefined ||
          account.scope !== "Account" ||
          job === undefined ||
          job.state !== "Running"
        )
          throw Object.assign(new Error("No resumable Vault replacement is available."), {
            id: "VAULT_REPLACEMENT_CONFLICT",
          });
        await runVaultReplacement(job, account);
        return { ok: true, value: await state() };
      }
      case "LogoutAccount":
        await assertNoApplyingServerSwitch();
        {
          const current = contexts.active();
          if (current !== undefined) {
            storageReliefControllers.get(current.vaultId)?.abort(
              Object.assign(new Error("Authentication is required."), {
                id: "STORAGE_RELIEF_AUTHENTICATION_REQUIRED",
              }),
            );
            await cancelArtifactSessions();
            await current.vault.lock();
          }
        }
        activeCable?.disconnect();
        activeCable = undefined;
        activeCableContext = undefined;
        await (await sessionManager()).logout();
        activeSessionManager = undefined;
        activeSessionOrigin = undefined;
        activeDeviceSessionManager?.clearAccessToken();
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      case "ResetLocalDevice":
        await resetLocalDevice();
        return { ok: true, value: null };
      case "SuggestVaultName":
        return { ok: true, value: { name: await workspace.suggestName() } };
      case "CreateVault":
        await assertNoApplyingServerSwitch();
        await contexts.create(request);
        return { ok: true, value: await state() };
      case "SelectActiveVault":
        await assertNoApplyingServerSwitch();
        await cancelArtifactSessions();
        await contexts.select(request);
        return { ok: true, value: await state() };
      case "RenameVault":
        await assertVaultMutationAllowed(request.vaultId);
        await contexts.rename(request);
        wakeVaultSynchronization(request.vaultId);
        return { ok: true, value: await state() };
      case "UnlockDevice": {
        await contexts.unlockWithDevice(request.expectedVaultId);
        const switchJob = await serverSwitchRepository.loadJob();
        if (
          switchJob !== undefined &&
          switchJob.vaultId === request.expectedVaultId &&
          (switchJob.state === "Running" || switchJob.state === "WaitingForUnlock")
        )
          await compareServerSwitchSafely(
            await (await serverSwitchSession(switchJob.candidateOrigin)).accessToken(),
          );
        const relief = await storageReliefRepository.latestStorageReliefJob(
          request.expectedVaultId,
        );
        if (relief?.state === "WaitingForUnlock")
          void runStorageRelief(request.expectedVaultId).catch((error) =>
            testingFaultCheckpoint?.recordFailure(error),
          );
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      }
      case "DismissRecentCapture": {
        const context = contexts.snapshot(request.expectedVaultId);
        await context.driver.dismissCaptureNotice(request.jobId);
        await notifyAppStateChanged();
        return { ok: true, value: await state() };
      }
      case "CaptureActivePage":
        return {
          ok: true,
          value: await captureActivePage(request.expectedVaultId, request.tabId),
        };
      case "ListLibrary":
        return {
          ok: true,
          value: await libraryGroups(request.expectedVaultId),
        };
      case "ListDeleted":
        return {
          ok: true,
          value: await libraryGroups(request.expectedVaultId, "Deleted"),
        };
      case "DeleteCaptures":
        await changeLibraryState(request.expectedVaultId, request.bundleIds, "Delete");
        await notifyAppStateChanged();
        return { ok: true, value: null };
      case "RestoreCaptures":
        await changeLibraryState(request.expectedVaultId, request.bundleIds, "Restore");
        await notifyAppStateChanged();
        return { ok: true, value: null };
      case "MergeCollections":
      case "MoveCaptures":
      case "ExtractCaptures":
      case "UndoLibraryOperation": {
        const receipt = await manageCollections(request);
        await notifyAppStateChanged();
        return { ok: true, value: receipt };
      }
      case "VacuumVault": {
        await assertVaultMutationAllowed(request.expectedVaultId);
        const context = contexts.snapshot(request.expectedVaultId);
        const records = await vaultRepository.load(context.vaultId);
        if (records === undefined) {
          throw Object.assign(new Error("Vault locked"), {
            id: "VAULT_LOCKED",
          });
        }
        const service = await library(request.expectedVaultId);
        const accountVault = await accountRepository.loadAccountVault();
        const synchronized = accountVault?.vaultId === context.vaultId;
        const resumeSynchronization = synchronized
          ? await synchronizationCoordinator.suspend()
          : undefined;
        try {
          if (synchronized) {
            if (!(await accountRepository.hasAuthenticatedSecrets()))
              throw Object.assign(new Error("Synchronized Vacuum requires authentication"), {
                id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
              });
            await executeSynchronization();
            const [reconciledJob, reconciledAccount] = await Promise.all([
              accountRepository.latestSynchronizationJob(),
              accountRepository.loadAccountVault(),
            ]);
            if (
              reconciledJob?.state !== "Succeeded" ||
              reconciledAccount?.vaultId !== context.vaultId ||
              reconciledAccount.remoteGenerationId !== records.head.generationId ||
              reconciledAccount.remoteGenerationNumber !== records.head.generationNumber
            )
              throw Object.assign(
                new Error("Synchronized Vacuum requires an online current Replica"),
                {
                  id: "SYNCHRONIZATION_INTERRUPTED",
                },
              );
          }
          const repository: VacuumRepository = {
            listStoredObjects: () => context.driver.listStoredObjects(),
            listStoredEvents: () => context.driver.listStoredEvents(),
            getVaultNameProjection: () => context.driver.getVaultNameProjection(),
            acquireVacuum: async (jobId, createdAt) => {
              const head = await context.driver.acquireVacuum(jobId, createdAt);
              await notifyAppStateChanged();
              return head;
            },
            updateVacuumStage: async (jobId, stage) => {
              await context.driver.updateVacuumStage(jobId, stage);
              await notifyAppStateChanged();
            },
            getVaultGeneration: (generationId) => context.driver.getVaultGeneration(generationId),
            releaseVacuum: async (jobId) => {
              await context.driver.releaseVacuum(jobId);
              await notifyAppStateChanged();
            },
            commitVacuum: async (input) => {
              await context.driver.commitVacuum(input);
              await notifyAppStateChanged();
            },
          };
          const activateCandidate = synchronized
            ? async (candidate: VacuumCandidate): Promise<void> => {
                const current = await accountRepository.loadAccountVault();
                if (current === undefined || current.vaultId !== context.vaultId)
                  throw Object.assign(new Error("Account Vault context changed"), {
                    id: "VAULT_CONTEXT_CHANGED",
                  });
                if (
                  current.remoteGenerationId === undefined ||
                  current.remoteGenerationNumber === undefined
                )
                  throw Object.assign(new Error("Remote Generation authority is incomplete"), {
                    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
                  });
                const remoteGenerationId = current.remoteGenerationId;
                const remoteGenerationNumber = current.remoteGenerationNumber;
                const configuration = await accountRepository.loadConfiguration();
                if (configuration.mode !== "Configured")
                  throw Object.assign(new Error("Synchronization server changed"), {
                    id: "VAULT_CONTEXT_CHANGED",
                  });
                const transport = new SynchronizationHttp(
                  configuration.serverOrigin,
                  await deviceSessionManager(context.vaultId),
                );
                await new SynchronizedVacuumActivator(
                  context.vaultId,
                  remoteGenerationNumber,
                  current.deliveryCursor,
                  context.driver,
                  transport,
                  async (approved, activatedHeadCursor) => {
                    await context.driver.commitVacuum(approved);
                    await accountRepository.recordActivatedGeneration({
                      vaultId: context.vaultId,
                      expectedGenerationId: remoteGenerationId,
                      generationId: approved.generation.generationId,
                      generationNumber: approved.generation.generationNumber,
                      deliveryCursor: activatedHeadCursor,
                    });
                    await Promise.all(
                      approved.deletedArtifactObjectIds.map((objectId) =>
                        artifactStore.remove(context.vaultId, objectId),
                      ),
                    );
                    await notifyAppStateChanged();
                  },
                  {
                    persistCandidate: (approved) =>
                      context.driver.persistSynchronizedVacuumCandidate(approved.jobId, approved),
                    markRemoteActivated: (jobId, headCursor) =>
                      context.driver.markSynchronizedVacuumActivated(jobId, headCursor),
                  },
                  runtimeFaultCheckpoint,
                ).activate(candidate);
              }
            : undefined;
          const result = await new VaultVacuumService(
            repository,
            service,
            context.vault.requireKeyring(),
            records.metadata.vaultId,
            records.metadata.deviceId,
            artifactStore,
            activateCandidate,
          ).execute();
          return { ok: true, value: result };
        } catch (error) {
          testingFaultCheckpoint?.recordFailure(error);
          const errorId = error instanceof Error && "id" in error ? String(error.id) : undefined;
          if (
            synchronized &&
            (errorId === "SYNCHRONIZATION_AUTHENTICATION_REQUIRED" ||
              errorId === "AUTHENTICATION_FAILED")
          ) {
            await accountRepository.logout();
            activeSessionManager = undefined;
            activeSessionOrigin = undefined;
            activeDeviceSessionManager = undefined;
            activeDeviceSessionContext = undefined;
            await notifyAppStateChanged();
          }
          throw error;
        } finally {
          resumeSynchronization?.();
          if (synchronized) void synchronizationCoordinator.passivePoll();
        }
      }
      case "GetStorageReliefEstimate": {
        const current = await storageReliefContext(request.expectedVaultId);
        if (!current.context.vault.isUnlocked())
          throw Object.assign(new Error("The Vault is locked."), {
            id: "VAULT_LOCKED",
          });
        if (!current.authenticated)
          throw Object.assign(new Error("Authentication is required."), {
            id: "STORAGE_RELIEF_AUTHENTICATION_REQUIRED",
          });
        const estimate = await storageReliefService(current.context).estimate(
          current.context.vaultId,
          current.context.vault.requireKeyring(),
        );
        return {
          ok: true,
          value: {
            candidateArtifacts: estimate.candidateArtifacts,
            candidateBytes: estimate.candidateBytes,
          },
        };
      }
      case "StartStorageRelief": {
        const current = await storageReliefContext(request.expectedVaultId);
        if (!current.context.vault.isUnlocked())
          throw Object.assign(new Error("The Vault is locked."), {
            id: "VAULT_LOCKED",
          });
        if (!current.authenticated)
          throw Object.assign(new Error("Authentication is required."), {
            id: "STORAGE_RELIEF_AUTHENTICATION_REQUIRED",
          });
        const result = await storageReliefService(current.context).start({
          vaultId: current.context.vaultId,
          keyring: current.context.vault.requireKeyring(),
          accountId: current.metadata.accountId,
          serverOrigin: current.configuration.serverOrigin,
          candidateArtifacts: request.candidateArtifacts,
          candidateBytes: request.candidateBytes,
          now: new Date().toISOString(),
        });
        await notifyAppStateChanged();
        void runStorageRelief(current.context.vaultId).catch((error) =>
          testingFaultCheckpoint?.recordFailure(error),
        );
        return { ok: true, value: result };
      }
      case "CancelStorageRelief": {
        contexts.snapshot(request.expectedVaultId);
        await storageReliefRepository.requestStorageReliefCancellation(
          request.expectedVaultId,
          request.jobId,
          new Date().toISOString(),
        );
        await notifyAppStateChanged();
        return { ok: true, value: null };
      }
      case "GetVacuumEstimate":
        return {
          ok: true,
          value: await vacuumEstimate(request.expectedVaultId),
        };
      case "ExportVault":
        await assertNoApplyingServerSwitch();
        return {
          ok: true,
          value: await exportVault(request.expectedVaultId, request.passphrase),
        };
      case "CancelVaultExport": {
        const context = contexts.snapshot(request.expectedVaultId);
        await context.driver.requestExportCancellation(request.jobId, new Date().toISOString());
        exportControllers.get(request.jobId)?.abort();
        await notifyAppStateChanged();
        return { ok: true, value: null };
      }
      case "BeginVaultImport": {
        await assertNoApplyingServerSwitch();
        const job = await importRepository.begin({
          jobId: crypto.randomUUID(),
          sourceByteLength: request.sourceByteLength,
          createdAt: new Date().toISOString(),
        });
        await notifyAppStateChanged();
        return { ok: true, value: { jobId: job.jobId } };
      }
      case "ReportVaultImportProgress":
        await importRepository.reportAcquired(
          request.jobId,
          request.acquiredBytes,
          new Date().toISOString(),
        );
        await notifyAppStateChanged();
        return { ok: true, value: null };
      case "CompleteVaultImportStaging": {
        const source = await importHost.open(request.jobId);
        await importRepository.completeStaging(
          request.jobId,
          source.size,
          new Date().toISOString(),
        );
        await notifyAppStateChanged();
        return { ok: true, value: null };
      }
      case "ImportVault": {
        if (importControllers.has(request.jobId)) {
          throw Object.assign(new Error("Vault Import is already running."), {
            id: "VAULT_BUSY",
          });
        }
        const controller = new AbortController();
        importControllers.set(request.jobId, controller);
        let passphrase = request.passphrase;
        Reflect.deleteProperty(request, "passphrase");
        try {
          const source = await importHost.open(request.jobId);
          const value = await new VaultImportService(
            importRepository,
            workspaceRepository,
            artifactStore,
            notifyAppStateChanged,
          ).execute({
            jobId: request.jobId,
            source,
            passphrase,
            signal: controller.signal,
          });
          if (contexts.active() === undefined) await contexts.initialize();
          await notifyAppStateChanged();
          return { ok: true, value };
        } finally {
          passphrase = "";
          importControllers.delete(request.jobId);
          const job = await importRepository.latest().catch(() => undefined);
          if (job?.state !== "Created") {
            await importHost.cleanup(request.jobId).catch(() => undefined);
          }
        }
      }
      case "CancelVaultImport": {
        await importRepository.cancel(request.jobId, new Date().toISOString());
        importControllers.get(request.jobId)?.abort();
        await importHost.cleanup(request.jobId).catch(() => undefined);
        await notifyAppStateChanged();
        return { ok: true, value: null };
      }
      case "GetLibraryDetail": {
        const detail = await (await library(request.expectedVaultId)).detail(request.bundleId);
        return {
          ok: true,
          value: {
            item: detail.item,
            metadata: detail.metadata,
            artifacts: detail.artifacts,
          },
        };
      }
      case "OpenArtifact": {
        if (request.role === "PRIMARY")
          throw Object.assign(new Error("Use Download MHTML for the primary page snapshot."), {
            id: "BUNDLE_INVALID",
          });
        const service = await library(request.expectedVaultId);
        const opened = await service.openArtifact(request.bundleId, request.role);
        const wasRemote = await storageReliefRepository.isArtifactRemoteOnly(
          request.expectedVaultId,
          opened.reference.artifactObjectId,
        );
        const sessionId = crypto.randomUUID();
        artifactSessions.set(sessionId, {
          vaultId: request.expectedVaultId,
          bundleId: request.bundleId,
          role: request.role,
          artifactObjectId: opened.reference.artifactObjectId,
          wasRemote,
          reader: opened.stream.getReader(),
        });
        return {
          ok: true,
          value: {
            sessionId,
            role: request.role,
            mimeType: opened.reference.mimeType,
            byteLength: opened.reference.plaintextByteLength,
            filename: artifactFilename(request.bundleId, request.role),
          },
        };
      }
      case "DownloadMhtml": {
        const service = await library(request.expectedVaultId);
        const opened = await service.openArtifact(request.bundleId, "PRIMARY");
        const wasRemote = await storageReliefRepository.isArtifactRemoteOnly(
          request.expectedVaultId,
          opened.reference.artifactObjectId,
        );
        const filename = mhtmlDownloadFilename(request.bundleId);
        await mhtmlDownloadHost.download(
          {
            snapshotTemporaryName: `${crypto.randomUUID()}.awsm-page.tmp`,
            mhtmlTemporaryName: `${crypto.randomUUID()}.mhtml.tmp`,
            filename,
            stream: opened.stream,
          },
          new AbortController().signal,
        );
        if (
          wasRemote &&
          !(await storageReliefRepository.isArtifactRemoteOnly(
            request.expectedVaultId,
            opened.reference.artifactObjectId,
          ))
        )
          await notifyAppStateChanged();
        return { ok: true, value: { filename } };
      }
      case "ReadArtifactChunk": {
        contexts.snapshot(request.expectedVaultId);
        const session = artifactSessions.get(request.sessionId);
        if (session === undefined || session.vaultId !== request.expectedVaultId)
          throw Object.assign(new Error("Artifact session missing"), {
            id: "VAULT_CONTEXT_CHANGED",
          });
        let chunk = session.pending;
        if (chunk === undefined) {
          const next = await session.reader.read();
          if (next.done) {
            artifactSessions.delete(request.sessionId);
            session.reader.releaseLock();
            if (
              session.wasRemote &&
              !(await storageReliefRepository.isArtifactRemoteOnly(
                session.vaultId,
                session.artifactObjectId,
              ))
            )
              await notifyAppStateChanged();
            return { ok: true, value: { done: true } };
          }
          chunk = next.value;
        }
        const outgoing = chunk.subarray(0, ARTIFACT_MESSAGE_CHUNK_BYTES);
        if (outgoing.byteLength === chunk.byteLength) delete session.pending;
        else session.pending = chunk.subarray(outgoing.byteLength);
        return {
          ok: true,
          value: { done: false, chunkBase64: bytesToBase64(outgoing) },
        };
      }
      case "CancelArtifactSession": {
        const session = artifactSessions.get(request.sessionId);
        artifactSessions.delete(request.sessionId);
        if (session !== undefined) await session.reader.cancel().catch(() => undefined);
        return { ok: true, value: null };
      }
    }
  } catch (error) {
    testingFaultCheckpoint?.recordFailure(error);
    return safeError(error);
  }
}

export function startBackground(): void {
  browser.runtime.onMessage.addListener((request: unknown) => {
    const testingResponse = testingFaultCheckpoint?.handle(request);
    if (testingResponse !== undefined) return Promise.resolve(testingResponse);
    if (!isAppRequest(request)) return undefined;
    return startup.then(() => handle(request));
  });
}

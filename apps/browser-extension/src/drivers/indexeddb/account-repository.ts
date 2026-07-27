import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { canonicalRecord, literal, uuid } from "../../domain/validation";
import type { WorkspaceVaultNameCacheV1 } from "../../runtime/vault/workspace-name-cache";
import { openDatabase, requestValue, transactionDone } from "./database";
import { storageError } from "./errors";
import { vaultKey, vaultKeyRange, vaultSingletonKey } from "./keys";
import {
  type AccountConfigurationV1,
  DATABASE_NAME,
  type ServerSwitchJobV1,
  STORES,
  type StoredAccountMetadataV1,
  type StoredAccountSecretsV1,
  type StoredAccountVaultV1,
  type StoredCollectionProjectionV1,
  type StoredEvent,
  type StoredObjectV1,
  type StoredProjectionV1,
  type StoredRecoveryKitV1,
  type StoredVaultGenerationV1,
  type StoredVaultHeadV1,
  type StoredVaultNameProjectionV1,
  type SynchronizationCheckpointV1,
  type SynchronizationJobV1,
} from "./schema";

export interface ServerSwitchReplicaPromotion {
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly libraryProjections: readonly StoredProjectionV1[];
  readonly collectionProjection: StoredCollectionProjectionV1;
  readonly vaultNameProjection: StoredVaultNameProjectionV1;
  readonly nameCache: WorkspaceVaultNameCacheV1;
  readonly clearArtifactAvailability: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type AccountCredentialScope = "active" | "server-switch-candidate" | "server-switch-prior";

function credentialKeys(scope: AccountCredentialScope): {
  readonly metadata: string;
  readonly secrets: string;
  readonly session: string;
} {
  switch (scope) {
    case "active":
      return {
        metadata: "active",
        secrets: "active",
        session: "session-storage",
      };
    case "server-switch-candidate":
      return {
        metadata: "server-switch-candidate",
        secrets: "server-switch-candidate",
        session: "server-switch-candidate-session",
      };
    case "server-switch-prior":
      return {
        metadata: "server-switch-prior",
        secrets: "server-switch-prior",
        session: "server-switch-prior-session",
      };
  }
}

function accountAad(
  scope: AccountCredentialScope,
  accountId: string,
  sessionId: string,
): Uint8Array {
  return encodeCanonicalCbor(["account:session-storage:v1", scope, accountId, sessionId]);
}

function sessionStorageKey(value: unknown): CryptoKey {
  if (
    !(value instanceof CryptoKey) ||
    value.extractable ||
    value.algorithm.name !== "AES-GCM" ||
    !value.usages.includes("encrypt") ||
    !value.usages.includes("decrypt")
  ) {
    throw new DomainValidationError("sessionStorageKey", "must be a non-exportable AES-GCM key");
  }
  return value;
}

function metadata(value: unknown): StoredAccountMetadataV1 {
  const input = canonicalRecord(value, "accountMetadata", [
    "version",
    "accountId",
    "sessionId",
    "email",
    "scope",
  ]);
  if (
    typeof input.email !== "string" ||
    (input.scope !== "Account" && input.scope !== "VaultDevice")
  ) {
    throw new DomainValidationError("accountMetadata", "contains invalid Account metadata");
  }
  return {
    version: literal(input.version, 1, "accountMetadata.version"),
    accountId: uuid(input.accountId, "accountMetadata.accountId"),
    sessionId: uuid(input.sessionId, "accountMetadata.sessionId"),
    email: input.email,
    scope: input.scope,
  };
}

function secrets(value: unknown): StoredAccountSecretsV1 {
  const input = canonicalRecord(value, "accountSecrets", [
    "version",
    "accountId",
    "sessionId",
    "refreshNonce",
    "refreshCiphertext",
  ]);
  const bytes = (candidate: unknown, field: string, length?: number): Uint8Array => {
    if (
      !(candidate instanceof Uint8Array) ||
      (length !== undefined && candidate.byteLength !== length)
    )
      throw new DomainValidationError(field, "contains invalid bytes");
    return candidate;
  };
  return {
    version: literal(input.version, 1, "accountSecrets.version"),
    accountId: uuid(input.accountId, "accountSecrets.accountId"),
    sessionId: uuid(input.sessionId, "accountSecrets.sessionId"),
    refreshNonce: bytes(input.refreshNonce, "accountSecrets.refreshNonce", 12),
    refreshCiphertext: bytes(input.refreshCiphertext, "accountSecrets.refreshCiphertext"),
  };
}

interface AuthenticatedInput {
  readonly metadata: StoredAccountMetadataV1;
  readonly refreshToken: string;
}

interface PreparedAuthenticated {
  readonly metadata: StoredAccountMetadataV1;
  readonly sessionKey: CryptoKey;
  readonly sessionKeyIsNew: boolean;
  readonly secrets: StoredAccountSecretsV1;
}

async function prepareAuthenticated(
  input: AuthenticatedInput,
  scope: AccountCredentialScope,
  retainedSessionKey?: CryptoKey,
): Promise<PreparedAuthenticated> {
  const sessionKey =
    retainedSessionKey ??
    (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]));
  const refreshNonce = crypto.getRandomValues(new Uint8Array(12));
  const refreshCiphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: refreshNonce,
        additionalData: Uint8Array.from(
          accountAad(scope, input.metadata.accountId, input.metadata.sessionId),
        ),
      },
      sessionKey,
      encoder.encode(input.refreshToken),
    ),
  );
  return {
    metadata: input.metadata,
    sessionKey,
    sessionKeyIsNew: retainedSessionKey === undefined,
    secrets: {
      version: 1,
      accountId: input.metadata.accountId,
      sessionId: input.metadata.sessionId,
      refreshNonce,
      refreshCiphertext,
    },
  };
}

function putPrepared(
  transaction: IDBTransaction,
  scope: AccountCredentialScope,
  prepared: PreparedAuthenticated,
): void {
  const keys = credentialKeys(scope);
  transaction.objectStore(STORES.apiSessions).put(prepared.metadata, keys.metadata);
  if (prepared.sessionKeyIsNew)
    transaction.objectStore(STORES.sessionKeys).put(prepared.sessionKey, keys.session);
  transaction.objectStore(STORES.protectedCredentials).put(prepared.secrets, keys.secrets);
}

export class IndexedDbAccountRepository {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(readonly databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  async saveAuthenticated(
    input: AuthenticatedInput,
    scope: AccountCredentialScope = "active",
  ): Promise<void> {
    const database = await this.databasePromise;
    const keys = credentialKeys(scope);
    const read = database.transaction(STORES.sessionKeys, "readonly");
    const retainedValue = await requestValue(
      read.objectStore(STORES.sessionKeys).get(keys.session),
    );
    await transactionDone(read);
    const retainedSessionKey =
      retainedValue === undefined ? undefined : sessionStorageKey(retainedValue);
    const prepared = await prepareAuthenticated(input, scope, retainedSessionKey);
    const transaction = database.transaction(
      [STORES.apiSessions, STORES.sessionKeys, STORES.protectedCredentials],
      "readwrite",
    );
    try {
      putPrepared(transaction, scope, prepared);
      await transactionDone(transaction);
    } catch (error) {
      transaction.abort();
      throw storageError(error);
    }
  }

  async loadAuthenticated(scope: AccountCredentialScope = "active"): Promise<
    | {
        readonly metadata: StoredAccountMetadataV1;
        readonly refreshToken: string;
        readonly sessionKey: CryptoKey;
      }
    | undefined
  > {
    const database = await this.databasePromise;
    const keys = credentialKeys(scope);
    const transaction = database.transaction(
      [STORES.apiSessions, STORES.sessionKeys, STORES.protectedCredentials],
      "readonly",
    );
    try {
      const [metadataValue, sessionValue, secretsValue] = await Promise.all([
        requestValue(transaction.objectStore(STORES.apiSessions).get(keys.metadata)),
        requestValue(transaction.objectStore(STORES.sessionKeys).get(keys.session)),
        requestValue(transaction.objectStore(STORES.protectedCredentials).get(keys.secrets)),
      ]);
      await transactionDone(transaction);
      if (secretsValue === undefined) {
        if (sessionValue !== undefined) sessionStorageKey(sessionValue);
        return undefined;
      }
      if (metadataValue === undefined || sessionValue === undefined)
        throw new DomainValidationError("account", "is only partially initialized");
      const decodedMetadata = metadata(metadataValue);
      const decodedSecrets = secrets(secretsValue);
      if (
        decodedMetadata.accountId !== decodedSecrets.accountId ||
        decodedMetadata.sessionId !== decodedSecrets.sessionId
      )
        throw new DomainValidationError("account", "has mismatched session identity");
      const sessionKey = sessionStorageKey(sessionValue);
      const refreshBytes = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(decodedSecrets.refreshNonce),
          additionalData: Uint8Array.from(
            accountAad(scope, decodedMetadata.accountId, decodedMetadata.sessionId),
          ),
        },
        sessionKey,
        Uint8Array.from(decodedSecrets.refreshCiphertext),
      );
      return {
        metadata: decodedMetadata,
        refreshToken: decoder.decode(refreshBytes),
        sessionKey,
      };
    } catch (error) {
      throw storageError(error);
    }
  }

  async loadMetadata(
    scope: AccountCredentialScope = "active",
  ): Promise<StoredAccountMetadataV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.apiSessions, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.apiSessions).get(credentialKeys(scope).metadata),
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : metadata(value);
  }

  async hasAuthenticatedSecrets(scope: AccountCredentialScope = "active"): Promise<boolean> {
    const database = await this.databasePromise;
    const keys = credentialKeys(scope);
    const transaction = database.transaction(
      [STORES.apiSessions, STORES.sessionKeys, STORES.protectedCredentials],
      "readonly",
    );
    const [metadataValue, sessionValue, secretsValue] = await Promise.all([
      requestValue(transaction.objectStore(STORES.apiSessions).get(keys.metadata)),
      requestValue(transaction.objectStore(STORES.sessionKeys).get(keys.session)),
      requestValue(transaction.objectStore(STORES.protectedCredentials).get(keys.secrets)),
    ]);
    await transactionDone(transaction);
    if (secretsValue === undefined) {
      if (sessionValue !== undefined) sessionStorageKey(sessionValue);
      return false;
    }
    if (metadataValue === undefined || sessionValue === undefined)
      throw new DomainValidationError("account", "has partial credential state");
    const decodedMetadata = metadata(metadataValue);
    const decodedSecrets = secrets(secretsValue);
    if (
      decodedMetadata.accountId !== decodedSecrets.accountId ||
      decodedMetadata.sessionId !== decodedSecrets.sessionId
    )
      throw new DomainValidationError("account", "has mismatched session identity");
    sessionStorageKey(sessionValue);
    return true;
  }

  async eraseAuthenticated(scope: AccountCredentialScope): Promise<void> {
    const database = await this.databasePromise;
    const keys = credentialKeys(scope);
    const transaction = database.transaction(
      [STORES.apiSessions, STORES.sessionKeys, STORES.protectedCredentials],
      "readwrite",
    );
    transaction.objectStore(STORES.apiSessions).delete(keys.metadata);
    transaction.objectStore(STORES.sessionKeys).delete(keys.session);
    transaction.objectStore(STORES.protectedCredentials).delete(keys.secrets);
    await transactionDone(transaction);
  }

  async eraseAuthenticationSecrets(scope: AccountCredentialScope): Promise<void> {
    const database = await this.databasePromise;
    const keys = credentialKeys(scope);
    const transaction = database.transaction(
      [STORES.sessionKeys, STORES.protectedCredentials],
      "readwrite",
    );
    transaction.objectStore(STORES.sessionKeys).delete(keys.session);
    transaction.objectStore(STORES.protectedCredentials).delete(keys.secrets);
    await transactionDone(transaction);
  }

  async logout(): Promise<void> {
    const database = await this.databasePromise;
    const keys = credentialKeys("active");
    const transaction = database.transaction(
      [STORES.protectedCredentials, STORES.synchronizationJobs, STORES.synchronizationCheckpoints],
      "readwrite",
    );
    transaction.objectStore(STORES.protectedCredentials).delete(keys.secrets);
    transaction.objectStore(STORES.synchronizationJobs).clear();
    transaction.objectStore(STORES.synchronizationCheckpoints).clear();
    await transactionDone(transaction);
  }

  async beginEnrollment(input: {
    readonly registration: StoredAccountVaultV1;
    readonly job: SynchronizationJobV1;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.synchronizationJobs],
      "readwrite",
    );
    transaction.objectStore(STORES.vaultSyncState).put(input.registration, "active");
    transaction.objectStore(STORES.synchronizationJobs).put(input.job, "active");
    await transactionDone(transaction);
  }

  async saveDiscoveredVault(input: {
    readonly registration?: StoredAccountVaultV1;
    readonly job: SynchronizationJobV1;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.synchronizationJobs],
      "readwrite",
    );
    if (input.registration === undefined) transaction.objectStore(STORES.vaultSyncState).clear();
    else transaction.objectStore(STORES.vaultSyncState).put(input.registration, "active");
    transaction.objectStore(STORES.synchronizationJobs).put(input.job, "active");
    await transactionDone(transaction);
  }

  async saveRecoveryDiscovery(input: {
    readonly registration?: StoredAccountVaultV1;
    readonly recoveryKit?: StoredRecoveryKitV1;
    readonly job: SynchronizationJobV1;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.recoveryKits, STORES.synchronizationJobs],
      "readwrite",
    );
    transaction.objectStore(STORES.vaultSyncState).clear();
    transaction.objectStore(STORES.recoveryKits).clear();
    if (input.registration !== undefined)
      transaction.objectStore(STORES.vaultSyncState).put(input.registration, "active");
    if (input.recoveryKit !== undefined)
      transaction
        .objectStore(STORES.recoveryKits)
        .put(input.recoveryKit, input.recoveryKit.vaultId);
    transaction.objectStore(STORES.synchronizationJobs).put(input.job, "active");
    await transactionDone(transaction);
  }

  async saveReturningDeviceDiscovery(input: {
    readonly expected: StoredAccountVaultV1;
    readonly recoveryKit: StoredRecoveryKitV1;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.recoveryKits],
      "readwrite",
    );
    const current = (await requestValue(
      transaction.objectStore(STORES.vaultSyncState).get("active"),
    )) as StoredAccountVaultV1 | undefined;
    if (
      current === undefined ||
      current.version !== input.expected.version ||
      current.accountId !== input.expected.accountId ||
      current.vaultId !== input.expected.vaultId ||
      current.activeRecoveryGenerationId !== input.expected.activeRecoveryGenerationId ||
      current.activeKeyEpochId !== input.expected.activeKeyEpochId ||
      current.remoteGenerationId !== input.expected.remoteGenerationId ||
      current.remoteGenerationNumber !== input.expected.remoteGenerationNumber ||
      current.deliveryCursor !== input.expected.deliveryCursor ||
      input.recoveryKit.vaultId !== current.vaultId ||
      input.recoveryKit.recoveryGenerationId !== current.activeRecoveryGenerationId
    ) {
      transaction.abort();
      throw new DomainValidationError(
        "returningDeviceDiscovery",
        "changed while refreshing Recovery Kit metadata",
      );
    }
    transaction.objectStore(STORES.recoveryKits).put(input.recoveryKit, input.recoveryKit.vaultId);
    await transactionDone(transaction);
  }

  async loadRecoveryKit(vaultId: string): Promise<StoredRecoveryKitV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.recoveryKits, "readonly");
    const value = await requestValue(transaction.objectStore(STORES.recoveryKits).get(vaultId));
    await transactionDone(transaction);
    return value as StoredRecoveryKitV1 | undefined;
  }

  async beginRecoveredBootstrap(input: {
    readonly accountId: string;
    readonly vaultId: string;
    readonly generationId: string;
    readonly generationNumber: number;
    readonly deliveryCursor: number;
    readonly now: string;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.synchronizationJobs],
      "readwrite",
    );
    const stored = (await requestValue(
      transaction.objectStore(STORES.vaultSyncState).get("active"),
    )) as StoredAccountVaultV1 | undefined;
    if (
      stored === undefined ||
      stored.accountId !== input.accountId ||
      stored.vaultId !== input.vaultId ||
      stored.activeRecoveryGenerationId === undefined ||
      stored.activeKeyEpochId === undefined
    ) {
      transaction.abort();
      throw new DomainValidationError(
        "recoveredDevice",
        "does not match discovered Vault authority",
      );
    }
    const registration: StoredAccountVaultV1 = {
      ...stored,
      remoteGenerationId: input.generationId,
      remoteGenerationNumber: input.generationNumber,
      deliveryCursor: input.deliveryCursor,
    };
    const job: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId: input.accountId,
      vaultId: input.vaultId,
      generationId: input.generationId,
      generationNumber: input.generationNumber,
      state: "Running",
      stage: "DownloadRecords",
      createdAt: input.now,
      updatedAt: input.now,
      snapshotCursor: input.deliveryCursor,
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    transaction.objectStore(STORES.vaultSyncState).put(registration, "active");
    transaction.objectStore(STORES.synchronizationJobs).put(job, "active");
    await transactionDone(transaction);
  }

  async latestSynchronizationJob(): Promise<SynchronizationJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.synchronizationJobs, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.synchronizationJobs).get("active"),
    );
    await transactionDone(transaction);
    return value as SynchronizationJobV1 | undefined;
  }

  async saveAccountVault(
    registration: StoredAccountVaultV1,
    scope: "active" | "server-switch-candidate" = "active",
  ): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultSyncState, "readwrite");
    transaction.objectStore(STORES.vaultSyncState).put(registration, scope);
    await transactionDone(transaction);
  }

  async eraseAccountVault(scope: "active" | "server-switch-candidate"): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultSyncState, "readwrite");
    transaction.objectStore(STORES.vaultSyncState).delete(scope);
    await transactionDone(transaction);
  }

  async loadAccountVault(
    scope: "active" | "server-switch-candidate" = "active",
  ): Promise<StoredAccountVaultV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultSyncState, "readonly");
    const value = await requestValue(transaction.objectStore(STORES.vaultSyncState).get(scope));
    await transactionDone(transaction);
    return value as StoredAccountVaultV1 | undefined;
  }

  async promoteServerSwitch(input: {
    readonly job: ServerSwitchJobV1;
    readonly candidateOrigin: string;
    readonly now: string;
  }): Promise<void> {
    await this.promoteServerSwitchAuthority(input);
  }

  async promoteServerSwitchWithReplica(input: {
    readonly job: ServerSwitchJobV1;
    readonly candidateOrigin: string;
    readonly now: string;
    readonly replica: ServerSwitchReplicaPromotion;
  }): Promise<void> {
    await this.promoteServerSwitchAuthority(input, input.replica);
  }

  private async promoteServerSwitchAuthority(
    input: {
      readonly job: ServerSwitchJobV1;
      readonly candidateOrigin: string;
      readonly now: string;
    },
    replica?: ServerSwitchReplicaPromotion,
  ): Promise<void> {
    if (input.job.stage !== "PromoteContext" || input.job.state !== "Running")
      throw new DomainValidationError("serverSwitchJob", "is not ready for promotion");
    const [source, candidate, registration] = await Promise.all([
      this.loadAuthenticated("active"),
      this.loadAuthenticated("server-switch-candidate"),
      this.loadAccountVault("server-switch-candidate"),
    ]);
    if (
      source === undefined ||
      candidate === undefined ||
      registration === undefined ||
      registration.accountId !== candidate.metadata.accountId ||
      registration.vaultId !== input.job.vaultId
    )
      throw new DomainValidationError("serverSwitchJob", "has incomplete Account authority");
    try {
      const [preparedActive, preparedPrior] = await Promise.all([
        prepareAuthenticated(candidate, "active"),
        prepareAuthenticated(source, "server-switch-prior"),
      ]);
      const database = await this.databasePromise;
      const transaction = database.transaction(
        [
          STORES.accountConfiguration,
          STORES.apiSessions,
          STORES.sessionKeys,
          STORES.protectedCredentials,
          STORES.vaultSyncState,
          STORES.synchronizationJobs,
          STORES.synchronizationCheckpoints,
          STORES.serverSwitchJobs,
          STORES.deviceSessions,
          ...(replica === undefined
            ? []
            : [
                STORES.vaultGenerations,
                STORES.vaultHead,
                STORES.objects,
                STORES.events,
                STORES.libraryProjection,
                STORES.collectionProjection,
                STORES.vaultNameProjection,
                STORES.vaultNameCache,
                STORES.artifactAvailability,
                STORES.storageReliefJobs,
                STORES.storageReliefCheckpoints,
              ]),
        ],
        "readwrite",
      );
      try {
        const storedJob = (await requestValue(
          transaction.objectStore(STORES.serverSwitchJobs).get("active"),
        )) as ServerSwitchJobV1 | undefined;
        if (storedJob?.jobId !== input.job.jobId || storedJob.stage !== "PromoteContext") {
          transaction.abort();
          throw new DomainValidationError("serverSwitchJob", "changed before promotion");
        }
        if (replica !== undefined) {
          const storedHead = (await requestValue(
            transaction
              .objectStore(STORES.vaultHead)
              .get(vaultSingletonKey(input.job.vaultId, "active")),
          )) as StoredVaultHeadV1 | undefined;
          if (
            storedHead === undefined ||
            storedHead.generationId !== input.job.expectedLocalHead.generationId ||
            storedHead.generationNumber !== input.job.expectedLocalHead.generationNumber ||
            storedHead.appendedObjectIds.join("\n") !==
              input.job.expectedLocalHead.appendedObjectIds.join("\n") ||
            storedHead.appendedEventIds.join("\n") !==
              input.job.expectedLocalHead.appendedEventIds.join("\n") ||
            replica.head.vaultId !== input.job.vaultId ||
            replica.head.generationId !== replica.generation.generationId ||
            replica.events.some((event) => event.vaultId !== input.job.vaultId) ||
            replica.collectionProjection.projectionId !== input.job.vaultId ||
            replica.vaultNameProjection.vaultId !== input.job.vaultId ||
            replica.nameCache.vaultId !== input.job.vaultId
          ) {
            transaction.abort();
            throw new DomainValidationError("serverSwitchJob", "local authority changed");
          }
          transaction.objectStore(STORES.vaultGenerations).delete(vaultKeyRange(input.job.vaultId));
          transaction.objectStore(STORES.events).delete(vaultKeyRange(input.job.vaultId));
          transaction.objectStore(STORES.objects).delete(vaultKeyRange(input.job.vaultId));
          transaction
            .objectStore(STORES.vaultGenerations)
            .put(replica.generation, vaultKey(input.job.vaultId, replica.generation.generationId));
          for (const event of replica.events)
            transaction
              .objectStore(STORES.events)
              .put(event, vaultKey(input.job.vaultId, event.eventId));
          for (const object of replica.objects)
            transaction
              .objectStore(STORES.objects)
              .put(object, vaultKey(input.job.vaultId, object.objectId));
          transaction
            .objectStore(STORES.libraryProjection)
            .delete(vaultKeyRange(input.job.vaultId));
          for (const projection of replica.libraryProjections)
            transaction
              .objectStore(STORES.libraryProjection)
              .put(projection, vaultKey(input.job.vaultId, projection.bundleId));
          transaction
            .objectStore(STORES.collectionProjection)
            .put(replica.collectionProjection, vaultSingletonKey(input.job.vaultId, "active"));
          transaction
            .objectStore(STORES.vaultNameProjection)
            .put(replica.vaultNameProjection, vaultSingletonKey(input.job.vaultId, "active"));
          transaction.objectStore(STORES.vaultNameCache).put(replica.nameCache, input.job.vaultId);
          if (replica.clearArtifactAvailability) {
            transaction
              .objectStore(STORES.artifactAvailability)
              .delete(vaultKeyRange(input.job.vaultId));
            transaction
              .objectStore(STORES.storageReliefJobs)
              .delete(vaultKeyRange(input.job.vaultId));
            transaction
              .objectStore(STORES.storageReliefCheckpoints)
              .delete(vaultKeyRange(input.job.vaultId));
          }
          transaction
            .objectStore(STORES.vaultHead)
            .put(replica.head, vaultSingletonKey(input.job.vaultId, "active"));
        }
        putPrepared(transaction, "active", preparedActive);
        putPrepared(transaction, "server-switch-prior", preparedPrior);
        const candidateKeys = credentialKeys("server-switch-candidate");
        transaction.objectStore(STORES.apiSessions).delete(candidateKeys.metadata);
        transaction.objectStore(STORES.sessionKeys).delete(candidateKeys.session);
        transaction.objectStore(STORES.protectedCredentials).delete(candidateKeys.secrets);
        transaction.objectStore(STORES.accountConfiguration).put(
          {
            version: 1,
            mode: "Configured",
            serverOrigin: input.candidateOrigin,
            registration: input.job.candidateRegistration,
          },
          "active",
        );
        transaction.objectStore(STORES.vaultSyncState).put(registration, "active");
        transaction.objectStore(STORES.vaultSyncState).delete("server-switch-candidate");
        const candidateDeviceSession = await requestValue(
          transaction
            .objectStore(STORES.deviceSessions)
            .get(`${input.job.vaultId}:server-switch-candidate`),
        );
        if (candidateDeviceSession === undefined) {
          transaction.abort();
          throw new DomainValidationError(
            "serverSwitchJob",
            "candidate Device session is incomplete",
          );
        }
        transaction
          .objectStore(STORES.deviceSessions)
          .put(candidateDeviceSession, input.job.vaultId);
        transaction
          .objectStore(STORES.deviceSessions)
          .delete(`${input.job.vaultId}:server-switch-candidate`);
        transaction.objectStore(STORES.synchronizationCheckpoints).clear();
        if (
          registration.remoteGenerationId === undefined ||
          registration.remoteGenerationNumber === undefined
        ) {
          transaction.abort();
          throw new DomainValidationError(
            "serverSwitchJob",
            "candidate Generation authority is incomplete",
          );
        }
        transaction.objectStore(STORES.synchronizationJobs).put(
          {
            version: 1,
            jobId: crypto.randomUUID(),
            accountId: candidate.metadata.accountId,
            vaultId: registration.vaultId,
            generationId: registration.remoteGenerationId,
            generationNumber: registration.remoteGenerationNumber,
            state: "Running",
            stage: "FetchChanges",
            createdAt: input.now,
            updatedAt: input.now,
            snapshotCursor: registration.deliveryCursor,
            completedItems: 0,
            totalItems: 0,
            processedBytes: 0,
            totalBytes: 0,
            retryCount: 0,
            attachIdempotencyKey: crypto.randomUUID(),
          } satisfies SynchronizationJobV1,
          "active",
        );
        transaction
          .objectStore(STORES.serverSwitchJobs)
          .put({ ...input.job, stage: "RevokePriorSession", updatedAt: input.now }, "active");
        await transactionDone(transaction);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // A request failure may already have aborted the transaction.
        }
        throw error;
      }
    } finally {
      // Non-extractable session keys and encrypted refresh credentials remain store-owned.
    }
  }

  async saveSynchronizationJob(job: SynchronizationJobV1): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.synchronizationJobs, "readwrite");
    transaction.objectStore(STORES.synchronizationJobs).put(job, "active");
    await transactionDone(transaction);
  }

  async synchronizationCheckpoint(
    vaultId: string,
    kind: "Object" | "Event",
    entityId: string,
  ): Promise<SynchronizationCheckpointV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.synchronizationCheckpoints, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.synchronizationCheckpoints).get([vaultId, kind, entityId]),
    );
    await transactionDone(transaction);
    return value as SynchronizationCheckpointV1 | undefined;
  }

  async saveSynchronizationCheckpoint(checkpoint: SynchronizationCheckpointV1): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.synchronizationCheckpoints, "readwrite");
    transaction
      .objectStore(STORES.synchronizationCheckpoints)
      .put(checkpoint, [checkpoint.vaultId, checkpoint.kind, checkpoint.entityId]);
    await transactionDone(transaction);
  }

  async wakeSynchronization(vaultId: string, now = new Date().toISOString()): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.synchronizationJobs],
      "readwrite",
    );
    const [registrationValue, jobValue] = await Promise.all([
      requestValue(transaction.objectStore(STORES.vaultSyncState).get("active")),
      requestValue(transaction.objectStore(STORES.synchronizationJobs).get("active")),
    ]);
    const registration = registrationValue as StoredAccountVaultV1 | undefined;
    const current = jobValue as SynchronizationJobV1 | undefined;
    if (
      registration?.vaultId !== vaultId ||
      registration.remoteGenerationId === undefined ||
      registration.remoteGenerationNumber === undefined
    ) {
      await transactionDone(transaction);
      return false;
    }
    if (
      current?.vaultId === vaultId &&
      current.state !== "Succeeded" &&
      current.state !== "Waiting"
    ) {
      await transactionDone(transaction);
      return false;
    }
    const job: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId: registration.accountId,
      vaultId,
      generationId: registration.remoteGenerationId,
      generationNumber: registration.remoteGenerationNumber,
      state: "Created",
      stage: "UploadObjects",
      createdAt: now,
      updatedAt: now,
      snapshotCursor: registration.deliveryCursor,
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    transaction.objectStore(STORES.synchronizationJobs).put(job, "active");
    await transactionDone(transaction);
    return true;
  }

  async wakePull(latestCursor?: number, now = new Date().toISOString()): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.synchronizationJobs],
      "readwrite",
    );
    const [registrationValue, jobValue] = await Promise.all([
      requestValue(transaction.objectStore(STORES.vaultSyncState).get("active")),
      requestValue(transaction.objectStore(STORES.synchronizationJobs).get("active")),
    ]);
    const registration = registrationValue as StoredAccountVaultV1 | undefined;
    const current = jobValue as SynchronizationJobV1 | undefined;
    if (
      registration === undefined ||
      registration.remoteGenerationId === undefined ||
      registration.remoteGenerationNumber === undefined ||
      (latestCursor !== undefined && latestCursor <= registration.deliveryCursor) ||
      (current !== undefined && current.state !== "Succeeded")
    ) {
      await transactionDone(transaction);
      return false;
    }
    const job: SynchronizationJobV1 = {
      version: 1,
      jobId: crypto.randomUUID(),
      accountId: registration.accountId,
      vaultId: registration.vaultId,
      generationId: registration.remoteGenerationId,
      generationNumber: registration.remoteGenerationNumber,
      state: "Created",
      stage: "FetchChanges",
      createdAt: now,
      updatedAt: now,
      snapshotCursor: registration.deliveryCursor,
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    transaction.objectStore(STORES.synchronizationJobs).put(job, "active");
    await transactionDone(transaction);
    return true;
  }

  async retrySynchronization(now = new Date().toISOString()): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.synchronizationJobs, "readwrite");
    const value = await requestValue(
      transaction.objectStore(STORES.synchronizationJobs).get("active"),
    );
    const job = value as SynchronizationJobV1 | undefined;
    if (
      job === undefined ||
      (job.state !== "Waiting" &&
        job.state !== "Failed" &&
        job.state !== "AuthenticationRequired") ||
      job.errorId === "ACCOUNT_VAULT_SELECTION_REQUIRED"
    ) {
      await transactionDone(transaction);
      return false;
    }
    const { retryAt: _retryAt, errorId: _errorId, ...retryable } = job;
    const retried: SynchronizationJobV1 = {
      ...retryable,
      state: "Created",
      updatedAt: now,
      retryCount: 0,
    };
    transaction.objectStore(STORES.synchronizationJobs).put(retried, "active");
    await transactionDone(transaction);
    return true;
  }

  async recordActivatedGeneration(input: {
    readonly vaultId: string;
    readonly expectedGenerationId: string;
    readonly generationId: string;
    readonly generationNumber: number;
    readonly deliveryCursor: number;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.synchronizationJobs],
      "readwrite",
    );
    const value = await requestValue(transaction.objectStore(STORES.vaultSyncState).get("active"));
    const registration = value as StoredAccountVaultV1 | undefined;
    if (
      registration?.vaultId !== input.vaultId ||
      registration.remoteGenerationId !== input.expectedGenerationId
    ) {
      transaction.abort();
      throw new DomainValidationError("accountVault", "changed during Vacuum activation");
    }
    const updated: StoredAccountVaultV1 = {
      ...registration,
      remoteGenerationId: input.generationId,
      remoteGenerationNumber: input.generationNumber,
      deliveryCursor: input.deliveryCursor,
    };
    transaction.objectStore(STORES.vaultSyncState).put(updated, "active");
    transaction.objectStore(STORES.synchronizationJobs).put(
      {
        version: 1,
        jobId: crypto.randomUUID(),
        accountId: registration.accountId,
        vaultId: registration.vaultId,
        generationId: input.generationId,
        generationNumber: input.generationNumber,
        state: "Succeeded",
        stage: "Checkpoint",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshotCursor: input.deliveryCursor,
        completedItems: 0,
        totalItems: 0,
        processedBytes: 0,
        totalBytes: 0,
        retryCount: 0,
        attachIdempotencyKey: crypto.randomUUID(),
      } satisfies SynchronizationJobV1,
      "active",
    );
    await transactionDone(transaction);
  }

  async recordSupersededGeneration(input: {
    readonly job: SynchronizationJobV1;
    readonly generationId: string;
    readonly generationNumber: number;
    readonly headCursor: number;
    readonly predecessorGenerationId?: string;
    readonly now: string;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultSyncState, STORES.synchronizationJobs],
      "readwrite",
    );
    const value = await requestValue(transaction.objectStore(STORES.vaultSyncState).get("active"));
    const registration = value as StoredAccountVaultV1 | undefined;
    if (
      input.job.vaultId === undefined ||
      input.job.generationId === undefined ||
      registration?.vaultId !== input.job.vaultId ||
      registration.remoteGenerationId !== input.job.generationId
    ) {
      transaction.abort();
      throw new DomainValidationError("accountVault", "changed during stale detection");
    }
    transaction.objectStore(STORES.vaultSyncState).put(
      {
        ...registration,
        remoteGenerationId: input.generationId,
        remoteGenerationNumber: input.generationNumber,
        deliveryCursor: input.headCursor,
      } satisfies StoredAccountVaultV1,
      "active",
    );
    transaction.objectStore(STORES.synchronizationJobs).put(
      {
        ...input.job,
        generationId: input.generationId,
        generationNumber: input.generationNumber,
        ...(input.predecessorGenerationId === undefined
          ? {}
          : { predecessorGenerationId: input.predecessorGenerationId }),
        snapshotCursor: input.headCursor,
        state: "Conflict",
        retryCount: input.job.retryCount + 1,
        updatedAt: input.now,
        errorId: "VAULT_GENERATION_SUPERSEDED",
      } satisfies SynchronizationJobV1,
      "active",
    );
    await transactionDone(transaction);
  }

  async saveConfiguration(configuration: AccountConfigurationV1): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.accountConfiguration, "readwrite");
    transaction.objectStore(STORES.accountConfiguration).put(configuration, "active");
    await transactionDone(transaction);
  }

  async loadConfiguration(): Promise<AccountConfigurationV1> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.accountConfiguration, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.accountConfiguration).get("active"),
    );
    await transactionDone(transaction);
    if (value === undefined) return { version: 1, mode: "Unconfigured" };
    const input = canonicalRecord(value, "accountConfiguration", [
      "version",
      "mode",
      "serverOrigin",
      "registration",
    ]);
    literal(input.version, 1, "accountConfiguration.version");
    if (input.mode === "Unconfigured" || input.mode === "LocalOnly") {
      if (input.serverOrigin !== undefined || input.registration !== undefined)
        throw new DomainValidationError("accountConfiguration", "contains an unexpected origin");
      return { version: 1, mode: input.mode };
    }
    if (
      input.mode !== "Configured" ||
      typeof input.serverOrigin !== "string" ||
      typeof input.registration !== "object" ||
      input.registration === null
    )
      throw new DomainValidationError("accountConfiguration", "contains an invalid mode");
    const registration = canonicalRecord(input.registration, "accountRegistration", [
      "enabled",
      "signUpUrl",
    ]);
    if (registration.enabled === false && registration.signUpUrl === undefined)
      return {
        version: 1,
        mode: "Configured",
        serverOrigin: input.serverOrigin,
        registration: { enabled: false },
      };
    if (registration.enabled !== true || typeof registration.signUpUrl !== "string")
      throw new DomainValidationError("accountRegistration", "contains invalid registration");
    return {
      version: 1,
      mode: "Configured",
      serverOrigin: input.serverOrigin,
      registration: { enabled: true, signUpUrl: registration.signUpUrl },
    };
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}

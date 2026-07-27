import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import type { AuthenticatedSession } from "../../runtime/account/http";
import type {
  DeviceCertificateV1,
  DeviceIdentity,
  DeviceKeyEnvelopeV1,
} from "../../runtime/recovery/device";
import type { RecoveredDeviceAuthority } from "../../runtime/recovery/enrollment";
import type { FutureProtectedDeviceAuthority } from "../../runtime/recovery/future-protection";
import type { InitialDeviceAuthority } from "../../runtime/recovery/initial-attachment";
import { createDeviceSlot, createVerifier } from "../../runtime/vault/slots";
import { openDatabase, requestValue, transactionDone } from "./database";
import { storageError } from "./errors";
import { vaultKeyRange, vaultSingletonKey } from "./keys";
import { DATABASE_NAME, STORES } from "./schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface StoredDeviceIdentity {
  readonly version: 1;
  readonly accountId: string;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly deviceId: string;
  readonly signingPublicKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
  readonly wrappedSigningSecretKey: Uint8Array;
  readonly wrappedWrappingSecretKey: Uint8Array;
  readonly certificate: DeviceCertificateV1;
  readonly envelopes: readonly DeviceKeyEnvelopeV1[];
}

export interface StoredEpochKey {
  readonly version: 1;
  readonly vaultId: string;
  readonly keyEpochId: string;
  readonly ordinal: number;
  readonly wrappedRootKey: Uint8Array;
}

export interface StoredDeviceSession {
  readonly version: 1;
  readonly accountId: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly scope: "VaultDevice";
  readonly refreshNonce: Uint8Array;
  readonly refreshCiphertext: Uint8Array;
}

export interface LoadedDeviceAuthority {
  readonly accountId: string;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly identity: DeviceIdentity;
  readonly certificate: DeviceCertificateV1;
  readonly envelopes: readonly DeviceKeyEnvelopeV1[];
  readonly keyEpochs: readonly {
    readonly keyEpochId: string;
    readonly ordinal: number;
    readonly rootKey: Uint8Array;
  }[];
}

export interface RenewedDeviceAuthority {
  readonly accountId: string;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly certificate: DeviceCertificateV1;
  readonly envelope: DeviceKeyEnvelopeV1;
  readonly keyEpoch: {
    readonly keyEpochId: string;
    readonly ordinal: number;
    readonly rootKey: Uint8Array;
  };
  readonly session: AuthenticatedSession;
}

function deviceAad(input: {
  readonly accountId: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}): Uint8Array {
  return encodeCanonicalCbor([
    "device:session-storage:v1",
    input.accountId,
    input.vaultId,
    input.deviceId,
    input.sessionId,
  ]);
}

function nonExtractableKey(
  value: unknown,
  name: "AES-KW" | "AES-GCM",
  usages: readonly KeyUsage[],
): CryptoKey {
  if (
    !(value instanceof CryptoKey) ||
    value.extractable ||
    value.algorithm.name !== name ||
    usages.some((usage) => !value.usages.includes(usage))
  )
    throw new DomainValidationError("deviceLocalKey", "contains an invalid protected key");
  return value;
}

async function wrapRaw(value: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const carrier = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(value),
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.wrapKey("raw", carrier, key, "AES-KW"));
}

async function unwrapRaw(value: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const carrier = await crypto.subtle.unwrapKey(
    "raw",
    Uint8Array.from(value),
    key,
    "AES-KW",
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.exportKey("raw", carrier));
}

export interface PreparedDeviceAuthorityStorage {
  readonly identity: StoredDeviceIdentity;
  readonly wrappingKey: CryptoKey;
  readonly epochs: readonly StoredEpochKey[];
  readonly session: StoredDeviceSession;
  readonly sessionKey: CryptoKey;
  readonly recoveryKit: import("./schema").StoredRecoveryKitV1;
  readonly registration: import("./schema").StoredAccountVaultV1;
}

export async function prepareDeviceAuthorityStorage(
  authority: InitialDeviceAuthority,
  deliveryCursor: number,
): Promise<PreparedDeviceAuthorityStorage> {
  if (
    authority.session.scope !== "VaultDevice" ||
    authority.session.account.accountId !== authority.accountId ||
    authority.identity.deviceId !== authority.certificate.content.deviceId ||
    authority.certificate.content.vaultId !== authority.vaultId ||
    authority.recoveryKit.metadata.vaultId !== authority.vaultId ||
    authority.recoveryKit.metadata.recoveryGenerationId !== authority.recoveryGenerationId ||
    authority.keyEpochs.length === 0 ||
    authority.envelopes.length !== authority.keyEpochs.length ||
    !Number.isSafeInteger(deliveryCursor) ||
    deliveryCursor < 1
  )
    throw new DomainValidationError("replacementDeviceAuthority", "contains mismatched authority");
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
  const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const identity: StoredDeviceIdentity = {
    version: 1,
    accountId: authority.accountId,
    vaultId: authority.vaultId,
    recoveryGenerationId: authority.recoveryGenerationId,
    deviceId: authority.identity.deviceId,
    signingPublicKey: Uint8Array.from(authority.identity.signingPublicKey),
    wrappingPublicKey: Uint8Array.from(authority.identity.wrappingPublicKey),
    wrappedSigningSecretKey: await wrapRaw(authority.identity.signingSecretKey, wrappingKey),
    wrappedWrappingSecretKey: await wrapRaw(authority.identity.wrappingSecretKey, wrappingKey),
    certificate: authority.certificate,
    envelopes: authority.envelopes,
  };
  const epochs = await Promise.all(
    authority.keyEpochs.map(
      async (epoch): Promise<StoredEpochKey> => ({
        version: 1,
        vaultId: authority.vaultId,
        keyEpochId: epoch.keyEpochId,
        ordinal: epoch.ordinal,
        wrappedRootKey: await wrapRaw(epoch.rootKey, wrappingKey),
      }),
    ),
  );
  const refreshNonce = crypto.getRandomValues(new Uint8Array(12));
  const session: StoredDeviceSession = {
    version: 1,
    accountId: authority.accountId,
    vaultId: authority.vaultId,
    deviceId: authority.identity.deviceId,
    sessionId: authority.session.sessionId,
    email: authority.session.account.email,
    scope: "VaultDevice",
    refreshNonce,
    refreshCiphertext: new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(refreshNonce),
          additionalData: Uint8Array.from(
            deviceAad({
              accountId: authority.accountId,
              vaultId: authority.vaultId,
              deviceId: authority.identity.deviceId,
              sessionId: authority.session.sessionId,
            }),
          ),
        },
        sessionKey,
        encoder.encode(authority.session.refreshToken),
      ),
    ),
  };
  const activeEpoch = authority.keyEpochs.at(-1);
  if (activeEpoch === undefined)
    throw new DomainValidationError("replacementDeviceAuthority", "has no active key epoch");
  return {
    identity,
    wrappingKey,
    epochs,
    session,
    sessionKey,
    recoveryKit: {
      version: 1,
      vaultId: authority.vaultId,
      recoveryGenerationId: authority.recoveryGenerationId,
      metadata: authority.recoveryKit.metadata,
      ciphertext: authority.recoveryKit.ciphertext,
    },
    registration: {
      version: 1,
      accountId: authority.accountId,
      vaultId: authority.vaultId,
      activeRecoveryGenerationId: authority.recoveryGenerationId,
      activeKeyEpochId: activeEpoch.keyEpochId,
      remoteGenerationId: authority.remoteGenerationId,
      remoteGenerationNumber: authority.remoteGenerationNumber,
      deliveryCursor,
    },
  };
}

export class IndexedDbDeviceRepository {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(readonly databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }

  async saveRecoveredDevice(authority: RecoveredDeviceAuthority): Promise<void> {
    await this.saveDeviceAuthority(authority);
  }

  async saveInitialDevice(authority: InitialDeviceAuthority): Promise<void> {
    await this.saveDeviceAuthority(authority, false, true);
  }

  async saveFutureProtectedDevice(authority: FutureProtectedDeviceAuthority): Promise<void> {
    await this.saveDeviceAuthority(authority, true);
  }

  private async saveDeviceAuthority(
    authority: RecoveredDeviceAuthority | InitialDeviceAuthority | FutureProtectedDeviceAuthority,
    rotateLocalVaultAuthority = false,
    clearSynchronizationSetup = false,
  ): Promise<void> {
    if (
      authority.session.scope !== "VaultDevice" ||
      authority.session.account.accountId !== authority.accountId ||
      authority.identity.deviceId !== authority.certificate.content.deviceId ||
      authority.keyEpochs.length === 0 ||
      authority.envelopes.length !== authority.keyEpochs.length
    )
      throw new DomainValidationError("recoveredDevice", "contains mismatched authority");
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const identity: StoredDeviceIdentity = {
      version: 1,
      accountId: authority.accountId,
      vaultId: authority.vaultId,
      recoveryGenerationId: authority.recoveryGenerationId,
      deviceId: authority.identity.deviceId,
      signingPublicKey: Uint8Array.from(authority.identity.signingPublicKey),
      wrappingPublicKey: Uint8Array.from(authority.identity.wrappingPublicKey),
      wrappedSigningSecretKey: await wrapRaw(authority.identity.signingSecretKey, wrappingKey),
      wrappedWrappingSecretKey: await wrapRaw(authority.identity.wrappingSecretKey, wrappingKey),
      certificate: authority.certificate,
      envelopes: authority.envelopes,
    };
    const epochs: StoredEpochKey[] = await Promise.all(
      authority.keyEpochs.map(async (epoch) => ({
        version: 1,
        vaultId: authority.vaultId,
        keyEpochId: epoch.keyEpochId,
        ordinal: epoch.ordinal,
        wrappedRootKey: await wrapRaw(epoch.rootKey, wrappingKey),
      })),
    );
    const refreshNonce = crypto.getRandomValues(new Uint8Array(12));
    const session: StoredDeviceSession = {
      version: 1,
      accountId: authority.accountId,
      vaultId: authority.vaultId,
      deviceId: authority.identity.deviceId,
      sessionId: authority.session.sessionId,
      email: authority.session.account.email,
      scope: "VaultDevice",
      refreshNonce,
      refreshCiphertext: new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.from(refreshNonce),
            additionalData: Uint8Array.from(
              deviceAad({
                accountId: authority.accountId,
                vaultId: authority.vaultId,
                deviceId: authority.identity.deviceId,
                sessionId: authority.session.sessionId,
              }),
            ),
          },
          sessionKey,
          encoder.encode(authority.session.refreshToken),
        ),
      ),
    };
    const activeEpoch = authority.keyEpochs.at(-1);
    if (activeEpoch === undefined)
      throw new DomainValidationError("recoveredDevice", "has no active key epoch");
    const localAuthority = rotateLocalVaultAuthority
      ? await (async () => {
          const carrier = await crypto.subtle.importKey(
            "raw",
            Uint8Array.from(activeEpoch.rootKey),
            { name: "HMAC", hash: "SHA-256", length: 256 },
            true,
            ["sign"],
          );
          const created = await createDeviceSlot(
            carrier,
            authority.vaultId,
            activeEpoch.keyEpochId,
            authority.identity.deviceId,
          );
          return {
            ...created,
            verifier: await createVerifier(activeEpoch.rootKey, created.slot),
          };
        })()
      : undefined;

    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.deviceIdentities,
        STORES.deviceLocalKeys,
        STORES.epochKeys,
        STORES.deviceSessions,
        STORES.recoveryKits,
        STORES.vaultSyncState,
        STORES.synchronizationJobs,
        STORES.vaultMetadata,
        STORES.keySlots,
        STORES.deviceKeys,
      ],
      "readwrite",
    );
    try {
      const localMetadata =
        localAuthority === undefined
          ? undefined
          : await requestValue(
              transaction
                .objectStore(STORES.vaultMetadata)
                .get(vaultSingletonKey(authority.vaultId, "metadata")),
            );
      if (localAuthority !== undefined && localMetadata === undefined) {
        transaction.abort();
        throw new DomainValidationError(
          "futureProtection",
          "cannot rotate missing local Vault authority",
        );
      }
      transaction.objectStore(STORES.deviceIdentities).put(identity, authority.vaultId);
      transaction.objectStore(STORES.deviceLocalKeys).put(wrappingKey, `${authority.vaultId}:wrap`);
      transaction
        .objectStore(STORES.deviceLocalKeys)
        .put(sessionKey, `${authority.vaultId}:session`);
      transaction.objectStore(STORES.epochKeys).delete(vaultKeyRange(authority.vaultId));
      for (const epoch of epochs)
        transaction.objectStore(STORES.epochKeys).put(epoch, [authority.vaultId, epoch.keyEpochId]);
      transaction.objectStore(STORES.deviceSessions).put(session, authority.vaultId);
      if ("recoveryKit" in authority) {
        transaction.objectStore(STORES.recoveryKits).put(
          {
            version: 1,
            vaultId: authority.vaultId,
            recoveryGenerationId: authority.recoveryGenerationId,
            metadata: authority.recoveryKit.metadata,
            ciphertext: authority.recoveryKit.ciphertext,
          },
          authority.vaultId,
        );
        transaction.objectStore(STORES.vaultSyncState).put(
          {
            version: 1,
            accountId: authority.accountId,
            vaultId: authority.vaultId,
            activeRecoveryGenerationId: authority.recoveryGenerationId,
            activeKeyEpochId: activeEpoch.keyEpochId,
            remoteGenerationId: authority.remoteGenerationId,
            remoteGenerationNumber: authority.remoteGenerationNumber,
            deliveryCursor: 1,
          },
          "active",
        );
        if (clearSynchronizationSetup) {
          const now = new Date().toISOString();
          transaction.objectStore(STORES.synchronizationJobs).put(
            {
              version: 1,
              jobId: crypto.randomUUID(),
              accountId: authority.accountId,
              vaultId: authority.vaultId,
              generationId: authority.remoteGenerationId,
              generationNumber: authority.remoteGenerationNumber,
              state: "Created",
              stage: "UploadObjects",
              createdAt: now,
              updatedAt: now,
              snapshotCursor: 1,
              completedItems: 0,
              totalItems: 0,
              processedBytes: 0,
              totalBytes: 0,
              retryCount: 0,
              attachIdempotencyKey: crypto.randomUUID(),
            },
            "active",
          );
        }
      } else {
        const existing = (await requestValue(
          transaction.objectStore(STORES.vaultSyncState).get("active"),
        )) as import("./schema").StoredAccountVaultV1 | undefined;
        if (
          existing === undefined ||
          existing.accountId !== authority.accountId ||
          existing.vaultId !== authority.vaultId
        ) {
          transaction.abort();
          throw new DomainValidationError(
            "recoveredDevice",
            "does not match discovered Vault authority",
          );
        }
        transaction.objectStore(STORES.vaultSyncState).put(
          {
            ...existing,
            activeRecoveryGenerationId: authority.recoveryGenerationId,
            activeKeyEpochId: activeEpoch.keyEpochId,
          },
          "active",
        );
      }
      if (localAuthority !== undefined) {
        transaction.objectStore(STORES.vaultMetadata).put(
          {
            ...(localMetadata as import("../../runtime/vault/contracts").VaultMetadataV1),
            activeKeyEpochId: activeEpoch.keyEpochId,
            deviceId: authority.identity.deviceId,
            verifier: localAuthority.verifier,
          },
          vaultSingletonKey(authority.vaultId, "metadata"),
        );
        transaction
          .objectStore(STORES.keySlots)
          .put(localAuthority.slot, vaultSingletonKey(authority.vaultId, "device"));
        transaction
          .objectStore(STORES.deviceKeys)
          .put(localAuthority.deviceKey, vaultSingletonKey(authority.vaultId, "device"));
      }
      await transactionDone(transaction);
    } catch (error) {
      transaction.abort();
      throw storageError(error);
    }
  }

  async loadDeviceSession(vaultId: string): Promise<
    | {
        readonly metadata: StoredDeviceSession;
        readonly refreshToken: string;
      }
    | undefined
  > {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.deviceSessions, STORES.deviceLocalKeys],
      "readonly",
    );
    const [stored, keyValue] = await Promise.all([
      requestValue(transaction.objectStore(STORES.deviceSessions).get(vaultId)),
      requestValue(transaction.objectStore(STORES.deviceLocalKeys).get(`${vaultId}:session`)),
    ]);
    await transactionDone(transaction);
    if (stored === undefined && keyValue === undefined) return undefined;
    if (stored === undefined || keyValue === undefined)
      throw new DomainValidationError("deviceSession", "is partially initialized");
    const session = stored as StoredDeviceSession;
    const key = nonExtractableKey(keyValue, "AES-GCM", ["encrypt", "decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(session.refreshNonce),
        additionalData: Uint8Array.from(deviceAad(session)),
      },
      key,
      Uint8Array.from(session.refreshCiphertext),
    );
    return { metadata: session, refreshToken: decoder.decode(plaintext) };
  }

  async saveRefreshedDeviceSession(vaultId: string, session: AuthenticatedSession): Promise<void> {
    if (session.scope !== "VaultDevice")
      throw new DomainValidationError("deviceSession", "has the wrong authority scope");
    const database = await this.databasePromise;
    const readTransaction = database.transaction(
      [STORES.deviceSessions, STORES.deviceLocalKeys],
      "readonly",
    );
    let stored: StoredDeviceSession;
    let key: CryptoKey;
    try {
      const [storedValue, keyValue] = await Promise.all([
        requestValue(readTransaction.objectStore(STORES.deviceSessions).get(vaultId)),
        requestValue(readTransaction.objectStore(STORES.deviceLocalKeys).get(`${vaultId}:session`)),
      ]);
      if (storedValue === undefined || keyValue === undefined) {
        readTransaction.abort();
        throw new DomainValidationError("deviceSession", "is not initialized");
      }
      stored = storedValue as StoredDeviceSession;
      if (
        stored.accountId !== session.account.accountId ||
        stored.email !== session.account.email
      ) {
        readTransaction.abort();
        throw new DomainValidationError("deviceSession", "changed Account identity");
      }
      key = nonExtractableKey(keyValue, "AES-GCM", ["encrypt", "decrypt"]);
      await transactionDone(readTransaction);
    } catch (error) {
      readTransaction.abort();
      throw storageError(error);
    }
    const refreshNonce = crypto.getRandomValues(new Uint8Array(12));
    const next: StoredDeviceSession = {
      ...stored,
      sessionId: session.sessionId,
      refreshNonce,
      refreshCiphertext: new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.from(refreshNonce),
            additionalData: Uint8Array.from(
              deviceAad({
                accountId: stored.accountId,
                vaultId,
                deviceId: stored.deviceId,
                sessionId: session.sessionId,
              }),
            ),
          },
          key,
          encoder.encode(session.refreshToken),
        ),
      ),
    };
    const transaction = database.transaction(STORES.deviceSessions, "readwrite");
    try {
      const currentValue = await requestValue(
        transaction.objectStore(STORES.deviceSessions).get(vaultId),
      );
      if (
        currentValue === undefined ||
        (currentValue as StoredDeviceSession).sessionId !== stored.sessionId
      ) {
        transaction.abort();
        throw new DomainValidationError("deviceSession", "changed concurrently");
      }
      transaction.objectStore(STORES.deviceSessions).put(next, vaultId);
      await transactionDone(transaction);
    } catch (error) {
      transaction.abort();
      throw storageError(error);
    }
  }

  async saveServerSwitchCandidateSession(
    vaultId: string,
    session: AuthenticatedSession,
  ): Promise<void> {
    if (session.scope !== "VaultDevice")
      throw new DomainValidationError("deviceSession", "has the wrong authority scope");
    const database = await this.databasePromise;
    const readTransaction = database.transaction(
      [STORES.deviceSessions, STORES.deviceLocalKeys],
      "readonly",
    );
    let identity: StoredDeviceSession;
    let key: CryptoKey;
    try {
      const [identityValue, keyValue] = await Promise.all([
        requestValue(readTransaction.objectStore(STORES.deviceSessions).get(vaultId)),
        requestValue(readTransaction.objectStore(STORES.deviceLocalKeys).get(`${vaultId}:session`)),
      ]);
      if (identityValue === undefined || keyValue === undefined)
        throw new DomainValidationError("deviceSession", "is not initialized");
      identity = identityValue as StoredDeviceSession;
      key = nonExtractableKey(keyValue, "AES-GCM", ["encrypt", "decrypt"]);
      await transactionDone(readTransaction);
    } catch (error) {
      readTransaction.abort();
      throw storageError(error);
    }
    const refreshNonce = crypto.getRandomValues(new Uint8Array(12));
    const candidate: StoredDeviceSession = {
      version: 1,
      accountId: session.account.accountId,
      vaultId,
      deviceId: identity.deviceId,
      sessionId: session.sessionId,
      email: session.account.email,
      scope: "VaultDevice",
      refreshNonce,
      refreshCiphertext: new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.from(refreshNonce),
            additionalData: Uint8Array.from(
              deviceAad({
                accountId: session.account.accountId,
                vaultId,
                deviceId: identity.deviceId,
                sessionId: session.sessionId,
              }),
            ),
          },
          key,
          encoder.encode(session.refreshToken),
        ),
      ),
    };
    const transaction = database.transaction(STORES.deviceSessions, "readwrite");
    try {
      const currentValue = await requestValue(
        transaction.objectStore(STORES.deviceSessions).get(vaultId),
      );
      if (
        currentValue === undefined ||
        (currentValue as StoredDeviceSession).sessionId !== identity.sessionId
      ) {
        transaction.abort();
        throw new DomainValidationError("deviceSession", "changed concurrently");
      }
      transaction
        .objectStore(STORES.deviceSessions)
        .put(candidate, `${vaultId}:server-switch-candidate`);
      await transactionDone(transaction);
    } catch (error) {
      transaction.abort();
      throw storageError(error);
    }
  }

  async saveRenewedDeviceAuthority(authority: RenewedDeviceAuthority): Promise<void> {
    if (
      authority.session.scope !== "VaultDevice" ||
      authority.session.account.accountId !== authority.accountId ||
      authority.certificate.content.vaultId !== authority.vaultId ||
      authority.certificate.content.recoveryGenerationId !== authority.recoveryGenerationId ||
      authority.envelope.metadata.keyEpochId !== authority.keyEpoch.keyEpochId
    )
      throw new DomainValidationError("deviceAuthority", "contains mismatched authority");
    const localCarrier = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(authority.keyEpoch.rootKey),
      { name: "HMAC", hash: "SHA-256", length: 256 },
      true,
      ["sign"],
    );
    const localAuthority = await createDeviceSlot(
      localCarrier,
      authority.vaultId,
      authority.keyEpoch.keyEpochId,
      authority.certificate.content.deviceId,
    );
    const localVerifier = await createVerifier(authority.keyEpoch.rootKey, localAuthority.slot);
    const database = await this.databasePromise;
    const readTransaction = database.transaction(
      [
        STORES.deviceIdentities,
        STORES.deviceLocalKeys,
        STORES.vaultSyncState,
        STORES.vaultMetadata,
      ],
      "readonly",
    );
    let identity: StoredDeviceIdentity;
    let sync: import("./schema").StoredAccountVaultV1;
    let localMetadata: import("../../runtime/vault/contracts").VaultMetadataV1;
    let wrappingKey: CryptoKey;
    let sessionKey: CryptoKey;
    try {
      const [identityValue, wrappingKeyValue, sessionKeyValue, syncValue, localMetadataValue] =
        await Promise.all([
          requestValue(readTransaction.objectStore(STORES.deviceIdentities).get(authority.vaultId)),
          requestValue(
            readTransaction.objectStore(STORES.deviceLocalKeys).get(`${authority.vaultId}:wrap`),
          ),
          requestValue(
            readTransaction.objectStore(STORES.deviceLocalKeys).get(`${authority.vaultId}:session`),
          ),
          requestValue(readTransaction.objectStore(STORES.vaultSyncState).get("active")),
          requestValue(
            readTransaction
              .objectStore(STORES.vaultMetadata)
              .get(vaultSingletonKey(authority.vaultId, "metadata")),
          ),
        ]);
      if (
        identityValue === undefined ||
        wrappingKeyValue === undefined ||
        sessionKeyValue === undefined ||
        syncValue === undefined ||
        localMetadataValue === undefined
      ) {
        readTransaction.abort();
        throw new DomainValidationError("deviceAuthority", "is not initialized");
      }
      identity = identityValue as StoredDeviceIdentity;
      sync = syncValue as import("./schema").StoredAccountVaultV1;
      if (
        identity.accountId !== authority.accountId ||
        identity.deviceId !== authority.certificate.content.deviceId ||
        sync.accountId !== authority.accountId ||
        sync.vaultId !== authority.vaultId
      ) {
        readTransaction.abort();
        throw new DomainValidationError("deviceAuthority", "changed identity");
      }
      localMetadata = localMetadataValue as import("../../runtime/vault/contracts").VaultMetadataV1;
      wrappingKey = nonExtractableKey(wrappingKeyValue, "AES-KW", ["wrapKey", "unwrapKey"]);
      sessionKey = nonExtractableKey(sessionKeyValue, "AES-GCM", ["encrypt", "decrypt"]);
      await transactionDone(readTransaction);
    } catch (error) {
      readTransaction.abort();
      throw storageError(error);
    }

    // Firefox may make an IndexedDB transaction inactive while WebCrypto is pending. Prepare all
    // encrypted values before opening the atomic write transaction.
    const refreshNonce = crypto.getRandomValues(new Uint8Array(12));
    const session: StoredDeviceSession = {
      version: 1,
      accountId: authority.accountId,
      vaultId: authority.vaultId,
      deviceId: identity.deviceId,
      sessionId: authority.session.sessionId,
      email: authority.session.account.email,
      scope: "VaultDevice",
      refreshNonce,
      refreshCiphertext: new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.from(refreshNonce),
            additionalData: Uint8Array.from(
              deviceAad({
                accountId: authority.accountId,
                vaultId: authority.vaultId,
                deviceId: identity.deviceId,
                sessionId: authority.session.sessionId,
              }),
            ),
          },
          sessionKey,
          encoder.encode(authority.session.refreshToken),
        ),
      ),
    };
    const epoch: StoredEpochKey = {
      version: 1,
      vaultId: authority.vaultId,
      keyEpochId: authority.keyEpoch.keyEpochId,
      ordinal: authority.keyEpoch.ordinal,
      wrappedRootKey: await wrapRaw(authority.keyEpoch.rootKey, wrappingKey),
    };
    const transaction = database.transaction(
      [
        STORES.deviceIdentities,
        STORES.epochKeys,
        STORES.deviceSessions,
        STORES.vaultSyncState,
        STORES.vaultMetadata,
        STORES.keySlots,
        STORES.deviceKeys,
      ],
      "readwrite",
    );
    try {
      transaction.objectStore(STORES.deviceIdentities).put(
        {
          ...identity,
          recoveryGenerationId: authority.recoveryGenerationId,
          certificate: authority.certificate,
          envelopes: [
            ...identity.envelopes.filter(
              (envelope) => envelope.metadata.keyEpochId !== authority.envelope.metadata.keyEpochId,
            ),
            authority.envelope,
          ],
        } satisfies StoredDeviceIdentity,
        authority.vaultId,
      );
      transaction
        .objectStore(STORES.epochKeys)
        .put(epoch, [authority.vaultId, authority.keyEpoch.keyEpochId]);
      transaction.objectStore(STORES.deviceSessions).put(session, authority.vaultId);
      transaction.objectStore(STORES.vaultSyncState).put(
        {
          ...sync,
          activeRecoveryGenerationId: authority.recoveryGenerationId,
          activeKeyEpochId: authority.keyEpoch.keyEpochId,
        },
        "active",
      );
      transaction.objectStore(STORES.vaultMetadata).put(
        {
          ...localMetadata,
          activeKeyEpochId: authority.keyEpoch.keyEpochId,
          deviceId: authority.certificate.content.deviceId,
          verifier: localVerifier,
        },
        vaultSingletonKey(authority.vaultId, "metadata"),
      );
      transaction
        .objectStore(STORES.keySlots)
        .put(localAuthority.slot, vaultSingletonKey(authority.vaultId, "device"));
      transaction
        .objectStore(STORES.deviceKeys)
        .put(localAuthority.deviceKey, vaultSingletonKey(authority.vaultId, "device"));
      await transactionDone(transaction);
    } catch (error) {
      transaction.abort();
      throw storageError(error);
    }
  }

  async eraseDeviceSession(vaultId: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.deviceSessions, "readwrite");
    transaction.objectStore(STORES.deviceSessions).delete(vaultId);
    await transactionDone(transaction);
  }

  async loadDeviceAuthority(vaultId: string): Promise<LoadedDeviceAuthority | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.deviceIdentities, STORES.deviceLocalKeys, STORES.epochKeys],
      "readonly",
    );
    const [stored, keyValue, epochValues] = await Promise.all([
      requestValue(transaction.objectStore(STORES.deviceIdentities).get(vaultId)),
      requestValue(transaction.objectStore(STORES.deviceLocalKeys).get(`${vaultId}:wrap`)),
      requestValue(transaction.objectStore(STORES.epochKeys).getAll()),
    ]);
    await transactionDone(transaction);
    if (stored === undefined && keyValue === undefined) return undefined;
    if (stored === undefined || keyValue === undefined)
      throw new DomainValidationError("deviceIdentity", "is partially initialized");
    const identity = stored as StoredDeviceIdentity;
    const key = nonExtractableKey(keyValue, "AES-KW", ["wrapKey", "unwrapKey"]);
    const epochs = (epochValues as StoredEpochKey[])
      .filter((epoch) => epoch.vaultId === vaultId)
      .sort((left, right) => left.ordinal - right.ordinal);
    return {
      accountId: identity.accountId,
      vaultId: identity.vaultId,
      recoveryGenerationId: identity.recoveryGenerationId,
      identity: {
        deviceId: identity.deviceId,
        signingPublicKey: Uint8Array.from(identity.signingPublicKey),
        signingSecretKey: await unwrapRaw(identity.wrappedSigningSecretKey, key),
        wrappingPublicKey: Uint8Array.from(identity.wrappingPublicKey),
        wrappingSecretKey: await unwrapRaw(identity.wrappedWrappingSecretKey, key),
      },
      certificate: identity.certificate,
      envelopes: identity.envelopes,
      keyEpochs: await Promise.all(
        epochs.map(async (epoch) => ({
          keyEpochId: epoch.keyEpochId,
          ordinal: epoch.ordinal,
          rootKey: await unwrapRaw(epoch.wrappedRootKey, key),
        })),
      ),
    };
  }

  async loadEpochKeys(vaultId: string): Promise<
    | readonly {
        readonly keyEpochId: string;
        readonly ordinal: number;
        readonly rootKey: Uint8Array;
      }[]
    | undefined
  > {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.deviceLocalKeys, STORES.epochKeys],
      "readonly",
    );
    const [keyValue, epochValues] = await Promise.all([
      requestValue(transaction.objectStore(STORES.deviceLocalKeys).get(`${vaultId}:wrap`)),
      requestValue(transaction.objectStore(STORES.epochKeys).getAll(vaultKeyRange(vaultId))),
    ]);
    await transactionDone(transaction);
    if (keyValue === undefined && epochValues.length === 0) return undefined;
    if (keyValue === undefined || epochValues.length === 0)
      throw new DomainValidationError("vaultEpochKeys", "are partially initialized");
    const key = nonExtractableKey(keyValue, "AES-KW", ["wrapKey", "unwrapKey"]);
    const epochs = (epochValues as StoredEpochKey[]).sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    if (
      epochs.some(
        (epoch, ordinal) =>
          epoch.version !== 1 ||
          epoch.vaultId !== vaultId ||
          epoch.ordinal !== ordinal ||
          typeof epoch.keyEpochId !== "string" ||
          !(epoch.wrappedRootKey instanceof Uint8Array),
      ) ||
      new Set(epochs.map((epoch) => epoch.keyEpochId)).size !== epochs.length
    )
      throw new DomainValidationError("vaultEpochKeys", "contain invalid authority");
    return Promise.all(
      epochs.map(async (epoch) => ({
        keyEpochId: epoch.keyEpochId,
        ordinal: epoch.ordinal,
        rootKey: await unwrapRaw(epoch.wrappedRootKey, key),
      })),
    );
  }
}

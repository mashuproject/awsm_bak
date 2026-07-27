import { DomainValidationError } from "../../domain/errors";
import { uuid } from "../../domain/validation";
import { abortTransaction, openDatabase, requestValue, transactionDone } from "./database";
import type { StoredDeviceIdentity, StoredEpochKey } from "./device-repository";
import { storageError } from "./errors";
import {
  DATABASE_NAME,
  type DetachedVaultAuthorityV1,
  STORES,
  type StoredAccountMetadataV1,
  type StoredAccountVaultV1,
  type StoredRecoveryKitV1,
} from "./schema";

const CLEARED_STORES = [
  STORES.apiSessions,
  STORES.sessionKeys,
  STORES.protectedCredentials,
  STORES.vaultSyncState,
  STORES.deviceSessions,
  STORES.deviceEnrollmentJobs,
  STORES.futureProtectionJobs,
  STORES.vaultReplacementJobs,
  STORES.vaultReplacementCheckpoints,
  STORES.synchronizationJobs,
  STORES.synchronizationCheckpoints,
  STORES.serverSwitchJobs,
  STORES.serverSwitchCheckpoints,
  STORES.artifactAvailability,
  STORES.storageReliefJobs,
  STORES.storageReliefCheckpoints,
] as const;

export class IndexedDbDetachmentRepository {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  async prepare(vaultId: string): Promise<{
    readonly account: StoredAccountMetadataV1;
    readonly registration: StoredAccountVaultV1;
    readonly authority: DetachedVaultAuthorityV1;
  }> {
    const scopedVaultId = uuid(vaultId, "detachment.vaultId");
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.apiSessions,
        STORES.vaultSyncState,
        STORES.deviceIdentities,
        STORES.epochKeys,
        STORES.recoveryKits,
      ],
      "readonly",
    );
    const [accountValue, registrationValue, identityValue, epochValues, recoveryKitValue] =
      await Promise.all([
        requestValue(transaction.objectStore(STORES.apiSessions).get("active")),
        requestValue(transaction.objectStore(STORES.vaultSyncState).get("active")),
        requestValue(transaction.objectStore(STORES.deviceIdentities).get(scopedVaultId)),
        requestValue(transaction.objectStore(STORES.epochKeys).getAll()),
        requestValue(transaction.objectStore(STORES.recoveryKits).get(scopedVaultId)),
      ]);
    await transactionDone(transaction);
    const account = accountValue as StoredAccountMetadataV1 | undefined;
    const registration = registrationValue as StoredAccountVaultV1 | undefined;
    const identity = identityValue as StoredDeviceIdentity | undefined;
    const recoveryKit = recoveryKitValue as StoredRecoveryKitV1 | undefined;
    const epochs = (epochValues as StoredEpochKey[])
      .filter((epoch) => epoch.vaultId === scopedVaultId)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (
      account === undefined ||
      registration === undefined ||
      identity === undefined ||
      recoveryKit === undefined ||
      account.accountId !== registration.accountId ||
      identity.accountId !== registration.accountId ||
      registration.vaultId !== scopedVaultId ||
      identity.vaultId !== scopedVaultId ||
      identity.recoveryGenerationId !== registration.activeRecoveryGenerationId ||
      recoveryKit.vaultId !== scopedVaultId ||
      recoveryKit.recoveryGenerationId !== registration.activeRecoveryGenerationId ||
      registration.activeKeyEpochId === undefined ||
      epochs.length === 0 ||
      epochs.some(
        (epoch, ordinal) =>
          epoch.version !== 1 ||
          epoch.vaultId !== scopedVaultId ||
          epoch.ordinal !== ordinal ||
          !(epoch.wrappedRootKey instanceof Uint8Array),
      ) ||
      epochs.at(-1)?.keyEpochId !== registration.activeKeyEpochId
    )
      throw new DomainValidationError("detachedVaultAuthority", "is incomplete");

    return {
      account,
      registration,
      authority: {
        version: 1,
        vaultId: scopedVaultId,
        activeRecoveryGenerationId: registration.activeRecoveryGenerationId,
        activeKeyEpochId: registration.activeKeyEpochId,
        deviceIdentity: {
          deviceId: identity.deviceId,
          recoveryGenerationId: identity.recoveryGenerationId,
          certificate: identity.certificate,
          envelopes: identity.envelopes,
          signingPublicKey: identity.signingPublicKey,
          wrappingPublicKey: identity.wrappingPublicKey,
          wrappedSigningSecretKey: identity.wrappedSigningSecretKey,
          wrappedWrappingSecretKey: identity.wrappedWrappingSecretKey,
        },
        epochKeys: epochs,
        recoveryKit,
      },
    };
  }

  async commit(input: {
    readonly expectedAccountId: string;
    readonly expectedVaultId: string;
    readonly authority: DetachedVaultAuthorityV1;
  }): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [
        STORES.accountConfiguration,
        STORES.detachedVaultAuthorities,
        STORES.deviceIdentities,
        STORES.deviceLocalKeys,
        ...CLEARED_STORES,
      ],
      "readwrite",
    );
    try {
      const [accountValue, registrationValue] = await Promise.all([
        requestValue(transaction.objectStore(STORES.apiSessions).get("active")),
        requestValue(transaction.objectStore(STORES.vaultSyncState).get("active")),
      ]);
      const account = accountValue as StoredAccountMetadataV1 | undefined;
      const registration = registrationValue as StoredAccountVaultV1 | undefined;
      if (
        account?.accountId !== input.expectedAccountId ||
        registration?.accountId !== input.expectedAccountId ||
        registration.vaultId !== input.expectedVaultId ||
        input.authority.vaultId !== input.expectedVaultId ||
        input.authority.activeRecoveryGenerationId !== registration.activeRecoveryGenerationId ||
        input.authority.activeKeyEpochId !== registration.activeKeyEpochId
      ) {
        abortTransaction(transaction);
        throw new DomainValidationError("detachedVaultAuthority", "changed before commit");
      }

      transaction
        .objectStore(STORES.detachedVaultAuthorities)
        .put(input.authority, input.expectedVaultId);
      transaction
        .objectStore(STORES.accountConfiguration)
        .put({ version: 1, mode: "LocalOnly" }, "active");
      for (const storeName of CLEARED_STORES) transaction.objectStore(storeName).clear();
      transaction.objectStore(STORES.deviceIdentities).delete(input.expectedVaultId);
      transaction.objectStore(STORES.deviceLocalKeys).delete(`${input.expectedVaultId}:session`);
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}

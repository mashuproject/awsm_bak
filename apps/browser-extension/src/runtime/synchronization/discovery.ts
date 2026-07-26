import { canonicalRecord, uuid } from "../../domain/validation";
import type {
  StoredAccountMetadataV1,
  StoredAccountVaultV1,
  StoredRecoveryKitV1,
  SynchronizationJobV1,
} from "../../drivers/indexeddb/schema";
import { type RecoveryKitV1, recoveryKitFromWire, sha256 } from "../recovery/kit";

interface DiscoveryAccountStore {
  loadMetadata(): Promise<StoredAccountMetadataV1 | undefined>;
  loadAccountVault(): Promise<StoredAccountVaultV1 | undefined>;
  saveRecoveryDiscovery(input: {
    readonly registration?: StoredAccountVaultV1;
    readonly recoveryKit?: StoredRecoveryKitV1;
    readonly job: SynchronizationJobV1;
  }): Promise<void>;
  saveReturningDeviceDiscovery(input: {
    readonly expected: StoredAccountVaultV1;
    readonly recoveryKit: StoredRecoveryKitV1;
  }): Promise<void>;
}

interface DiscoveryTransport {
  request(
    method: string,
    path: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export class AccountVaultDiscovery {
  constructor(
    private readonly accounts: DiscoveryAccountStore,
    private readonly transport: DiscoveryTransport,
  ) {}

  async run(now = new Date().toISOString()): Promise<SynchronizationJobV1> {
    const metadata = await this.accounts.loadMetadata();
    if (metadata === undefined || metadata.scope !== "Account")
      throw integrity("Account session metadata is missing");
    const response = canonicalRecord(
      (await this.transport.request("GET", "/api/account/vault-enrollment")).body,
      "vaultEnrollment",
      ["state", "vaultId", "recoveryKit"],
    );
    const base = {
      version: 1 as const,
      jobId: crypto.randomUUID(),
      accountId: metadata.accountId,
      createdAt: now,
      updatedAt: now,
      completedItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      attachIdempotencyKey: crypto.randomUUID(),
    };
    if (response.state === "Empty") {
      if (Object.keys(response).length !== 1) throw integrity("Empty enrollment has extra fields");
      const job: SynchronizationJobV1 = {
        ...base,
        state: "Waiting",
        stage: "DiscoverAccountVault",
        snapshotCursor: 0,
        totalItems: 0,
        errorId: "ACCOUNT_VAULT_SELECTION_REQUIRED",
      };
      await this.accounts.saveRecoveryDiscovery({ job });
      return job;
    }
    if (response.state !== "Attached") throw integrity("Enrollment state is invalid");

    const vaultId = uuid(response.vaultId, "vaultEnrollment.vaultId");
    let recoveryKit: RecoveryKitV1;
    try {
      recoveryKit = recoveryKitFromWire(response.recoveryKit);
      if (
        recoveryKit.metadata.vaultId !== vaultId ||
        !equal(await sha256(recoveryKit.ciphertext), recoveryKit.metadata.ciphertextSha256)
      )
        throw new Error("Recovery Kit binding differs");
    } catch {
      throw integrity("Recovery Kit is invalid");
    }
    const recoveryGenerationId = recoveryKit.metadata.recoveryGenerationId;
    const existing = await this.accounts.loadAccountVault();
    const storedRecoveryKit: StoredRecoveryKitV1 = {
      version: 1,
      vaultId,
      recoveryGenerationId,
      metadata: recoveryKit.metadata,
      ciphertext: recoveryKit.ciphertext,
    };
    if (
      existing?.accountId === metadata.accountId &&
      existing.vaultId === vaultId &&
      existing.activeRecoveryGenerationId === recoveryGenerationId &&
      existing.activeKeyEpochId !== undefined &&
      existing.remoteGenerationId !== undefined &&
      existing.remoteGenerationNumber !== undefined
    ) {
      await this.accounts.saveReturningDeviceDiscovery({
        expected: existing,
        recoveryKit: storedRecoveryKit,
      });
      return {
        ...base,
        vaultId,
        generationId: existing.remoteGenerationId,
        generationNumber: existing.remoteGenerationNumber,
        state: "Succeeded",
        stage: "FetchChanges",
        snapshotCursor: existing.deliveryCursor,
        totalItems: 0,
      };
    }
    const registration: StoredAccountVaultV1 = {
      version: 1,
      accountId: metadata.accountId,
      vaultId,
      activeRecoveryGenerationId: recoveryGenerationId,
      deliveryCursor: 0,
    };
    const job: SynchronizationJobV1 = {
      ...base,
      vaultId,
      state: "Waiting",
      stage: "RecoverVault",
      snapshotCursor: 0,
      totalItems: 0,
      errorId: "RECOVERY_PHRASE_REQUIRED",
    };
    await this.accounts.saveRecoveryDiscovery({
      registration,
      recoveryKit: storedRecoveryKit,
      job,
    });
    return job;
  }
}

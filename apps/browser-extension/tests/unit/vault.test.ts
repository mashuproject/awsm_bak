import { describe, expect, it } from "vitest";

import {
  type PreparedVault,
  type VaultRecordsV1,
  type VaultRepository,
  VaultService,
  VaultServiceError,
} from "../../src/runtime/vault";

class MemoryVaultRepository implements VaultRepository {
  private records: VaultRecordsV1 | undefined;
  rejectLockMutation = false;

  store(records: VaultRecordsV1): void {
    this.records = records;
  }

  async load(vaultId: string): Promise<VaultRecordsV1 | undefined> {
    return this.records?.metadata.vaultId === vaultId ? this.records : undefined;
  }

  async setManualLock(vaultId: string, manuallyLocked: boolean): Promise<void> {
    if (this.rejectLockMutation)
      throw Object.assign(new Error("Import owns the Workspace."), { id: "VAULT_BUSY" });
    const current = this.requireRecords();
    if (current.metadata.vaultId !== vaultId) throw new Error("Wrong Vault context.");
    this.records = { ...current, metadata: { ...current.metadata, manuallyLocked } };
  }

  requireRecords(): VaultRecordsV1 {
    if (this.records === undefined) throw new Error("Expected Vault records");
    return this.records;
  }

  mutateDeviceIdentity(): void {
    const current = this.requireRecords();
    this.records = {
      ...current,
      deviceSlot: { ...current.deviceSlot, deviceId: crypto.randomUUID() },
    };
  }

  corruptVerifier(): void {
    const current = this.requireRecords();
    this.records = {
      ...current,
      metadata: {
        ...current.metadata,
        verifier: {
          ...current.metadata.verifier,
          ciphertext: current.metadata.verifier.ciphertext.map((byte, index) =>
            index === 0 ? byte ^ 1 : byte,
          ),
        },
      },
    };
  }
}

async function preparedVault(
  repository: MemoryVaultRepository,
): Promise<{ readonly prepared: PreparedVault; readonly service: VaultService }> {
  const preparer = new VaultService(repository);
  const prepared = await preparer.prepareCreate({
    name: "Amber Archive",
    createdAt: "2026-07-18T16:00:00.000Z",
  });
  repository.store(prepared.records);
  const service = new VaultService(repository, prepared.records.metadata.vaultId);
  service.activatePrepared(prepared);
  return { prepared, service };
}

describe("Vault lifecycle", () => {
  it("prepares independent Vault records without persisting and uses one creation timestamp", async () => {
    const repository = new MemoryVaultRepository();
    const service = new VaultService(repository);
    const createdAt = "2026-07-18T16:00:00.000Z";
    const prepared = await service.prepareCreate({ name: "Amber Archive", createdAt });

    expect(repository.requireRecords).toThrow();
    expect(prepared.records.metadata.createdAt).toBe(createdAt);
    expect(prepared.records.head.vaultId).toBe(prepared.records.metadata.vaultId);
    expect(prepared.keyring.active().rootKey.extractable).toBe(false);
    expect(service.isUnlocked()).toBe(false);
  });

  it("stores the canonical normalized name during preparation", async () => {
    const repository = new MemoryVaultRepository();
    const prepared = await new VaultService(repository).prepareCreate({
      name: "  Amber   Chron\u0069\u0301cle  ",
      createdAt: "2026-07-18T16:00:00.000Z",
    });

    expect(prepared.name).toBe("Amber Chronícle");
  });

  it("prepares a device-only Vault without exposing an unwrapped Root Key in records", async () => {
    const repository = new MemoryVaultRepository();
    const { prepared, service } = await preparedVault(repository);
    const records = repository.requireRecords();

    expect(service.isUnlocked()).toBe(true);
    expect(records.deviceKey.extractable).toBe(false);
    expect(records.deviceSlot.wrappedRootKey.byteLength).toBe(40);
    expect(Object.keys(records)).not.toContain("passphraseSlot");
    expect(records.head).toMatchObject({
      vaultId: prepared.records.metadata.vaultId,
      generationNumber: 0,
    });
    expect(Object.keys(records)).not.toContain("rootKey");
  });

  it("persists manual lock across service-worker activation", async () => {
    const repository = new MemoryVaultRepository();
    const { prepared, service } = await preparedVault(repository);
    await service.lock();

    const restarted = new VaultService(repository, prepared.records.metadata.vaultId);
    expect(await restarted.autoUnlock()).toBe(false);
    await restarted.unlockWithDevice();
    expect(restarted.isUnlocked()).toBe(true);
    expect(repository.requireRecords().metadata.manuallyLocked).toBe(false);
  });

  it("automatically unlocks only its scoped Vault when not manually locked", async () => {
    const repository = new MemoryVaultRepository();
    const { prepared } = await preparedVault(repository);
    const restarted = new VaultService(repository, prepared.records.metadata.vaultId);
    expect(await restarted.autoUnlock()).toBe(true);
    expect(restarted.isUnlocked()).toBe(true);
  });

  it("rejects tampered device-slot metadata and Vault verifiers", async () => {
    const repository = new MemoryVaultRepository();
    const { service } = await preparedVault(repository);
    await service.lock();
    repository.mutateDeviceIdentity();
    await expect(service.unlockWithDevice()).rejects.toBeInstanceOf(VaultServiceError);

    const secondRepository = new MemoryVaultRepository();
    const { service: second } = await preparedVault(secondRepository);
    await second.lock();
    secondRepository.corruptVerifier();
    await expect(second.unlockWithDevice()).rejects.toMatchObject({
      id: "CRYPTO_AUTHENTICATION_FAILED",
    });
  });

  it("does not change the in-memory Root Key when Import wins a Lock or Unlock race", async () => {
    const lockingRepository = new MemoryVaultRepository();
    const { service: unlocked } = await preparedVault(lockingRepository);
    lockingRepository.rejectLockMutation = true;
    await expect(unlocked.lock()).rejects.toMatchObject({ id: "VAULT_BUSY" });
    expect(unlocked.isUnlocked()).toBe(true);

    const unlockingRepository = new MemoryVaultRepository();
    const { service: locked } = await preparedVault(unlockingRepository);
    await locked.lock();
    unlockingRepository.rejectLockMutation = true;
    await expect(locked.unlockWithDevice()).rejects.toMatchObject({ id: "VAULT_BUSY" });
    expect(locked.isUnlocked()).toBe(false);
  });
});

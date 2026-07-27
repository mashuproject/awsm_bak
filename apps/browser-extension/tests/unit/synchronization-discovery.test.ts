import { describe, expect, it, vi } from "vitest";
import { createRecoveryKit, recoveryKitToWire } from "../../src/runtime/recovery/kit";
import { deriveRecoveryKeys } from "../../src/runtime/recovery/phrase";
import { AccountVaultDiscovery } from "../../src/runtime/synchronization/discovery";

describe("Account Vault enrollment discovery", () => {
  const accountId = "01900000-0000-7000-8000-000000000061";
  const sessionId = "01900000-0000-7000-8000-000000000062";
  const vaultId = "01900000-0000-7000-8000-000000000063";
  const recoveryGenerationId = "01900000-0000-7000-8000-000000000064";
  const keyEpochId = "01900000-0000-7000-8000-000000000065";
  const metadata = {
    version: 1 as const,
    accountId,
    sessionId,
    username: "reader_test",
    inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
    scope: "Account" as const,
  };

  it("records that first-Vault setup is required without inventing cryptographic authority", async () => {
    const saveRecoveryDiscovery = vi.fn(async () => undefined);
    const discovery = new AccountVaultDiscovery(
      {
        loadMetadata: async () => metadata,
        loadAccountVault: async () => undefined,
        saveRecoveryDiscovery,
        saveReturningDeviceDiscovery: vi.fn(async () => undefined),
      },
      {
        request: vi.fn(async () => ({ status: 200, body: { state: "Empty" } })),
      },
    );

    const job = await discovery.run("2026-07-25T18:30:00.000Z");

    expect(job).toMatchObject({
      accountId,
      state: "Waiting",
      stage: "DiscoverAccountVault",
      errorId: "ACCOUNT_VAULT_SELECTION_REQUIRED",
    });
    expect(saveRecoveryDiscovery).toHaveBeenCalledWith({ job });
  });

  it("stores only the authenticated encrypted Recovery Kit and waits for phrase recovery", async () => {
    const keys = await deriveRecoveryKeys({ entropy: new Uint8Array(16), vaultId });
    const kit = await createRecoveryKit({
      keyring: {
        version: 1,
        vaultId,
        recoveryGenerationId,
        activeKeyEpochId: keyEpochId,
        keyEpochs: [{ keyEpochId, ordinal: 0, rootKey: new Uint8Array(32).fill(0x41) }],
      },
      recoveryKitWrappingKey: keys.recoveryKitWrappingKey,
      recoveryAdministratorSeed: keys.recoveryAdministratorSeed,
      nonce: new Uint8Array(24).fill(0x31),
    });
    const saveRecoveryDiscovery = vi.fn(async () => undefined);
    const discovery = new AccountVaultDiscovery(
      {
        loadMetadata: async () => metadata,
        loadAccountVault: async () => undefined,
        saveRecoveryDiscovery,
        saveReturningDeviceDiscovery: vi.fn(async () => undefined),
      },
      {
        request: vi.fn(async () => ({
          status: 200,
          body: {
            state: "Attached",
            vaultId,
            recoveryKit: recoveryKitToWire(kit),
          },
        })),
      },
    );

    const job = await discovery.run("2026-07-25T18:30:00.000Z");

    expect(job).toMatchObject({
      accountId,
      vaultId,
      state: "Waiting",
      stage: "RecoverVault",
      errorId: "RECOVERY_PHRASE_REQUIRED",
    });
    expect(saveRecoveryDiscovery).toHaveBeenCalledWith({
      registration: {
        version: 1,
        accountId,
        vaultId,
        activeRecoveryGenerationId: recoveryGenerationId,
        deliveryCursor: 0,
      },
      recoveryKit: {
        version: 1,
        vaultId,
        recoveryGenerationId,
        metadata: kit.metadata,
        ciphertext: kit.ciphertext,
      },
      job,
    });
  });

  it("preserves complete returning-Device authority while refreshing the server Recovery Kit", async () => {
    const keys = await deriveRecoveryKeys({ entropy: new Uint8Array(16), vaultId });
    const kit = await createRecoveryKit({
      keyring: {
        version: 1,
        vaultId,
        recoveryGenerationId,
        activeKeyEpochId: keyEpochId,
        keyEpochs: [{ keyEpochId, ordinal: 0, rootKey: new Uint8Array(32).fill(0x41) }],
      },
      recoveryKitWrappingKey: keys.recoveryKitWrappingKey,
      recoveryAdministratorSeed: keys.recoveryAdministratorSeed,
      nonce: new Uint8Array(24).fill(0x31),
    });
    const existing = {
      version: 1 as const,
      accountId,
      vaultId,
      activeRecoveryGenerationId: recoveryGenerationId,
      activeKeyEpochId: keyEpochId,
      remoteGenerationId: "01900000-0000-7000-8000-000000000066",
      remoteGenerationNumber: 2,
      deliveryCursor: 41,
    };
    const saveRecoveryDiscovery = vi.fn(async () => undefined);
    const saveReturningDeviceDiscovery = vi.fn(async () => undefined);
    const discovery = new AccountVaultDiscovery(
      {
        loadMetadata: async () => metadata,
        loadAccountVault: async () => existing,
        saveRecoveryDiscovery,
        saveReturningDeviceDiscovery,
      },
      {
        request: vi.fn(async () => ({
          status: 200,
          body: {
            state: "Attached",
            vaultId,
            recoveryKit: recoveryKitToWire(kit),
          },
        })),
      },
    );

    const job = await discovery.run("2026-07-25T18:30:00.000Z");

    expect(job).toMatchObject({
      vaultId,
      generationId: existing.remoteGenerationId,
      generationNumber: 2,
      state: "Succeeded",
      stage: "FetchChanges",
      snapshotCursor: 41,
    });
    expect(saveRecoveryDiscovery).not.toHaveBeenCalled();
    expect(saveReturningDeviceDiscovery).toHaveBeenCalledWith({
      expected: existing,
      recoveryKit: {
        version: 1,
        vaultId,
        recoveryGenerationId,
        metadata: kit.metadata,
        ciphertext: kit.ciphertext,
      },
    });
  });

  it("rejects a Recovery Kit checksum substitution before persistence", async () => {
    const saveRecoveryDiscovery = vi.fn(async () => undefined);
    const discovery = new AccountVaultDiscovery(
      {
        loadMetadata: async () => metadata,
        loadAccountVault: async () => undefined,
        saveRecoveryDiscovery,
        saveReturningDeviceDiscovery: vi.fn(async () => undefined),
      },
      {
        request: vi.fn(async () => ({
          status: 200,
          body: {
            state: "Attached",
            vaultId,
            recoveryKit: {
              version: 1,
              vaultId,
              recoveryGenerationId,
              derivationAlgorithm: "kdf:hkdf-sha256:recovery-entropy:v1",
              wrappingAlgorithm: "wrap:xchacha20poly1305:recovery-kit:v1",
              administratorSigningAlgorithm: "sign:ed25519:recovery-administrator:v1",
              administratorPublicKey: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE",
              nonce: "bm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5u",
              ciphertextLength: 16,
              ciphertextSha256: "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg",
              ciphertext: "Y2NjY2NjY2NjY2NjY2NjYw",
            },
          },
        })),
      },
    );

    await expect(discovery.run()).rejects.toMatchObject({
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
    expect(saveRecoveryDiscovery).not.toHaveBeenCalled();
  });
});

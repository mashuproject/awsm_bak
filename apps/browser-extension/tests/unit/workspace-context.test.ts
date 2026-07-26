import { describe, expect, it, vi } from "vitest";
import type { IndexedDbDriver } from "../../src/drivers/indexeddb";
import type { WorkspaceRecordsV1 } from "../../src/drivers/indexeddb/schema";
import type { VaultService } from "../../src/runtime/vault";
import type { VaultKeyring } from "../../src/runtime/vault/keyring";
import { WorkspaceContextManager } from "../../src/runtime/vault/workspace-context";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const firstVaultId = "00000000-0000-4000-8000-000000000101";
const secondVaultId = "00000000-0000-4000-8000-000000000102";

function workspace(activeVaultId = firstVaultId): WorkspaceRecordsV1 {
  return {
    metadata: {
      version: 1,
      workspaceId,
      createdAt: "2026-07-18T12:00:00.000Z",
      activeVaultId,
    },
    nameCacheKey: {} as CryptoKey,
  };
}

function vaultService(vaultId: string) {
  return {
    vaultId,
    isUnlocked: vi.fn(() => vaultId === firstVaultId),
    autoUnlock: vi.fn(async () => vaultId === firstVaultId),
    releaseRootKey: vi.fn(),
  };
}

function commonCreationDependencies() {
  return {
    createVaultPreparer: () => ({}) as VaultService,
    prepareNameChange: vi.fn(),
    encryptNameCache: vi.fn(),
    uuid: () => "00000000-0000-4000-8000-000000000201",
  };
}

function preparedNameChange() {
  return {
    event: {
      version: 1 as const,
      vaultId: secondVaultId,
      eventId: "00000000-0000-4000-8000-000000000201",
      referencedObjectIds: [],
      orderingTimestamp: "2026-07-18T12:02:00.000Z",
      envelopeBytes: new Uint8Array([1]),
    },
    projection: {
      version: 1 as const,
      vaultId: secondVaultId,
      sourceEventId: "00000000-0000-4000-8000-000000000201",
      envelopeBytes: new Uint8Array([2]),
    },
  };
}

function preparedNameCache() {
  return {
    version: 1 as const,
    vaultId: secondVaultId,
    sourceEventId: "00000000-0000-4000-8000-000000000201",
    nonce: new Uint8Array(12),
    ciphertext: new Uint8Array(17),
  };
}

describe("WorkspaceContextManager Select", () => {
  it("releases the previous Root Key only after commit and installs a locked target", async () => {
    const records = workspace();
    const commitVaultSelect = vi.fn(async () => undefined);
    const services = new Map<string, ReturnType<typeof vaultService>>();
    const drivers = new Map<string, { close: ReturnType<typeof vi.fn> }>();
    const notify = vi.fn();
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Amber Archive",
        commitVaultCreate: vi.fn(),
        commitVaultRename: vi.fn(),
        replaceVaultNameCache: vi.fn(),
        commitVaultSelect,
      },
      createVaultService: (vaultId) => {
        const service = vaultService(vaultId);
        services.set(vaultId, service);
        return service as unknown as VaultService;
      },
      createDriver: (vaultId) => {
        const driver = { close: vi.fn(async () => undefined) };
        drivers.set(vaultId, driver);
        return driver as unknown as IndexedDbDriver;
      },
      notify,
      now: () => "2026-07-18T12:01:00.000Z",
      token: (() => {
        let value = 0;
        return () => `token-${++value}`;
      })(),
      ...commonCreationDependencies(),
    });
    await manager.initialize();
    const before = manager.snapshot(firstVaultId);

    await manager.select({ expectedActiveVaultId: firstVaultId, vaultId: secondVaultId });

    expect(commitVaultSelect).toHaveBeenCalledWith({
      expectedActiveVaultId: firstVaultId,
      vaultId: secondVaultId,
    });
    expect(services.get(firstVaultId)?.releaseRootKey).toHaveBeenCalledOnce();
    expect(drivers.get(firstVaultId)?.close).toHaveBeenCalledOnce();
    const after = manager.snapshot(secondVaultId);
    expect(after.token).not.toBe(before.token);
    expect(after.vault.isUnlocked()).toBe(false);
    expect(services.get(secondVaultId)?.autoUnlock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith({ type: "AppStateChanged" });
  });

  it("retains the unlocked context and emits nothing when the transaction fails", async () => {
    const records = workspace();
    const failure = Object.assign(new Error("busy"), { id: "VAULT_BUSY" });
    const service = vaultService(firstVaultId);
    const driver = { close: vi.fn(async () => undefined) };
    const notify = vi.fn();
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Amber Archive",
        commitVaultCreate: vi.fn(),
        commitVaultRename: vi.fn(),
        replaceVaultNameCache: vi.fn(),
        commitVaultSelect: async () => {
          throw failure;
        },
      },
      createVaultService: () => service as unknown as VaultService,
      createDriver: () => driver as unknown as IndexedDbDriver,
      notify,
      now: () => "2026-07-18T12:01:00.000Z",
      token: () => "token-1",
      ...commonCreationDependencies(),
    });
    await manager.initialize();
    const before = manager.snapshot(firstVaultId);

    await expect(
      manager.select({ expectedActiveVaultId: firstVaultId, vaultId: secondVaultId }),
    ).rejects.toBe(failure);

    expect(manager.snapshot(firstVaultId)).toBe(before);
    expect(service.releaseRootKey).not.toHaveBeenCalled();
    expect(driver.close).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("treats selecting the active Vault as a no-op without rotating context", async () => {
    const records = workspace();
    const notify = vi.fn();
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Amber Archive",
        commitVaultCreate: vi.fn(),
        commitVaultRename: vi.fn(),
        replaceVaultNameCache: vi.fn(),
        commitVaultSelect: vi.fn(async () => undefined),
      },
      createVaultService: () => vaultService(firstVaultId) as unknown as VaultService,
      createDriver: () => ({ close: vi.fn() }) as unknown as IndexedDbDriver,
      notify,
      now: () => "2026-07-18T12:01:00.000Z",
      token: () => "token-1",
      ...commonCreationDependencies(),
    });
    await manager.initialize();
    const before = manager.snapshot(firstVaultId);

    await manager.select({ expectedActiveVaultId: firstVaultId, vaultId: firstVaultId });

    expect(manager.snapshot(firstVaultId)).toBe(before);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("WorkspaceContextManager Create", () => {
  it("installs the prepared unlocked Vault only after the atomic commit", async () => {
    const records = workspace();
    const prepared = {
      records: {
        metadata: {
          version: 1 as const,
          vaultId: secondVaultId,
          deviceId: "00000000-0000-4000-8000-000000000103",
          createdAt: "2026-07-18T12:02:00.000Z",
          manuallyLocked: false,
          verifier: { version: 1 as const, nonce: new Uint8Array(), ciphertext: new Uint8Array() },
        },
      },
      rootKey: {} as CryptoKey,
      name: "Amber Archive",
    };
    const oldVault = vaultService(firstVaultId);
    const newVault = {
      ...vaultService(secondVaultId),
      activatePrepared: vi.fn(),
      isUnlocked: vi.fn(() => true),
    };
    const preparer = { prepareCreate: vi.fn(async () => prepared) };
    const commitVaultCreate = vi.fn(async () => undefined);
    const notify = vi.fn();
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Amber Archive",
        commitVaultSelect: vi.fn(),
        commitVaultRename: vi.fn(),
        replaceVaultNameCache: vi.fn(),
        commitVaultCreate,
      },
      createVaultPreparer: () => preparer as unknown as VaultService,
      createVaultService: (vaultId) =>
        (vaultId === firstVaultId ? oldVault : newVault) as unknown as VaultService,
      createDriver: () => ({ close: vi.fn(async () => undefined) }) as unknown as IndexedDbDriver,
      prepareNameChange: vi.fn(async () => preparedNameChange()),
      encryptNameCache: vi.fn(async () => preparedNameCache()),
      notify,
      now: () => "2026-07-18T12:02:00.000Z",
      uuid: () => "00000000-0000-4000-8000-000000000201",
      token: (() => {
        let value = 0;
        return () => `token-${++value}`;
      })(),
    });
    await manager.initialize();

    const created = await manager.create({
      expectedActiveVaultId: firstVaultId,
      name: "Amber Archive",
    });

    expect(created).toBe(secondVaultId);
    expect(commitVaultCreate).toHaveBeenCalledOnce();
    expect(newVault.activatePrepared).toHaveBeenCalledWith(prepared);
    expect(oldVault.releaseRootKey).toHaveBeenCalledOnce();
    expect(manager.snapshot(secondVaultId).vault.isUnlocked()).toBe(true);
    expect(notify).toHaveBeenCalledWith({ type: "AppStateChanged" });
  });

  it("leaves the previous context untouched when Create aborts", async () => {
    const records = workspace();
    const oldVault = vaultService(firstVaultId);
    const prepared = {
      records: { metadata: { vaultId: secondVaultId, deviceId: firstVaultId } },
      rootKey: {} as CryptoKey,
      name: "Amber Archive",
    };
    const notify = vi.fn();
    const failure = new Error("abort");
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Amber Archive",
        commitVaultSelect: vi.fn(),
        commitVaultRename: vi.fn(),
        replaceVaultNameCache: vi.fn(),
        commitVaultCreate: async () => {
          throw failure;
        },
      },
      createVaultPreparer: () =>
        ({ prepareCreate: async () => prepared }) as unknown as VaultService,
      createVaultService: () => oldVault as unknown as VaultService,
      createDriver: () => ({ close: vi.fn(async () => undefined) }) as unknown as IndexedDbDriver,
      prepareNameChange: vi.fn(async () => preparedNameChange()),
      encryptNameCache: vi.fn(async () => preparedNameCache()),
      notify,
      now: () => "2026-07-18T12:02:00.000Z",
      uuid: () => "00000000-0000-4000-8000-000000000201",
      token: () => "token-1",
    });
    await manager.initialize();
    const before = manager.snapshot(firstVaultId);

    await expect(
      manager.create({ expectedActiveVaultId: firstVaultId, name: "Amber Archive" }),
    ).rejects.toBe(failure);

    expect(manager.snapshot(firstVaultId)).toBe(before);
    expect(oldVault.releaseRootKey).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("WorkspaceContextManager Rename", () => {
  it("commits encrypted name state without replacing the active context", async () => {
    const records = workspace();
    const activeVault = {
      ...vaultService(firstVaultId),
      isUnlocked: vi.fn(() => true),
      requireKeyring: vi.fn(() => ({}) as VaultKeyring),
      repository: {
        load: vi.fn(async () => ({
          metadata: { deviceId: "00000000-0000-4000-8000-000000000103" },
        })),
      },
    };
    const commitVaultRename = vi.fn(async () => undefined);
    const notify = vi.fn();
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Amber Archive",
        commitVaultCreate: vi.fn(),
        commitVaultSelect: vi.fn(),
        commitVaultRename,
        replaceVaultNameCache: vi.fn(),
      },
      createVaultPreparer: () => ({}) as VaultService,
      createVaultService: () => activeVault as unknown as VaultService,
      createDriver: () => ({ close: vi.fn(async () => undefined) }) as unknown as IndexedDbDriver,
      prepareNameChange: vi.fn(async () => preparedNameChange()),
      encryptNameCache: vi.fn(async () => preparedNameCache()),
      notify,
      now: () => "2026-07-18T12:02:00.000Z",
      uuid: () => "00000000-0000-4000-8000-000000000201",
      token: () => "token-1",
    });
    await manager.initialize();
    const before = manager.snapshot(firstVaultId);

    await manager.rename({
      expectedActiveVaultId: firstVaultId,
      vaultId: firstVaultId,
      name: "Quiet Folio",
    });

    expect(commitVaultRename).toHaveBeenCalledOnce();
    expect(manager.snapshot(firstVaultId)).toBe(before);
    expect(notify).toHaveBeenCalledWith({ type: "AppStateChanged" });
  });

  it("does not append an Event when the canonical name is unchanged", async () => {
    const records = workspace();
    const commitVaultRename = vi.fn();
    const notify = vi.fn();
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Amber Archive",
        commitVaultCreate: vi.fn(),
        commitVaultSelect: vi.fn(),
        commitVaultRename,
        replaceVaultNameCache: vi.fn(),
      },
      createVaultPreparer: () => ({}) as VaultService,
      createVaultService: () =>
        ({ ...vaultService(firstVaultId), requireKeyring: vi.fn() }) as unknown as VaultService,
      createDriver: () => ({ close: vi.fn(async () => undefined) }) as unknown as IndexedDbDriver,
      notify,
      now: () => "2026-07-18T12:02:00.000Z",
      token: () => "token-1",
    });
    await manager.initialize();

    await manager.rename({
      expectedActiveVaultId: firstVaultId,
      vaultId: firstVaultId,
      name: "Amber Archive",
    });

    expect(commitVaultRename).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("WorkspaceContextManager unlock", () => {
  it("rebuilds the Workspace name cache from the authoritative Projection", async () => {
    const records = workspace();
    const replaceVaultNameCache = vi.fn(async () => undefined);
    const activeVault = {
      ...vaultService(firstVaultId),
      unlockWithDevice: vi.fn(async () => undefined),
      requireKeyring: vi.fn(() => ({}) as VaultKeyring),
    };
    const storedProjection = {
      version: 1 as const,
      vaultId: firstVaultId,
      sourceEventId: "00000000-0000-4000-8000-000000000201",
      envelopeBytes: new Uint8Array([1]),
    };
    const manager = new WorkspaceContextManager({
      workspaceRepository: {
        bootstrap: async () => records,
        load: async () => records,
        readVaultName: async () => "Vault 000101",
        commitVaultCreate: vi.fn(),
        commitVaultSelect: vi.fn(),
        commitVaultRename: vi.fn(),
        replaceVaultNameCache,
      },
      createVaultPreparer: () => ({}) as VaultService,
      createVaultService: () => activeVault as unknown as VaultService,
      createDriver: () =>
        ({
          close: vi.fn(async () => undefined),
          getVaultNameProjection: vi.fn(async () => storedProjection),
        }) as unknown as IndexedDbDriver,
      decryptNameProjection: vi.fn(async () => ({
        version: 1 as const,
        vaultId: firstVaultId,
        name: "Amber Archive",
        sourceEventId: storedProjection.sourceEventId,
        updatedAt: "2026-07-18T12:02:00.000Z",
      })),
      encryptNameCache: vi.fn(async () => ({
        ...preparedNameCache(),
        vaultId: firstVaultId,
      })),
      notify: vi.fn(),
      now: () => "2026-07-18T12:02:00.000Z",
      token: () => "token-1",
    });
    await manager.initialize();

    await manager.unlockWithDevice(firstVaultId);

    expect(activeVault.unlockWithDevice).toHaveBeenCalledOnce();
    expect(replaceVaultNameCache).toHaveBeenCalledWith(
      expect.objectContaining({ expectedActiveVaultId: firstVaultId, vaultId: firstVaultId }),
    );
  });
});

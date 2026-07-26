import type { IndexedDbDriver } from "../../drivers/indexeddb/driver";
import type { WorkspaceRecordsV1 } from "../../drivers/indexeddb/schema";
import type {
  AtomicVaultCreateV1,
  AtomicVaultRename,
  AtomicVaultSelect,
  ReplaceVaultNameCache,
} from "../../drivers/indexeddb/workspace-repository";
import { VaultServiceError } from "./errors";
import { normalizeVaultName } from "./name";
import { decryptVaultNameProjection, prepareVaultNameChange } from "./name-crypto";
import type { VaultService } from "./service";
import { encryptWorkspaceVaultName, type WorkspaceVaultNameCacheV1 } from "./workspace-name-cache";

export interface ActiveVaultContext {
  readonly workspaceId: string;
  readonly vaultId: string;
  readonly vault: VaultService;
  readonly driver: IndexedDbDriver;
  readonly token: string;
}

interface WorkspaceContextRepository {
  bootstrap(createdAt: string): Promise<WorkspaceRecordsV1>;
  load(): Promise<WorkspaceRecordsV1 | undefined>;
  readVaultName(key: CryptoKey, workspaceId: string, vaultId: string): Promise<string>;
  commitVaultCreate(input: AtomicVaultCreateV1): Promise<void>;
  commitVaultRename(input: AtomicVaultRename): Promise<void>;
  replaceVaultNameCache(input: ReplaceVaultNameCache): Promise<void>;
  commitVaultSelect(input: AtomicVaultSelect): Promise<void>;
}

export interface CreateVaultContextInput {
  readonly expectedActiveVaultId?: string;
  readonly name: string;
}

export interface RenameVaultContextInput {
  readonly expectedActiveVaultId: string;
  readonly vaultId: string;
  readonly name: string;
}

export interface WorkspaceContextDependencies {
  readonly workspaceRepository: WorkspaceContextRepository;
  readonly createVaultPreparer: () => VaultService;
  readonly createVaultService: (vaultId: string) => VaultService;
  readonly createDriver: (vaultId: string) => IndexedDbDriver;
  readonly prepareNameChange?: typeof prepareVaultNameChange;
  readonly decryptNameProjection?: typeof decryptVaultNameProjection;
  readonly encryptNameCache?: (input: {
    readonly key: CryptoKey;
    readonly workspaceId: string;
    readonly vaultId: string;
    readonly sourceEventId: string;
    readonly name: string;
  }) => Promise<WorkspaceVaultNameCacheV1>;
  readonly notify: (message: { readonly type: "AppStateChanged" }) => void | Promise<void>;
  readonly now?: () => string;
  readonly token?: () => string;
  readonly uuid?: () => string;
}

export class WorkspaceContextManager {
  private context: ActiveVaultContext | undefined;
  private readonly now: () => string;
  private readonly nextToken: () => string;
  private readonly uuid: () => string;

  constructor(private readonly dependencies: WorkspaceContextDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.nextToken = dependencies.token ?? (() => crypto.randomUUID());
    this.uuid = dependencies.uuid ?? (() => crypto.randomUUID());
  }

  async initialize(): Promise<void> {
    const workspace = await this.dependencies.workspaceRepository.bootstrap(this.now());
    const activeVaultId = workspace.metadata.activeVaultId;
    if (activeVaultId === undefined) {
      this.context = undefined;
      return;
    }
    const vault = this.dependencies.createVaultService(activeVaultId);
    const driver = this.dependencies.createDriver(activeVaultId);
    try {
      await vault.autoUnlock();
      this.context = {
        workspaceId: workspace.metadata.workspaceId,
        vaultId: activeVaultId,
        vault,
        driver,
        token: this.nextToken(),
      };
    } catch (error) {
      await driver.close().catch(() => undefined);
      throw error;
    }
  }

  async reloadFromAuthority(): Promise<void> {
    const previous = this.context;
    this.context = undefined;
    previous?.vault.releaseRootKey();
    await previous?.driver.close().catch(() => undefined);
    await this.initialize();
    await this.dependencies.notify({ type: "AppStateChanged" });
  }

  async shutdown(): Promise<void> {
    const previous = this.context;
    this.context = undefined;
    previous?.vault.releaseRootKey();
    await previous?.driver.close().catch(() => undefined);
  }

  active(): ActiveVaultContext | undefined {
    return this.context;
  }

  snapshot(expectedVaultId: string): ActiveVaultContext {
    const context = this.context;
    if (context === undefined || context.vaultId !== expectedVaultId) {
      throw new VaultServiceError(
        "VAULT_CONTEXT_CHANGED",
        "The active Vault changed. Refresh and try again.",
      );
    }
    return context;
  }

  assertCurrent(snapshot: ActiveVaultContext): void {
    if (this.context !== snapshot || this.context.token !== snapshot.token) {
      throw new VaultServiceError(
        "VAULT_CONTEXT_CHANGED",
        "The active Vault changed. Refresh and try again.",
      );
    }
  }

  async create(input: CreateVaultContextInput): Promise<string> {
    const previous = this.context;
    if (previous?.vaultId !== input.expectedActiveVaultId) {
      if (previous !== undefined || input.expectedActiveVaultId !== undefined) {
        throw new VaultServiceError(
          "VAULT_CONTEXT_CHANGED",
          "The active Vault changed. Refresh and try again.",
        );
      }
    }
    const workspace = await this.dependencies.workspaceRepository.bootstrap(this.now());
    if (workspace.metadata.activeVaultId !== input.expectedActiveVaultId) {
      throw new VaultServiceError(
        "VAULT_CONTEXT_CHANGED",
        "The active Vault changed. Refresh and try again.",
      );
    }
    const timestamp = this.now();
    const prepared = await this.dependencies.createVaultPreparer().prepareCreate({
      name: input.name,
      createdAt: timestamp,
    });
    const vaultId = prepared.records.metadata.vaultId;
    const eventId = this.uuid();
    const prepareName = this.dependencies.prepareNameChange ?? prepareVaultNameChange;
    const nameChange = await prepareName({
      keyring: prepared.keyring,
      eventType: "VaultCreated",
      vaultId,
      deviceId: prepared.records.metadata.deviceId,
      eventId,
      timestamp,
      name: prepared.name,
    });
    const encryptName = this.dependencies.encryptNameCache ?? encryptWorkspaceVaultName;
    const cache = await encryptName({
      key: workspace.nameCacheKey,
      workspaceId: workspace.metadata.workspaceId,
      vaultId,
      sourceEventId: eventId,
      name: prepared.name,
    });
    await this.dependencies.workspaceRepository.commitVaultCreate({
      ...(input.expectedActiveVaultId === undefined
        ? {}
        : { expectedActiveVaultId: input.expectedActiveVaultId }),
      records: prepared.records,
      event: nameChange.event,
      projection: nameChange.projection,
      cache,
    });

    const vault = this.dependencies.createVaultService(vaultId);
    vault.activatePrepared(prepared);
    const driver = this.dependencies.createDriver(vaultId);
    this.context = {
      workspaceId: workspace.metadata.workspaceId,
      vaultId,
      vault,
      driver,
      token: this.nextToken(),
    };
    if (previous !== undefined) {
      previous.vault.releaseRootKey();
      await previous.driver.close();
    }
    await this.dependencies.notify({ type: "AppStateChanged" });
    return vaultId;
  }

  async rename(input: RenameVaultContextInput): Promise<void> {
    const context = this.snapshot(input.expectedActiveVaultId);
    if (input.vaultId !== context.vaultId) {
      throw new VaultServiceError(
        "VAULT_CONTEXT_CHANGED",
        "The active Vault changed. Refresh and try again.",
      );
    }
    const keyring = context.vault.requireKeyring();
    const workspace = await this.dependencies.workspaceRepository.bootstrap(this.now());
    if (workspace.metadata.activeVaultId !== context.vaultId) {
      throw new VaultServiceError(
        "VAULT_CONTEXT_CHANGED",
        "The active Vault changed. Refresh and try again.",
      );
    }
    const name = normalizeVaultName(input.name);
    const currentName = await this.dependencies.workspaceRepository.readVaultName(
      workspace.nameCacheKey,
      workspace.metadata.workspaceId,
      context.vaultId,
    );
    if (name === currentName) return;
    const records = await context.vault.repository.load(context.vaultId);
    if (records === undefined) {
      throw new VaultServiceError("VAULT_LOCKED", "The active Vault does not exist.");
    }
    const eventId = this.uuid();
    const timestamp = this.now();
    const prepareName = this.dependencies.prepareNameChange ?? prepareVaultNameChange;
    const nameChange = await prepareName({
      keyring,
      eventType: "VaultRenamed",
      vaultId: context.vaultId,
      deviceId: records.metadata.deviceId,
      eventId,
      timestamp,
      name,
    });
    const encryptName = this.dependencies.encryptNameCache ?? encryptWorkspaceVaultName;
    const cache = await encryptName({
      key: workspace.nameCacheKey,
      workspaceId: workspace.metadata.workspaceId,
      vaultId: context.vaultId,
      sourceEventId: eventId,
      name,
    });
    this.assertCurrent(context);
    await this.dependencies.workspaceRepository.commitVaultRename({
      expectedActiveVaultId: input.expectedActiveVaultId,
      vaultId: input.vaultId,
      event: nameChange.event,
      projection: nameChange.projection,
      cache,
    });
    this.assertCurrent(context);
    await this.dependencies.notify({ type: "AppStateChanged" });
  }

  async unlockWithDevice(expectedVaultId: string): Promise<void> {
    const context = this.snapshot(expectedVaultId);
    await context.vault.unlockWithDevice();
    await this.rebuildNameCache(context);
  }

  private async rebuildNameCache(context: ActiveVaultContext): Promise<void> {
    this.assertCurrent(context);
    const workspace = await this.dependencies.workspaceRepository.bootstrap(this.now());
    if (workspace.metadata.activeVaultId !== context.vaultId) {
      throw new VaultServiceError(
        "VAULT_CONTEXT_CHANGED",
        "The active Vault changed. Refresh and try again.",
      );
    }
    const stored = await context.driver.getVaultNameProjection();
    if (stored === undefined) {
      throw new VaultServiceError(
        "STORAGE_TRANSACTION_FAILED",
        "The active Vault Name Projection is unavailable.",
      );
    }
    const decryptName = this.dependencies.decryptNameProjection ?? decryptVaultNameProjection;
    const projection = await decryptName(context.vault.requireKeyring(), stored);
    const encryptName = this.dependencies.encryptNameCache ?? encryptWorkspaceVaultName;
    const cache = await encryptName({
      key: workspace.nameCacheKey,
      workspaceId: workspace.metadata.workspaceId,
      vaultId: context.vaultId,
      sourceEventId: projection.sourceEventId,
      name: projection.name,
    });
    this.assertCurrent(context);
    await this.dependencies.workspaceRepository.replaceVaultNameCache({
      expectedActiveVaultId: context.vaultId,
      vaultId: context.vaultId,
      cache,
    });
  }

  async select(input: AtomicVaultSelect): Promise<void> {
    const previous = this.snapshot(input.expectedActiveVaultId);
    await this.dependencies.workspaceRepository.commitVaultSelect(input);
    if (input.vaultId === previous.vaultId) return;

    const targetVault = this.dependencies.createVaultService(input.vaultId);
    const targetDriver = this.dependencies.createDriver(input.vaultId);
    this.context = {
      workspaceId: previous.workspaceId,
      vaultId: input.vaultId,
      vault: targetVault,
      driver: targetDriver,
      token: this.nextToken(),
    };
    previous.vault.releaseRootKey();
    await previous.driver.close();
    await this.dependencies.notify({ type: "AppStateChanged" });
  }
}

import type { WorkspaceRecordsV1 } from "../../drivers/indexeddb/schema";
import { VaultServiceError } from "./errors";
import { suggestVaultName, vaultNameComparisonKey } from "./name";

export interface VaultDirectoryEntryV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly createdAt: string;
}

export interface VaultSummary {
  readonly vaultId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly active: boolean;
  readonly unlocked: boolean;
  readonly manuallyLocked: boolean;
}

export type WorkspaceBusyState =
  | { readonly operation: "Import" }
  | {
      readonly vaultId: string;
      readonly operation:
        | "Capture"
        | "Vacuum"
        | "Export"
        | "Server Switch"
        | "Storage relief"
        | "Vault replacement";
    };

export interface WorkspaceState {
  readonly workspaceId: string;
  readonly activeVaultId?: string;
  readonly vaults: readonly VaultSummary[];
  readonly busy?: WorkspaceBusyState;
}

export interface WorkspaceVaultStatus {
  readonly manuallyLocked: boolean;
}

export interface WorkspaceServiceRepository {
  bootstrap(createdAt: string): Promise<WorkspaceRecordsV1>;
  listVaultDirectory(): Promise<readonly VaultDirectoryEntryV1[]>;
  loadVaultStatus(vaultId: string): Promise<WorkspaceVaultStatus | undefined>;
  readVaultName(key: CryptoKey, workspaceId: string, vaultId: string): Promise<string>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function placeholderName(vaultId: string): string {
  return `Vault ${vaultId.slice(-6)}`;
}

export class WorkspaceService {
  constructor(
    private readonly repository: WorkspaceServiceRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async state(input: {
    readonly unlockedVaultId?: string;
    readonly busy?: WorkspaceBusyState;
  }): Promise<WorkspaceState> {
    const workspace = await this.repository.bootstrap(this.now());
    const directory = await this.repository.listVaultDirectory();
    const activeVaultId = workspace.metadata.activeVaultId;
    if (
      activeVaultId !== undefined &&
      !directory.some((candidate) => candidate.vaultId === activeVaultId)
    ) {
      throw new VaultServiceError(
        "STORAGE_TRANSACTION_FAILED",
        "The active Vault selection is not present in the Workspace directory.",
      );
    }
    const vaults = await Promise.all(
      directory.map(async (entry): Promise<VaultSummary> => {
        const status = await this.repository.loadVaultStatus(entry.vaultId);
        if (status === undefined) {
          throw new VaultServiceError(
            "STORAGE_TRANSACTION_FAILED",
            "A Workspace Vault directory entry has no matching Vault metadata.",
          );
        }
        let name: string;
        try {
          name = await this.repository.readVaultName(
            workspace.nameCacheKey,
            workspace.metadata.workspaceId,
            entry.vaultId,
          );
        } catch {
          name = placeholderName(entry.vaultId);
        }
        const active = entry.vaultId === activeVaultId;
        return {
          vaultId: entry.vaultId,
          name,
          createdAt: entry.createdAt,
          active,
          unlocked: active && input.unlockedVaultId === entry.vaultId,
          manuallyLocked: status.manuallyLocked,
        };
      }),
    );
    vaults.sort(
      (left, right) =>
        compareText(vaultNameComparisonKey(left.name), vaultNameComparisonKey(right.name)) ||
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.vaultId, right.vaultId),
    );
    return {
      workspaceId: workspace.metadata.workspaceId,
      ...(activeVaultId === undefined ? {} : { activeVaultId }),
      vaults,
      ...(input.busy === undefined ? {} : { busy: input.busy }),
    };
  }

  async suggestName(): Promise<string> {
    const state = await this.state({});
    return suggestVaultName(state.vaults.map((vault) => vault.name));
  }
}

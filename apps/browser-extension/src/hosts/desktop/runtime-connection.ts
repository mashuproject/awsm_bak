import {
  DEFAULT_DESKTOP_RUNTIME_ENDPOINT,
  DesktopRuntimeApi,
  DesktopRuntimeApiError,
  type RuntimeGrant,
  type RuntimeTransfer,
  type RuntimeTransferSummary,
} from "./runtime-api";
import type { DesktopRuntimeGrantState } from "./runtime-grant-store";

export type DesktopRuntimeConnectionStatus =
  | { readonly kind: "Disconnected"; readonly message?: string }
  | { readonly kind: "WaitingForApproval" }
  | {
      readonly kind: "Connected";
      readonly grantId: string;
      readonly clientName: string;
      readonly scopes: readonly string[];
    }
  | { readonly kind: "Unavailable"; readonly message: string };

export interface DesktopRuntimeGrantStore {
  load(): Promise<DesktopRuntimeGrantState | undefined>;
  save(grant: DesktopRuntimeGrantState): Promise<void>;
  clear(): Promise<void>;
}

type DesktopRuntimeApiPort = Pick<
  DesktopRuntimeApi,
  | "health"
  | "beginPairing"
  | "redeemPairing"
  | "grant"
  | "command"
  | "beginTransfer"
  | "stageTransfer"
  | "pendingTransfers"
  | "discardTransfer"
  | "setToken"
  | "clearToken"
>;

export interface DesktopRuntimeConnectionOptions {
  readonly api?: DesktopRuntimeApiPort;
  readonly apiFactory?: (endpoint: string, token?: string) => DesktopRuntimeApiPort;
  readonly store: DesktopRuntimeGrantStore;
  readonly requestPermission: () => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly clientName?: string;
}

export interface DesktopRuntimeConnectOptions {
  /** The caller requested permission in the current user-gesture boundary. */
  readonly permissionAlreadyGranted?: boolean;
}

const RUNTIME_VAULT_SCOPE = "runtime.vault";
const DEFAULT_CLIENT_NAME = "AWSM browser extension";
const DEFAULT_MAX_ATTEMPTS = 240;

export class CanonicalDesktopRuntimeConnection {
  private readonly store: DesktopRuntimeGrantStore;
  private readonly apiFactory: NonNullable<DesktopRuntimeConnectionOptions["apiFactory"]>;
  private readonly requestPermission: () => Promise<void>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly clientName: string;
  private api: DesktopRuntimeApiPort;
  private currentStatus: DesktopRuntimeConnectionStatus = { kind: "Disconnected" };

  constructor(options: DesktopRuntimeConnectionOptions) {
    this.store = options.store;
    const suppliedApi = options.api;
    this.apiFactory =
      options.apiFactory ??
      (suppliedApi === undefined
        ? (endpoint, token) =>
            new DesktopRuntimeApi({ endpoint, ...(token === undefined ? {} : { token }) })
        : () => suppliedApi);
    this.api = options.api ?? this.apiFactory(DEFAULT_DESKTOP_RUNTIME_ENDPOINT);
    this.requestPermission = options.requestPermission;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.clientName = options.clientName ?? DEFAULT_CLIENT_NAME;
  }

  status(): DesktopRuntimeConnectionStatus {
    return this.currentStatus;
  }

  async restore(): Promise<DesktopRuntimeConnectionStatus> {
    let stored: DesktopRuntimeGrantState | undefined;
    try {
      stored = await this.store.load();
    } catch {
      await this.store.clear();
      this.currentStatus = {
        kind: "Disconnected",
        message: "Stored Desktop Runtime access was invalid.",
      };
      return this.currentStatus;
    }
    if (stored === undefined) {
      this.currentStatus = { kind: "Disconnected" };
      return this.currentStatus;
    }
    this.api = this.apiFactory(stored.endpoint, stored.token);
    this.api.setToken(stored.token);
    try {
      await this.api.health();
      const grant = await this.api.grant();
      if (!grant.scopes.includes(RUNTIME_VAULT_SCOPE)) {
        await this.store.clear();
        this.api.clearToken();
        this.currentStatus = {
          kind: "Disconnected",
          message: "Stored Desktop Runtime access cannot manage Vaults.",
        };
        return this.currentStatus;
      }
      this.currentStatus = connectedStatus(grant);
      return this.currentStatus;
    } catch (error) {
      if (isApiStatus(error, 401)) {
        await this.store.clear();
        this.api.clearToken();
        this.currentStatus = {
          kind: "Disconnected",
          message: "Desktop Runtime access was revoked.",
        };
        return this.currentStatus;
      }
      this.currentStatus = { kind: "Unavailable", message: "Desktop Runtime is unavailable." };
      return this.currentStatus;
    }
  }

  async connect(
    options: DesktopRuntimeConnectOptions = {},
  ): Promise<DesktopRuntimeConnectionStatus> {
    try {
      if (!options.permissionAlreadyGranted) await this.requestPermission();
      this.api = this.apiFactory(DEFAULT_DESKTOP_RUNTIME_ENDPOINT);
      await this.api.health();
      const pairing = await this.api.beginPairing(this.clientName, [RUNTIME_VAULT_SCOPE]);
      this.currentStatus = { kind: "WaitingForApproval" };
      for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
        try {
          const grant = await this.api.redeemPairing(pairing.pairingId, pairing.code, [
            RUNTIME_VAULT_SCOPE,
          ]);
          if (!grant.scopes.includes(RUNTIME_VAULT_SCOPE)) {
            throw new Error("Desktop Runtime did not grant Vault access.");
          }
          await this.store.save({
            endpoint: DEFAULT_DESKTOP_RUNTIME_ENDPOINT,
            grantId: grant.grantId,
            clientName: grant.clientName,
            scopes: grant.scopes,
            token: requireToken(grant),
          });
          this.currentStatus = connectedStatus(grant);
          return this.currentStatus;
        } catch (error) {
          if (!isApiStatus(error, 409)) throw error;
          await this.sleep(250);
        }
      }
      throw new Error("Desktop Runtime approval timed out.");
    } catch (error) {
      this.currentStatus = {
        kind: "Unavailable",
        message: error instanceof Error ? error.message : "Desktop Runtime is unavailable.",
      };
      return this.currentStatus;
    }
  }

  async disconnect(): Promise<void> {
    this.api?.clearToken();
    await this.store.clear();
    this.currentStatus = { kind: "Disconnected" };
  }

  async command<T>(request: object): Promise<T> {
    if (this.currentStatus.kind !== "Connected") {
      throw new Error("Desktop Runtime is not connected.");
    }
    return this.api.command<T>(request);
  }

  async beginTransfer(vaultId: string): Promise<RuntimeTransfer> {
    this.requireConnected();
    return this.api.beginTransfer(vaultId);
  }

  async stageTransfer(
    transferId: string,
    secret: string,
    envelope: Uint8Array,
  ): Promise<RuntimeTransferSummary> {
    this.requireConnected();
    return this.api.stageTransfer(transferId, secret, envelope);
  }

  async pendingTransfers(): Promise<readonly RuntimeTransferSummary[]> {
    this.requireConnected();
    return this.api.pendingTransfers();
  }

  async discardTransfer(transferId: string): Promise<void> {
    this.requireConnected();
    return this.api.discardTransfer(transferId);
  }

  private requireConnected(): void {
    if (this.currentStatus.kind !== "Connected") {
      throw new Error("Desktop Runtime is not connected.");
    }
  }
}

function requireToken(grant: RuntimeGrant): string {
  if (grant.token === undefined || grant.token.length === 0) {
    throw new Error("Desktop Runtime did not return a grant token.");
  }
  return grant.token;
}

function connectedStatus(grant: RuntimeGrant): DesktopRuntimeConnectionStatus {
  return {
    kind: "Connected",
    grantId: grant.grantId,
    clientName: grant.clientName,
    scopes: grant.scopes,
  };
}

function isApiStatus(error: unknown, status: number): boolean {
  return (
    (error instanceof DesktopRuntimeApiError && error.status === status) ||
    (typeof error === "object" && error !== null && "status" in error && error.status === status)
  );
}

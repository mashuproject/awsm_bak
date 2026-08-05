export const DEFAULT_DESKTOP_RUNTIME_ENDPOINT = "http://127.0.0.1:37373";

export interface DesktopRuntimeApiOptions {
  readonly endpoint?: string;
  readonly token?: string;
  readonly fetcher?: typeof fetch;
}

export interface RuntimeHealth {
  readonly status: "ok";
}

export interface RuntimePairing {
  readonly pairingId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly code: string;
}

export interface RuntimeGrant {
  readonly grantId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly token?: string;
  readonly revoked: boolean;
}

export interface RuntimeTransfer {
  readonly transferId: string;
  readonly vaultId: string;
  readonly secret: string;
}

export interface RuntimeTransferSummary {
  readonly transferId: string;
  readonly vaultId: string;
  readonly byteLength: number;
  readonly digest: string;
}

export class DesktopRuntimeApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Runtime API request failed (${status})`);
    this.name = "DesktopRuntimeApiError";
    this.status = status;
  }
}

export class DesktopRuntimeCommandError extends Error {
  readonly id: string;

  constructor(id: string, message: string) {
    super(message);
    this.name = "DesktopRuntimeCommandError";
    this.id = id;
  }
}

export class DesktopRuntimeApi {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private token: string | undefined;

  constructor(options: DesktopRuntimeApiOptions = {}) {
    const endpoint = options.endpoint ?? DEFAULT_DESKTOP_RUNTIME_ENDPOINT;
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("Desktop Runtime endpoint must use HTTP or HTTPS.");
    }
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new TypeError("Desktop Runtime endpoint must not contain credentials or URL state.");
    }
    if (
      !(
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]"
      )
    ) {
      throw new TypeError("Desktop Runtime endpoint must be loopback.");
    }
    if (parsed.pathname !== "/") {
      throw new TypeError("Desktop Runtime endpoint must not contain a path.");
    }
    this.endpoint = parsed.origin;
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis);
    this.token = options.token;
  }

  async health(): Promise<RuntimeHealth> {
    const value = await this.request<unknown>("/api/awsm/runtime/health");
    if (!isRecord(value) || value.status !== "ok") {
      throw new Error("Desktop Runtime returned an invalid health response.");
    }
    return { status: "ok" };
  }

  async beginPairing(clientName: string, scopes?: readonly string[]): Promise<RuntimePairing> {
    const body: { readonly clientName: string; readonly scopes?: readonly string[] } = {
      clientName,
      ...(scopes === undefined ? {} : { scopes }),
    };
    const value = await this.request<unknown>("/api/awsm/runtime/pairings", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return parsePairing(value);
  }

  async redeemPairing(
    pairingId: string,
    code: string,
    scopes?: readonly string[],
  ): Promise<RuntimeGrant> {
    const body: { readonly code: string; readonly scopes?: readonly string[] } = {
      code,
      ...(scopes === undefined ? {} : { scopes }),
    };
    const value = await this.request<unknown>(
      `/api/awsm/runtime/pairings/${encodeURIComponent(pairingId)}/redeem`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const grant = parseGrant(value);
    if (grant.token === undefined) throw new Error("Desktop Runtime did not return a grant token.");
    this.token = grant.token;
    return grant;
  }

  async grant(): Promise<RuntimeGrant> {
    return parseGrant(await this.request<unknown>("/api/awsm/runtime/grants/me"));
  }

  async command<T>(request: object): Promise<T> {
    const value = await this.request<unknown>("/api/awsm/runtime/command", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (isRecord(value) && value.ok === true && Object.hasOwn(value, "value")) {
      return value.value as T;
    }
    if (
      isRecord(value) &&
      value.ok === false &&
      isRecord(value.error) &&
      typeof value.error.id === "string" &&
      typeof value.error.message === "string"
    ) {
      throw new DesktopRuntimeCommandError(value.error.id, value.error.message);
    }
    throw new Error("Desktop Runtime returned an invalid Command response.");
  }

  async beginTransfer(vaultId: string): Promise<RuntimeTransfer> {
    const value = await this.request<unknown>("/api/awsm/runtime/transfers", {
      method: "POST",
      body: JSON.stringify({ vaultId }),
    });
    if (
      !isRecord(value) ||
      typeof value.transferId !== "string" ||
      typeof value.vaultId !== "string" ||
      typeof value.secret !== "string"
    ) {
      throw new Error("Desktop Runtime returned an invalid transfer request.");
    }
    return { transferId: value.transferId, vaultId: value.vaultId, secret: value.secret };
  }

  async stageTransfer(
    transferId: string,
    secret: string,
    envelope: Uint8Array,
  ): Promise<RuntimeTransferSummary> {
    const value = await this.request<unknown>(
      `/api/awsm/runtime/transfers/${encodeURIComponent(transferId)}`,
      {
        method: "PUT",
        body: Uint8Array.from(envelope).buffer,
        headers: {
          "Content-Type": "application/octet-stream",
          "Awsm-Transfer-Secret": secret,
        },
      },
    );
    return parseTransferSummary(value);
  }

  async pendingTransfers(): Promise<readonly RuntimeTransferSummary[]> {
    const value = await this.request<unknown>("/api/awsm/runtime/transfers");
    if (!Array.isArray(value))
      throw new Error("Desktop Runtime returned an invalid transfer list.");
    return value.map(parseTransferSummary);
  }

  async discardTransfer(transferId: string): Promise<void> {
    await this.request<unknown>(`/api/awsm/runtime/transfers/${encodeURIComponent(transferId)}`, {
      method: "DELETE",
    });
  }

  setToken(token: string): void {
    if (token.trim() === "") throw new TypeError("Runtime grant token cannot be empty.");
    this.token = token;
  }

  clearToken(): void {
    this.token = undefined;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (this.token !== undefined) headers.set("Authorization", `Bearer ${this.token}`);
    const response = await this.fetcher(`${this.endpoint}${path}`, { ...init, headers });
    const body = await response.text();
    let value: unknown;
    try {
      value = body === "" ? undefined : (JSON.parse(body) as unknown);
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      throw new DesktopRuntimeApiError(response.status);
    }
    return value as T;
  }
}

function parsePairing(value: unknown): RuntimePairing {
  if (
    !isRecord(value) ||
    typeof value.pairingId !== "string" ||
    typeof value.clientName !== "string" ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope): scope is string => typeof scope === "string") ||
    typeof value.code !== "string"
  ) {
    throw new Error("Desktop Runtime returned an invalid pairing response.");
  }
  return {
    pairingId: value.pairingId,
    clientName: value.clientName,
    scopes: value.scopes,
    code: value.code,
  };
}

function parseGrant(value: unknown): RuntimeGrant {
  if (
    !isRecord(value) ||
    typeof value.grantId !== "string" ||
    typeof value.clientName !== "string" ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope): scope is string => typeof scope === "string") ||
    typeof value.revoked !== "boolean"
  ) {
    throw new Error("Desktop Runtime returned an invalid grant response.");
  }
  return {
    grantId: value.grantId,
    clientName: value.clientName,
    scopes: value.scopes,
    ...(typeof value.token === "string" ? { token: value.token } : {}),
    revoked: value.revoked,
  };
}

function parseTransferSummary(value: unknown): RuntimeTransferSummary {
  if (
    !isRecord(value) ||
    typeof value.transferId !== "string" ||
    typeof value.vaultId !== "string" ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    typeof value.digest !== "string"
  ) {
    throw new Error("Desktop Runtime returned an invalid transfer summary.");
  }
  return {
    transferId: value.transferId,
    vaultId: value.vaultId,
    byteLength: value.byteLength,
    digest: value.digest,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

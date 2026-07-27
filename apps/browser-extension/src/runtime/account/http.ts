import { canonicalRecord, string, timestamp, uuid } from "../../domain/validation";

export type ApiSessionScope = "Account" | "VaultDevice";

export interface AuthenticatedSession {
  readonly account: {
    readonly accountId: string;
    readonly username: string;
    readonly inactiveDeletionAt: string;
  };
  readonly sessionId: string;
  readonly scope: ApiSessionScope;
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
}

export interface AccountHttp {
  createSession(username: string, password: string): Promise<AuthenticatedSession>;
  refresh(refreshToken: string): Promise<AuthenticatedSession>;
  logout(accessToken: string): Promise<void>;
}

export function decodeAuthenticatedSession(value: unknown): AuthenticatedSession {
  const input = canonicalRecord(value, "authenticatedSession", [
    "account",
    "sessionId",
    "scope",
    "accessToken",
    "accessExpiresAt",
    "refreshToken",
    "refreshExpiresAt",
  ]);
  const account = canonicalRecord(input.account, "authenticatedSession.account", [
    "accountId",
    "username",
    "inactiveDeletionAt",
  ]);
  const scope = string(input.scope, "authenticatedSession.scope");
  if (scope !== "Account" && scope !== "VaultDevice") throw new Error("Invalid API session scope");
  return {
    account: {
      accountId: uuid(account.accountId, "authenticatedSession.account.accountId"),
      username: string(account.username, "authenticatedSession.account.username"),
      inactiveDeletionAt: timestamp(
        account.inactiveDeletionAt,
        "authenticatedSession.account.inactiveDeletionAt",
      ),
    },
    sessionId: uuid(input.sessionId, "authenticatedSession.sessionId"),
    scope,
    accessToken: string(input.accessToken, "authenticatedSession.accessToken"),
    accessExpiresAt: timestamp(input.accessExpiresAt, "authenticatedSession.accessExpiresAt"),
    refreshToken: string(input.refreshToken, "authenticatedSession.refreshToken"),
    refreshExpiresAt: timestamp(input.refreshExpiresAt, "authenticatedSession.refreshExpiresAt"),
  };
}

export class AccountHttpError extends Error {
  constructor(readonly id: string) {
    super(id);
  }
}

export class CoordinationAccountHttp implements AccountHttp {
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private fetch(input: string, init: RequestInit): Promise<Response> {
    return this.fetcher.call(globalThis, input, init);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.origin}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        "Awsm-Protocol-Version": "1",
        "Awsm-Request-ID": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok || response.redirected) {
      const outcome =
        typeof payload === "object" && payload !== null && "outcome" in payload
          ? String(payload.outcome)
          : "SERVER_INCOMPATIBLE";
      throw new AccountHttpError(outcome);
    }
    return payload;
  }

  async createSession(username: string, password: string): Promise<AuthenticatedSession> {
    return decodeAuthenticatedSession(await this.post("/api/sessions", { username, password }));
  }

  async refresh(refreshToken: string): Promise<AuthenticatedSession> {
    return decodeAuthenticatedSession(await this.post("/api/session/refresh", { refreshToken }));
  }

  async logout(accessToken: string): Promise<void> {
    const response = await this.fetch(`${this.origin}/api/session`, {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Awsm-Protocol-Version": "1",
        "Awsm-Request-ID": crypto.randomUUID(),
      },
    });
    if (response.status !== 204) throw new AccountHttpError("AUTHENTICATION_FAILED");
  }
}

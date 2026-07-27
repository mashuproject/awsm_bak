import type { AccountHttp, AuthenticatedSession } from "./http";

export interface StoredApiSession {
  readonly version: 1;
  readonly accountId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly inactiveDeletionAt: string;
  readonly scope: "Account" | "VaultDevice";
}

interface AccountCredentialStore {
  saveAuthenticated(input: {
    readonly metadata: StoredApiSession;
    readonly refreshToken: string;
  }): Promise<void>;
}

function failure(id = "AUTHENTICATION_FAILED"): Error {
  return Object.assign(new Error(id), { id });
}

export function normalizeAccountUsername(value: string): string {
  const username = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "").toLowerCase();
  if (
    username.length < 3 ||
    username.length > 32 ||
    !/^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/u.test(username)
  )
    throw Object.assign(new Error("Invalid Account username"), { id: "ACCOUNT_INPUT_INVALID" });
  return username;
}

function metadata(session: AuthenticatedSession): StoredApiSession {
  return {
    version: 1,
    accountId: session.account.accountId,
    sessionId: session.sessionId,
    username: session.account.username,
    inactiveDeletionAt: session.account.inactiveDeletionAt,
    scope: session.scope,
  };
}

export class AccountAuthenticationService {
  constructor(
    private readonly http: Pick<AccountHttp, "createSession">,
    private readonly store: AccountCredentialStore,
  ) {}

  async login(input: { readonly username: string; readonly password: string }): Promise<string> {
    const username = normalizeAccountUsername(input.username);
    try {
      const session = await this.http.createSession(username, input.password);
      if (session.scope !== "Account" || session.account.username !== username) throw failure();
      await this.store.saveAuthenticated({
        metadata: metadata(session),
        refreshToken: session.refreshToken,
      });
      return session.accessToken;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "id" in error &&
        typeof error.id === "string"
      )
        throw error;
      throw failure();
    }
  }
}

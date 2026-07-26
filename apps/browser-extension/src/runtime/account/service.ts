import type { AccountHttp, AuthenticatedSession } from "./http";

export interface StoredApiSession {
  readonly version: 1;
  readonly accountId: string;
  readonly sessionId: string;
  readonly email: string;
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

export function normalizeAccountEmail(value: string): string {
  const email = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "").toLowerCase();
  if (
    new TextEncoder().encode(email).byteLength > 254 ||
    !/^[\x21-\x7e]+@[\x21-\x7e]+$/u.test(email) ||
    email.includes(" ")
  )
    throw Object.assign(new Error("Invalid Account email"), { id: "ACCOUNT_INPUT_INVALID" });
  return email;
}

function metadata(session: AuthenticatedSession): StoredApiSession {
  return {
    version: 1,
    accountId: session.account.accountId,
    sessionId: session.sessionId,
    email: session.account.email,
    scope: session.scope,
  };
}

export class AccountAuthenticationService {
  constructor(
    private readonly http: Pick<AccountHttp, "createSession">,
    private readonly store: AccountCredentialStore,
  ) {}

  async login(input: { readonly email: string; readonly password: string }): Promise<string> {
    const email = normalizeAccountEmail(input.email);
    try {
      const session = await this.http.createSession(email, input.password);
      if (session.scope !== "Account" || session.account.email !== email) throw failure();
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

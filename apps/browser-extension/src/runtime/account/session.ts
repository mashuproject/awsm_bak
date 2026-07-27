import type {
  AccountCredentialScope,
  IndexedDbAccountRepository,
} from "../../drivers/indexeddb/account-repository";
import type { AccountHttp } from "./http";

export class AccountSessionManager {
  private access: string | undefined;
  private refreshPromise: Promise<string> | undefined;

  constructor(
    private readonly http: Pick<AccountHttp, "refresh" | "logout">,
    private readonly repository: IndexedDbAccountRepository,
    private readonly scope: AccountCredentialScope = "active",
  ) {}

  setAccessToken(value: string): void {
    this.access = value;
  }

  async accessToken(): Promise<string> {
    if (this.access !== undefined) return this.access;
    this.refreshPromise ??= this.refreshAccess().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  async logout(): Promise<void> {
    try {
      const access = await this.accessToken();
      await this.http.logout(access);
    } catch {
      // Local credential erasure is mandatory even if the server is unavailable.
    } finally {
      this.access = undefined;
      if (this.scope === "active") await this.repository.logout();
      else await this.repository.eraseAuthenticated(this.scope);
    }
  }

  private async refreshAccess(): Promise<string> {
    const stored = await this.repository.loadAuthenticated(this.scope);
    if (stored === undefined)
      throw Object.assign(new Error("Account authentication is required"), {
        id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
      });
    const session = await this.http.refresh(stored.refreshToken);
    if (
      session.account.accountId !== stored.metadata.accountId ||
      session.account.username !== stored.metadata.username ||
      session.scope !== stored.metadata.scope
    )
      throw Object.assign(new Error("Account identity changed"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    await this.repository.saveAuthenticated(
      {
        metadata: {
          version: 1,
          accountId: session.account.accountId,
          sessionId: session.sessionId,
          username: session.account.username,
          inactiveDeletionAt: session.account.inactiveDeletionAt,
          scope: session.scope,
        },
        refreshToken: session.refreshToken,
      },
      this.scope,
    );
    this.access = session.accessToken;
    return session.accessToken;
  }
}

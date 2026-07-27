import type { AccountCredentialScope } from "../../drivers/indexeddb/account-repository";
import type {
  ServerSwitchJobV1,
  StoredAccountMetadataV1,
  StoredVaultHeadV1,
} from "../../drivers/indexeddb/schema";
import { CoordinationAccountHttp } from "../account/http";
import { AccountAuthenticationService } from "../account/service";

function contextChanged(message: string): Error {
  return Object.assign(new Error(message), { id: "VAULT_CONTEXT_CHANGED" });
}

export class ServerSwitchService {
  constructor(
    private readonly jobs: {
      loadJob(): Promise<ServerSwitchJobV1 | undefined>;
      saveJob(job: ServerSwitchJobV1): Promise<void>;
      deleteJob(jobId: string): Promise<unknown>;
    },
    private readonly accounts: {
      eraseAuthenticated(scope: AccountCredentialScope): Promise<void>;
      eraseAuthenticationSecrets?(scope: AccountCredentialScope): Promise<void>;
      loadMetadata?(scope: AccountCredentialScope): Promise<StoredAccountMetadataV1 | undefined>;
      eraseAccountVault?(scope: "server-switch-candidate"): Promise<void>;
      hasAuthenticatedSecrets(scope: AccountCredentialScope): Promise<boolean>;
      saveAuthenticated(
        credentials: {
          readonly metadata: StoredAccountMetadataV1;
          readonly refreshToken: string;
        },
        scope: AccountCredentialScope,
      ): Promise<void>;
    },
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
  ) {}

  async begin(input: {
    readonly sourceOrigin: string;
    readonly candidateOrigin: string;
    readonly candidateRegistration:
      | { readonly enabled: false }
      | { readonly enabled: true; readonly signUpUrl: string };
    readonly vaultId: string;
    readonly expectedLocalHead: StoredVaultHeadV1;
  }): Promise<void> {
    if (input.sourceOrigin === input.candidateOrigin)
      throw Object.assign(new Error("Candidate server is already active"), {
        id: "SERVER_INCOMPATIBLE",
      });
    const existing = await this.jobs.loadJob();
    if (
      input.expectedLocalHead.vaultId !== input.vaultId ||
      existing?.state === "Running" ||
      existing?.state === "AuthenticationRequired" ||
      existing?.state === "WaitingForUnlock"
    )
      throw contextChanged("Another Server Switch Job is active");
    await this.accounts.eraseAuthenticated("server-switch-candidate");
    await this.accounts.eraseAccountVault?.("server-switch-candidate");
    const timestamp = this.now();
    await this.jobs.saveJob({
      version: 1,
      jobId: this.randomUuid(),
      sourceOrigin: input.sourceOrigin,
      candidateOrigin: input.candidateOrigin,
      candidateRegistration: input.candidateRegistration,
      vaultId: input.vaultId,
      state: "AuthenticationRequired",
      stage: "AuthenticateCandidate",
      expectedLocalHead: input.expectedLocalHead,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
      candidateAuthorityChanged: false,
      attachIdempotencyKey: this.randomUuid(),
      candidateIdempotencyKey: this.randomUuid(),
    });
  }

  async authenticate(input: {
    readonly username: string;
    readonly password: string;
  }): Promise<string> {
    const job = await this.jobs.loadJob();
    if (job?.state !== "AuthenticationRequired")
      throw contextChanged("Server Switch authentication is stale");
    const expected = await this.accounts.loadMetadata?.("server-switch-candidate");
    const authentication = new AccountAuthenticationService(
      new CoordinationAccountHttp(job.candidateOrigin),
      {
        saveAuthenticated: (credentials) =>
          this.accounts.saveAuthenticated(credentials, "server-switch-candidate"),
      },
    );
    const accessToken = await authentication.login(input);
    const authenticated = await this.accounts.loadMetadata?.("server-switch-candidate");
    if (
      expected !== undefined &&
      (authenticated === undefined || authenticated.accountId !== expected.accountId)
    ) {
      await this.accounts.eraseAuthenticated("server-switch-candidate");
      throw Object.assign(new Error("Candidate Account identity changed"), {
        id: "AUTHENTICATION_FAILED",
      });
    }
    await this.jobs.saveJob({
      ...job,
      state: "Running",
      stage: job.stage === "AuthenticateCandidate" ? "Compare" : job.stage,
      updatedAt: this.now(),
    });
    return accessToken;
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.jobs.loadJob();
    if (job?.jobId !== jobId) throw contextChanged("Server Switch cancellation is stale");
    if (
      job.candidateAuthorityChanged ||
      (job.state === "Running" && job.stage !== "Compare") ||
      job.state === "Succeeded"
    )
      throw Object.assign(new Error("Server Switch application cannot be cancelled"), {
        id: "VAULT_BUSY",
      });
    await this.accounts.eraseAuthenticated("server-switch-candidate");
    await this.accounts.eraseAccountVault?.("server-switch-candidate");
    await this.jobs.deleteJob(jobId);
  }

  async retry(jobId: string): Promise<void> {
    const job = await this.jobs.loadJob();
    if (job?.jobId !== jobId) throw contextChanged("Server Switch retry is stale");
    if (job.state !== "Failed")
      throw Object.assign(new Error("Server Switch is not retryable"), { id: "VAULT_BUSY" });
    const hasCandidate = await this.accounts.hasAuthenticatedSecrets("server-switch-candidate");
    const { errorId: _errorId, retryAt: _retryAt, ...retryable } = job;
    await this.jobs.saveJob({
      ...retryable,
      state: hasCandidate ? "Running" : "AuthenticationRequired",
      stage: hasCandidate ? job.stage : "AuthenticateCandidate",
      updatedAt: this.now(),
      retryCount: job.retryCount + 1,
    });
  }
}

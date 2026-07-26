import { readySodium } from "../../crypto/sodium";
import { encodeCanonicalCbor } from "../../domain/cbor";
import { canonicalRecord, string, timestamp, uuid } from "../../domain/validation";
import type { IndexedDbDeviceRepository } from "../../drivers/indexeddb/device-repository";
import type { AccountHttp } from "./http";
import { type AuthenticatedSession, decodeAuthenticatedSession } from "./http";
import { base64UrlToBytes, bytesToBase64Url } from "./wire";

interface DeviceSessionTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

export async function establishDeviceSession(input: {
  readonly transport: DeviceSessionTransport;
  readonly accountId: string;
  readonly accountSessionId: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly deviceSigningSecretKey: Uint8Array;
}): Promise<AuthenticatedSession> {
  const challengeResponse = canonicalRecord(
    (
      await input.transport.request("POST", "/api/device-session-challenges", {
        vaultId: input.vaultId,
        deviceId: input.deviceId,
      })
    ).body,
    "deviceSessionChallenge",
    ["challenge", "expiresAt"],
  );
  const challenge = base64UrlToBytes(
    string(challengeResponse.challenge, "deviceSessionChallenge.challenge"),
    32,
  );
  timestamp(challengeResponse.expiresAt, "deviceSessionChallenge.expiresAt");
  const sodium = await readySodium();
  const signature = Uint8Array.from(
    sodium.crypto_sign_detached(
      encodeCanonicalCbor({
        domain: "awsm:device-session-challenge:v1",
        accountSessionId: uuid(input.accountSessionId, "accountSessionId"),
        vaultId: uuid(input.vaultId, "vaultId"),
        deviceId: uuid(input.deviceId, "deviceId"),
        challenge,
      }),
      input.deviceSigningSecretKey,
    ),
  );
  const session = decodeAuthenticatedSession(
    (
      await input.transport.request("POST", "/api/device-sessions", {
        vaultId: input.vaultId,
        deviceId: input.deviceId,
        challenge: bytesToBase64Url(challenge),
        signature: bytesToBase64Url(signature),
      })
    ).body,
  );
  if (session.scope !== "VaultDevice" || session.account.accountId !== input.accountId)
    throw Object.assign(new Error("Device session identity changed"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  return session;
}

export class DeviceSessionManager {
  private access: string | undefined;
  private refreshPromise: Promise<string> | undefined;

  constructor(
    private readonly http: Pick<AccountHttp, "refresh" | "logout">,
    private readonly repository: IndexedDbDeviceRepository,
    private readonly vaultId: string,
  ) {}

  setAccessToken(value: string): void {
    this.access = value;
  }

  clearAccessToken(): void {
    this.access = undefined;
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
      await this.http.logout(await this.accessToken());
    } finally {
      this.access = undefined;
    }
  }

  private async refreshAccess(): Promise<string> {
    const stored = await this.repository.loadDeviceSession(this.vaultId);
    if (stored === undefined)
      throw Object.assign(new Error("Device authentication is required"), {
        id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
      });
    const session = await this.http.refresh(stored.refreshToken);
    if (
      session.scope !== "VaultDevice" ||
      session.account.accountId !== stored.metadata.accountId ||
      session.account.email !== stored.metadata.email
    )
      throw Object.assign(new Error("Device session identity changed"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    await this.repository.saveRefreshedDeviceSession(this.vaultId, session);
    this.access = session.accessToken;
    return session.accessToken;
  }
}

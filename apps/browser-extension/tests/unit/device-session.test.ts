import { describe, expect, it, vi } from "vitest";

import { DeviceSessionManager } from "../../src/runtime/account/device-session";

const vaultId = "01900000-0000-7000-8000-000000000301";
const stored = {
  metadata: {
    version: 1 as const,
    accountId: "01900000-0000-7000-8000-000000000302",
    vaultId,
    deviceId: "01900000-0000-7000-8000-000000000303",
    sessionId: "01900000-0000-7000-8000-000000000304",
    username: "owner_test",
    inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
    scope: "VaultDevice" as const,
    refreshNonce: new Uint8Array(12),
    refreshCiphertext: new Uint8Array(32),
  },
  refreshToken: "old-device-refresh",
};

describe("Device session manager", () => {
  it("refreshes only VaultDevice authority and atomically persists the rotated credential", async () => {
    const session = {
      account: {
        accountId: stored.metadata.accountId,
        username: stored.metadata.username,
        inactiveDeletionAt: stored.metadata.inactiveDeletionAt,
      },
      sessionId: "01900000-0000-7000-8000-000000000305",
      scope: "VaultDevice" as const,
      accessToken: "new-device-access",
      accessExpiresAt: "2026-07-25T19:00:00.000Z",
      refreshToken: "new-device-refresh",
      refreshExpiresAt: "2026-08-24T18:00:00.000Z",
    };
    const repository = {
      loadDeviceSession: vi.fn(async () => stored),
      saveRefreshedDeviceSession: vi.fn(async () => undefined),
    };
    const http = {
      refresh: vi.fn(async () => session),
      logout: vi.fn(async () => undefined),
    };
    const manager = new DeviceSessionManager(http, repository as never, vaultId);

    await expect(manager.accessToken()).resolves.toBe("new-device-access");
    await expect(manager.accessToken()).resolves.toBe("new-device-access");
    expect(http.refresh).toHaveBeenCalledOnce();
    expect(http.refresh).toHaveBeenCalledWith("old-device-refresh");
    expect(repository.saveRefreshedDeviceSession).toHaveBeenCalledWith(vaultId, session);
  });

  it("rejects an Account-scoped refresh response", async () => {
    const repository = {
      loadDeviceSession: vi.fn(async () => stored),
      saveRefreshedDeviceSession: vi.fn(async () => undefined),
    };
    const manager = new DeviceSessionManager(
      {
        refresh: vi.fn(async () => ({
          account: {
            accountId: stored.metadata.accountId,
            username: stored.metadata.username,
            inactiveDeletionAt: stored.metadata.inactiveDeletionAt,
          },
          sessionId: "01900000-0000-7000-8000-000000000305",
          scope: "Account" as const,
          accessToken: "account-access",
          accessExpiresAt: "2026-07-25T19:00:00.000Z",
          refreshToken: "account-refresh",
          refreshExpiresAt: "2026-08-24T18:00:00.000Z",
        })),
        logout: vi.fn(async () => undefined),
      },
      repository as never,
      vaultId,
    );

    await expect(manager.accessToken()).rejects.toMatchObject({
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
    expect(repository.saveRefreshedDeviceSession).not.toHaveBeenCalled();
  });
});

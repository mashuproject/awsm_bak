import { describe, expect, it, vi } from "vitest";

import {
  configureSyncServer,
  HOSTED_SERVER_ORIGIN,
  serverPermissionPattern,
  validateServerOrigin,
} from "../../src/runtime/account/server";

describe("Account Coordination Server selection", () => {
  it("uses the visible hosted default and canonicalizes an exact custom origin", () => {
    expect(HOSTED_SERVER_ORIGIN).toBe("https://awsm.foo");
    expect(validateServerOrigin("https://sync.example.test/")).toBe("https://sync.example.test");
    expect(serverPermissionPattern("https://sync.example.test")).toBe(
      "https://sync.example.test/*",
    );
    expect(validateServerOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(validateServerOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it.each([
    "http://sync.example.test",
    "https://user:secret@sync.example.test",
    "https://sync.example.test/api",
    "https://sync.example.test/?mode=unsafe",
    "https://sync.example.test/#unsafe",
    "ftp://sync.example.test",
    "not a URL",
  ])("rejects unsafe or non-origin server input %s", (value) => {
    expect(() => validateServerOrigin(value)).toThrow();
  });

  it("requests only the exact origin, rejects redirects, and commits after a compatible probe", async () => {
    const requestPermission = vi.fn(async () => true);
    const probe = vi.fn(
      async (): Promise<{
        status: number;
        redirected: boolean;
        body: unknown;
      }> => ({
        status: 200,
        redirected: false,
        body: {
          service: "AWSM Coordination Server",
          protocolVersion: "1",
          capabilities: {
            accountPassword: true,
            accountVaultLimit: 1,
            completeReplicaSynchronization: true,
            deviceEnrollment: "RecoveryPhrase",
            deviceRevocation: true,
          },
          registration: {
            enabled: true,
            signUpUrl: "https://sync.example.test/sign_up",
          },
        },
      }),
    );
    const commit = vi.fn(async () => undefined);

    await configureSyncServer("https://sync.example.test", {
      requestPermission,
      probe,
      commit,
    });

    expect(requestPermission).toHaveBeenCalledWith("https://sync.example.test/*");
    expect(probe).toHaveBeenCalledWith("https://sync.example.test/api/server-information");
    expect(commit).toHaveBeenCalledWith({
      version: 1,
      mode: "Configured",
      serverOrigin: "https://sync.example.test",
      registration: {
        enabled: true,
        signUpUrl: "https://sync.example.test/sign_up",
      },
    });

    probe.mockResolvedValueOnce({
      status: 200,
      redirected: true,
      body: {
        service: "AWSM Coordination Server",
        protocolVersion: "1",
        capabilities: {
          accountPassword: true,
          accountVaultLimit: 1,
          completeReplicaSynchronization: true,
          deviceEnrollment: "RecoveryPhrase",
          deviceRevocation: true,
        },
        registration: { enabled: false },
      },
    });
    await expect(
      configureSyncServer("https://redirect.example.test", {
        requestPermission,
        probe,
        commit,
      }),
    ).rejects.toMatchObject({ id: "SERVER_INCOMPATIBLE" });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("does not probe or commit when optional permission is denied", async () => {
    const probe = vi.fn();
    const commit = vi.fn();
    await expect(
      configureSyncServer("https://sync.example.test", {
        requestPermission: async () => false,
        probe,
        commit,
      }),
    ).rejects.toMatchObject({ id: "SERVER_PERMISSION_DENIED" });
    expect(probe).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("maps permission API rejection to a stable public error without probing", async () => {
    const probe = vi.fn();
    await expect(
      configureSyncServer("https://sync.example.test", {
        requestPermission: async () => {
          throw new Error("host failure");
        },
        probe,
        commit: vi.fn(),
      }),
    ).rejects.toMatchObject({ id: "SERVER_PERMISSION_DENIED" });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "probe timeout",
      probe: async () => Promise.reject(new DOMException("Timed out", "TimeoutError")),
    },
    {
      name: "probe transport failure",
      probe: async () => Promise.reject(new TypeError("Failed to fetch")),
    },
  ])("maps $name to a stable public error without committing", async ({ probe }) => {
    const commit = vi.fn();
    await expect(
      configureSyncServer("https://sync.example.test", {
        requestPermission: async () => true,
        probe,
        commit,
      }),
    ).rejects.toMatchObject({ id: "SERVER_INCOMPATIBLE" });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { service: "AWSM Coordination Server" },
    {
      service: "AWSM Coordination Server",
      protocolVersion: "2",
      capabilities: {},
    },
    {
      service: "AWSM Coordination Server",
      protocolVersion: "1",
      capabilities: {
        accountPassword: true,
        accountVaultLimit: 1,
        completeReplicaSynchronization: true,
        deviceEnrollment: "RecoveryPhrase",
        deviceRevocation: true,
        unexpected: true,
      },
      registration: { enabled: false },
    },
  ])("rejects malformed or incompatible server information %#", async (body) => {
    const commit = vi.fn();
    await expect(
      configureSyncServer("https://sync.example.test", {
        requestPermission: async () => true,
        probe: async () => ({ status: 200, redirected: false, body }),
        commit,
      }),
    ).rejects.toMatchObject({ id: "SERVER_INCOMPATIBLE" });
    expect(commit).not.toHaveBeenCalled();
  });
});

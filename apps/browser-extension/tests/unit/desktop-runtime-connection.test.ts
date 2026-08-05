import { describe, expect, it, vi } from "vitest";

import {
  CanonicalDesktopRuntimeConnection,
  type DesktopRuntimeConnectionStatus,
} from "../../src/hosts/desktop/runtime-connection";
import type { DesktopRuntimeGrantState } from "../../src/hosts/desktop/runtime-grant-store";

const grant: DesktopRuntimeGrantState = {
  endpoint: "http://127.0.0.1:37373",
  grantId: "grant-1",
  clientName: "AWSM browser extension",
  scopes: ["runtime.vault"],
  token: "opaque-token",
};

function store(initial?: DesktopRuntimeGrantState) {
  let value = initial;
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next: DesktopRuntimeGrantState) => {
      value = next;
    }),
    clear: vi.fn(async () => {
      value = undefined;
    }),
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    health: vi.fn(async () => ({ status: "ok" as const })),
    beginPairing: vi.fn(async () => ({
      pairingId: "pair-1",
      clientName: "AWSM browser extension",
      scopes: ["runtime.vault"],
      code: "pair-code",
    })),
    redeemPairing: vi.fn(async () => ({
      grantId: grant.grantId,
      clientName: grant.clientName,
      scopes: grant.scopes,
      token: grant.token,
      revoked: false,
    })),
    setToken: vi.fn(),
    clearToken: vi.fn(),
    grant: vi.fn(async () => ({
      grantId: grant.grantId,
      clientName: grant.clientName,
      scopes: grant.scopes,
      revoked: false,
    })),
    ...overrides,
  };
}

describe("desktop Runtime connection", () => {
  it("requests loopback permission, waits for approval, and persists the grant", async () => {
    const stored = store();
    const runtimeApi = api();
    const permission = vi.fn(async () => undefined);
    const connection = new CanonicalDesktopRuntimeConnection({
      api: runtimeApi as never,
      store: stored,
      requestPermission: permission,
      sleep: async () => undefined,
    });

    await expect(connection.connect()).resolves.toMatchObject({ kind: "Connected" });
    expect(permission).toHaveBeenCalledOnce();
    expect(runtimeApi.beginPairing).toHaveBeenCalledWith("AWSM browser extension", [
      "runtime.vault",
    ]);
    expect(stored.save).toHaveBeenCalledWith(grant);
  });

  it("restores a persisted grant and clears it after an unauthorized response", async () => {
    const stored = store(grant);
    const runtimeApi = api({
      grant: vi.fn(async () => {
        throw Object.assign(new Error("revoked"), { status: 401 });
      }),
    });
    const connection = new CanonicalDesktopRuntimeConnection({
      apiFactory: () => runtimeApi as never,
      store: stored,
      requestPermission: async () => undefined,
    });

    await expect(connection.restore()).resolves.toMatchObject({ kind: "Disconnected" });
    expect(runtimeApi.setToken).toHaveBeenCalledWith(grant.token);
    expect(stored.clear).toHaveBeenCalledOnce();
  });

  it("discards a persisted grant that cannot authorize the current Vault surface", async () => {
    const stored = store({ ...grant, scopes: ["runtime.unsupported"] });
    const runtimeApi = api({
      grant: vi.fn(async () => ({
        grantId: grant.grantId,
        clientName: grant.clientName,
        scopes: ["runtime.unsupported"],
        revoked: false,
      })),
    });
    const connection = new CanonicalDesktopRuntimeConnection({
      apiFactory: () => runtimeApi as never,
      store: stored,
      requestPermission: async () => undefined,
    });

    await expect(connection.restore()).resolves.toEqual({
      kind: "Disconnected",
      message: "Stored Desktop Runtime access cannot manage Vaults.",
    });
    expect(stored.clear).toHaveBeenCalledOnce();
    expect(runtimeApi.clearToken).toHaveBeenCalledOnce();
  });

  it("does not expose the bearer token in its status", async () => {
    const stored = store();
    const connection = new CanonicalDesktopRuntimeConnection({
      api: api() as never,
      store: stored,
      requestPermission: async () => undefined,
    });

    const status = (await connection.connect()) as DesktopRuntimeConnectionStatus;
    expect(JSON.stringify(status)).not.toContain(grant.token);
  });

  it("can reuse permission granted by the initiating user gesture", async () => {
    const permission = vi.fn(async () => undefined);
    const connection = new CanonicalDesktopRuntimeConnection({
      api: api() as never,
      store: store(),
      requestPermission: permission,
    });

    await expect(connection.connect({ permissionAlreadyGranted: true })).resolves.toMatchObject({
      kind: "Connected",
    });
    expect(permission).not.toHaveBeenCalled();
  });

  it("reports a denied permission as unavailable", async () => {
    const connection = new CanonicalDesktopRuntimeConnection({
      api: api() as never,
      store: store(),
      requestPermission: async () => {
        throw new Error("Allow loopback access before connecting to the Desktop Runtime.");
      },
    });

    await expect(connection.connect()).resolves.toEqual({
      kind: "Unavailable",
      message: "Allow loopback access before connecting to the Desktop Runtime.",
    });
  });
});

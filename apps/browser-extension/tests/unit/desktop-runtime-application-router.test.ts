import { describe, expect, it, vi } from "vitest";

import { DesktopRuntimeApplicationRouter } from "../../src/hosts/desktop/runtime-application-router";
import type { CanonicalPopupApplicationTransport } from "../../src/ui/canonical-popup-application-client";

const localVault = {
  vaultId: "a".repeat(64),
  label: "Local",
  lifecycle: "Open" as const,
  access: "Authoring" as const,
  selected: true,
};
const desktopVault = {
  vaultId: "b".repeat(64),
  label: "Desktop",
  lifecycle: "Open" as const,
  access: "Authoring" as const,
  selected: true,
};

function transport(state: object): CanonicalPopupApplicationTransport {
  return {
    request: vi.fn(async (request) => {
      if (request.type === "GetState") return state;
      return null;
    }),
    subscribe: () => () => undefined,
  };
}

describe("desktop-backed Vault application router", () => {
  it("merges local and desktop Vault directories without copying Vault bytes", async () => {
    const local = transport({ selectedVaultId: localVault.vaultId, vaults: [localVault] });
    const desktop = {
      status: () => ({
        kind: "Connected" as const,
        grantId: "grant",
        clientName: "extension",
        scopes: [],
      }),
      command: vi.fn(async (request: { type: string }) => {
        if (request.type === "GetState")
          return { selectedVaultId: desktopVault.vaultId, vaults: [desktopVault] };
        return null;
      }),
    };
    const router = new DesktopRuntimeApplicationRouter(local);
    router.setDesktopConnection(desktop as never);

    await expect(router.request({ type: "GetState" })).resolves.toEqual({
      selectedVaultId: localVault.vaultId,
      vaults: [
        { ...localVault, selected: true },
        { ...desktopVault, selected: false },
      ],
    });
    expect(desktop.command).toHaveBeenCalledWith({ type: "GetState" });
    expect(local.request).toHaveBeenCalledWith({ type: "GetState" });
  });

  it("routes selection and subsequent Vault reads to the selected desktop backend", async () => {
    const local = transport({ selectedVaultId: localVault.vaultId, vaults: [localVault] });
    const desktopState: { selectedVaultId?: string; vaults: readonly (typeof desktopVault)[] } = {
      vaults: [desktopVault],
    };
    const desktop = {
      status: () => ({
        kind: "Connected" as const,
        grantId: "grant",
        clientName: "extension",
        scopes: [],
      }),
      command: vi.fn(async (request: { type: string }) => {
        if (request.type === "GetState") return desktopState;
        if (request.type === "SelectVault") {
          desktopState.selectedVaultId = desktopVault.vaultId;
          return {
            selectedVaultId: desktopVault.vaultId,
            vaults: [{ ...desktopVault, selected: true }],
          };
        }
        return [];
      }),
    };
    const router = new DesktopRuntimeApplicationRouter(local);
    router.setDesktopConnection(desktop as never);
    await router.request({ type: "GetState" });

    await router.request({
      type: "SelectVault",
      expectedVaultId: localVault.vaultId,
      vaultId: desktopVault.vaultId,
    });
    await router.request({ type: "ListLibrary", expectedVaultId: desktopVault.vaultId });
    expect(desktop.command).toHaveBeenCalledWith({
      type: "SelectVault",
      expectedVaultId: null,
      vaultId: desktopVault.vaultId,
    });
    expect(desktop.command).toHaveBeenCalledWith({
      type: "ListLibrary",
      expectedVaultId: desktopVault.vaultId,
    });
  });

  it("surfaces a local/desktop Vault identity collision instead of hiding one backend", async () => {
    const local = transport({ selectedVaultId: localVault.vaultId, vaults: [localVault] });
    const desktop = {
      status: () => ({
        kind: "Connected" as const,
        grantId: "grant",
        clientName: "extension",
        scopes: [],
      }),
      command: vi.fn(async () => ({
        selectedVaultId: localVault.vaultId,
        vaults: [{ ...localVault, selected: true }],
      })),
    };
    const router = new DesktopRuntimeApplicationRouter(local);
    router.setDesktopConnection(desktop as never);

    await expect(router.request({ type: "GetState" })).rejects.toThrow(
      "A desktop Vault has the same identity as a local Vault.",
    );
  });

  it("surfaces a connected desktop command failure instead of hiding the desktop directory", async () => {
    const local = transport({ selectedVaultId: localVault.vaultId, vaults: [localVault] });
    const desktop = {
      status: () => ({
        kind: "Connected" as const,
        grantId: "grant",
        clientName: "extension",
        scopes: ["runtime.vault"],
      }),
      command: vi.fn(async () => {
        throw new Error("desktop command failed");
      }),
    };
    const router = new DesktopRuntimeApplicationRouter(local);
    router.setDesktopConnection(desktop as never);

    await expect(router.request({ type: "GetState" })).rejects.toThrow("desktop command failed");
  });
});

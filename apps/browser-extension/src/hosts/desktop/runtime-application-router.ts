import type { CanonicalApplicationRequest } from "../../app/canonical-application";
import type {
  CanonicalClientState,
  CanonicalClientVaultSummary,
} from "../../runtime/client/canonical-runtime";
import type { CanonicalPopupApplicationTransport } from "../../ui/canonical-popup-application-client";
import type { CanonicalDesktopRuntimeConnection } from "./runtime-connection";

type Backend = "local" | "desktop";

/**
 * Keeps local and desktop-owned Vaults in one selection surface. The selected
 * Vault determines the transport for every subsequent command; no Vault bytes
 * are copied into the extension merely because the list is merged.
 */
export class DesktopRuntimeApplicationRouter implements CanonicalPopupApplicationTransport {
  private desktop: CanonicalDesktopRuntimeConnection | undefined;
  private activeBackend: Backend = "local";
  private readonly locations = new Map<string, Backend>();
  private localState: CanonicalClientState | undefined;
  private desktopState: CanonicalClientState | undefined;

  constructor(private readonly local: CanonicalPopupApplicationTransport) {}

  setDesktopConnection(connection: CanonicalDesktopRuntimeConnection | undefined): void {
    this.desktop = connection;
    if (connection?.status().kind !== "Connected" && this.activeBackend === "desktop") {
      this.activeBackend = "local";
    }
  }

  request(request: CanonicalApplicationRequest): Promise<unknown> {
    if (request.type === "GetState") return this.getState();
    return this.route(request);
  }

  subscribe(listener: () => void): () => void {
    const unsubscribe = this.local.subscribe(listener);
    return unsubscribe;
  }

  private async getState(): Promise<CanonicalClientState> {
    this.localState = (await this.local.request({ type: "GetState" })) as CanonicalClientState;
    this.locations.clear();
    for (const vault of this.localState.vaults) this.locations.set(vault.vaultId, "local");

    this.desktopState = undefined;
    if (this.desktop?.status().kind === "Connected") {
      this.desktopState = (await this.desktop.command({
        type: "GetState",
      })) as CanonicalClientState;
      for (const vault of this.desktopState.vaults) {
        if (this.locations.has(vault.vaultId)) {
          throw new Error("A desktop Vault has the same identity as a local Vault.");
        }
        this.locations.set(vault.vaultId, "desktop");
      }
    }

    const vaults = [...this.localState.vaults, ...(this.desktopState?.vaults ?? [])].map(
      (vault): CanonicalClientVaultSummary => ({ ...vault, selected: false }),
    );
    const preferredState = this.activeBackend === "desktop" ? this.desktopState : this.localState;
    const fallbackBackend = this.activeBackend === "desktop" ? "local" : "desktop";
    const fallbackState = fallbackBackend === "desktop" ? this.desktopState : this.localState;
    if (
      preferredState?.selectedVaultId === undefined &&
      fallbackState?.selectedVaultId !== undefined
    ) {
      this.activeBackend = fallbackBackend;
    }
    const selectedState = this.activeBackend === "desktop" ? this.desktopState : this.localState;
    const selectedVaultId = selectedState?.selectedVaultId;
    if (selectedVaultId !== undefined) {
      const selected = vaults.find((vault) => vault.vaultId === selectedVaultId);
      if (selected !== undefined) {
        const index = vaults.indexOf(selected);
        vaults[index] = { ...selected, selected: true };
      }
    }
    const pending = selectedState?.pendingVaultCreation;
    return {
      ...(selectedVaultId === undefined ? {} : { selectedVaultId }),
      ...(pending === undefined ? {} : { pendingVaultCreation: pending }),
      vaults,
    };
  }

  private async route(request: CanonicalApplicationRequest): Promise<unknown> {
    const backend = this.backendFor(request);
    if (request.type === "SelectVault") {
      const selectedState = backend === "desktop" ? this.desktopState : this.localState;
      const expectedVaultId = selectedState?.selectedVaultId ?? null;
      const result = await this.requestBackend(backend, {
        ...request,
        expectedVaultId,
      });
      this.activeBackend = backend;
      return result;
    }
    return this.requestBackend(backend, request);
  }

  private backendFor(request: CanonicalApplicationRequest): Backend {
    if (request.type === "SelectVault") {
      return this.locations.get(request.vaultId) ?? this.activeBackend;
    }
    const expected = "expectedVaultId" in request ? request.expectedVaultId : undefined;
    if (typeof expected === "string") return this.locations.get(expected) ?? this.activeBackend;
    return this.activeBackend;
  }

  private requestBackend(backend: Backend, request: CanonicalApplicationRequest): Promise<unknown> {
    if (backend === "local") return this.local.request(request);
    if (this.desktop?.status().kind !== "Connected") {
      return Promise.reject(new Error("Desktop Runtime is not connected."));
    }
    return this.desktop.command(request);
  }
}

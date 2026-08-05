import type { CanonicalApplicationRequest } from "../../app/canonical-application";
import type { CanonicalPopupApplicationTransport } from "../../ui/canonical-popup-application-client";
import type { CanonicalDesktopRuntimeConnection } from "./runtime-connection";

/**
 * Adapts the browser popup's existing application contract to a paired
 * desktop Runtime. The popup remains unaware of HTTP, bearer tokens, or the
 * distinction between local and desktop-backed Vault state.
 */
export class DesktopRuntimeApplicationTransport implements CanonicalPopupApplicationTransport {
  constructor(private readonly connection: CanonicalDesktopRuntimeConnection) {}

  request(request: CanonicalApplicationRequest): Promise<unknown> {
    return this.connection.command(request);
  }

  subscribe(_listener: () => void): () => void {
    // Commands returned by the desktop are authoritative. The popup already
    // refreshes after its own mutations; a future event stream can wake this
    // same transport without changing the application contract.
    return () => undefined;
  }
}

import { browser } from "wxt/browser";

import { CanonicalApplicationClientError } from "../app/canonical-application-client";
import {
  firefoxServerPermissionPattern,
  requestFirefoxSynchronizationPermissions,
} from "../hosts/firefox/synchronization-permission";

export interface HostedReplicaPermissionRequestOptions {
  readonly deniedMessage?: string;
}

export function hostedReplicaOriginPattern(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length !== 0 ||
      parsed.password.length !== 0 ||
      parsed.search.length !== 0 ||
      parsed.hash.length !== 0 ||
      parsed.href !== endpoint
    ) {
      throw new TypeError("Hosted Replica endpoint is noncanonical");
    }
    return firefoxServerPermissionPattern(endpoint);
  } catch {
    throw new CanonicalApplicationClientError(
      "HOSTED_REPLICA_ENDPOINT_INVALID",
      "Enter a canonical HTTPS Replica Host address.",
    );
  }
}

/** Requests only the configured opaque Host origins immediately from a user action. */
export async function requestHostedReplicaPermissions(
  endpoints: readonly string[],
  options: HostedReplicaPermissionRequestOptions = {},
): Promise<void> {
  const originPatterns = [...new Set(endpoints.map(hostedReplicaOriginPattern))].toSorted();
  if (originPatterns.length === 0) return;
  const firefox = browser.runtime.getManifest().browser_specific_settings?.gecko !== undefined;
  const granted = firefox
    ? await requestFirefoxSynchronizationPermissions(browser.permissions, originPatterns)
    : await browser.permissions.request({ origins: originPatterns });
  if (!granted) {
    throw new CanonicalApplicationClientError(
      "HOST_PERMISSION_DENIED",
      options.deniedMessage ?? "Allow access to this Replica Host before connecting it.",
    );
  }
}

export async function requestHostedReplicaPermission(
  endpoint: string,
  options?: HostedReplicaPermissionRequestOptions,
): Promise<void> {
  await requestHostedReplicaPermissions([endpoint], options);
}

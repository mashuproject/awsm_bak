import { browser } from "wxt/browser";

import { CanonicalApplicationClientError } from "../../app/canonical-application-client";

export const DESKTOP_RUNTIME_ORIGIN_PATTERN = "http://127.0.0.1/*";

export async function requestDesktopRuntimePermission(): Promise<void> {
  const granted = await browser.permissions.request({
    origins: [DESKTOP_RUNTIME_ORIGIN_PATTERN],
  });
  if (!granted) {
    throw new CanonicalApplicationClientError(
      "DESKTOP_RUNTIME_PERMISSION_DENIED",
      "Allow loopback access before connecting to the Desktop Runtime.",
    );
  }
}

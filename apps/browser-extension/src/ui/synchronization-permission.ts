import { browser } from "wxt/browser";
import {
  type FirefoxSynchronizationPermissionApi,
  firefoxServerPermissionPattern,
  requestFirefoxSynchronizationPermission,
} from "../hosts/firefox/synchronization-permission";
import { serverPermissionPattern } from "../runtime/account/server";

export async function requestSynchronizationPermission(serverOrigin: string): Promise<boolean> {
  const originPattern = serverPermissionPattern(serverOrigin);
  if (browser.runtime.getManifest().browser_specific_settings?.gecko === undefined) {
    return browser.permissions.request({ origins: [originPattern] });
  }
  return requestFirefoxSynchronizationPermission(
    browser.permissions as unknown as FirefoxSynchronizationPermissionApi,
    firefoxServerPermissionPattern(serverOrigin),
  );
}

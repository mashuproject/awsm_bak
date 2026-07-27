import { browser } from "wxt/browser";
import { FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES } from "../hosts/firefox/synchronization-permission";
import { remoteSearchPermissionPattern } from "../runtime/search/remote-endpoint";

export function requestRemoteSearchPermission(endpoint: string): Promise<boolean> {
  const origins = [remoteSearchPermissionPattern(endpoint)];
  if (browser.runtime.getManifest().browser_specific_settings?.gecko === undefined)
    return browser.permissions.request({ origins });
  return (
    browser.permissions as unknown as {
      request(input: {
        readonly origins: readonly string[];
        readonly data_collection: readonly string[];
      }): Promise<boolean>;
    }
  ).request({
    origins,
    data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
  });
}

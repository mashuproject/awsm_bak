import { browser } from "wxt/browser";
import { ChromeAccountServerHost } from "../chrome/account-server";
import {
  type FirefoxSynchronizationPermissionApi,
  firefoxServerPermissionPattern,
  hasFirefoxSynchronizationPermission,
} from "./synchronization-permission";

export class FirefoxAccountServerHost extends ChromeAccountServerHost {
  override async requestPermission(pattern: string): Promise<boolean> {
    const permissions = browser.permissions as unknown as FirefoxSynchronizationPermissionApi;
    return hasFirefoxSynchronizationPermission(
      await permissions.getAll(),
      firefoxServerPermissionPattern(pattern),
    );
  }
}

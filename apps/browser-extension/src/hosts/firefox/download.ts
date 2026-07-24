import { browser } from "wxt/browser";
import type { DownloadListener, DownloadsAdapter } from "../shared/download-waiter";

const listenerBridges = new Map<
  DownloadListener,
  Parameters<typeof browser.downloads.onChanged.addListener>[0]
>();

export const firefoxDownloads: DownloadsAdapter = {
  search: async (downloadId) =>
    (await browser.downloads.search({ id: downloadId })).map((item) => ({
      state: item.state,
      ...(typeof item.error === "string" ? { error: item.error } : {}),
    })),
  addChangedListener: (listener) => {
    const bridge: Parameters<typeof browser.downloads.onChanged.addListener>[0] = (delta) =>
      listener({
        id: delta.id,
        ...(delta.state?.current === undefined ? {} : { state: delta.state.current }),
        ...(typeof delta.error?.current === "string" ? { error: delta.error.current } : {}),
      });
    listenerBridges.set(listener, bridge);
    browser.downloads.onChanged.addListener(bridge);
  },
  removeChangedListener: (listener) => {
    const bridge = listenerBridges.get(listener);
    if (bridge === undefined) return;
    listenerBridges.delete(listener);
    browser.downloads.onChanged.removeListener(bridge);
  },
};

export function assertFirefoxObjectUrl(url: string): string {
  const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;
  if (!url.startsWith(`blob:${extensionOrigin}/`))
    throw new Error("The download URL is outside the Firefox extension origin.");
  return url;
}

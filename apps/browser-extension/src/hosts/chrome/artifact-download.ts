import { browser } from "wxt/browser";
import {
  type DownloadListener,
  type DownloadsAdapter,
  exportDownloadFailure,
  waitForDownload,
} from "../shared/download-waiter";
import { mhtmlDownloadFilenameSuggestion } from "./mhtml-download";

const DIRECTORY = "awsm-artifact-downloads";
const SNAPSHOT_DIRECTORY = "awsm-page-snapshots";

const listeners = new Map<
  DownloadListener,
  Parameters<typeof browser.downloads.onChanged.addListener>[0]
>();

const downloads: DownloadsAdapter = {
  search: async (downloadId) =>
    (await browser.downloads.search({ id: downloadId })).map((item) => ({
      state: item.state,
      ...(item.error === undefined ? {} : { error: item.error }),
    })),
  addChangedListener: (listener) => {
    const bridge: Parameters<typeof browser.downloads.onChanged.addListener>[0] = (delta) =>
      listener({
        id: delta.id,
        ...(delta.state?.current === undefined ? {} : { state: delta.state.current }),
        ...(delta.error?.current === undefined ? {} : { error: delta.error.current }),
      });
    listeners.set(listener, bridge);
    browser.downloads.onChanged.addListener(bridge);
  },
  removeChangedListener: (listener) => {
    const bridge = listeners.get(listener);
    if (bridge === undefined) return;
    listeners.delete(listener);
    browser.downloads.onChanged.removeListener(bridge);
  },
};

function downloadError(cause?: unknown): Error {
  return Object.assign(new Error("MHTML download failed.", { cause }), {
    id: "MHTML_DOWNLOAD_FAILED" as const,
  });
}

function preparedUrl(value: unknown): string {
  if (typeof value === "object" && value !== null && "error" in value && value.error === true)
    throw downloadError();
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !value.url.startsWith(`blob:chrome-extension://${browser.runtime.id}/`)
  )
    throw downloadError();
  return value.url;
}

export class ChromeMhtmlDownloadHost {
  async download(
    input: {
      readonly snapshotTemporaryName: string;
      readonly mhtmlTemporaryName: string;
      readonly filename: string;
      readonly stream: ReadableStream<Uint8Array>;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const snapshotDirectory = await root.getDirectoryHandle(SNAPSHOT_DIRECTORY, { create: true });
    const handle = await snapshotDirectory.getFileHandle(input.snapshotTemporaryName, {
      create: true,
    });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await input.stream.pipeTo(writable, { signal });
      const contexts = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      const createdDocument = contexts.length === 0;
      if (createdDocument) {
        await browser.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["BLOBS"],
          justification: "Download a verified MHTML archive from temporary extension storage.",
        });
      }
      let downloadId: number | undefined;
      let removeFilenameListener: (() => void) | undefined;
      try {
        const prepared: unknown = await browser.runtime.sendMessage({
          type: "awsm:prepare-mhtml-download",
          snapshotTemporaryName: input.snapshotTemporaryName,
          mhtmlTemporaryName: input.mhtmlTemporaryName,
        });
        signal.throwIfAborted();
        const url = preparedUrl(prepared);
        const determineFilename: Parameters<
          typeof browser.downloads.onDeterminingFilename.addListener
        >[0] = (item, suggest) => {
          suggest(mhtmlDownloadFilenameSuggestion(item.url, url, input.filename));
        };
        browser.downloads.onDeterminingFilename.addListener(determineFilename);
        removeFilenameListener = () =>
          browser.downloads.onDeterminingFilename.removeListener(determineFilename);
        downloadId = await browser.downloads.download({
          url,
          filename: input.filename,
          saveAs: false,
        });
        await waitForDownload(downloads, downloadId, signal);
      } catch (error) {
        if (signal.aborted && downloadId !== undefined)
          await browser.downloads.cancel(downloadId).catch(() => undefined);
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw downloadError(exportDownloadFailure(error));
      } finally {
        removeFilenameListener?.();
        await browser.runtime
          .sendMessage({
            type: "awsm:release-mhtml-download",
            mhtmlTemporaryName: input.mhtmlTemporaryName,
          })
          .catch(() => undefined);
        if (createdDocument) await browser.offscreen.closeDocument().catch(() => undefined);
      }
    } finally {
      await snapshotDirectory.removeEntry(input.snapshotTemporaryName).catch(() => undefined);
    }
  }

  async cleanupOrphans(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(DIRECTORY, { create: true });
    for await (const name of directory.keys())
      await directory.removeEntry(name).catch(() => undefined);
    const snapshots = await root.getDirectoryHandle(SNAPSHOT_DIRECTORY, { create: true });
    for await (const name of snapshots.keys())
      await snapshots.removeEntry(name).catch(() => undefined);
  }
}

export function mhtmlDownloadFilename(bundleId: string): string {
  return `awsm-${bundleId.slice(0, 8)}-page.mhtml`;
}

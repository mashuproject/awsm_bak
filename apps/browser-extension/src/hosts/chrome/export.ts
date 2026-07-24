import { browser } from "wxt/browser";
import {
  type PreparedVaultExport,
  type ValidatedVaultPackage,
  validateVaultPackage,
  writeVaultPackage,
} from "../../runtime/export";
import {
  type DownloadListener,
  type DownloadsAdapter,
  exportDownloadFailure,
  waitForDownload,
} from "../shared/download-waiter";

const TEMP_DIRECTORY = "awsm-vault-exports";

async function exportDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(TEMP_DIRECTORY, { create: true });
}

function temporaryName(packageId: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(packageId)) throw new Error("Invalid Export package identifier.");
  return `${packageId}.awsm.tmp`;
}

function preparedDownloadUrl(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !value.url.startsWith(`blob:chrome-extension://${browser.runtime.id}/`)
  )
    throw Object.assign(new Error("Export download preparation failed."), {
      id: "EXPORT_DOWNLOAD_FAILED",
    });
  return value.url;
}

const downloadListeners = new Map<
  DownloadListener,
  Parameters<typeof browser.downloads.onChanged.addListener>[0]
>();
const downloadsAdapter: DownloadsAdapter = {
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
    downloadListeners.set(listener, bridge);
    browser.downloads.onChanged.addListener(bridge);
  },
  removeChangedListener: (listener) => {
    const bridge = downloadListeners.get(listener);
    if (bridge === undefined) return;
    downloadListeners.delete(listener);
    browser.downloads.onChanged.removeListener(bridge);
  },
};

export class ChromeVaultExportHost {
  constructor(private readonly beforeDownload?: () => Promise<void>) {}

  async writeAndValidate(
    packageId: string,
    prepared: PreparedVaultExport,
    passphrase: string,
    signal: AbortSignal,
  ): Promise<ValidatedVaultPackage> {
    const directory = await exportDirectory();
    const file = await directory.getFileHandle(temporaryName(packageId), { create: true });
    const writable = await file.createWritable({ keepExistingData: false });
    try {
      await writeVaultPackage(writable, prepared.entries, signal);
      signal.throwIfAborted();
      await prepared.assertSnapshotCurrent();
      return await validateVaultPackage(await file.getFile(), passphrase);
    } catch (error) {
      await writable.abort().catch(() => undefined);
      if (error instanceof Error && "id" in error) throw error;
      throw Object.assign(new Error("Temporary Export output failed."), {
        id: "EXPORT_DOWNLOAD_FAILED",
      });
    }
  }

  async download(packageId: string, filename: string, signal: AbortSignal): Promise<void> {
    const contexts = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    const createdDocument = contexts.length === 0;
    if (createdDocument) {
      await browser.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Download a validated encrypted Vault Package from temporary storage.",
      });
    }
    const name = temporaryName(packageId);
    if (!/^awsm-vault-[0-9]{4}-[0-9]{2}-[0-9]{2}\.awsm$/u.test(filename))
      throw Object.assign(new Error("Invalid Export filename."), {
        id: "EXPORT_DOWNLOAD_FAILED",
      });
    let downloadId: number | undefined;
    let cancellationIssued = false;
    const cancel = (): void => {
      if (downloadId !== undefined && !cancellationIssued) {
        cancellationIssued = true;
        void browser.downloads.cancel(downloadId).catch(() => undefined);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const prepared: unknown = await browser.runtime.sendMessage({
        type: "awsm:prepare-vault-export-download",
        temporaryName: name,
      });
      signal.throwIfAborted();
      await this.beforeDownload?.();
      try {
        downloadId = await browser.downloads.download({
          url: preparedDownloadUrl(prepared),
          filename,
          saveAs: import.meta.env.MODE !== "e2e",
        });
      } catch (error) {
        if (signal.aborted) throw new DOMException("Export download cancelled.", "AbortError");
        throw exportDownloadFailure(error);
      }
      if (signal.aborted) cancel();
      signal.throwIfAborted();
      await waitForDownload(downloadsAdapter, downloadId, signal);
    } finally {
      signal.removeEventListener("abort", cancel);
      await browser.runtime
        .sendMessage({
          type: "awsm:release-vault-export-download",
          temporaryName: name,
        })
        .catch(() => undefined);
      if (createdDocument) await browser.offscreen.closeDocument().catch(() => undefined);
    }
  }

  async cleanup(packageId: string): Promise<void> {
    const directory = await exportDirectory();
    await directory.removeEntry(temporaryName(packageId)).catch(() => undefined);
  }
}

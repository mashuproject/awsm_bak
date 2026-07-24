import { browser } from "wxt/browser";
import {
  type PreparedVaultExport,
  type ValidatedVaultPackage,
  validateVaultPackage,
  writeVaultPackage,
} from "../../runtime/export";
import { exportDownloadFailure, waitForDownload } from "../shared/download-waiter";
import { assertFirefoxObjectUrl, firefoxDownloads } from "./download";

const TEMP_DIRECTORY = "awsm-vault-exports";

async function exportDirectory(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(TEMP_DIRECTORY, {
    create: true,
  });
}

function temporaryName(packageId: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(packageId)) throw new Error("Invalid Export package identifier.");
  return `${packageId}.awsm.tmp`;
}

export class FirefoxVaultExportHost {
  constructor(private readonly beforeDownload?: () => Promise<void>) {}

  async writeAndValidate(
    packageId: string,
    prepared: PreparedVaultExport,
    passphrase: string,
    signal: AbortSignal,
  ): Promise<ValidatedVaultPackage> {
    const directory = await exportDirectory();
    const handle = await directory.getFileHandle(temporaryName(packageId), {
      create: true,
    });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writeVaultPackage(writable, prepared.entries, signal);
      signal.throwIfAborted();
      await prepared.assertSnapshotCurrent();
      return validateVaultPackage(await handle.getFile(), passphrase);
    } catch (error) {
      await writable.abort().catch(() => undefined);
      if (error instanceof Error && "id" in error) throw error;
      throw exportDownloadFailure(error);
    }
  }

  async download(packageId: string, filename: string, signal: AbortSignal): Promise<void> {
    if (!/^awsm-vault-[0-9]{4}-[0-9]{2}-[0-9]{2}\.awsm$/u.test(filename))
      throw exportDownloadFailure();
    const handle = await (await exportDirectory()).getFileHandle(temporaryName(packageId));
    let objectUrl: string | undefined;
    let downloadId: number | undefined;
    try {
      objectUrl = assertFirefoxObjectUrl(URL.createObjectURL(await handle.getFile()));
      await this.beforeDownload?.();
      signal.throwIfAborted();
      downloadId = await browser.downloads.download({
        url: objectUrl,
        filename,
        saveAs: import.meta.env.MODE !== "e2e",
        conflictAction: "uniquify",
      });
      await waitForDownload(firefoxDownloads, downloadId, signal);
    } catch (error) {
      if (signal.aborted && downloadId !== undefined)
        await browser.downloads.cancel(downloadId).catch(() => undefined);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw exportDownloadFailure(error);
    } finally {
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    }
  }

  async cleanup(packageId: string): Promise<void> {
    await (await exportDirectory()).removeEntry(temporaryName(packageId)).catch(() => undefined);
  }
}

import { browser } from "wxt/browser";
import { readySodium } from "../../crypto/sodium";
import { deriveMhtml, validatePageSnapshot } from "../../runtime/page-snapshot";
import { mhtmlDownloadBlob } from "../chrome/mhtml-download";
import { waitForDownload } from "../shared/download-waiter";
import { assertFirefoxObjectUrl, firefoxDownloads } from "./download";

const ARTIFACT_DIRECTORY = "awsm-artifact-downloads";
const SNAPSHOT_DIRECTORY = "awsm-page-snapshots";

function downloadError(cause?: unknown): Error {
  return Object.assign(new Error("MHTML download failed.", { cause }), {
    id: "MHTML_DOWNLOAD_FAILED" as const,
  });
}

async function checksum(blob: Blob): Promise<Uint8Array> {
  const sodium = await readySodium();
  const state = sodium.crypto_hash_sha256_init();
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      sodium.crypto_hash_sha256_update(state, next.value);
    }
    return Uint8Array.from(sodium.crypto_hash_sha256_final(state));
  } finally {
    reader.releaseLock();
  }
}

export class FirefoxMhtmlDownloadHost {
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
    const snapshots = await root.getDirectoryHandle(SNAPSHOT_DIRECTORY, { create: true });
    const artifacts = await root.getDirectoryHandle(ARTIFACT_DIRECTORY, { create: true });
    const snapshotHandle = await snapshots.getFileHandle(input.snapshotTemporaryName, {
      create: true,
    });
    const snapshotWritable = await snapshotHandle.createWritable({ keepExistingData: false });
    let objectUrl: string | undefined;
    let downloadId: number | undefined;
    try {
      await input.stream.pipeTo(snapshotWritable, { signal });
      const snapshot = await snapshotHandle.getFile();
      const validated = await validatePageSnapshot(snapshot);
      const mhtmlHandle = await artifacts.getFileHandle(input.mhtmlTemporaryName, {
        create: true,
      });
      const mhtmlWritable = await mhtmlHandle.createWritable({ keepExistingData: false });
      await deriveMhtml(validated, await checksum(snapshot), mhtmlWritable);
      objectUrl = assertFirefoxObjectUrl(
        URL.createObjectURL(mhtmlDownloadBlob(await mhtmlHandle.getFile())),
      );
      downloadId = await browser.downloads.download({
        url: objectUrl,
        filename: input.filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      await waitForDownload(firefoxDownloads, downloadId, signal);
    } catch (error) {
      if (signal.aborted && downloadId !== undefined)
        await browser.downloads.cancel(downloadId).catch(() => undefined);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw downloadError(error);
    } finally {
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
      await snapshots.removeEntry(input.snapshotTemporaryName).catch(() => undefined);
      await artifacts.removeEntry(input.mhtmlTemporaryName).catch(() => undefined);
    }
  }

  async cleanupOrphans(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    for (const name of [ARTIFACT_DIRECTORY, SNAPSHOT_DIRECTORY]) {
      const directory = await root.getDirectoryHandle(name, { create: true });
      for await (const entry of directory.keys())
        await directory.removeEntry(entry).catch(() => undefined);
    }
  }
}

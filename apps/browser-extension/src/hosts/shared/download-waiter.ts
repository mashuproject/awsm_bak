export interface DownloadDelta {
  readonly id: number;
  readonly state?: string;
  readonly error?: string;
}

export type DownloadListener = (delta: DownloadDelta) => void;

export interface DownloadsAdapter {
  search(
    downloadId: number,
  ): Promise<readonly { readonly state?: string; readonly error?: string }[]>;
  addChangedListener(listener: DownloadListener): void;
  removeChangedListener(listener: DownloadListener): void;
}

export function exportDownloadFailure(cause?: unknown): Error {
  return Object.assign(new Error("Vault Package download failed.", { cause }), {
    id: "EXPORT_DOWNLOAD_FAILED",
  });
}

export async function waitForDownload(
  downloads: DownloadsAdapter,
  downloadId: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: "complete" | "failed" | "aborted", cause?: unknown): void => {
      if (settled) return;
      settled = true;
      downloads.removeChangedListener(changed);
      signal.removeEventListener("abort", aborted);
      if (outcome === "complete") resolve();
      else if (outcome === "aborted")
        reject(new DOMException("Export download cancelled.", "AbortError"));
      else reject(exportDownloadFailure(cause));
    };
    const aborted = (): void => finish("aborted");
    const changed: DownloadListener = (delta): void => {
      if (delta.id !== downloadId) return;
      if (delta.state === "complete") finish("complete");
      else if (delta.state === "interrupted" || delta.error !== undefined)
        finish("failed", delta.error);
    };
    downloads.addChangedListener(changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    void downloads.search(downloadId).then(
      (items) => {
        const current = items[0];
        if (current === undefined) finish("failed");
        else if (current.state === "complete") finish("complete");
        else if (current.state === "interrupted" || current.error !== undefined)
          finish("failed", current.error);
      },
      (error: unknown) => finish("failed", error),
    );
  });
}

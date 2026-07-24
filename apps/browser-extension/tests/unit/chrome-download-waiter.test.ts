import { describe, expect, it, vi } from "vitest";
import {
  type DownloadDelta,
  type DownloadListener,
  type DownloadsAdapter,
  waitForDownload,
} from "../../src/hosts/shared/download-waiter";

function fixture(searchResult: readonly { readonly state?: string; readonly error?: string }[]) {
  const listeners = new Set<DownloadListener>();
  const adapter: DownloadsAdapter = {
    search: vi.fn(async () => searchResult),
    addChangedListener: (listener) => listeners.add(listener),
    removeChangedListener: (listener) => listeners.delete(listener),
  };
  return {
    adapter,
    listenerCount: () => listeners.size,
    emit: (delta: DownloadDelta) => {
      for (const listener of listeners) listener(delta);
    },
  };
}

describe("Chrome download completion waiting", () => {
  it("observes a download that completed before the listener was attached", async () => {
    const value = fixture([{ state: "complete" }]);

    await waitForDownload(value.adapter, 41, new AbortController().signal);

    expect(value.adapter.search).toHaveBeenCalledWith(41);
    expect(value.listenerCount()).toBe(0);
  });

  it("waits for a later completion event and removes its listener", async () => {
    const value = fixture([{ state: "in_progress" }]);
    const waiting = waitForDownload(value.adapter, 42, new AbortController().signal);
    await Promise.resolve();

    value.emit({ id: 42, state: "complete" });

    await waiting;
    expect(value.listenerCount()).toBe(0);
  });

  it.each([
    { name: "interrupted search state", result: [{ state: "interrupted" }] },
    { name: "missing search result", result: [] },
  ])("maps $name to EXPORT_DOWNLOAD_FAILED", async ({ result }) => {
    const value = fixture(result);

    await expect(
      waitForDownload(value.adapter, 43, new AbortController().signal),
    ).rejects.toMatchObject({ id: "EXPORT_DOWNLOAD_FAILED" });
    expect(value.listenerCount()).toBe(0);
  });

  it("maps an interruption event to EXPORT_DOWNLOAD_FAILED", async () => {
    const value = fixture([{ state: "in_progress" }]);
    const waiting = waitForDownload(value.adapter, 44, new AbortController().signal);
    await Promise.resolve();

    value.emit({ id: 44, error: "NETWORK_FAILED" });

    await expect(waiting).rejects.toMatchObject({ id: "EXPORT_DOWNLOAD_FAILED" });
    expect(value.listenerCount()).toBe(0);
  });

  it("maps a search rejection and cleans up", async () => {
    const value = fixture([]);
    vi.mocked(value.adapter.search).mockRejectedValue(new Error("downloads unavailable"));

    await expect(
      waitForDownload(value.adapter, 45, new AbortController().signal),
    ).rejects.toMatchObject({ id: "EXPORT_DOWNLOAD_FAILED" });
    expect(value.listenerCount()).toBe(0);
  });

  it("rejects AbortError and ignores a later completion", async () => {
    const value = fixture([{ state: "in_progress" }]);
    const controller = new AbortController();
    const waiting = waitForDownload(value.adapter, 46, controller.signal);
    await Promise.resolve();

    controller.abort();
    value.emit({ id: 46, state: "complete" });

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(value.listenerCount()).toBe(0);
  });
});

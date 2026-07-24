interface CollectorResult {
  html: string;
  inputValue: string;
  textareaValue: string;
  selectValue: string;
  checked: boolean;
  sameOriginStatus: number;
  sameOriginBody: string;
  crossOriginBodyAcquired: boolean;
}

interface GateReport {
  completedAt: string;
  extensionId: string;
  startupCount: number;
  assertions: Record<string, boolean>;
  collector: CollectorResult;
  sameOriginBody: string;
  downloadFilename: string;
  error?: string;
}

const REPORT_DATABASE = "awsm-firefox-feasibility";
const REPORT_STORE = "report";
const REPORT_KEY = "latest";
const STARTUP_KEY = "startup-count";
const ZIP_FILE = "streaming-gate.zip";
const DOWNLOAD_FILE = "download-gate.txt";
const FAILURE_FILE = "failure-cleanup.tmp";
const DOWNLOAD_NAME = "awsm-firefox-feasibility.txt";
const LARGE_ZIP_FILE = "bounded-memory-gate.zip";
const LARGE_SOURCE_BYTES = 144 * 1024 * 1024;

let startupReady = Promise.resolve(0);

function openReportDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REPORT_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(REPORT_STORE);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open gate database."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openReportDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(REPORT_STORE, mode);
      const request = operation(transaction.objectStore(REPORT_STORE));
      request.onerror = () => reject(request.error ?? new Error("Gate database request failed."));
      request.onsuccess = () => resolve(request.result);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Gate database transaction failed."));
    });
  } finally {
    database.close();
  }
}

async function getReportValue<T>(key: string): Promise<T | undefined> {
  return transact<T | undefined>("readonly", (store) => store.get(key));
}

async function setReportValue(key: string, value: unknown): Promise<void> {
  await transact<IDBValidKey>("readwrite", (store) => store.put(value, key));
}

async function incrementStartupCount(): Promise<number> {
  const count = (await getReportValue<number>(STARTUP_KEY)) ?? 0;
  const next = count + 1;
  await setReportValue(STARTUP_KEY, next);
  return next;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function removeIfPresent(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await root.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
}

async function streamZipToOpfs(name: string, sourceBytes: number): Promise<number> {
  const worker = new Worker(new URL("../zip-worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<number>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ size?: number; error?: string }>) => {
        if (event.data.error) reject(new Error(event.data.error));
        else if (event.data.size !== undefined) resolve(event.data.size);
        else reject(new Error("The ZIP worker returned no size."));
      };
      worker.onerror = (event) => reject(new Error(event.message || "The ZIP worker failed."));
      worker.postMessage({ name, sourceBytes });
    });
  } finally {
    worker.terminate();
  }
}

async function proveOpfsZip(root: FileSystemDirectoryHandle): Promise<boolean> {
  await removeIfPresent(root, ZIP_FILE);
  const size = await streamZipToOpfs(ZIP_FILE, 2 * 1024 * 1024);
  const handle = await root.getFileHandle(ZIP_FILE);
  const file = await handle.getFile();
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const valid = size > 2 * 1024 * 1024 && signature.join(",") === "80,75,3,4";
  await root.removeEntry(ZIP_FILE);
  return valid;
}

async function runBoundedMemoryProof(sourceBytes = LARGE_SOURCE_BYTES): Promise<{
  sourceBytes: number;
  archiveBytes: number;
  cleaned: boolean;
}> {
  const root = await opfsRoot();
  await removeIfPresent(root, LARGE_ZIP_FILE);
  try {
    const archiveBytes = await streamZipToOpfs(LARGE_ZIP_FILE, sourceBytes);
    return {
      sourceBytes,
      archiveBytes,
      cleaned: true,
    };
  } finally {
    await removeIfPresent(root, LARGE_ZIP_FILE);
  }
}

async function proveScreenshotStitching(tab: Browser.tabs.Tab): Promise<boolean> {
  if (tab.windowId === undefined) throw new Error("The active tab has no window.");
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(source.width, source.height * 2);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not create an OffscreenCanvas context.");
      context.drawImage(source, 0, 0);
      context.drawImage(source, 0, source.height);
      return (await canvas.convertToBlob({ type: "image/png" })).size > 0;
    }

    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height * 2;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a document canvas context.");
    context.drawImage(source, 0, 0);
    context.drawImage(source, 0, source.height);
    return await new Promise<boolean>((resolve) => {
      canvas.toBlob((blob) => resolve((blob?.size ?? 0) > 0), "image/png");
    });
  } finally {
    source.close();
  }
}

async function waitForDownload(downloadId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.downloads.onChanged.removeListener(listener);
      reject(new Error("Timed out waiting for the feasibility download."));
    }, 15_000);
    const listener: Parameters<typeof browser.downloads.onChanged.addListener>[0] = (delta) => {
      if (delta.id !== downloadId || delta.state?.current === undefined) return;
      if (delta.state.current === "complete") {
        clearTimeout(timeout);
        browser.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === "interrupted") {
        clearTimeout(timeout);
        browser.downloads.onChanged.removeListener(listener);
        reject(new Error(`Feasibility download interrupted: ${delta.error?.current ?? "unknown"}`));
      }
    };
    browser.downloads.onChanged.addListener(listener);
  });
}

async function proveDownload(root: FileSystemDirectoryHandle): Promise<boolean> {
  await removeIfPresent(root, DOWNLOAD_FILE);
  const handle = await root.getFileHandle(DOWNLOAD_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new TextEncoder().encode("AWSM Firefox feasibility download\n"));
  await writable.close();
  const file = await handle.getFile();
  const url = URL.createObjectURL(file);
  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: DOWNLOAD_NAME,
      saveAs: false,
    });
    await waitForDownload(downloadId);
    const [download] = await browser.downloads.search({ id: downloadId });
    return download?.state === "complete" && download.filename.endsWith(DOWNLOAD_NAME);
  } finally {
    URL.revokeObjectURL(url);
    await removeIfPresent(root, DOWNLOAD_FILE);
  }
}

async function proveFailureCleanup(root: FileSystemDirectoryHandle): Promise<boolean> {
  await removeIfPresent(root, FAILURE_FILE);
  const handle = await root.getFileHandle(FAILURE_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write("temporary plaintext");
  await writable.close();
  const url = URL.createObjectURL(await handle.getFile());
  try {
    throw new Error("simulated failure");
  } catch {
    return true;
  } finally {
    URL.revokeObjectURL(url);
    await root.removeEntry(FAILURE_FILE);
  }
}

async function collect(tabId: number): Promise<CollectorResult> {
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => ({
      html: document.documentElement.outerHTML,
      inputValue: (document.querySelector("#live-input") as HTMLInputElement | null)?.value ?? "",
      textareaValue:
        (document.querySelector("#live-textarea") as HTMLTextAreaElement | null)?.value ?? "",
      selectValue:
        (document.querySelector("#live-select") as HTMLSelectElement | null)?.value ?? "",
      checked: (document.querySelector("#live-check") as HTMLInputElement | null)?.checked ?? false,
      sameOriginStatus: 0,
      sameOriginBody: "",
      crossOriginBodyAcquired: false,
    }),
  });
  if (!result?.result) throw new Error("The isolated-world collector returned no result.");
  return result.result as CollectorResult;
}

async function acquireSameOrigin(
  tabId: number,
  url: string,
): Promise<{
  status: number;
  body: string;
}> {
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url],
    func: async (allowedUrl: string) => {
      if (new URL(allowedUrl).origin !== location.origin) {
        throw new Error("The acquisition URL is outside the frozen top origin.");
      }
      const response = await fetch(allowedUrl, { credentials: "include" });
      return { status: response.status, body: await response.text() };
    },
  });
  if (!result?.result) throw new Error("The same-origin acquisition returned no result.");
  return result.result;
}

async function runGate(tab: Browser.tabs.Tab): Promise<void> {
  const startupCount = (await getReportValue<number>(STARTUP_KEY)) ?? 1;
  let stage = "preflight";
  try {
    if (tab.id === undefined || !tab.url)
      throw new Error("The action did not provide an HTTP tab.");
    const pageUrl = new URL(tab.url);
    const crossOriginUrl = pageUrl.searchParams.get("crossOrigin");
    if (!crossOriginUrl) throw new Error("The fixture did not provide its cross-origin URL.");

    stage = "isolated collector";
    const collector = await collect(tab.id);
    stage = "same-origin authenticated GET";
    const sameOrigin = await acquireSameOrigin(tab.id, new URL("/authenticated", pageUrl).href);
    collector.sameOriginStatus = sameOrigin.status;
    collector.sameOriginBody = sameOrigin.body;
    const sameOriginBody = sameOrigin.body;
    const crossOriginBlocked = new URL(crossOriginUrl).origin !== pageUrl.origin;

    stage = "OPFS";
    const root = await opfsRoot();
    stage = "ZIP64 stream";
    const zipStreamed = await proveOpfsZip(root);
    stage = "screenshot stitching";
    const screenshotStitched = await proveScreenshotStitching(tab);
    stage = "download";
    const downloadObserved = await proveDownload(root);
    stage = "failure cleanup";
    const failureCleanup = await proveFailureCleanup(root);

    const report: GateReport = {
      completedAt: new Date().toISOString(),
      extensionId: browser.runtime.id,
      startupCount,
      assertions: {
        collectorRenderedDom: collector.html.includes("rendered-after-load"),
        collectorLiveFormState:
          collector.inputValue === "live input" &&
          collector.textareaValue === "live textarea" &&
          collector.selectValue === "second" &&
          collector.checked,
        sameOriginAuthenticatedGet:
          collector.sameOriginStatus === 200 && sameOriginBody === "authenticated fixture",
        crossOriginBlocked,
        opfsAvailable: true,
        zipStreamed,
        screenshotStitched,
        downloadObserved,
        successCleanup: !(await root
          .getFileHandle(DOWNLOAD_FILE)
          .then(() => true)
          .catch(() => false)),
        failureCleanup,
      },
      collector,
      sameOriginBody,
      downloadFilename: DOWNLOAD_NAME,
    };
    await setReportValue(REPORT_KEY, report);
  } catch (error) {
    const report: GateReport = {
      completedAt: new Date().toISOString(),
      extensionId: browser.runtime.id,
      startupCount,
      assertions: {},
      collector: {
        html: "",
        inputValue: "",
        textareaValue: "",
        selectValue: "",
        checked: false,
        sameOriginStatus: 0,
        sameOriginBody: "",
        crossOriginBodyAcquired: false,
      },
      sameOriginBody: "",
      downloadFilename: DOWNLOAD_NAME,
      error:
        error instanceof Error
          ? `${stage}: ${error.name}: ${error.message}\n${error.stack ?? ""}`
          : `${stage}: ${String(error)}`,
    };
    await setReportValue(REPORT_KEY, report);
  }
  const reportUrl = (browser.runtime.getURL as (path: string) => string)("report.html");
  await browser.tabs.create({ url: reportUrl });
}

export default defineBackground(() => {
  startupReady = incrementStartupCount();
  browser.action.onClicked.addListener((tab) => {
    void runGate(tab);
  });
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "awsm:get-firefox-feasibility-report"
    ) {
      return Promise.all([getReportValue<GateReport>(REPORT_KEY), startupReady]).then(
        ([report, startupCount]) => (report ? { ...report, startupCount } : undefined),
      );
    }
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "awsm:run-firefox-bounded-memory-proof"
    ) {
      const requestedBytes =
        "sourceBytes" in message && message.sourceBytes === 2 * 1024 * 1024
          ? message.sourceBytes
          : LARGE_SOURCE_BYTES;
      return runBoundedMemoryProof(requestedBytes);
    }
    return undefined;
  });
});

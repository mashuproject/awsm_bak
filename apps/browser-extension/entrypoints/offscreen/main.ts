import { type Browser, browser } from "wxt/browser";
import { readySodium } from "../../src/crypto/sodium";
import { mhtmlDownloadBlob } from "../../src/hosts/chrome/mhtml-download";
import type { ScreenshotPlan, ScreenshotTile } from "../../src/hosts/shared/screenshot";
import { deriveMhtml, validatePageSnapshot } from "../../src/runtime/page-snapshot";

const SCREENSHOT_WEBP_QUALITY = 0.72;
const THUMBNAIL_WEBP_QUALITY = 0.78;

interface PrepareExportDownloadRequest {
  readonly type: "awsm:prepare-vault-export-download";
  readonly temporaryName: string;
}

interface ReleaseExportDownloadRequest {
  readonly type: "awsm:release-vault-export-download";
  readonly temporaryName: string;
}

interface MhtmlDownloadRequest {
  readonly type: "awsm:prepare-mhtml-download" | "awsm:release-mhtml-download";
  readonly snapshotTemporaryName?: string;
  readonly mhtmlTemporaryName: string;
}

const activeExportUrls = new Map<string, string>();
const activeMhtmlUrls = new Map<string, string>();

function isPrepareExportDownloadRequest(value: unknown): value is PrepareExportDownloadRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "awsm:prepare-vault-export-download" &&
    "temporaryName" in value &&
    typeof value.temporaryName === "string"
  );
}

async function prepareExportDownload(
  request: PrepareExportDownloadRequest,
): Promise<{ readonly url: string }> {
  if (!/^[0-9a-f-]{36}\.awsm\.tmp$/iu.test(request.temporaryName))
    throw new Error("Invalid temporary Export name.");
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("awsm-vault-exports");
  const handle = await directory.getFileHandle(request.temporaryName);
  const previous = activeExportUrls.get(request.temporaryName);
  if (previous !== undefined) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(await handle.getFile());
  activeExportUrls.set(request.temporaryName, url);
  return { url };
}

function releaseExportDownload(request: ReleaseExportDownloadRequest): true {
  const url = activeExportUrls.get(request.temporaryName);
  if (url !== undefined) URL.revokeObjectURL(url);
  activeExportUrls.delete(request.temporaryName);
  return true;
}

function isMhtmlDownloadRequest(value: unknown): value is MhtmlDownloadRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "awsm:prepare-mhtml-download" ||
      value.type === "awsm:release-mhtml-download") &&
    "mhtmlTemporaryName" in value &&
    typeof value.mhtmlTemporaryName === "string" &&
    (value.type === "awsm:release-mhtml-download" ||
      ("snapshotTemporaryName" in value && typeof value.snapshotTemporaryName === "string"))
  );
}

async function mhtmlDownload(
  request: MhtmlDownloadRequest,
): Promise<{ readonly url: string } | true> {
  if (!/^[0-9a-f-]{36}\.mhtml\.tmp$/iu.test(request.mhtmlTemporaryName))
    throw new Error("Invalid temporary MHTML name.");
  const previous = activeMhtmlUrls.get(request.mhtmlTemporaryName);
  if (request.type === "awsm:release-mhtml-download") {
    if (previous !== undefined) URL.revokeObjectURL(previous);
    activeMhtmlUrls.delete(request.mhtmlTemporaryName);
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("awsm-artifact-downloads", { create: true });
    await directory.removeEntry(request.mhtmlTemporaryName).catch(() => undefined);
    return true;
  }
  if (
    request.snapshotTemporaryName === undefined ||
    !/^[0-9a-f-]{36}\.awsm-page\.tmp$/iu.test(request.snapshotTemporaryName)
  )
    throw new Error("Invalid temporary page snapshot name.");
  const root = await navigator.storage.getDirectory();
  const snapshots = await root.getDirectoryHandle("awsm-page-snapshots");
  const snapshotHandle = await snapshots.getFileHandle(request.snapshotTemporaryName);
  const snapshotBlob = await snapshotHandle.getFile();
  const validated = await validatePageSnapshot(snapshotBlob);
  const sodium = await readySodium();
  const state = sodium.crypto_hash_sha256_init();
  const reader = snapshotBlob.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      sodium.crypto_hash_sha256_update(state, next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const checksum = Uint8Array.from(sodium.crypto_hash_sha256_final(state));
  const directory = await root.getDirectoryHandle("awsm-artifact-downloads", { create: true });
  const handle = await directory.getFileHandle(request.mhtmlTemporaryName, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  await deriveMhtml(validated, checksum, writable);
  if (previous !== undefined) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(mhtmlDownloadBlob(await handle.getFile()));
  activeMhtmlUrls.set(request.mhtmlTemporaryName, url);
  return { url };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function thumbnailBlob(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Blob> {
  const width = 640;
  const height = 360;
  const targetRatio = width / height;
  const sourceRatio = sourceWidth / sourceHeight;
  const cropWidth = sourceRatio > targetRatio ? sourceHeight * targetRatio : sourceWidth;
  const cropHeight = sourceRatio > targetRatio ? sourceHeight : sourceWidth / targetRatio;
  const sourceX = Math.max(0, (sourceWidth - cropWidth) / 2);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("A thumbnail canvas is unavailable.");
  context.drawImage(source, sourceX, 0, cropWidth, cropHeight, 0, 0, width, height);
  return canvas.convertToBlob({ type: "image/webp", quality: THUMBNAIL_WEBP_QUALITY });
}

function attachScreenshotPort(port: Browser.runtime.Port): void {
  if (!port.name.startsWith("awsm:screenshot:")) return;
  let canvas: OffscreenCanvas | undefined;
  let context: OffscreenCanvasRenderingContext2D | undefined;
  let geometry: ScreenshotTile | undefined;
  let tileParts: ArrayBuffer[] = [];
  let outputSequence = 0;
  let queue = Promise.resolve();
  const sendOutput = (value: Record<string, unknown>): Promise<void> => {
    outputSequence += 1;
    const outputId = outputSequence;
    return new Promise((resolve, reject) => {
      const disconnected = (): void => reject(new Error("Screenshot consumer disconnected."));
      const acknowledged = (message: unknown): void => {
        if (
          typeof message === "object" &&
          message !== null &&
          "outputAcknowledged" in message &&
          message.outputAcknowledged === outputId
        ) {
          port.onMessage.removeListener(acknowledged);
          port.onDisconnect.removeListener(disconnected);
          resolve();
        }
      };
      port.onMessage.addListener(acknowledged);
      port.onDisconnect.addListener(disconnected);
      port.postMessage({ ...value, outputId });
    });
  };
  const streamBlob = async (kind: "Full" | "Thumbnail", blob: Blob): Promise<void> => {
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        await sendOutput({ kind, chunkBase64: bytesToBase64(next.value) });
      }
    } finally {
      reader.releaseLock();
    }
  };
  port.onMessage.addListener((message: unknown) => {
    queue = queue.then(async () => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("operation" in message) ||
        !("sequence" in message) ||
        typeof message.sequence !== "number"
      )
        throw new Error("Invalid screenshot operation.");
      if (message.operation === "Start" && "plan" in message) {
        const plan = message.plan as ScreenshotPlan;
        canvas = new OffscreenCanvas(plan.outputWidth, plan.outputHeight);
        context = canvas.getContext("2d") ?? undefined;
        if (context === undefined) throw new Error("A 2D canvas is unavailable.");
      } else if (message.operation === "TileStart" && "geometry" in message) {
        geometry = message.geometry as ScreenshotTile;
        tileParts = [];
      } else if (
        message.operation === "TileChunk" &&
        "chunkBase64" in message &&
        typeof message.chunkBase64 === "string"
      ) {
        tileParts.push(Uint8Array.from(base64ToBytes(message.chunkBase64)).buffer);
      } else if (message.operation === "TileEnd") {
        if (context === undefined || geometry === undefined) throw new Error("Tile state missing.");
        const bitmap = await createImageBitmap(new Blob(tileParts, { type: "image/png" }));
        try {
          context.drawImage(
            bitmap,
            geometry.sourcePixelX,
            geometry.sourcePixelY,
            geometry.pixelWidth,
            geometry.pixelHeight,
            geometry.pixelX,
            geometry.pixelY,
            geometry.pixelWidth,
            geometry.pixelHeight,
          );
        } finally {
          bitmap.close();
          tileParts = [];
          geometry = undefined;
        }
      } else if (message.operation === "Finish") {
        if (canvas === undefined) throw new Error("Screenshot canvas missing.");
        const full = await canvas.convertToBlob({
          type: "image/webp",
          quality: SCREENSHOT_WEBP_QUALITY,
        });
        const thumbnail = await thumbnailBlob(canvas, canvas.width, canvas.height);
        await streamBlob("Full", full);
        await streamBlob("Thumbnail", thumbnail);
        await sendOutput({ done: true });
      } else throw new Error("Unsupported screenshot operation.");
      port.postMessage({ acknowledged: message.sequence });
    });
    void queue.catch(() => port.disconnect());
  });
}

browser.runtime.onConnect.addListener(attachScreenshotPort);

browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const operation = isMhtmlDownloadRequest(message)
    ? mhtmlDownload(message)
    : isPrepareExportDownloadRequest(message)
      ? prepareExportDownload(message)
      : typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "awsm:release-vault-export-download" &&
          "temporaryName" in message &&
          typeof message.temporaryName === "string"
        ? Promise.resolve(releaseExportDownload(message as ReleaseExportDownloadRequest))
        : undefined;
  if (operation === undefined) return undefined;
  void operation.then(sendResponse, () => sendResponse({ error: true }));
  return true;
});

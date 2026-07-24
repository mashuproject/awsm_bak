import type { CaptureWarningId } from "../../domain/contracts";

const MAX_CANVAS_DIMENSION = 16_384;
const MIN_CAPTURE_INTERVAL_MS = 600;
const SCREENSHOT_HOST_OPERATION_TIMEOUT_MS = 15_000;

export interface PageDimensions {
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
}

export interface ScreenshotTile {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly pixelX: number;
  readonly pixelY: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly sourcePixelX: number;
  readonly sourcePixelY: number;
}

export interface ScreenshotPlan {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly truncated: boolean;
  readonly tiles: readonly ScreenshotTile[];
}

export interface CapturedTile {
  readonly geometry: ScreenshotTile;
  readonly imageBytes: Uint8Array;
}

export interface ScreenshotHost {
  measure(): Promise<PageDimensions>;
  prepareTile(tile: ScreenshotTile, hideRepeatedFixedElements: boolean): Promise<void>;
  captureVisible(): Promise<Uint8Array>;
  stitch(plan: ScreenshotPlan, tiles: readonly CapturedTile[]): Promise<StitchedScreenshot>;
  restore(): Promise<void>;
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

export interface ScreenshotResult {
  readonly webpBlob?: Blob;
  readonly thumbnailWebpBlob?: Blob;
  readonly warnings: readonly CaptureWarningId[];
}

export interface StitchedScreenshot {
  readonly webpBlob: Blob;
  readonly thumbnailWebpBlob?: Blob;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function computeTilePlan(dimensions: PageDimensions): ScreenshotPlan {
  const values = [
    dimensions.documentWidth,
    dimensions.documentHeight,
    dimensions.viewportWidth,
    dimensions.viewportHeight,
    dimensions.devicePixelRatio,
  ];
  if (!values.every(positiveFinite)) throw new Error("invalid screenshot dimensions");

  const fullWidth = Math.round(dimensions.documentWidth * dimensions.devicePixelRatio);
  const fullHeight = Math.round(dimensions.documentHeight * dimensions.devicePixelRatio);
  const outputWidth = Math.min(fullWidth, MAX_CANVAS_DIMENSION);
  const outputHeight = Math.min(fullHeight, MAX_CANVAS_DIMENSION);
  const truncated = outputWidth < fullWidth || outputHeight < fullHeight;

  const tiles: ScreenshotTile[] = [];
  for (let y = 0; y < dimensions.documentHeight; y += dimensions.viewportHeight) {
    for (let x = 0; x < dimensions.documentWidth; x += dimensions.viewportWidth) {
      const pixelX = Math.round(x * dimensions.devicePixelRatio);
      const pixelY = Math.round(y * dimensions.devicePixelRatio);
      if (pixelX >= outputWidth || pixelY >= outputHeight) continue;
      const width = Math.min(dimensions.viewportWidth, dimensions.documentWidth - x);
      const height = Math.min(dimensions.viewportHeight, dimensions.documentHeight - y);
      const pixelRight = Math.min(
        outputWidth,
        Math.round((x + width) * dimensions.devicePixelRatio),
      );
      const pixelBottom = Math.min(
        outputHeight,
        Math.round((y + height) * dimensions.devicePixelRatio),
      );
      const scrollX = Math.min(x, Math.max(0, dimensions.documentWidth - dimensions.viewportWidth));
      const scrollY = Math.min(
        y,
        Math.max(0, dimensions.documentHeight - dimensions.viewportHeight),
      );
      tiles.push({
        index: tiles.length,
        x,
        y,
        width,
        height,
        scrollX,
        scrollY,
        pixelX,
        pixelY,
        pixelWidth: pixelRight - pixelX,
        pixelHeight: pixelBottom - pixelY,
        sourcePixelX: Math.round((x - scrollX) * dimensions.devicePixelRatio),
        sourcePixelY: Math.round((y - scrollY) * dimensions.devicePixelRatio),
      });
    }
  }
  return { outputWidth, outputHeight, truncated, tiles };
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Screenshot Host operation timed out.")),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timeout);
        reject(cause);
      },
    );
  });
}

export async function acquireBestEffortScreenshot(
  host: ScreenshotHost,
  operationTimeoutMs = SCREENSHOT_HOST_OPERATION_TIMEOUT_MS,
): Promise<ScreenshotResult> {
  let stage: "measure" | "prepare" | "capture" | "stitch" = "measure";
  try {
    const plan = computeTilePlan(await bounded(host.measure(), operationTimeoutMs));
    stage = "capture";
    const captured: CapturedTile[] = [];
    let previousCaptureAt = 0;
    for (const tile of plan.tiles) {
      stage = "prepare";
      await bounded(host.prepareTile(tile, tile.index > 0), operationTimeoutMs);
      if (captured.length > 0) {
        const remaining = MIN_CAPTURE_INTERVAL_MS - (host.now() - previousCaptureAt);
        if (remaining > 0) await host.wait(remaining);
      }
      stage = "capture";
      const imageBytes = await bounded(host.captureVisible(), operationTimeoutMs);
      previousCaptureAt = host.now();
      captured.push({ geometry: tile, imageBytes });
    }
    stage = "stitch";
    const stitched = await bounded(host.stitch(plan, captured), operationTimeoutMs);
    if (stitched.webpBlob.size === 0) throw new Error("empty screenshot");
    return { ...stitched, warnings: plan.truncated ? ["SCREENSHOT_TRUNCATED"] : [] };
  } catch {
    return {
      warnings: [stage === "measure" ? "SCREENSHOT_UNAVAILABLE" : "SCREENSHOT_CAPTURE_FAILED"],
    };
  } finally {
    try {
      await bounded(host.restore(), operationTimeoutMs);
    } catch {
      // Restoration is deliberately attempted after every path. Its failure cannot expose partial bytes.
    }
  }
}

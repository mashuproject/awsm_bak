import { browser } from "wxt/browser";
import { ChromeCaptureHost } from "../chrome/api";
import type {
  CapturedTile,
  PageDimensions,
  ScreenshotHost,
  ScreenshotPlan,
  ScreenshotTile,
  StitchedScreenshot,
} from "../shared/screenshot";

interface MeasuredPage extends PageDimensions {
  readonly scrollX: number;
  readonly scrollY: number;
}

function firstResult<T>(results: readonly { readonly result?: T }[]): T {
  const result = results[0]?.result;
  if (result === undefined) throw new Error("The active page did not return screenshot geometry.");
  return result;
}

async function canvasBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/webp", quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Canvas encoding failed.")) : resolve(blob)),
      "image/webp",
      quality,
    ),
  );
}

function createCanvas(
  width: number,
  height: number,
): {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("A Firefox screenshot canvas is unavailable.");
    return { canvas, context };
  }
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("A Firefox screenshot canvas is unavailable.");
  return { canvas, context };
}

export class FirefoxCaptureHost extends ChromeCaptureHost {
  constructor() {
    super("Firefox", navigator.userAgent.match(/Firefox\/([^ ]+)/u)?.[1] ?? "unknown");
  }
}

export class FirefoxScreenshotHost implements ScreenshotHost {
  private originalScroll = { x: 0, y: 0 };

  private constructor(
    readonly tabId: number,
    readonly windowId: number,
  ) {}

  static async create(tabId: number): Promise<FirefoxScreenshotHost> {
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId === undefined) throw new Error("The capture tab has no window.");
    return new FirefoxScreenshotHost(tabId, tab.windowId);
  }

  async measure(): Promise<PageDimensions> {
    const measured = firstResult(
      await browser.scripting.executeScript({
        target: { tabId: this.tabId },
        func: (): MeasuredPage => {
          const root = document.documentElement;
          const body = document.body;
          return {
            documentWidth: Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0),
            documentHeight: Math.max(root.scrollHeight, root.clientHeight, body?.scrollHeight ?? 0),
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
          };
        },
      }),
    );
    this.originalScroll = { x: measured.scrollX, y: measured.scrollY };
    return measured;
  }

  async prepareTile(tile: ScreenshotTile, hideRepeatedFixedElements: boolean): Promise<void> {
    await browser.scripting.executeScript({
      target: { tabId: this.tabId },
      args: [tile.scrollX, tile.scrollY, hideRepeatedFixedElements],
      func: async (x: number, y: number, hideFixed: boolean): Promise<void> => {
        const marker = "data-awsm-capture-hidden-v1";
        const original = "data-awsm-capture-visibility-v1";
        for (const element of document.querySelectorAll<HTMLElement>(`[${marker}]`)) {
          element.style.visibility = element.getAttribute(original) ?? "";
          element.removeAttribute(marker);
          element.removeAttribute(original);
        }
        window.scrollTo(x, y);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (!hideFixed) return;
        for (const element of document.querySelectorAll<HTMLElement>("body *")) {
          const position = getComputedStyle(element).position;
          if (position === "fixed" || position === "sticky") {
            element.setAttribute(original, element.style.visibility);
            element.setAttribute(marker, "");
            element.style.visibility = "hidden";
          }
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      },
    });
  }

  async captureVisible(): Promise<Uint8Array> {
    const dataUrl = await browser.tabs.captureVisibleTab(this.windowId, { format: "png" });
    return new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  }

  async stitch(plan: ScreenshotPlan, tiles: readonly CapturedTile[]): Promise<StitchedScreenshot> {
    const { canvas, context } = createCanvas(plan.outputWidth, plan.outputHeight);
    for (const tile of tiles) {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(tile.imageBytes).buffer], { type: "image/png" }),
      );
      try {
        context.drawImage(
          bitmap,
          tile.geometry.sourcePixelX,
          tile.geometry.sourcePixelY,
          tile.geometry.pixelWidth,
          tile.geometry.pixelHeight,
          tile.geometry.pixelX,
          tile.geometry.pixelY,
          tile.geometry.pixelWidth,
          tile.geometry.pixelHeight,
        );
      } finally {
        bitmap.close();
      }
    }
    const thumbnailWidth = 640;
    const thumbnailHeight = 360;
    const sourceRatio = plan.outputWidth / plan.outputHeight;
    const targetRatio = thumbnailWidth / thumbnailHeight;
    const cropWidth =
      sourceRatio > targetRatio ? plan.outputHeight * targetRatio : plan.outputWidth;
    const cropHeight =
      sourceRatio > targetRatio ? plan.outputHeight : plan.outputWidth / targetRatio;
    const sourceX = Math.max(0, (plan.outputWidth - cropWidth) / 2);
    const thumbnail = createCanvas(thumbnailWidth, thumbnailHeight);
    thumbnail.context.drawImage(
      canvas,
      sourceX,
      0,
      cropWidth,
      cropHeight,
      0,
      0,
      thumbnailWidth,
      thumbnailHeight,
    );
    return {
      webpBlob: await canvasBlob(canvas, 0.72),
      thumbnailWebpBlob: await canvasBlob(thumbnail.canvas, 0.78),
    };
  }

  async restore(): Promise<void> {
    await browser.scripting.executeScript({
      target: { tabId: this.tabId },
      args: [this.originalScroll.x, this.originalScroll.y],
      func: (x: number, y: number): void => {
        const marker = "data-awsm-capture-hidden-v1";
        const original = "data-awsm-capture-visibility-v1";
        for (const element of document.querySelectorAll<HTMLElement>(`[${marker}]`)) {
          element.style.visibility = element.getAttribute(original) ?? "";
          element.removeAttribute(marker);
          element.removeAttribute(original);
        }
        window.scrollTo(x, y);
      },
    });
  }

  now(): number {
    return Date.now();
  }

  wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

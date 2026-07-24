import { describe, expect, it, vi } from "vitest";
import {
  acquireBestEffortScreenshot,
  computeTilePlan,
  type ScreenshotHost,
} from "../../src/hosts/shared/screenshot";

describe("full-page screenshot geometry", () => {
  it("uses one tile for one viewport", () => {
    expect(
      computeTilePlan({
        documentWidth: 800,
        documentHeight: 600,
        viewportWidth: 800,
        viewportHeight: 600,
        devicePixelRatio: 1,
      }),
    ).toMatchObject({
      outputWidth: 800,
      outputHeight: 600,
      tiles: [
        {
          index: 0,
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          pixelX: 0,
          pixelY: 0,
          pixelWidth: 800,
          pixelHeight: 600,
          scrollX: 0,
          scrollY: 0,
          sourcePixelX: 0,
          sourcePixelY: 0,
        },
      ],
    });
  });

  it("covers multiple viewports and clips final partial tiles", () => {
    const plan = computeTilePlan({
      documentWidth: 900,
      documentHeight: 1300,
      viewportWidth: 800,
      viewportHeight: 600,
      devicePixelRatio: 1,
    });
    expect(plan.tiles).toHaveLength(6);
    expect(plan.tiles.at(-1)).toMatchObject({
      x: 800,
      y: 1200,
      width: 100,
      height: 100,
      scrollX: 100,
      scrollY: 700,
      sourcePixelX: 700,
      sourcePixelY: 500,
    });
    expect(plan).toMatchObject({ outputWidth: 900, outputHeight: 1300 });
  });

  it("uses stable physical-pixel boundaries for fractional DPR", () => {
    const plan = computeTilePlan({
      documentWidth: 801,
      documentHeight: 601,
      viewportWidth: 800,
      viewportHeight: 600,
      devicePixelRatio: 1.25,
    });
    expect(plan).toMatchObject({ outputWidth: 1001, outputHeight: 751 });
    expect(plan.tiles.at(-1)).toMatchObject({
      pixelX: 1000,
      pixelY: 750,
      pixelWidth: 1,
      pixelHeight: 1,
    });
  });

  it("truncates oversized dimensions at native resolution", () => {
    const plan = computeTilePlan({
      documentWidth: 20_000,
      documentHeight: 600,
      viewportWidth: 800,
      viewportHeight: 600,
      devicePixelRatio: 1,
    });
    expect(plan).toMatchObject({ outputWidth: 16_384, outputHeight: 600, truncated: true });
    expect(plan.tiles.at(-1)).toMatchObject({ pixelX: 16_000, pixelWidth: 384 });
  });
});

function host(overrides: Partial<ScreenshotHost> = {}): ScreenshotHost {
  let now = 0;
  return {
    measure: vi.fn(async () => ({
      documentWidth: 800,
      documentHeight: 1200,
      viewportWidth: 800,
      viewportHeight: 600,
      devicePixelRatio: 1,
    })),
    prepareTile: vi.fn(async () => undefined),
    captureVisible: vi.fn(async () => new Uint8Array([1, 2, 3])),
    stitch: vi.fn(async () => ({
      webpBlob: new Blob([new Uint8Array([82, 73, 70, 70])]),
      thumbnailWebpBlob: new Blob([new Uint8Array([1, 2, 3])]),
    })),
    restore: vi.fn(async () => undefined),
    now: () => now,
    wait: vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    }),
    ...overrides,
  };
}

describe("best-effort screenshot lifecycle", () => {
  it("mitigates repeated fixed content, throttles captures, stitches, and restores", async () => {
    const fake = host();
    await expect(acquireBestEffortScreenshot(fake)).resolves.toEqual({
      webpBlob: new Blob([new Uint8Array([82, 73, 70, 70])]),
      thumbnailWebpBlob: new Blob([new Uint8Array([1, 2, 3])]),
      warnings: [],
    });
    expect(fake.prepareTile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ index: 0 }),
      false,
    );
    expect(fake.prepareTile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ index: 1 }),
      true,
    );
    expect(fake.wait).toHaveBeenCalledWith(600);
    expect(fake.restore).toHaveBeenCalledOnce();
  });

  it.each(["measure", "prepareTile", "captureVisible", "stitch"] as const)(
    "restores and returns a warning when %s fails",
    async (point) => {
      const fake = host({ [point]: vi.fn(async () => Promise.reject(new Error("page secret"))) });
      await expect(acquireBestEffortScreenshot(fake)).resolves.toEqual({
        warnings: [point === "measure" ? "SCREENSHOT_UNAVAILABLE" : "SCREENSHOT_CAPTURE_FAILED"],
      });
      expect(fake.restore).toHaveBeenCalledOnce();
    },
  );

  it("bounds a Host operation that never settles and still attempts restoration", async () => {
    vi.useFakeTimers();
    try {
      const fake = host({ captureVisible: vi.fn(() => new Promise<Uint8Array>(() => undefined)) });
      const result = acquireBestEffortScreenshot(fake, 25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toEqual({ warnings: ["SCREENSHOT_CAPTURE_FAILED"] });
      expect(fake.restore).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a native-resolution truncated screenshot with a warning", async () => {
    const fake = host({
      measure: vi.fn(async () => ({
        documentWidth: 20_000,
        documentHeight: 600,
        viewportWidth: 800,
        viewportHeight: 600,
        devicePixelRatio: 1,
      })),
    });
    await expect(acquireBestEffortScreenshot(fake)).resolves.toEqual({
      webpBlob: new Blob([new Uint8Array([82, 73, 70, 70])]),
      thumbnailWebpBlob: new Blob([new Uint8Array([1, 2, 3])]),
      warnings: ["SCREENSHOT_TRUNCATED"],
    });
    expect(fake.captureVisible).toHaveBeenCalled();
    expect(fake.restore).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  CanonicalBrowserPageCapture,
  CanonicalBrowserPageCaptureError,
} from "../../src/hosts/shared/canonical-browser-page-capture";
import { validatePageSnapshot } from "../../src/runtime/page-snapshot";

describe("canonical browser page capture", () => {
  it("packages one permitted HTTP page as canonical Capture input without a legacy command", async () => {
    const collectPageSnapshot = vi.fn().mockResolvedValue({
      metadata: {
        finalUrl: "https://example.test/article#conclusion",
        title: "An article",
      },
      documents: [
        {
          originalUrl: "https://example.test/article",
          finalUrl: "https://example.test/article",
          bytes: new TextEncoder().encode("<!doctype html><title>An article</title>"),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
      omissions: [],
    });
    const capture = new CanonicalBrowserPageCapture(
      {
        getActiveTab: vi.fn().mockResolvedValue({
          id: 9,
          url: "https://example.test/article#introduction",
        }),
        getTab: vi.fn(),
        hasCapturePermission: vi.fn().mockResolvedValue(true),
        collectPageSnapshot,
      },
      "0.3.0",
      () => 1_700_000_000_000,
    );

    const captured = await capture.captureActivePage();

    expect(captured).toMatchObject({
      originalUrl: "https://example.test/article",
      finalUrl: "https://example.test/article",
      title: "An article",
      capturedAt: 1_700_000_000_000,
    });
    expect(collectPageSnapshot).toHaveBeenCalledWith(
      9,
      { observedUrl: "https://example.test/article" },
      "2023-11-14T22:13:20.000Z",
      "0.3.0",
    );
    await expect(validatePageSnapshot(captured.primary.blob)).resolves.toMatchObject({
      manifest: {
        capturedAt: 1_700_000_000_000,
        originalUrl: "https://example.test/article",
        finalUrl: "https://example.test/article",
      },
    });
  });

  it("rejects an unsupported page before collection", async () => {
    const collectPageSnapshot = vi.fn();
    const capture = new CanonicalBrowserPageCapture(
      {
        getActiveTab: vi.fn().mockResolvedValue({ id: 9, url: "about:preferences" }),
        getTab: vi.fn(),
        hasCapturePermission: vi.fn(),
        collectPageSnapshot,
      },
      "0.3.0",
    );

    await expect(capture.captureActivePage()).rejects.toEqual(
      new CanonicalBrowserPageCaptureError(
        "UNSUPPORTED_URL",
        "Only active HTTP and HTTPS pages can be captured.",
      ),
    );
    expect(collectPageSnapshot).not.toHaveBeenCalled();
  });

  it("rejects absent capture permission before collection", async () => {
    const collectPageSnapshot = vi.fn();
    const capture = new CanonicalBrowserPageCapture(
      {
        getActiveTab: vi.fn().mockResolvedValue({ id: 9, url: "https://example.test/" }),
        getTab: vi.fn(),
        hasCapturePermission: vi.fn().mockResolvedValue(false),
        collectPageSnapshot,
      },
      "0.3.0",
    );

    await expect(capture.captureActivePage()).rejects.toEqual(
      new CanonicalBrowserPageCaptureError(
        "PERMISSION_DENIED",
        "The browser did not grant capture permission.",
      ),
    );
    expect(collectPageSnapshot).not.toHaveBeenCalled();
  });
});

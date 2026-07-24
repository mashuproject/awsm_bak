import { describe, expect, it, vi } from "vitest";
import {
  type CaptureHost,
  CaptureHostError,
  preflightCapture,
} from "../../src/hosts/chrome/capture";

function host(overrides: Partial<CaptureHost> = {}): CaptureHost {
  return {
    getActiveTab: vi.fn(async () => ({ id: 7, url: "https://example.test/page" })),
    hasCapturePermission: vi.fn(async () => true),
    ...overrides,
  };
}

describe("Chrome capture Host preflight", () => {
  it.each([
    "chrome://settings",
    "chrome-extension://id/page",
    "file:///tmp/a",
    "view-source:https://x.test",
  ])("rejects restricted URL %s before snapshot collection", async (url) => {
    const fake = host({ getActiveTab: vi.fn(async () => ({ id: 7, url })) });
    await expect(preflightCapture(fake, true)).rejects.toMatchObject({ id: "UNSUPPORTED_URL" });
  });

  it("accepts active HTTP and HTTPS tabs", async () => {
    await expect(preflightCapture(host(), true)).resolves.toEqual({
      tabId: 7,
      url: "https://example.test/page",
    });
    await expect(
      preflightCapture(
        host({ getActiveTab: vi.fn(async () => ({ id: 8, url: "http://localhost/" })) }),
        true,
      ),
    ).resolves.toEqual({ tabId: 8, url: "http://localhost/" });
  });

  it("rejects a locked Vault, missing tab ID, and denied permission with typed errors", async () => {
    await expect(preflightCapture(host(), false)).rejects.toMatchObject({ id: "VAULT_LOCKED" });
    await expect(
      preflightCapture(
        host({ getActiveTab: vi.fn(async () => ({ url: "https://example.test" })) }),
        true,
      ),
    ).rejects.toMatchObject({ id: "UNSUPPORTED_URL" });
    await expect(
      preflightCapture(host({ hasCapturePermission: vi.fn(async () => false) }), true),
    ).rejects.toMatchObject({ id: "PERMISSION_DENIED" });
  });

  it("uses a stable typed Host error", () => {
    expect(new CaptureHostError("PAGE_SNAPSHOT_FAILED", "Unavailable")).toMatchObject({
      name: "CaptureHostError",
      id: "PAGE_SNAPSHOT_FAILED",
    });
  });
});

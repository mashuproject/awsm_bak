import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("wxt/browser", () => ({
  browser: { tabs: { query } },
}));

import { getActiveCaptureTabId } from "../../src/hosts/shared/active-tab";

describe("active Capture tab", () => {
  beforeEach(() => query.mockReset());

  it("returns the active tab ID without requiring its URL", async () => {
    query.mockResolvedValue([{ id: 42, active: true }]);

    await expect(getActiveCaptureTabId()).resolves.toBe(42);
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it("returns no target when the browser exposes no active tab ID", async () => {
    query.mockResolvedValue([{ active: true }]);

    await expect(getActiveCaptureTabId()).resolves.toBeUndefined();
  });
});

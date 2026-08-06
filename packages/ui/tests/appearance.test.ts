import { afterEach, describe, expect, it, vi } from "vitest";

import { applyAppearanceMode } from "../src/components/appearance";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyAppearanceMode", () => {
  it("applies the light theme to the document", () => {
    const documentElement = {
      dataset: {} as Record<string, string>,
      style: {} as { colorScheme?: string },
    };
    vi.stubGlobal("document", { documentElement });

    expect(applyAppearanceMode("light")).toBe("light");
    expect(documentElement.dataset.awsmTheme).toBe("light");
    expect(documentElement.style.colorScheme).toBe("light");
  });

  it("applies the dark theme to the document", () => {
    const documentElement = {
      dataset: {} as Record<string, string>,
      style: {} as { colorScheme?: string },
    };
    vi.stubGlobal("document", { documentElement });

    expect(applyAppearanceMode("dark")).toBe("dark");
    expect(documentElement.dataset.awsmTheme).toBe("dark");
    expect(documentElement.style.colorScheme).toBe("dark");
  });

  it("resolves system appearance from the client preference", () => {
    const documentElement = {
      dataset: {} as Record<string, string>,
      style: {} as { colorScheme?: string },
    };
    vi.stubGlobal("document", { documentElement });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(applyAppearanceMode("system")).toBe("dark");
    expect(documentElement.dataset.awsmTheme).toBe("dark");
    expect(documentElement.style.colorScheme).toBe("dark");
  });
});

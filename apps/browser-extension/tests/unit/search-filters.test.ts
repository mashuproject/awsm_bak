import { describe, expect, it } from "vitest";
import { canonicalSearchDateBounds, normalizedSearchHosts } from "../../src/ui/search-filters";

describe("Library Search filters", () => {
  it("normalizes, deduplicates, and sorts hosts without ports", () => {
    expect(
      normalizedSearchHosts([
        "https://Example.com:8443/one",
        "https://b.example/path",
        "https://example.com/two",
      ]),
    ).toEqual(["b.example", "example.com"]);
  });

  it("converts date fields to inclusive and exclusive UTC midnights", () => {
    expect(canonicalSearchDateBounds("2026-07-01", "2026-08-01")).toEqual({
      capturedFrom: "2026-07-01T00:00:00.000Z",
      capturedBefore: "2026-08-01T00:00:00.000Z",
    });
    expect(canonicalSearchDateBounds("", "")).toEqual({});
  });

  it("rejects malformed dates and Before earlier than From", () => {
    expect(() => canonicalSearchDateBounds("2026-02-30", "")).toThrow("Enter a valid From date.");
    expect(() => canonicalSearchDateBounds("2026-08-02", "2026-08-01")).toThrow(
      "Before must be the same as or later than From.",
    );
  });
});

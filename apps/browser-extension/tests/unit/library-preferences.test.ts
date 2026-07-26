import { describe, expect, it } from "vitest";
import type { LibraryPageGroupMessage } from "../../src/app/protocol";
import {
  DEFAULT_LIBRARY_PREFERENCES,
  decodeLibraryPreferences,
  sortLibraryGroups,
} from "../../src/ui/library-preferences";

function group(collectionId: string, title: string, capturedAt: string): LibraryPageGroupMessage {
  return {
    collectionId,
    title,
    originalUrl: "https://example.com",
    knownUrls: ["https://example.com"],
    latest: {
      version: 1,
      bundleId: `${collectionId}-bundle`,
      descriptorObjectId: `${collectionId}-descriptor`,
      assignedCollectionId: collectionId,
      title,
      originalUrl: "https://example.com",
      capturedAt,
      status: "Active",
      warnings: [],
      artifactRoles: [],
    },
    captures: [],
    captureThumbnails: [],
  };
}

describe("Library preferences", () => {
  it("strictly decodes the canonical persisted shape", () => {
    expect(decodeLibraryPreferences({ version: 1, sort: "CapturedOldest", view: "List" })).toEqual({
      version: 1,
      sort: "CapturedOldest",
      view: "List",
    });
    for (const value of [
      undefined,
      null,
      {},
      { version: 1, sort: "CapturedNewest", view: "Grid", extra: true },
      { version: 2, sort: "CapturedNewest", view: "Grid" },
      { version: 1, sort: "Newest", view: "Grid" },
      { version: 1, sort: "CapturedNewest", view: "Compact" },
    ]) {
      expect(() => decodeLibraryPreferences(value)).toThrow();
    }
  });

  it("defines local presentation defaults", () => {
    expect(DEFAULT_LIBRARY_PREFERENCES).toEqual({
      version: 1,
      sort: "CapturedNewest",
      view: "Grid",
    });
  });

  it("sorts with a deterministic collection identifier tie-break", () => {
    const groups = [
      group("b", "Zulu", "2026-07-20T12:00:00.000Z"),
      group("a", "alpha", "2026-07-20T12:00:00.000Z"),
      group("c", "Bravo", "2026-07-21T12:00:00.000Z"),
    ];
    expect(
      sortLibraryGroups(groups, "CapturedNewest").map(({ collectionId }) => collectionId),
    ).toEqual(["c", "a", "b"]);
    expect(
      sortLibraryGroups(groups, "CapturedOldest").map(({ collectionId }) => collectionId),
    ).toEqual(["a", "b", "c"]);
    expect(
      sortLibraryGroups(groups, "TitleAscending").map(({ collectionId }) => collectionId),
    ).toEqual(["a", "c", "b"]);
  });
});

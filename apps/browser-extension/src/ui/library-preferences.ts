import type { LibraryPageGroupMessage } from "../app/protocol";
import type { StoredLibraryPreferencesV1 } from "../drivers/indexeddb/schema";

export const DEFAULT_LIBRARY_PREFERENCES: StoredLibraryPreferencesV1 = {
  version: 1,
  sort: "CapturedNewest",
  view: "Grid",
};

const SORTS = new Set(["CapturedNewest", "CapturedOldest", "TitleAscending"]);
const VIEWS = new Set(["Grid", "List"]);

export function decodeLibraryPreferences(value: unknown): StoredLibraryPreferencesV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Library preferences must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join(",") !== "sort,version,view" ||
    record.version !== 1 ||
    typeof record.sort !== "string" ||
    !SORTS.has(record.sort) ||
    typeof record.view !== "string" ||
    !VIEWS.has(record.view)
  ) {
    throw new Error("Library preferences are invalid.");
  }
  return {
    version: 1,
    sort: record.sort as StoredLibraryPreferencesV1["sort"],
    view: record.view as StoredLibraryPreferencesV1["view"],
  };
}

export function sortLibraryGroups(
  groups: readonly LibraryPageGroupMessage[],
  sort: StoredLibraryPreferencesV1["sort"],
): readonly LibraryPageGroupMessage[] {
  return groups
    .map((group, index) => ({ group, index }))
    .toSorted((left, right) => {
      let comparison = 0;
      if (sort === "TitleAscending") {
        comparison = left.group.title.localeCompare(right.group.title, undefined, {
          sensitivity: "base",
        });
      } else {
        const delta =
          Date.parse(left.group.latest.capturedAt) - Date.parse(right.group.latest.capturedAt);
        comparison = sort === "CapturedNewest" ? -delta : delta;
      }
      return (
        comparison ||
        left.group.collectionId.localeCompare(right.group.collectionId) ||
        left.index - right.index
      );
    })
    .map(({ group }) => group);
}

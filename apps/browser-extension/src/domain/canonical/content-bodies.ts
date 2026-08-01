import { bytesEqual } from "../hash";
import { DEPENDENCY_TYPES, type TypedDependency } from "./dependencies";
import type { IdentifierKind } from "./identifiers";
import {
  arrayValue,
  canonicalSetValue,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nullable,
  oneOfCodes,
  textValue,
} from "./schema";
import type { CanonicalValue } from "./value";

export const CONTENT_EVENT_NAMES = [
  "Vault Label",
  "Client Credential Label",
  "Bundle Registered",
  "Captures Deleted",
  "Captures Restored",
  "Captures Moved",
  "Collection Title",
  "Collections Merged",
  "Collection Merge Reverted",
  "Collection Merge Conflict Resolution",
  "Collection Folder Placement",
  "Folder Created",
  "Folder Renamed",
  "Folder Parent Placement",
  "Folder Deleted",
  "Folder Restored",
  "Folder Conflict Resolution",
  "Tag Created",
  "Tag Renamed",
  "Tag Assigned",
  "Tag Removed",
  "Tag Deleted",
  "Tag Restored",
  "Tags Merged",
  "Tag Merge Reverted",
  "Tag Merge Conflict Resolution",
  "Note Created",
  "Note Revised",
  "Note Deleted",
  "Note Restored",
  "Note Conflict Resolution",
] as const;

const LABEL_OPTIONS = { maxUtf8Bytes: 1_024 } as const;

function id(value: CanonicalValue, kind: IdentifierKind, field: string): Uint8Array {
  return identifierValue(value, kind, field);
}

function cause(value: CanonicalValue, field: string): Uint8Array {
  return id(value, "VaultRecord", field);
}

function label(value: CanonicalValue, field: string): string | null {
  return nullable(value, (entry) => textValue(entry, field, LABEL_OPTIONS));
}

function target(value: CanonicalValue, field = "Organization target"): void {
  const map = exactMap(value, [0, 1], field);
  const kind = oneOfCodes(mapValue(map, 0), [1, 2] as const, `${field} kind`);
  id(mapValue(map, 1), kind === 1 ? "Collection" : "Bundle", `${field} ID`);
}

function redirect(value: CanonicalValue, kind: "Collection" | "Tag", field: string): void {
  const map = exactMap(value, [0, 1], field);
  id(mapValue(map, 0), kind, `${field} source ID`);
  id(mapValue(map, 1), kind, `${field} destination ID`);
}

function canonicalRedirects(
  value: CanonicalValue,
  kind: "Collection" | "Tag",
  field: string,
): void {
  canonicalSetValue(value, field, (entry, index) => {
    redirect(entry, kind, `${field}[${index}]`);
    return entry;
  });
}

function canonicalIdKeyedArray(
  value: CanonicalValue,
  field: string,
  kind: IdentifierKind,
  validate: (entry: CanonicalValue, index: number) => Uint8Array,
): void {
  const entries = arrayValue(value, field);
  let previous: Uint8Array | undefined;
  entries.forEach((entry, index) => {
    const current = validate(entry, index);
    id(current, kind, `${field}[${index}] identity`);
    if (previous !== undefined && compareBytes(previous, current) >= 0) {
      throw new TypeError(`${field} must be sorted by unique ${kind} ID`);
    }
    previous = current;
  });
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function dependency(type: TypedDependency["type"], identifier: Uint8Array): TypedDependency {
  return { type, id: Uint8Array.from(identifier) };
}

function emptyDependencies(): readonly TypedDependency[] {
  return [];
}

export function validateContentEventBody(
  type: number,
  value: CanonicalValue,
): readonly TypedDependency[] {
  const eventName = CONTENT_EVENT_NAMES[type - 1];
  if (eventName === undefined) throw new TypeError("Unknown Content Event type");
  const body = exactMap(value, bodyKeys(type), `${eventName} Event body`);

  switch (type) {
    case 1:
      label(mapValue(body, 0), "Vault label");
      return emptyDependencies();
    case 2:
      id(mapValue(body, 0), "ClientCredential", "Client Credential ID");
      label(mapValue(body, 1), "Client Credential label");
      return emptyDependencies();
    case 3: {
      id(mapValue(body, 0), "Bundle", "Bundle ID");
      const descriptorId = id(mapValue(body, 1), "VaultObject", "Bundle Descriptor Object ID");
      id(mapValue(body, 2), "Collection", "Assigned Collection ID");
      return [dependency(DEPENDENCY_TYPES.BundleDescriptorObject, descriptorId)];
    }
    case 4:
    case 5:
      idSetValue(mapValue(body, 0), "Bundle", "Bundle IDs", { nonempty: true });
      return emptyDependencies();
    case 6:
      canonicalIdKeyedArray(mapValue(body, 0), "Capture moves", "Bundle", (entry, index) => {
        const move = exactMap(entry, [0, 1, 2], `Capture move ${index}`);
        const bundleId = id(mapValue(move, 0), "Bundle", "Moved Bundle ID");
        id(mapValue(move, 1), "Collection", "Source Collection ID");
        id(mapValue(move, 2), "Collection", "Destination Collection ID");
        return bundleId;
      });
      if (arrayValue(mapValue(body, 0), "Capture moves").length === 0) {
        throw new TypeError("Capture moves must not be empty");
      }
      nullable(mapValue(body, 1), (entry) => cause(entry, "Reverted move Cause ID"));
      return emptyDependencies();
    case 7:
      id(mapValue(body, 0), "Collection", "Collection ID");
      label(mapValue(body, 1), "Collection title");
      return emptyDependencies();
    case 8:
      idSetValue(mapValue(body, 0), "Collection", "Source Collection IDs", { nonempty: true });
      id(mapValue(body, 1), "Collection", "Destination Collection ID");
      return emptyDependencies();
    case 9:
      cause(mapValue(body, 0), "Collection redirect Cause ID");
      return emptyDependencies();
    case 10:
      idSetValue(mapValue(body, 0), "VaultRecord", "Conflicting Collection Cause IDs", {
        nonempty: true,
      });
      canonicalRedirects(mapValue(body, 1), "Collection", "Collection redirects");
      return emptyDependencies();
    case 11:
      id(mapValue(body, 0), "Collection", "Collection ID");
      nullable(mapValue(body, 1), (entry) => id(entry, "Folder", "Folder ID"));
      return emptyDependencies();
    case 12:
      id(mapValue(body, 0), "Folder", "Folder ID");
      textValue(mapValue(body, 1), "Folder name", LABEL_OPTIONS);
      nullable(mapValue(body, 2), (entry) => id(entry, "Folder", "Parent Folder ID"));
      return emptyDependencies();
    case 13:
      id(mapValue(body, 0), "Folder", "Folder ID");
      textValue(mapValue(body, 1), "Folder name", LABEL_OPTIONS);
      return emptyDependencies();
    case 14:
      id(mapValue(body, 0), "Folder", "Folder ID");
      nullable(mapValue(body, 1), (entry) => id(entry, "Folder", "Parent Folder ID"));
      return emptyDependencies();
    case 15:
    case 16:
      id(mapValue(body, 0), "Folder", "Folder ID");
      return emptyDependencies();
    case 17:
      idSetValue(mapValue(body, 0), "VaultRecord", "Conflicting Folder Cause IDs", {
        nonempty: true,
      });
      canonicalIdKeyedArray(mapValue(body, 1), "Folder placements", "Folder", (entry, index) => {
        const placement = exactMap(entry, [0, 1], `Folder placement ${index}`);
        const folderId = id(mapValue(placement, 0), "Folder", "Folder ID");
        nullable(mapValue(placement, 1), (parent) => id(parent, "Folder", "Parent Folder ID"));
        return folderId;
      });
      return emptyDependencies();
    case 18:
      id(mapValue(body, 0), "Tag", "Tag ID");
      textValue(mapValue(body, 1), "Tag name", LABEL_OPTIONS);
      return emptyDependencies();
    case 19:
      id(mapValue(body, 0), "Tag", "Tag ID");
      textValue(mapValue(body, 1), "Tag name", LABEL_OPTIONS);
      return emptyDependencies();
    case 20:
      id(mapValue(body, 0), "TagAssignment", "Tag Assignment ID");
      id(mapValue(body, 1), "Tag", "Tag ID");
      target(mapValue(body, 2));
      return emptyDependencies();
    case 21:
      idSetValue(mapValue(body, 0), "VaultRecord", "Tag Assignment Cause IDs", {
        nonempty: true,
      });
      return emptyDependencies();
    case 22:
    case 23:
      id(mapValue(body, 0), "Tag", "Tag ID");
      return emptyDependencies();
    case 24:
      idSetValue(mapValue(body, 0), "Tag", "Source Tag IDs", { nonempty: true });
      id(mapValue(body, 1), "Tag", "Destination Tag ID");
      return emptyDependencies();
    case 25:
      cause(mapValue(body, 0), "Tag redirect Cause ID");
      return emptyDependencies();
    case 26:
      idSetValue(mapValue(body, 0), "VaultRecord", "Conflicting Tag Cause IDs", {
        nonempty: true,
      });
      canonicalRedirects(mapValue(body, 1), "Tag", "Tag redirects");
      return emptyDependencies();
    case 27: {
      id(mapValue(body, 0), "Note", "Note ID");
      target(mapValue(body, 1), "Note target");
      const contentId = id(mapValue(body, 2), "VaultObject", "Note Content Object ID");
      return [dependency(DEPENDENCY_TYPES.NoteContentObject, contentId)];
    }
    case 28: {
      id(mapValue(body, 0), "Note", "Note ID");
      idSetValue(mapValue(body, 1), "VaultRecord", "Superseded Note revision Cause IDs", {
        nonempty: true,
      });
      const contentId = id(mapValue(body, 2), "VaultObject", "Note Content Object ID");
      return [dependency(DEPENDENCY_TYPES.NoteContentObject, contentId)];
    }
    case 29:
    case 30:
      id(mapValue(body, 0), "Note", "Note ID");
      idSetValue(mapValue(body, 1), "VaultRecord", "Observed Note head Cause IDs", {
        nonempty: true,
      });
      return emptyDependencies();
    case 31: {
      id(mapValue(body, 0), "Note", "Note ID");
      idSetValue(mapValue(body, 1), "VaultRecord", "Conflicting Note head Cause IDs", {
        nonempty: true,
      });
      const dependencies: TypedDependency[] = [];
      const retained = nullable(mapValue(body, 2), (entry) =>
        id(entry, "VaultObject", "Retained Note Content Object ID"),
      );
      if (retained !== null) {
        dependencies.push(dependency(DEPENDENCY_TYPES.NoteContentObject, retained));
      }
      canonicalIdKeyedArray(mapValue(body, 3), "Split Notes", "Note", (entry, index) => {
        const split = exactMap(entry, [0, 1], `Split Note ${index}`);
        const noteId = id(mapValue(split, 0), "Note", "Split Note ID");
        const contentId = id(mapValue(split, 1), "VaultObject", "Split Note Content Object ID");
        dependencies.push(dependency(DEPENDENCY_TYPES.NoteContentObject, contentId));
        return noteId;
      });
      return dependencies;
    }
    default:
      throw new TypeError("Unknown Content Event type");
  }
}

function bodyKeys(type: number): readonly number[] {
  switch (type) {
    case 1:
    case 4:
    case 5:
    case 9:
    case 15:
    case 16:
    case 21:
    case 22:
    case 23:
    case 25:
      return [0];
    case 2:
    case 6:
    case 7:
    case 8:
    case 10:
    case 11:
    case 13:
    case 14:
    case 17:
    case 18:
    case 19:
    case 24:
    case 26:
    case 29:
    case 30:
      return [0, 1];
    case 3:
    case 12:
    case 20:
    case 27:
    case 28:
      return [0, 1, 2];
    case 31:
      return [0, 1, 2, 3];
    default:
      throw new TypeError("Unknown Content Event type");
  }
}

export function rawIdsEqual(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqual(left, right);
}

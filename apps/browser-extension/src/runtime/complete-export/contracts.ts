import { sha256 } from "@noble/hashes/sha2.js";

import {
  DEPENDENCY_TYPES,
  type DependencyType,
  dependencySet,
  type TypedDependency,
} from "../../domain/canonical/dependencies";
import { type Identifier, identifier, keyEpochId } from "../../domain/canonical/identifiers";
import {
  byteString,
  canonicalSetValue,
  exactCode,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nonnegativeInteger,
  oneOfCodes,
} from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";

export const COMPLETE_EXPORT_MANIFEST_FORMAT = 1 as const;
export const COMPLETE_EXPORT_KEY_INVENTORY_FORMAT = 1 as const;

export type CompleteExportNamespace = 1 | 2 | 3 | 4 | 5;

export interface CompleteExportOpaqueItem {
  readonly namespace: CompleteExportNamespace;
  readonly logicalId: Uint8Array;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly byteLength: number;
  readonly byteDigest: Uint8Array;
}

export interface CompleteExportManifestInput {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly frontier: readonly Identifier<"VaultRecord">[];
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly typedLogicalRoots: readonly TypedDependency[];
  readonly opaqueItemInventory: readonly CompleteExportOpaqueItem[];
  readonly continuityProofRoots: readonly Identifier<"VaultRecord">[];
}

export interface CompleteExportManifest extends CompleteExportManifestInput {
  readonly format: typeof COMPLETE_EXPORT_MANIFEST_FORMAT;
  readonly stateDigest: Uint8Array;
}

export interface CompleteExportKeyEpochEntry {
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
}

export interface CompleteExportKeyInventoryInput {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly entries: readonly CompleteExportKeyEpochEntry[];
}

export interface CompleteExportKeyInventory extends CompleteExportKeyInventoryInput {
  readonly format: typeof COMPLETE_EXPORT_KEY_INVENTORY_FORMAT;
}

const DEPENDENCY_TYPE_CODES = Object.values(DEPENDENCY_TYPES);
const NAMESPACE_CODES = [1, 2, 3, 4, 5] as const;

function dependency(value: CanonicalValue, field: string): TypedDependency {
  const map = exactMap(value, [0, 1], field);
  return {
    type: oneOfCodes(mapValue(map, 0), DEPENDENCY_TYPE_CODES, `${field} type`) as DependencyType,
    id: byteString(mapValue(map, 1), 32, `${field} ID`),
  };
}

function dependencySetValue(value: CanonicalValue, field: string): readonly TypedDependency[] {
  const entries = canonicalSetValue(value, field, (entry) => entry, { nonempty: true });
  return entries.map((entry, index) => dependency(entry, `${field}[${index}]`));
}

function logicalIdForNamespace(namespace: CompleteExportNamespace, value: Uint8Array): Uint8Array {
  const kind =
    namespace === 1
      ? "VaultRecord"
      : namespace === 2
        ? "KeyEnvelope"
        : namespace === 3
          ? "VaultObject"
          : namespace === 4
            ? "FeatureManifest"
            : "Artifact";
  return identifier(kind, value);
}

function opaqueItemValue(item: CompleteExportOpaqueItem): ReadonlyMap<number, CanonicalValue> {
  const namespace = oneOfCodes(item.namespace, NAMESPACE_CODES, "Opaque namespace");
  const logicalId = logicalIdForNamespace(namespace, item.logicalId);
  const storageItemId = identifier("StorageItem", item.storageItemId);
  const epochId = identifier("KeyEpoch", item.keyEpochId);
  if (!Number.isSafeInteger(item.byteLength) || item.byteLength < 1) {
    throw new TypeError("Opaque item byte length must be a positive safe integer");
  }
  if (item.byteDigest.byteLength !== 32) {
    throw new TypeError("Opaque item byte digest must contain exactly 32 bytes");
  }
  return canonicalMap([
    [0, namespace],
    [1, logicalId],
    [2, storageItemId],
    [3, epochId],
    [4, item.byteLength],
    [5, Uint8Array.from(item.byteDigest)],
  ]);
}

function decodeOpaqueItem(value: CanonicalValue, field: string): CompleteExportOpaqueItem {
  const map = exactMap(value, [0, 1, 2, 3, 4, 5], field);
  const namespace = oneOfCodes(mapValue(map, 0), NAMESPACE_CODES, `${field} namespace`);
  const logicalId = logicalIdForNamespace(
    namespace,
    byteString(mapValue(map, 1), 32, `${field} logical ID`),
  );
  const byteLength = nonnegativeInteger(mapValue(map, 4), `${field} byte length`);
  if (byteLength < 1) throw new TypeError(`${field} byte length must be positive`);
  return {
    namespace,
    logicalId,
    storageItemId: identifierValue(mapValue(map, 2), "StorageItem", `${field} Storage Item ID`),
    keyEpochId: identifierValue(mapValue(map, 3), "KeyEpoch", `${field} Key Epoch ID`),
    byteLength,
    byteDigest: byteString(mapValue(map, 5), 32, `${field} byte digest`),
  };
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function opaqueInventoryValue(
  items: readonly CompleteExportOpaqueItem[],
): readonly ReadonlyMap<number, CanonicalValue>[] {
  if (items.length === 0) throw new TypeError("Complete Export opaque inventory must not be empty");
  const logicalKeys = items.map((item) => `${item.namespace}:${key(item.logicalId)}`);
  const storageKeys = items.map((item) => key(item.storageItemId));
  if (
    new Set(logicalKeys).size !== logicalKeys.length ||
    new Set(storageKeys).size !== storageKeys.length
  ) {
    throw new TypeError("Complete Export opaque inventory contains a duplicate identity");
  }
  return canonicalSet(items.map(opaqueItemValue));
}

function decodeOpaqueInventory(value: CanonicalValue): readonly CompleteExportOpaqueItem[] {
  const entries = canonicalSetValue(value, "Opaque item inventory", (entry) => entry, {
    nonempty: true,
  });
  const items = entries.map((entry, index) =>
    decodeOpaqueItem(entry, `Opaque item inventory[${index}]`),
  );
  opaqueInventoryValue(items);
  return items;
}

function manifestStateValue(
  input: CompleteExportManifestInput,
): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, COMPLETE_EXPORT_MANIFEST_FORMAT],
    [1, identifier("Vault", input.vaultId)],
    [2, identifier("Generation", input.generationId)],
    [3, canonicalSet(input.frontier.map((id) => identifier("VaultRecord", id)))],
    [4, identifier("RequiredFeatureSet", input.requiredFeatureSetId)],
    [5, dependencySet(input.typedLogicalRoots)],
    [6, opaqueInventoryValue(input.opaqueItemInventory)],
    [8, canonicalSet(input.continuityProofRoots.map((id) => identifier("VaultRecord", id)))],
  ]);
}

export function completeExportStateDigest(input: CompleteExportManifestInput): Uint8Array {
  if (input.frontier.length === 0)
    throw new TypeError("Complete Export Frontier must not be empty");
  if (input.typedLogicalRoots.length === 0) {
    throw new TypeError("Complete Export logical roots must not be empty");
  }
  if (input.continuityProofRoots.length === 0) {
    throw new TypeError("Complete Export Continuity roots must not be empty");
  }
  return sha256(
    transcript("awsm:complete-export-state-digest:v1", [
      encodeCanonicalValue(manifestStateValue(input)),
    ]),
  );
}

export function encodeCompleteExportManifest(input: CompleteExportManifest): Uint8Array {
  if (!bytesEqual(input.stateDigest, completeExportStateDigest(input))) {
    throw new TypeError("Complete Export state digest does not match the Manifest");
  }
  const state = manifestStateValue(input);
  return encodeCanonicalValue(
    canonicalMap([...state.entries(), [7, Uint8Array.from(input.stateDigest)] as const]),
  );
}

export function decodeCompleteExportManifest(bytes: Uint8Array): CompleteExportManifest {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
    "Complete Export Manifest",
  );
  const manifest: CompleteExportManifest = {
    format: exactCode(mapValue(map, 0), COMPLETE_EXPORT_MANIFEST_FORMAT, "Manifest format"),
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Manifest Vault ID"),
    generationId: identifierValue(mapValue(map, 2), "Generation", "Manifest Generation ID"),
    frontier: idSetValue(mapValue(map, 3), "VaultRecord", "Manifest Frontier", {
      nonempty: true,
    }),
    requiredFeatureSetId: identifierValue(
      mapValue(map, 4),
      "RequiredFeatureSet",
      "Manifest Required Feature Set ID",
    ),
    typedLogicalRoots: dependencySetValue(mapValue(map, 5), "Manifest logical roots"),
    opaqueItemInventory: decodeOpaqueInventory(mapValue(map, 6)),
    stateDigest: byteString(mapValue(map, 7), 32, "Manifest state digest"),
    continuityProofRoots: idSetValue(mapValue(map, 8), "VaultRecord", "Manifest Continuity roots", {
      nonempty: true,
    }),
  };
  if (!bytesEqual(manifest.stateDigest, completeExportStateDigest(manifest))) {
    throw new TypeError("Complete Export state digest does not match the Manifest");
  }
  if (!bytesEqual(bytes, encodeCompleteExportManifest(manifest))) {
    throw new TypeError("Complete Export Manifest is not canonical");
  }
  return manifest;
}

function keyEpochEntryValue(
  vaultId: Identifier<"Vault">,
  entry: CompleteExportKeyEpochEntry,
): ReadonlyMap<number, CanonicalValue> {
  const key = byteString(entry.keyEpochKey, 32, "Export Key Epoch Key");
  const id = identifier("KeyEpoch", entry.keyEpochId);
  if (!bytesEqual(keyEpochId(vaultId, key), id)) {
    throw new TypeError("Export Key Epoch ID does not match its Key Epoch Key");
  }
  return canonicalMap([
    [0, id],
    [1, key],
  ]);
}

function keyInventoryValue(
  input: CompleteExportKeyInventoryInput,
): ReadonlyMap<number, CanonicalValue> {
  const vaultId = identifier("Vault", input.vaultId);
  const generationId = identifier("Generation", input.generationId);
  if (input.entries.length === 0) throw new TypeError("Export Key Inventory must not be empty");
  const ids = input.entries.map((entry) => key(entry.keyEpochId));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Export Key Inventory contains a duplicate Key Epoch ID");
  }
  return canonicalMap([
    [0, COMPLETE_EXPORT_KEY_INVENTORY_FORMAT],
    [1, vaultId],
    [2, generationId],
    [3, canonicalSet(input.entries.map((entry) => keyEpochEntryValue(vaultId, entry)))],
  ]);
}

export function encodeCompleteExportKeyInventory(
  input: CompleteExportKeyInventoryInput,
): Uint8Array {
  return encodeCanonicalValue(keyInventoryValue(input));
}

export function decodeCompleteExportKeyInventory(bytes: Uint8Array): CompleteExportKeyInventory {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3], "Complete Export Key Inventory");
  const vaultId = identifierValue(mapValue(map, 1), "Vault", "Key Inventory Vault ID");
  const values = canonicalSetValue(mapValue(map, 3), "Key Epoch entries", (entry) => entry, {
    nonempty: true,
  });
  const entries = values.map((value, index) => {
    const entry = exactMap(value, [0, 1], `Key Epoch entry[${index}]`);
    const keyEpochKey = byteString(mapValue(entry, 1), 32, `Key Epoch entry[${index}] Key`);
    const id = identifierValue(mapValue(entry, 0), "KeyEpoch", `Key Epoch entry[${index}] ID`);
    if (!bytesEqual(keyEpochId(vaultId, keyEpochKey), id)) {
      throw new TypeError("Export Key Epoch ID does not match its Key Epoch Key");
    }
    return { keyEpochId: id, keyEpochKey };
  });
  const result: CompleteExportKeyInventory = {
    format: exactCode(
      mapValue(map, 0),
      COMPLETE_EXPORT_KEY_INVENTORY_FORMAT,
      "Key Inventory format",
    ),
    vaultId,
    generationId: identifierValue(mapValue(map, 2), "Generation", "Key Inventory Generation ID"),
    entries,
  };
  keyInventoryValue(result);
  if (!bytesEqual(bytes, encodeCompleteExportKeyInventory(result))) {
    throw new TypeError("Complete Export Key Inventory is not canonical");
  }
  return result;
}

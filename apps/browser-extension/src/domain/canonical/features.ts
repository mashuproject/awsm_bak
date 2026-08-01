import { sha256 } from "@noble/hashes/sha2.js";

import { bytesEqual } from "../hash";
import { type Identifier, identifier } from "./identifiers";
import { byteString, canonicalSetValue, exactMap, mapValue, nonnegativeInteger } from "./schema";
import { concatBytes, transcript } from "./transcript";
import {
  assertCanonicalScopedKey,
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "./value";

export interface FeatureManifest {
  readonly featureKey: string;
  readonly revision: number;
  readonly parameters: Uint8Array;
  readonly requiredManifestIds: readonly Identifier<"FeatureManifest">[];
  readonly incompatibleKeys: readonly string[];
}

interface ManifestEntry {
  readonly bytes: Uint8Array;
  readonly id: Identifier<"FeatureManifest">;
  readonly key: string;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

export function encodeFeatureManifest(manifest: FeatureManifest): Uint8Array {
  assertCanonicalScopedKey(manifest.featureKey);
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 0) {
    throw new TypeError("Feature revision must be a nonnegative safe integer");
  }
  const required = canonicalSet(manifest.requiredManifestIds);
  const incompatible = canonicalSet(
    manifest.incompatibleKeys.map((key) => assertCanonicalScopedKey(key)),
  );
  return encodeCanonicalValue(
    canonicalMap([
      [0, manifest.featureKey],
      [1, manifest.revision],
      [2, manifest.parameters],
      [3, required],
      [4, incompatible],
    ]),
  );
}

export function decodeFeatureManifest(bytes: Uint8Array): FeatureManifest {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4], "Feature Manifest");
  const featureKey = mapValue(map, 0);
  if (typeof featureKey !== "string") throw new TypeError("Feature key must be text");
  const manifest: FeatureManifest = {
    featureKey: assertCanonicalScopedKey(featureKey),
    revision: nonnegativeInteger(mapValue(map, 1), "Feature revision"),
    parameters: byteStringValue(mapValue(map, 2), "Feature parameters"),
    requiredManifestIds: canonicalSetValue(
      mapValue(map, 3),
      "Required Feature Manifest IDs",
      (value) => identifier("FeatureManifest", byteString(value, 32, "Feature Manifest ID")),
    ),
    incompatibleKeys: canonicalSetValue(mapValue(map, 4), "Incompatible feature keys", (value) => {
      if (typeof value !== "string") throw new TypeError("Incompatible feature key must be text");
      return assertCanonicalScopedKey(value);
    }),
  };
  if (!bytesEqual(encodeFeatureManifest(manifest), bytes)) {
    throw new TypeError("Feature Manifest bytes are not canonical");
  }
  return manifest;
}

function byteStringValue(value: CanonicalValue, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytes`);
  return Uint8Array.from(value);
}

export function featureManifestId(bytes: Uint8Array): Identifier<"FeatureManifest"> {
  return identifier("FeatureManifest", sha256(transcript("awsm:feature-manifest-id:v1", [bytes])));
}

function validatedManifestEntries(manifests: readonly FeatureManifest[]): ManifestEntry[] {
  const entries = manifests.map((manifest) => {
    const bytes = encodeFeatureManifest(manifest);
    return { bytes, id: featureManifestId(bytes), key: manifest.featureKey };
  });
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) throw new TypeError("Required Feature Set repeats a feature key");
    keys.add(entry.key);
  }
  const manifestIds = new Set(entries.map(({ id }) => hex(id)));
  for (const [index, manifest] of manifests.entries()) {
    for (const requiredId of manifest.requiredManifestIds) {
      if (!manifestIds.has(hex(requiredId))) {
        throw new TypeError(`Required Feature Manifest ${index} has an unsatisfied requirement`);
      }
    }
    for (const incompatibleKey of manifest.incompatibleKeys) {
      if (keys.has(incompatibleKey)) {
        throw new TypeError(`Required Feature Manifest ${index} conflicts with ${incompatibleKey}`);
      }
    }
  }
  entries.sort((left, right) => compareBytes(left.id, right.id));
  for (let index = 1; index < entries.length; index += 1) {
    if (
      bytesEqual(entries[index - 1]?.id ?? new Uint8Array(), entries[index]?.id ?? new Uint8Array())
    ) {
      throw new TypeError("Required Feature Set repeats a Manifest");
    }
  }
  return entries;
}

export function requiredFeatureSetValue(
  manifests: readonly FeatureManifest[],
): readonly Uint8Array[] {
  return validatedManifestEntries(manifests).map(({ bytes }) => bytes);
}

export function encodeRequiredFeatureSet(manifests: readonly FeatureManifest[]): Uint8Array {
  return encodeCanonicalValue(requiredFeatureSetValue(manifests));
}

export function decodeRequiredFeatureSet(bytes: Uint8Array): readonly FeatureManifest[] {
  const value = decodeCanonicalValue(bytes);
  if (!Array.isArray(value)) throw new TypeError("Required Feature Set must be an array");
  const manifests = value.map((entry) => {
    if (!(entry instanceof Uint8Array)) {
      throw new TypeError("Required Feature Set entries must be complete Manifest bytes");
    }
    return decodeFeatureManifest(entry);
  });
  if (!bytesEqual(encodeRequiredFeatureSet(manifests), bytes)) {
    throw new TypeError("Required Feature Set is not sorted by Manifest ID");
  }
  return manifests;
}

export function requiredFeatureSetId(
  manifests: readonly FeatureManifest[],
): Identifier<"RequiredFeatureSet"> {
  const entries = validatedManifestEntries(manifests);
  return identifier(
    "RequiredFeatureSet",
    sha256(
      transcript("awsm:required-feature-set-id:v1", [concatBytes(entries.map(({ id }) => id))]),
    ),
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const EMPTY_REQUIRED_FEATURE_SET_ID = requiredFeatureSetId([]);

export function advisoryExtensions(
  entries: readonly (readonly [string, Uint8Array])[],
): ReadonlyMap<string, CanonicalValue> {
  if (entries.length > 32) throw new TypeError("Too many Advisory Extensions");
  const map = new Map<string, CanonicalValue>();
  let valueBytes = 0;
  for (const [key, value] of entries) {
    assertCanonicalScopedKey(key);
    if (map.has(key)) throw new TypeError("Duplicate Advisory Extension key");
    if (value.byteLength > 16 * 1024) throw new TypeError("Advisory Extension value is too large");
    valueBytes += value.byteLength;
    map.set(key, Uint8Array.from(value));
  }
  if (valueBytes > 64 * 1024 || encodeCanonicalValue(map).byteLength > 64 * 1024) {
    throw new TypeError("Advisory Extension map is too large");
  }
  return map;
}

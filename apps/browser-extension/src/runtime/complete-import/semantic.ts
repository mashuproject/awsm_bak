import { sha256 } from "@noble/hashes/sha2.js";

import { type CompactPayloadType, openCompactItem } from "../../crypto/compact";
import { DEPENDENCY_TYPES, type TypedDependency } from "../../domain/canonical/dependencies";
import { featureManifestId } from "../../domain/canonical/features";
import type { Identifier } from "../../domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  decodeVaultObject,
  type VaultObject,
} from "../../domain/canonical/object";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import {
  COMPACT_STORAGE_CLASS,
  decodeOpaqueEnvelope,
  PORTABLE_COMPACT_CEILING,
} from "../../storage/opaque-envelope";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import { verifyCanonicalArtifactRepresentation } from "../artifact/canonical-verify";
import {
  type CompleteExportKeyInventory,
  type CompleteExportManifest,
  type CompleteExportOpaqueItem,
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "../complete-export/contracts";
import {
  type CompleteExportReachability,
  collectCompleteExportReachability,
} from "../complete-export/reachability";

const MAX_COMPACT_ENVELOPE_LENGTH = PORTABLE_COMPACT_CEILING + 4096 + 12;

type VaultRecord = AuthenticatedVaultEvent | VaultBaseline;

export interface CompleteImportPreparedSource {
  readonly openOpaque: (item: CompleteExportOpaqueItem) => Promise<ReadableStream<Uint8Array>>;
}

export interface ValidatedCompleteExportSemantics {
  readonly manifest: CompleteExportManifest;
  readonly keyInventory: CompleteExportKeyInventory;
  readonly reachability: CompleteExportReachability;
}

function key(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

async function readExactCompact(
  source: CompleteImportPreparedSource,
  item: CompleteExportOpaqueItem,
): Promise<Uint8Array> {
  if (item.byteLength > MAX_COMPACT_ENVELOPE_LENGTH) {
    throw new TypeError("Complete Import Compact item exceeds the portable bound");
  }
  const reader = (await source.openOpaque(item)).getReader();
  const result = new Uint8Array(item.byteLength);
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Prepared Opaque chunks must contain bytes");
      }
      if (offset + next.value.byteLength > result.byteLength) {
        throw new TypeError("Prepared Opaque item exceeds its declared length");
      }
      result.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== result.byteLength) {
      throw new TypeError("Prepared Opaque item ended before its declared length");
    }
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function decodeRecord(bytes: Uint8Array): VaultRecord {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Complete Import Record is not a map");
  if (value.get(6) === 1) return decodeVaultEvent(bytes);
  if (value.get(6) === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Complete Import Record kind is unsupported");
}

function expectedPayloadType(namespace: 1 | 3 | 4): CompactPayloadType {
  return namespace === 1 ? 1 : namespace === 3 ? 2 : 3;
}

function dependencyKey(value: TypedDependency): string {
  return `${value.type}:${key(value.id)}`;
}

function requireExactDependencies(
  actual: readonly TypedDependency[],
  expected: readonly TypedDependency[],
): void {
  const actualKeys = new Set(actual.map(dependencyKey));
  const expectedKeys = new Set(expected.map(dependencyKey));
  if (
    actualKeys.size !== expectedKeys.size ||
    [...actualKeys].some((candidate) => !expectedKeys.has(candidate))
  ) {
    throw new TypeError("Complete Export logical roots disagree with reachable state");
  }
}

function reachableInventoryKeys(reachability: CompleteExportReachability): Set<string> {
  return new Set([
    ...reachability.recordIds.map((id) => `1:${key(id)}`),
    ...reachability.keyEnvelopeIds.map((id) => `2:${key(id)}`),
    ...reachability.vaultObjectIds.map((id) => `3:${key(id)}`),
    ...reachability.featureManifestIds.map((id) => `4:${key(id)}`),
    ...reachability.artifactIds.map((id) => `5:${key(id)}`),
  ]);
}

export async function validateCompleteExportSemantics(input: {
  readonly manifest: CompleteExportManifest;
  readonly keyInventory: CompleteExportKeyInventory;
  readonly source: CompleteImportPreparedSource;
}): Promise<ValidatedCompleteExportSemantics> {
  const manifest = decodeCompleteExportManifest(encodeCompleteExportManifest(input.manifest));
  const keyInventory = decodeCompleteExportKeyInventory(
    encodeCompleteExportKeyInventory(input.keyInventory),
  );
  same(keyInventory.vaultId, manifest.vaultId, "Complete Export Key Inventory Vault ID");
  same(
    keyInventory.generationId,
    manifest.generationId,
    "Complete Export Key Inventory Generation ID",
  );
  const epochKeys = new Map(
    keyInventory.entries.map((entry) => [key(entry.keyEpochId), entry.keyEpochKey]),
  );
  const referencedEpochIds = new Set(
    manifest.opaqueItemInventory.map((item) => key(item.keyEpochId)),
  );
  if (
    epochKeys.size !== referencedEpochIds.size ||
    [...referencedEpochIds].some((epochId) => !epochKeys.has(epochId))
  ) {
    throw new TypeError("Complete Export Key Inventory is not the exact referenced Epoch set");
  }
  const records = new Map<string, VaultRecord>();
  const objects = new Map<string, VaultObject>();
  const features = new Map<string, Uint8Array>();
  const itemsByStorageId = new Map(
    manifest.opaqueItemInventory.map((item) => [key(item.storageItemId), item]),
  );

  for (const item of manifest.opaqueItemInventory) {
    const epochKey = epochKeys.get(key(item.keyEpochId));
    if (epochKey === undefined) {
      throw new TypeError("Complete Export omits a referenced Key Epoch Key");
    }
    if (item.namespace === 5) continue;
    const bytes = await readExactCompact(input.source, item);
    same(sha256(bytes), item.byteDigest, "Prepared Opaque byte digest");
    const envelope = decodeOpaqueEnvelope(bytes);
    same(envelope.storageItemId, item.storageItemId, "Prepared Opaque Storage Item ID");
    if (envelope.storageClass !== COMPACT_STORAGE_CLASS) {
      throw new TypeError("Complete Import compact inventory item is not Compact");
    }
    if (item.namespace === 2) continue;
    const opened = await openCompactItem({
      vaultId: manifest.vaultId,
      keyEpochId: item.keyEpochId,
      keyEpochKey: epochKey,
      envelopeBytes: bytes,
    });
    if (opened.payloadType !== expectedPayloadType(item.namespace)) {
      throw new TypeError("Complete Import Compact payload type disagrees with its namespace");
    }
    const logicalKey = key(item.logicalId);
    if (item.namespace === 1) {
      const record = decodeRecord(opened.payloadBytes);
      same(record.recordId, item.logicalId, "Complete Import Vault Record ID");
      records.set(logicalKey, record);
    } else if (item.namespace === 3) {
      const object = decodeVaultObject(opened.payloadBytes);
      same(object.objectId, item.logicalId, "Complete Import Vault Object ID");
      objects.set(logicalKey, object);
    } else {
      same(
        featureManifestId(opened.payloadBytes),
        item.logicalId,
        "Complete Import Feature Manifest ID",
      );
      features.set(logicalKey, opened.payloadBytes);
    }
  }

  const baselineRoots = manifest.typedLogicalRoots.filter(
    ({ type }) => type === DEPENDENCY_TYPES.VaultBaseline,
  );
  if (baselineRoots.length !== 1) {
    throw new TypeError("Complete Export requires exactly one Baseline logical root");
  }
  const baselineId = baselineRoots[0]?.id as Identifier<"VaultRecord">;
  const reachability = await collectCompleteExportReachability({
    vaultId: manifest.vaultId,
    generationId: manifest.generationId,
    requiredFeatureSetId: manifest.requiredFeatureSetId,
    baselineId,
    causalFrontier: manifest.frontier,
    authorityFrontier: manifest.continuityProofRoots,
    loadRecord: async (id) => records.get(key(id)),
    loadObject: async (id) => objects.get(key(id)),
    loadFeatureManifest: async (id) => features.get(key(id)),
  });
  requireExactDependencies(manifest.typedLogicalRoots, reachability.typedLogicalRoots);
  const expectedInventory = reachableInventoryKeys(reachability);
  const actualInventory = new Set(
    manifest.opaqueItemInventory.map((item) => `${item.namespace}:${key(item.logicalId)}`),
  );
  if (
    expectedInventory.size !== actualInventory.size ||
    [...expectedInventory].some((candidate) => !actualInventory.has(candidate))
  ) {
    throw new TypeError("Complete Export reachable inventory is not exact");
  }

  const artifactStore: CanonicalArtifactStore = {
    prepare: async () => {
      throw new TypeError("Complete Import semantic validation never prepares Artifacts");
    },
    open: async (storageItemId) => {
      const item = itemsByStorageId.get(key(storageItemId));
      if (item === undefined) throw new TypeError("Prepared Artifact wrapper is unavailable");
      return input.source.openOpaque(item);
    },
    has: async (storageItemId) => itemsByStorageId.has(key(storageItemId)),
    remove: async () => undefined,
  };
  for (const id of reachability.artifactIds) {
    const object = [...objects.values()].find(
      (candidate) =>
        candidate.objectType === ARTIFACT_OBJECT && bytesEqual(artifactId(candidate), id),
    );
    const item = manifest.opaqueItemInventory.find(
      (candidate) => candidate.namespace === 5 && bytesEqual(candidate.logicalId, id),
    );
    if (object === undefined || item === undefined) {
      throw new TypeError("Complete Export reachable Artifact inventory is incomplete");
    }
    const epochKey = epochKeys.get(key(item.keyEpochId));
    if (epochKey === undefined) throw new TypeError("Complete Export omits an Artifact Epoch Key");
    const verified = await verifyCanonicalArtifactRepresentation({
      store: artifactStore,
      storageItemId: item.storageItemId,
      object,
      keyEpochId: item.keyEpochId,
      keyEpochKey: epochKey,
      writePlaintext: async () => undefined,
    });
    if (verified.byteLength !== item.byteLength) {
      throw new TypeError("Complete Import Artifact wrapper length does not match");
    }
    same(verified.byteDigest, item.byteDigest, "Complete Import Artifact wrapper digest");
  }

  return { manifest, keyInventory, reachability };
}

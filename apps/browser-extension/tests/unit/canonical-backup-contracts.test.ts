import { describe, expect, it } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { EMPTY_REQUIRED_FEATURE_SET_ID } from "../../src/domain/canonical/features";
import { type Identifier, identifier } from "../../src/domain/canonical/identifiers";
import { decodeCanonicalValue, encodeCanonicalValue } from "../../src/domain/canonical/value";
import {
  backupSnapshotId,
  decodeBackupSnapshotManifest,
  encodeBackupSnapshotManifest,
} from "../../src/runtime/backup/contracts";
import { prepareCompleteExportEntry } from "../../src/runtime/complete-export/container";
import {
  type CompleteExportManifestInput,
  completeExportStateDigest,
  decodeCompleteExportManifest,
  encodeCompleteExportManifest,
} from "../../src/runtime/complete-export/contracts";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function exportManifest() {
  const vaultId = filled("Vault", 1);
  const generationId = filled("Generation", 2);
  const baselineId = filled("VaultRecord", 3);
  const frontierId = filled("VaultRecord", 4);
  const storageItemId = prepareCompleteExportEntry(2, Uint8Array.of(9)).header
    .entryId as Identifier<"StorageItem">;
  const input: CompleteExportManifestInput = {
    vaultId,
    generationId,
    frontier: [frontierId],
    requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
    typedLogicalRoots: [
      { type: DEPENDENCY_TYPES.VaultBaseline, id: baselineId },
      { type: DEPENDENCY_TYPES.VaultRecord, id: frontierId },
    ],
    opaqueItemInventory: [
      {
        namespace: 1,
        logicalId: frontierId,
        storageItemId,
        keyEpochId: filled("KeyEpoch", 5),
        byteLength: 1,
        byteDigest: new Uint8Array(32).fill(6),
      },
    ],
    continuityProofRoots: [frontierId],
  };
  return { format: 1 as const, ...input, stateDigest: completeExportStateDigest(input) };
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    if (needle.every((byte, index) => haystack[offset + index] === byte)) return true;
  }
  return false;
}

describe("canonical Backup Snapshot contract", () => {
  it("round-trips one exact Snapshot that binds its encrypted package bytes", () => {
    const manifest = decodeCompleteExportManifest(encodeCompleteExportManifest(exportManifest()));
    const input = {
      format: 1 as const,
      backupSetId: new Uint8Array(32).fill(7),
      protectionProfile: 1 as const,
      packageByteLength: 1234,
      packageByteDigest: new Uint8Array(32).fill(8),
    };
    const snapshotId = backupSnapshotId(input);
    const bytes = encodeBackupSnapshotManifest({ ...input, snapshotId });
    const decoded = decodeBackupSnapshotManifest(bytes);

    expect(decoded).toEqual({ ...input, snapshotId });
    expect(encodeBackupSnapshotManifest(decoded)).toEqual(bytes);
    expect(containsBytes(bytes, encodeCompleteExportManifest(manifest))).toBe(false);
  });

  it("rejects a mismatched Snapshot ID, an unknown field, or invalid package bounds", () => {
    const input = {
      format: 1 as const,
      backupSetId: new Uint8Array(32).fill(7),
      protectionProfile: 1 as const,
      packageByteLength: 1234,
      packageByteDigest: new Uint8Array(32).fill(8),
    };
    const bytes = encodeBackupSnapshotManifest({
      ...input,
      snapshotId: backupSnapshotId(input),
    });
    const value = decodeCanonicalValue(bytes);
    if (!(value instanceof Map)) throw new TypeError("test Snapshot must be a map");

    expect(() =>
      encodeBackupSnapshotManifest({ ...input, snapshotId: new Uint8Array(32).fill(9) }),
    ).toThrow(/Snapshot ID/u);
    expect(() =>
      decodeBackupSnapshotManifest(encodeCanonicalValue(new Map([...value, [7, 1]]))),
    ).toThrow(/unknown fields/u);
    expect(() =>
      encodeBackupSnapshotManifest({
        ...input,
        packageByteLength: 0,
        snapshotId: backupSnapshotId({ ...input, packageByteLength: 0 }),
      }),
    ).toThrow(/byte length/u);
  });
});

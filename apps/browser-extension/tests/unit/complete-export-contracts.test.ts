import { describe, expect, it } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { EMPTY_REQUIRED_FEATURE_SET_ID } from "../../src/domain/canonical/features";
import { type Identifier, identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import { prepareCompleteExportEntry } from "../../src/runtime/complete-export/container";
import {
  type CompleteExportManifestInput,
  completeExportStateDigest,
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "../../src/runtime/complete-export/contracts";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function manifestInput(): CompleteExportManifestInput {
  const vaultId = filled("Vault", 1);
  const generationId = filled("Generation", 2);
  const baselineId = filled("VaultRecord", 3);
  const frontierId = filled("VaultRecord", 4);
  const storageItemId = prepareCompleteExportEntry(2, Uint8Array.of(9)).header
    .entryId as Identifier<"StorageItem">;
  return {
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
}

describe("canonical Complete Export contracts", () => {
  it("round-trips one exact self-authenticating Manifest", () => {
    const input = manifestInput();
    const stateDigest = completeExportStateDigest(input);
    const bytes = encodeCompleteExportManifest({ format: 1, ...input, stateDigest });
    const decoded = decodeCompleteExportManifest(bytes);

    expect(decoded).toEqual({
      format: 1,
      ...input,
      typedLogicalRoots: [
        input.typedLogicalRoots[1] as (typeof input.typedLogicalRoots)[number],
        input.typedLogicalRoots[0] as (typeof input.typedLogicalRoots)[number],
      ],
      stateDigest,
    });
    expect(encodeCompleteExportManifest(decoded)).toEqual(bytes);
  });

  it("rejects incorrect state digests and duplicate inventory identities", () => {
    const input = manifestInput();
    expect(() =>
      encodeCompleteExportManifest({ format: 1, ...input, stateDigest: new Uint8Array(32) }),
    ).toThrow(/state digest/u);
    expect(() =>
      completeExportStateDigest({
        ...input,
        opaqueItemInventory: [
          input.opaqueItemInventory[0] as (typeof input.opaqueItemInventory)[number],
          input.opaqueItemInventory[0] as (typeof input.opaqueItemInventory)[number],
        ],
      }),
    ).toThrow(/duplicate/u);
  });

  it("round-trips exact Key Epoch keys and rejects mismatched identities", () => {
    const vaultId = filled("Vault", 7);
    const generationId = filled("Generation", 8);
    const firstKey = new Uint8Array(32).fill(9);
    const secondKey = new Uint8Array(32).fill(10);
    const entries = [
      { keyEpochId: keyEpochId(vaultId, secondKey), keyEpochKey: secondKey },
      { keyEpochId: keyEpochId(vaultId, firstKey), keyEpochKey: firstKey },
    ];
    const encoded = encodeCompleteExportKeyInventory({ vaultId, generationId, entries });
    const decoded = decodeCompleteExportKeyInventory(encoded);

    expect(decoded.format).toBe(1);
    expect(decoded.vaultId).toEqual(vaultId);
    expect(decoded.generationId).toEqual(generationId);
    expect(decoded.entries).toHaveLength(2);
    expect(encodeCompleteExportKeyInventory(decoded)).toEqual(encoded);
    expect(() =>
      encodeCompleteExportKeyInventory({
        vaultId,
        generationId,
        entries: [{ keyEpochId: filled("KeyEpoch", 11), keyEpochKey: firstKey }],
      }),
    ).toThrow(/does not match/u);
  });
});

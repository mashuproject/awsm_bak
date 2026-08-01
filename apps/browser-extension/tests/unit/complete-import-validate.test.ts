import { describe, expect, it, vi } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { EMPTY_REQUIRED_FEATURE_SET_ID } from "../../src/domain/canonical/features";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import {
  prepareCompleteExportEntry,
  sealCompleteExportStream,
  sequenceCompleteExportEntries,
} from "../../src/runtime/complete-export/container";
import {
  type CompleteExportManifestInput,
  completeExportStateDigest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "../../src/runtime/complete-export/contracts";
import {
  type CompleteImportPreparedSink,
  validateCompleteExportPackage,
} from "../../src/runtime/complete-import/validate";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

async function packageBytes(
  options: {
    readonly mismatchedInventory?: boolean;
    readonly missingOpaqueItem?: boolean;
    readonly mismatchedKeyInventoryContext?: boolean;
  } = {},
) {
  const vaultId = filled("Vault", 1);
  const generationId = filled("Generation", 2);
  const baselineId = filled("VaultRecord", 3);
  const frontierId = filled("VaultRecord", 4);
  const epochKey = new Uint8Array(32).fill(5);
  const epochId = keyEpochId(vaultId, epochKey);
  const opaque = prepareCompleteExportEntry(2, Uint8Array.of(9, 8, 7));
  const opaqueItemInventory: CompleteExportManifestInput["opaqueItemInventory"][number][] = [
    {
      namespace: 1,
      logicalId: frontierId,
      storageItemId: identifier("StorageItem", opaque.header.entryId),
      keyEpochId: epochId,
      byteLength: opaque.header.byteLength,
      byteDigest: options.mismatchedInventory
        ? new Uint8Array(32).fill(6)
        : opaque.header.byteDigest,
    },
  ];
  if (options.missingOpaqueItem) {
    opaqueItemInventory.push({
      namespace: 3,
      logicalId: filled("VaultObject", 12),
      storageItemId: filled("StorageItem", 13),
      keyEpochId: epochId,
      byteLength: 1,
      byteDigest: new Uint8Array(32).fill(14),
    });
  }
  const manifestInput: CompleteExportManifestInput = {
    vaultId,
    generationId,
    frontier: [frontierId],
    requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
    typedLogicalRoots: [
      { type: DEPENDENCY_TYPES.VaultRecord, id: frontierId },
      { type: DEPENDENCY_TYPES.VaultBaseline, id: baselineId },
    ],
    opaqueItemInventory,
    continuityProofRoots: [frontierId],
  };
  const manifest = prepareCompleteExportEntry(
    1,
    encodeCompleteExportManifest({
      format: 1,
      ...manifestInput,
      stateDigest: completeExportStateDigest(manifestInput),
    }),
  );
  const inventory = prepareCompleteExportEntry(
    3,
    encodeCompleteExportKeyInventory({
      vaultId,
      generationId: options.mismatchedKeyInventoryContext ? filled("Generation", 15) : generationId,
      entries: [{ keyEpochId: epochId, keyEpochKey: epochKey }],
    }),
  );
  const encrypted: Uint8Array[] = [];
  await sealCompleteExportStream({
    passphrase: "correct horse battery staple",
    salt: new Uint8Array(16).fill(10),
    nonce: new Uint8Array(24).fill(11),
    plaintext: sequenceCompleteExportEntries([manifest, opaque, inventory]),
    write: async (bytes) => {
      encrypted.push(Uint8Array.from(bytes));
    },
  });
  return { encrypted, vaultId, generationId, opaque };
}

describe("canonical Complete Import package validation", () => {
  it("stages every authenticated Opaque item and returns one exact package", async () => {
    const source = await packageBytes();
    const staged = new Map<string, Uint8Array[]>();
    const sink: CompleteImportPreparedSink = {
      beginOpaque: async (item) => {
        const key = Buffer.from(item.storageItemId).toString("hex");
        const chunks: Uint8Array[] = [];
        staged.set(key, chunks);
        return {
          write: async (bytes) => {
            chunks.push(Uint8Array.from(bytes));
          },
          finish: async () => undefined,
          abort: async () => {
            staged.delete(key);
          },
        };
      },
      abortAll: vi.fn(async () => staged.clear()),
    };

    const validated = await validateCompleteExportPackage({
      passphrase: "correct horse battery staple",
      encrypted: (async function* () {
        for (const bytes of source.encrypted) yield bytes;
      })(),
      sink,
    });

    expect(validated.manifest.vaultId).toEqual(source.vaultId);
    expect(validated.keyInventory.generationId).toEqual(source.generationId);
    expect(validated.opaqueItemCount).toBe(1);
    expect([...staged.values()].flat()).toEqual([Uint8Array.of(9, 8, 7)]);
    expect(sink.abortAll).not.toHaveBeenCalled();
  }, 15_000);

  it("aborts all Prepared Data when the Manifest inventory disagrees", async () => {
    const source = await packageBytes({ mismatchedInventory: true });
    const abortAll = vi.fn(async () => undefined);
    const sink: CompleteImportPreparedSink = {
      beginOpaque: async () => ({
        write: async () => undefined,
        finish: async () => undefined,
        abort: async () => undefined,
      }),
      abortAll,
    };

    await expect(
      validateCompleteExportPackage({
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          for (const bytes of source.encrypted) yield bytes;
        })(),
        sink,
      }),
    ).rejects.toThrow(/Manifest inventory/u);
    expect(abortAll).toHaveBeenCalledOnce();
  }, 15_000);

  it("rejects a package that omits an Opaque item declared by its Manifest", async () => {
    const source = await packageBytes({ missingOpaqueItem: true });
    const abortAll = vi.fn(async () => undefined);
    const sink: CompleteImportPreparedSink = {
      beginOpaque: async () => ({
        write: async () => undefined,
        finish: async () => undefined,
        abort: async () => undefined,
      }),
      abortAll,
    };

    await expect(
      validateCompleteExportPackage({
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          for (const bytes of source.encrypted) yield bytes;
        })(),
        sink,
      }),
    ).rejects.toThrow(/Manifest inventory is incomplete/u);
    expect(abortAll).toHaveBeenCalledOnce();
  }, 15_000);

  it("rejects a Key Inventory for a different Vault context", async () => {
    const source = await packageBytes({ mismatchedKeyInventoryContext: true });
    const abortAll = vi.fn(async () => undefined);
    const sink: CompleteImportPreparedSink = {
      beginOpaque: async () => ({
        write: async () => undefined,
        finish: async () => undefined,
        abort: async () => undefined,
      }),
      abortAll,
    };

    await expect(
      validateCompleteExportPackage({
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          for (const bytes of source.encrypted) yield bytes;
        })(),
        sink,
      }),
    ).rejects.toThrow(/Key Inventory context/u);
    expect(abortAll).toHaveBeenCalledOnce();
  }, 15_000);

  it("aborts the active writer and all Prepared Data after a staging write fails", async () => {
    const source = await packageBytes();
    const abort = vi.fn(async () => undefined);
    const abortAll = vi.fn(async () => undefined);
    const sink: CompleteImportPreparedSink = {
      beginOpaque: async () => ({
        write: async () => {
          throw new Error("prepared storage failed");
        },
        finish: async () => undefined,
        abort,
      }),
      abortAll,
    };

    await expect(
      validateCompleteExportPackage({
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          for (const bytes of source.encrypted) yield bytes;
        })(),
        sink,
      }),
    ).rejects.toThrow("prepared storage failed");
    expect(abort).toHaveBeenCalledOnce();
    expect(abortAll).toHaveBeenCalledOnce();
  }, 15_000);
});

import { concatBytes } from "../../domain/canonical/transcript";
import { bytesEqual } from "../../domain/hash";
import { openCompleteExportEntries } from "../complete-export/container";
import {
  type CompleteExportKeyInventory,
  type CompleteExportManifest,
  type CompleteExportOpaqueItem,
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
} from "../complete-export/contracts";

export interface CompleteImportPreparedWriter {
  readonly write: (bytes: Uint8Array) => Promise<void>;
  readonly finish: () => Promise<void>;
  readonly abort: () => Promise<void>;
}

export interface CompleteImportPreparedSink {
  readonly beginOpaque: (item: CompleteExportOpaqueItem) => Promise<CompleteImportPreparedWriter>;
  readonly abortAll: () => Promise<void>;
}

export interface ValidatedCompleteExportPackage {
  readonly manifest: CompleteExportManifest;
  readonly keyInventory: CompleteExportKeyInventory;
  readonly opaqueItemCount: number;
  readonly frameCount: number;
}

function key(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateCompleteExportPackage(input: {
  readonly passphrase: string;
  readonly encrypted: AsyncIterable<Uint8Array>;
  readonly sink: CompleteImportPreparedSink;
}): Promise<ValidatedCompleteExportPackage> {
  let manifest: CompleteExportManifest | undefined;
  let keyInventory: CompleteExportKeyInventory | undefined;
  let metadataChunks: Uint8Array[] = [];
  let activeWriter: CompleteImportPreparedWriter | undefined;
  let activeOpaqueItem: CompleteExportOpaqueItem | undefined;
  let opaqueByStorageId: ReadonlyMap<string, CompleteExportOpaqueItem> | undefined;
  const stagedStorageIds = new Set<string>();

  try {
    const opened = await openCompleteExportEntries({
      passphrase: input.passphrase,
      encrypted: input.encrypted,
      onEntryStart: async (header) => {
        if (header.kind === 1 || header.kind === 3) {
          metadataChunks = [];
          return;
        }
        if (manifest === undefined || opaqueByStorageId === undefined) {
          throw new TypeError("Complete Export Manifest must be validated before Opaque items");
        }
        const storageId = key(header.entryId);
        const item = opaqueByStorageId.get(storageId);
        if (
          item === undefined ||
          item.byteLength !== header.byteLength ||
          !bytesEqual(item.byteDigest, header.byteDigest)
        ) {
          throw new TypeError("Complete Export Manifest inventory disagrees with an Opaque item");
        }
        if (stagedStorageIds.has(storageId)) {
          throw new TypeError("Complete Export Manifest inventory contains a repeated Opaque item");
        }
        activeOpaqueItem = item;
        activeWriter = await input.sink.beginOpaque(item);
      },
      onEntryChunk: async (header, bytes) => {
        if (header.kind === 2) {
          if (activeWriter === undefined) {
            throw new TypeError("Complete Import has no Prepared Data writer");
          }
          await activeWriter.write(bytes);
          return;
        }
        metadataChunks.push(Uint8Array.from(bytes));
      },
      onEntryEnd: async (header) => {
        if (header.kind === 1) {
          manifest = decodeCompleteExportManifest(concatBytes(metadataChunks));
          opaqueByStorageId = new Map(
            manifest.opaqueItemInventory.map((item) => [key(item.storageItemId), item]),
          );
          metadataChunks = [];
          return;
        }
        if (header.kind === 2) {
          if (activeWriter === undefined || activeOpaqueItem === undefined) {
            throw new TypeError("Complete Import has no active Opaque item");
          }
          await activeWriter.finish();
          stagedStorageIds.add(key(activeOpaqueItem.storageItemId));
          activeWriter = undefined;
          activeOpaqueItem = undefined;
          return;
        }
        keyInventory = decodeCompleteExportKeyInventory(concatBytes(metadataChunks));
        metadataChunks = [];
      },
    });

    if (manifest === undefined || keyInventory === undefined) {
      throw new TypeError("Complete Export package is incomplete");
    }
    if (
      !bytesEqual(keyInventory.vaultId, manifest.vaultId) ||
      !bytesEqual(keyInventory.generationId, manifest.generationId)
    ) {
      throw new TypeError("Complete Export Key Inventory context disagrees with the Manifest");
    }
    if (
      stagedStorageIds.size !== manifest.opaqueItemInventory.length ||
      manifest.opaqueItemInventory.some((item) => !stagedStorageIds.has(key(item.storageItemId)))
    ) {
      throw new TypeError("Complete Export Manifest inventory is incomplete");
    }
    return {
      manifest,
      keyInventory,
      opaqueItemCount: stagedStorageIds.size,
      frameCount: opened.frameCount,
    };
  } catch (error) {
    await activeWriter?.abort().catch(() => undefined);
    await input.sink.abortAll().catch(() => undefined);
    throw error;
  }
}

import { sealArtifactFrames } from "../../crypto/artifact-stream";
import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../../runtime/artifact/canonical-store";
import { createStorageItemIdHasher } from "../../storage/opaque-envelope";

const ROOT_DIRECTORY = "awsm-canonical-artifacts";
const PREPARED_DIRECTORY = "prepared";
const ITEMS_DIRECTORY = "items";
const ITEM_SUFFIX = ".opaque";

function storageKey(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function itemFilename(storageItemId: Identifier<"StorageItem">): string {
  return `${storageKey(storageItemId)}${ITEM_SUFFIX}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function mapStorageError(error: unknown): unknown {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? Object.assign(new Error("There is not enough local storage to preserve this Artifact."), {
        id: "STORAGE_QUOTA_EXCEEDED",
      })
    : error;
}

async function rootDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIRECTORY, { create: true });
}

async function subdirectory(name: string): Promise<FileSystemDirectoryHandle> {
  return (await rootDirectory()).getDirectoryHandle(name, { create: true });
}

async function removeIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  await directory.removeEntry(name).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
}

async function writeBytes(
  writable: FileSystemWritableFileStream,
  bytes: Uint8Array,
): Promise<void> {
  await writable.write(Uint8Array.from(bytes).buffer);
}

async function copyFile(input: {
  readonly file: File;
  readonly writable: FileSystemWritableFileStream;
  readonly onChunk?: (chunk: Uint8Array) => void;
}): Promise<number> {
  const reader = input.file.stream().getReader();
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (!Number.isSafeInteger(length)) throw new RangeError("Artifact wrapper is too large");
      input.onChunk?.(next.value);
      await writeBytes(input.writable, next.value);
    }
    return length;
  } finally {
    reader.releaseLock();
  }
}

async function fileStorageItemId(file: File): Promise<Identifier<"StorageItem">> {
  const hasher = createStorageItemIdHasher(file.size);
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hasher.update(next.value);
    }
    return hasher.digest();
  } finally {
    reader.releaseLock();
  }
}

async function matchingItem(
  directory: FileSystemDirectoryHandle,
  name: string,
  expected: Identifier<"StorageItem">,
): Promise<boolean> {
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    return bytesEqual(await fileStorageItemId(file), expected);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export class CanonicalOpfsArtifactStore implements CanonicalArtifactStore {
  async prepare(
    input: Parameters<CanonicalArtifactStore["prepare"]>[0],
  ): Promise<PreparedArtifactRepresentation> {
    const prepared = await subdirectory(PREPARED_DIRECTORY);
    const preparationId = crypto.randomUUID();
    const frameName = `${preparationId}.frames`;
    const envelopeName = `${preparationId}.opaque`;
    let frameWritable: FileSystemWritableFileStream | undefined;
    let envelopeWritable: FileSystemWritableFileStream | undefined;
    try {
      const frameHandle = await prepared.getFileHandle(frameName, { create: true });
      frameWritable = await frameHandle.createWritable({ keepExistingData: false });
      const stream = await sealArtifactFrames({
        ...input,
        writeFrame: async (frame) =>
          writeBytes(frameWritable as FileSystemWritableFileStream, frame),
      });
      await frameWritable.close();
      frameWritable = undefined;
      const frameFile = await frameHandle.getFile();
      if (frameFile.size !== stream.ciphertextLength) {
        throw new Error("Prepared Artifact frames were truncated");
      }

      const envelopeLength = stream.envelopePrefix.prefixBytes.byteLength + frameFile.size;
      const itemHasher = createStorageItemIdHasher(envelopeLength);
      const envelopeHandle = await prepared.getFileHandle(envelopeName, { create: true });
      envelopeWritable = await envelopeHandle.createWritable({ keepExistingData: false });
      itemHasher.update(stream.envelopePrefix.prefixBytes);
      await writeBytes(envelopeWritable, stream.envelopePrefix.prefixBytes);
      const copiedFrames = await copyFile({
        file: frameFile,
        writable: envelopeWritable,
        onChunk: (chunk) => itemHasher.update(chunk),
      });
      if (copiedFrames !== stream.ciphertextLength) {
        throw new Error("Prepared Artifact frame copy was truncated");
      }
      await envelopeWritable.close();
      envelopeWritable = undefined;
      const storageItemId = itemHasher.digest();
      if ((await envelopeHandle.getFile()).size !== envelopeLength) {
        throw new Error("Prepared Artifact envelope was truncated");
      }
      await removeIfPresent(prepared, frameName);
      let promoted = false;
      let discarded = false;
      return {
        artifactId: input.artifactId,
        storageItemId,
        envelopeByteLength: envelopeLength,
        stream,
        promote: async () => {
          if (discarded) throw new Error("Prepared Artifact was already discarded");
          if (promoted) return;
          const items = await subdirectory(ITEMS_DIRECTORY);
          const finalName = itemFilename(storageItemId);
          if (await matchingItem(items, finalName, storageItemId)) {
            await removeIfPresent(prepared, envelopeName);
            promoted = true;
            return;
          }
          await removeIfPresent(items, finalName);
          let finalWritable: FileSystemWritableFileStream | undefined;
          try {
            const finalHandle = await items.getFileHandle(finalName, { create: true });
            finalWritable = await finalHandle.createWritable({ keepExistingData: false });
            const copied = await copyFile({
              file: await envelopeHandle.getFile(),
              writable: finalWritable,
            });
            if (copied !== envelopeLength) throw new Error("Artifact promotion was truncated");
            await finalWritable.close();
            finalWritable = undefined;
            if (!(await matchingItem(items, finalName, storageItemId))) {
              throw new Error("Promoted Artifact failed its Storage Item identity check");
            }
            promoted = true;
            await removeIfPresent(prepared, envelopeName);
          } catch (error) {
            await finalWritable?.abort().catch(() => undefined);
            await removeIfPresent(items, finalName);
            throw mapStorageError(error);
          }
        },
        discard: async () => {
          discarded = true;
          await Promise.all([
            removeIfPresent(prepared, frameName),
            removeIfPresent(prepared, envelopeName),
          ]);
          // A promoted content-addressed item may already have been adopted by another
          // transaction. Unreferenced durable items are removed by reconcile(), not here.
        },
      };
    } catch (error) {
      await frameWritable?.abort().catch(() => undefined);
      await envelopeWritable?.abort().catch(() => undefined);
      await Promise.all([
        removeIfPresent(prepared, frameName),
        removeIfPresent(prepared, envelopeName),
      ]).catch(() => undefined);
      throw mapStorageError(error);
    }
  }

  async has(storageItemId: Identifier<"StorageItem">): Promise<boolean> {
    return matchingItem(
      await subdirectory(ITEMS_DIRECTORY),
      itemFilename(storageItemId),
      storageItemId,
    );
  }

  async open(storageItemId: Identifier<"StorageItem">): Promise<ReadableStream<Uint8Array>> {
    const items = await subdirectory(ITEMS_DIRECTORY);
    const name = itemFilename(storageItemId);
    if (!(await matchingItem(items, name, storageItemId))) {
      throw new Error("Artifact wrapper is unavailable or corrupt");
    }
    return (await (await items.getFileHandle(name)).getFile()).stream();
  }

  async remove(storageItemId: Identifier<"StorageItem">): Promise<void> {
    await removeIfPresent(await subdirectory(ITEMS_DIRECTORY), itemFilename(storageItemId));
  }

  async reconcile(retainedStorageItemKeys: ReadonlySet<string>): Promise<void> {
    const prepared = await subdirectory(PREPARED_DIRECTORY);
    for await (const [name] of prepared.entries()) await removeIfPresent(prepared, name);
    const items = await subdirectory(ITEMS_DIRECTORY);
    for await (const [name, handle] of items.entries()) {
      const key = name.endsWith(ITEM_SUFFIX) ? name.slice(0, -ITEM_SUFFIX.length) : undefined;
      if (
        handle.kind !== "file" ||
        key === undefined ||
        !/^[0-9a-f]{64}$/u.test(key) ||
        !retainedStorageItemKeys.has(key)
      ) {
        await removeIfPresent(items, name);
      }
    }
  }
}

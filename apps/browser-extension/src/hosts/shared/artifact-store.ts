import { readArtifactEnvelope, writeArtifactEnvelope } from "../../crypto/artifact-envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { readySodium, wipe } from "../../crypto/sodium";
import { bytesEqual } from "../../domain/hash";
import { uuid } from "../../domain/validation";
import type { StoredArtifactObjectV1 } from "../../drivers/indexeddb/schema";
import type { ArtifactStore, PreparedArtifact } from "../../runtime/artifact";
import type { VaultKeyring } from "../../runtime/vault/keyring";
import { storedArtifactFileMatches, streamChunks } from "./artifact-store-file";

const ROOT_DIRECTORY = "awsm-vault-objects";
const SUFFIX = ".artifact";

async function rootDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_DIRECTORY, { create: true });
}

async function vaultDirectory(vaultId: string): Promise<FileSystemDirectoryHandle> {
  const scoped = uuid(vaultId, "artifactStore.vaultId");
  return (await rootDirectory()).getDirectoryHandle(scoped, { create: true });
}

function filename(objectId: string): string {
  return `${uuid(objectId, "artifactStore.objectId")}${SUFFIX}`;
}

function importStorageError(error: unknown): unknown {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? Object.assign(new Error("There is not enough local storage to import this Vault."), {
        id: "STORAGE_QUOTA_EXCEEDED",
      })
    : error;
}

async function fileStream(vaultId: string, objectId: string): Promise<ReadableStream<Uint8Array>> {
  const directory = await vaultDirectory(vaultId);
  const handle = await directory.getFileHandle(filename(objectId));
  return (await handle.getFile()).stream();
}

export class OpfsArtifactStore implements ArtifactStore {
  async prepare(input: {
    readonly vaultId: string;
    readonly objectId: string;
    readonly keyring: VaultKeyring;
    readonly plaintext: AsyncIterable<Uint8Array>;
    readonly noncePrefix?: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<PreparedArtifact> {
    const vaultId = uuid(input.vaultId, "artifactStore.vaultId");
    const objectId = uuid(input.objectId, "artifactStore.objectId");
    const directory = await vaultDirectory(vaultId);
    const name = filename(objectId);
    try {
      await directory.getFileHandle(name);
      throw new Error("An Artifact Object identifier already exists.");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    const epoch = input.keyring.active();
    const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
      vaultId,
      keyEpochId: epoch.keyEpochId,
      domain: "vault:artifact:v1",
      contextId: objectId,
      keyVersion: 1,
    });
    try {
      const summary = await writeArtifactEnvelope({
        objectId,
        keyEpochId: epoch.keyEpochId,
        key,
        plaintext: input.plaintext,
        write: (value) => writable.write(Uint8Array.from(value).buffer),
        ...(input.noncePrefix === undefined ? {} : { noncePrefix: input.noncePrefix }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      await writable.close();
      const stored = await handle.getFile();
      if (stored.size !== summary.envelopeByteLength)
        throw new Error("Artifact write was truncated.");
      return {
        object: {
          version: 1,
          objectId,
          objectType: "Artifact",
          keyEpochId: epoch.keyEpochId,
          envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
          envelopeByteLength: summary.envelopeByteLength,
          envelopeChecksumAlgorithm: "hash:sha256:v1",
          envelopeChecksum: summary.envelopeChecksum,
        },
        plaintextByteLength: summary.plaintextByteLength,
        plaintextChecksum: summary.plaintextChecksum,
      };
    } catch (error) {
      await writable.abort().catch(() => undefined);
      await directory.removeEntry(name).catch(() => undefined);
      throw error;
    } finally {
      await wipe(key);
    }
  }

  async prepareEncrypted(input: {
    readonly vaultId: string;
    readonly object: StoredArtifactObjectV1;
    readonly encrypted: ReadableStream<Uint8Array>;
    readonly signal?: AbortSignal;
    readonly afterFirstWrite?: () => Promise<void>;
  }): Promise<void> {
    const vaultId = uuid(input.vaultId, "artifactStore.vaultId");
    const objectId = uuid(input.object.objectId, "artifactStore.objectId");
    const directory = await vaultDirectory(vaultId);
    const name = filename(objectId);
    try {
      const existing = await directory.getFileHandle(name);
      const file = await existing.getFile();
      const matches = await storedArtifactFileMatches(file, input.object);
      if (matches) {
        await input.encrypted.cancel();
        return;
      }
      await directory.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
    const reader = input.encrypted.getReader();
    const sodium = await readySodium();
    const hash = sodium.crypto_hash_sha256_init();
    let byteLength = 0;
    let wroteChunk = false;
    let writable: FileSystemWritableFileStream | undefined;
    try {
      const handle = await directory.getFileHandle(name, { create: true });
      writable = await handle.createWritable({ keepExistingData: false });
      for (;;) {
        input.signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        byteLength += next.value.byteLength;
        if (!Number.isSafeInteger(byteLength)) throw new Error("Artifact wrapper is too large.");
        sodium.crypto_hash_sha256_update(hash, next.value);
        await writable.write(Uint8Array.from(next.value).buffer);
        if (!wroteChunk) {
          wroteChunk = true;
          await input.afterFirstWrite?.();
        }
      }
      const checksum = Uint8Array.from(sodium.crypto_hash_sha256_final(hash));
      if (
        byteLength !== input.object.envelopeByteLength ||
        !bytesEqual(checksum, input.object.envelopeChecksum)
      ) {
        throw new Error("Artifact wrapper does not match its authoritative Object record.");
      }
      await writable.close();
      if ((await handle.getFile()).size !== byteLength)
        throw new Error("Artifact write was truncated.");
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      await writable?.abort().catch(() => undefined);
      await directory.removeEntry(name).catch(() => undefined);
      throw importStorageError(error);
    } finally {
      reader.releaseLock();
    }
  }

  openEncrypted(vaultId: string, objectId: string): Promise<ReadableStream<Uint8Array>> {
    return fileStream(vaultId, objectId);
  }

  async has(vaultId: string, objectId: string): Promise<boolean> {
    const directory = await vaultDirectory(vaultId);
    try {
      await directory.getFileHandle(filename(objectId));
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return false;
      throw error;
    }
  }

  async verifyEncrypted(vaultId: string, object: StoredArtifactObjectV1): Promise<boolean> {
    const directory = await vaultDirectory(vaultId);
    const handle = await directory.getFileHandle(filename(object.objectId));
    return storedArtifactFileMatches(await handle.getFile(), object);
  }

  async openPlaintext(input: {
    readonly vaultId: string;
    readonly object: StoredArtifactObjectV1;
    readonly reference: import("../../domain/artifact-graph").ArtifactReferenceV1;
    readonly keyring: VaultKeyring;
    readonly signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const vaultId = uuid(input.vaultId, "artifactStore.vaultId");
    if (input.object.objectId !== input.reference.artifactObjectId)
      throw new Error("Artifact reference does not match its Object record.");
    const encrypted = await fileStream(vaultId, input.object.objectId);
    const epoch = input.keyring.require(input.object.keyEpochId);
    const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
      vaultId,
      keyEpochId: epoch.keyEpochId,
      domain: "vault:artifact:v1",
      contextId: input.object.objectId,
      keyVersion: 1,
    });
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transform.writable.getWriter();
    void readArtifactEnvelope({
      expectedObjectId: input.object.objectId,
      expectedKeyEpochId: epoch.keyEpochId,
      key,
      encrypted: streamChunks(encrypted),
      write: (value) => writer.write(value),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
      .then(async (summary) => {
        if (
          summary.envelopeByteLength !== input.object.envelopeByteLength ||
          !bytesEqual(summary.envelopeChecksum, input.object.envelopeChecksum) ||
          summary.plaintextByteLength !== input.reference.plaintextByteLength ||
          !bytesEqual(summary.plaintextChecksum, input.reference.plaintextChecksum)
        ) {
          throw new Error("Artifact integrity does not match its authoritative records.");
        }
        await writer.close();
      })
      .catch(async (error) => writer.abort(error))
      .finally(async () => wipe(key));
    return transform.readable;
  }

  async remove(vaultId: string, objectId: string): Promise<void> {
    const directory = await vaultDirectory(vaultId);
    await directory.removeEntry(filename(objectId)).catch((error) => {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    });
  }

  async reconcile(vaultId: string, authoritativeIds: ReadonlySet<string>): Promise<void> {
    const directory = await vaultDirectory(vaultId);
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      const objectId = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : undefined;
      if (objectId === undefined || !authoritativeIds.has(objectId)) {
        await directory.removeEntry(name);
      }
    }
  }
}

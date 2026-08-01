import { sha256 } from "@noble/hashes/sha2.js";

import { type EncryptedArtifactFrame, openArtifactFrames } from "../../crypto/artifact-stream";
import type { Identifier } from "../../domain/canonical/identifiers";
import { ARTIFACT_OBJECT, artifactId, type VaultObject } from "../../domain/canonical/object";
import {
  exactMap,
  identifierValue,
  mapValue,
  nonnegativeInteger,
} from "../../domain/canonical/schema";
import { concatBytes } from "../../domain/canonical/transcript";
import { bytesEqual } from "../../domain/hash";
import {
  createStorageItemIdHasher,
  decodeOpaqueEnvelopePrefix,
  STREAMABLE_STORAGE_CLASS,
} from "../../storage/opaque-envelope";
import type { CanonicalArtifactStore } from "./canonical-store";

class StreamBytes {
  private readonly queued: Uint8Array[] = [];
  private queuedLength = 0;
  private done = false;

  constructor(readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async exact(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError("Stream read length must be a nonnegative safe integer");
    }
    while (this.queuedLength < length && !this.done) {
      const next = await this.reader.read();
      if (next.done) {
        this.done = true;
        break;
      }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Artifact wrapper stream chunks must be nonempty bytes");
      }
      this.queued.push(next.value);
      this.queuedLength += next.value.byteLength;
    }
    if (this.queuedLength < length) throw new TypeError("Artifact wrapper stream is truncated");
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const first = this.queued[0];
      if (first === undefined) throw new TypeError("Artifact wrapper stream is truncated");
      const take = Math.min(first.byteLength, length - written);
      result.set(first.subarray(0, take), written);
      written += take;
      this.queuedLength -= take;
      if (take === first.byteLength) this.queued.shift();
      else this.queued[0] = first.subarray(take);
    }
    return result;
  }

  async requireEnd(): Promise<void> {
    if (this.queuedLength !== 0) throw new TypeError("Artifact wrapper has trailing bytes");
    if (!this.done) {
      const next = await this.reader.read();
      if (!next.done) throw new TypeError("Artifact wrapper has trailing bytes");
      this.done = true;
    }
  }
}

function artifactContract(object: VaultObject) {
  if (object.objectType !== ARTIFACT_OBJECT) {
    throw new TypeError("Artifact verification requires an Artifact Object");
  }
  const body = exactMap(object.body, [...Array(8).keys()], "Artifact Object body");
  return {
    plaintextLength: nonnegativeInteger(mapValue(body, 4), "Artifact plaintext length"),
    plaintextDigest: identifierValue(mapValue(body, 5), "Artifact", "Artifact plaintext digest"),
  };
}

export async function verifyCanonicalArtifactRepresentation(input: {
  readonly store: CanonicalArtifactStore;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly object: VaultObject;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly writePlaintext: (plaintext: Uint8Array, frameIndex: number) => Promise<void>;
}): Promise<{ readonly byteLength: number; readonly byteDigest: Uint8Array }> {
  const reader = (await input.store.open(input.storageItemId)).getReader();
  const bytes = new StreamBytes(reader);
  let lockReleased = false;
  try {
    const fixedPrefix = await bytes.exact(12);
    const headerLength = new DataView(fixedPrefix.buffer, fixedPrefix.byteOffset + 8, 4).getUint32(
      0,
      false,
    );
    if (headerLength < 1 || headerLength > 4096) {
      throw new TypeError("Artifact wrapper header length is invalid");
    }
    const prefix = decodeOpaqueEnvelopePrefix(
      concatBytes([fixedPrefix, await bytes.exact(headerLength)]),
    );
    if (prefix.storageClass !== STREAMABLE_STORAGE_CLASS) {
      throw new TypeError("Artifact wrapper must use the Streamable storage class");
    }
    const byteLength = prefix.prefixBytes.byteLength + prefix.ciphertextLength;
    const itemHasher = createStorageItemIdHasher(byteLength);
    const byteDigest = sha256.create();
    itemHasher.update(prefix.prefixBytes);
    byteDigest.update(prefix.prefixBytes);
    const frames = (async function* (): AsyncIterable<EncryptedArtifactFrame> {
      let remaining = prefix.ciphertextLength;
      try {
        while (remaining > 0) {
          if (remaining < 9) throw new TypeError("Artifact wrapper frame prefix is truncated");
          const framePrefix = await bytes.exact(9);
          const view = new DataView(framePrefix.buffer, framePrefix.byteOffset, 9);
          const index = view.getUint32(0, false);
          const flags = view.getUint8(4);
          const ciphertextLength = view.getUint32(5, false);
          if ((flags & 0xfe) !== 0 || ciphertextLength > remaining - 9) {
            throw new TypeError("Artifact wrapper frame metadata is invalid");
          }
          const ciphertext = await bytes.exact(ciphertextLength);
          itemHasher.update(framePrefix);
          itemHasher.update(ciphertext);
          byteDigest.update(framePrefix);
          byteDigest.update(ciphertext);
          remaining -= 9 + ciphertextLength;
          yield { index, final: (flags & 1) === 1, ciphertext };
        }
        await bytes.requireEnd();
        if (!bytesEqual(itemHasher.digest(), input.storageItemId)) {
          throw new TypeError("Artifact wrapper Storage Item identity is invalid");
        }
      } finally {
        reader.releaseLock();
        lockReleased = true;
      }
    })();
    await openArtifactFrames({
      vaultId: input.object.vaultId,
      keyEpochId: input.keyEpochId,
      keyEpochKey: input.keyEpochKey,
      artifactId: artifactId(input.object),
      contract: artifactContract(input.object),
      protectionParameters: prefix.protectionParameters,
      ciphertextLength: prefix.ciphertextLength,
      ciphertextDigest: prefix.ciphertextDigest,
      frames,
      writePlaintext: input.writePlaintext,
    });
    return { byteLength, byteDigest: byteDigest.digest() };
  } catch (error) {
    if (!lockReleased) await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (!lockReleased) reader.releaseLock();
  }
}

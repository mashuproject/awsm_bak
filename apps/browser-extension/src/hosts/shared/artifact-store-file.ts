import { readySodium } from "../../crypto/sodium";
import { bytesEqual } from "../../domain/hash";
import type { StoredArtifactObjectV1 } from "../../drivers/indexeddb/schema";

export async function storedArtifactFileMatches(
  file: File,
  object: StoredArtifactObjectV1,
): Promise<boolean> {
  if (file.size !== object.envelopeByteLength) return false;
  const sodium = await readySodium();
  const hash = sodium.crypto_hash_sha256_init();
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      sodium.crypto_hash_sha256_update(hash, next.value);
    }
    return bytesEqual(
      Uint8Array.from(sodium.crypto_hash_sha256_final(hash)),
      object.envelopeChecksum,
    );
  } finally {
    reader.releaseLock();
  }
}

export async function* streamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

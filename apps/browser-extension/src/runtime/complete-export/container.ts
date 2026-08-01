import { sha256 } from "@noble/hashes/sha2.js";

import { frameNonce } from "../../crypto/canonical";
import { derivePassphraseKey } from "../../crypto/passphrase";
import { xchachaDecrypt, xchachaEncrypt } from "../../crypto/xchacha";
import {
  concatBytes,
  transcript,
  uint8,
  uint32be,
  uint64be,
} from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { createStorageItemIdHasher } from "../../storage/opaque-envelope";

export const COMPLETE_EXPORT_MAGIC = Uint8Array.of(0x41, 0x57, 0x53, 0x4d, 0x45, 0x58, 0x01, 0x00);
export const COMPLETE_EXPORT_FORMAT = 1 as const;
export const COMPLETE_EXPORT_MEMORY_KIB = 65_536 as const;
export const COMPLETE_EXPORT_ITERATIONS = 3 as const;
export const COMPLETE_EXPORT_PARALLELISM = 1 as const;
export const COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT = 1_048_576 as const;
const FRAME_TAG_LENGTH = 16;
const FRAME_PREFIX_LENGTH = 9;

export interface CompleteExportPrefix {
  readonly format: typeof COMPLETE_EXPORT_FORMAT;
  readonly salt: Uint8Array;
  readonly memoryKiB: typeof COMPLETE_EXPORT_MEMORY_KIB;
  readonly iterations: typeof COMPLETE_EXPORT_ITERATIONS;
  readonly parallelism: typeof COMPLETE_EXPORT_PARALLELISM;
  readonly nonce: Uint8Array;
  readonly framePlaintextLimit: typeof COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT;
  readonly bytes: Uint8Array;
  readonly prefixBytes: Uint8Array;
}

export type CompleteExportEntryKind = 1 | 2 | 3;

export interface CompleteExportEntryHeader {
  readonly kind: CompleteExportEntryKind;
  readonly entryId: Uint8Array;
  readonly byteLength: number;
  readonly byteDigest: Uint8Array;
}

export interface CompleteExportEntry {
  readonly header: CompleteExportEntryHeader;
  readonly bytes: AsyncIterable<Uint8Array>;
}

function exactBytes(value: CanonicalValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new TypeError(`${field} must contain exactly ${length} bytes`);
  }
  return Uint8Array.from(value);
}

function exactCode<Value extends number>(
  value: CanonicalValue,
  expected: Value,
  field: string,
): Value {
  if (value !== expected) throw new TypeError(`${field} is unsupported`);
  return expected;
}

function headerValue(salt: Uint8Array, nonce: Uint8Array): ReadonlyMap<number, CanonicalValue> {
  if (salt.byteLength !== 16) throw new TypeError("Complete Export salt must contain 16 bytes");
  if (nonce.byteLength !== 24) throw new TypeError("Complete Export nonce must contain 24 bytes");
  return canonicalMap([
    [0, COMPLETE_EXPORT_FORMAT],
    [1, Uint8Array.from(salt)],
    [2, COMPLETE_EXPORT_MEMORY_KIB],
    [3, COMPLETE_EXPORT_ITERATIONS],
    [4, COMPLETE_EXPORT_PARALLELISM],
    [5, Uint8Array.from(nonce)],
    [6, COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT],
  ]);
}

export function encodeCompleteExportPrefix(input: {
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
}): Uint8Array {
  const headerBytes = encodeCanonicalValue(headerValue(input.salt, input.nonce));
  return concatBytes([COMPLETE_EXPORT_MAGIC, uint32be(headerBytes.byteLength), headerBytes]);
}

export function decodeCompleteExportPrefix(prefixBytes: Uint8Array): CompleteExportPrefix {
  if (prefixBytes.byteLength < COMPLETE_EXPORT_MAGIC.byteLength + 4 + 1) {
    throw new TypeError("Complete Export prefix is truncated");
  }
  if (!bytesEqual(prefixBytes.slice(0, COMPLETE_EXPORT_MAGIC.byteLength), COMPLETE_EXPORT_MAGIC)) {
    throw new TypeError("Complete Export magic is invalid");
  }
  const headerLength = new DataView(
    prefixBytes.buffer,
    prefixBytes.byteOffset + COMPLETE_EXPORT_MAGIC.byteLength,
    4,
  ).getUint32(0, false);
  if (prefixBytes.byteLength !== COMPLETE_EXPORT_MAGIC.byteLength + 4 + headerLength) {
    throw new TypeError("Complete Export decoder requires one exact prefix");
  }
  const bytes = prefixBytes.slice(COMPLETE_EXPORT_MAGIC.byteLength + 4);
  const decoded = decodeCanonicalValue(bytes);
  if (!(decoded instanceof Map) || decoded.size !== 7) {
    throw new TypeError("Complete Export header must contain the exact fields");
  }
  for (let index = 0; index < 7; index += 1) {
    if (!decoded.has(index)) throw new TypeError("Complete Export header omits a field");
  }
  const format = exactCode(decoded.get(0) ?? null, COMPLETE_EXPORT_FORMAT, "Export format");
  const salt = exactBytes(decoded.get(1) ?? null, 16, "Complete Export salt");
  const memoryKiB = exactCode(decoded.get(2) ?? null, COMPLETE_EXPORT_MEMORY_KIB, "Argon2 memory");
  const iterations = exactCode(
    decoded.get(3) ?? null,
    COMPLETE_EXPORT_ITERATIONS,
    "Argon2 iterations",
  );
  const parallelism = exactCode(
    decoded.get(4) ?? null,
    COMPLETE_EXPORT_PARALLELISM,
    "Argon2 parallelism",
  );
  const nonce = exactBytes(decoded.get(5) ?? null, 24, "Complete Export nonce");
  const framePlaintextLimit = exactCode(
    decoded.get(6) ?? null,
    COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT,
    "Complete Export frame plaintext limit",
  );
  if (!bytesEqual(bytes, encodeCanonicalValue(headerValue(salt, nonce)))) {
    throw new TypeError("Complete Export header is not canonical");
  }
  return {
    format,
    salt,
    memoryKiB,
    iterations,
    parallelism,
    nonce,
    framePlaintextLimit,
    bytes,
    prefixBytes: Uint8Array.from(prefixBytes),
  };
}

export async function deriveCompleteExportKey(
  passphrase: string,
  prefix: CompleteExportPrefix,
): Promise<Uint8Array> {
  const validated = decodeCompleteExportPrefix(prefix.prefixBytes);
  if (!bytesEqual(validated.bytes, prefix.bytes)) {
    throw new TypeError("Complete Export prefix bytes are inconsistent");
  }
  const normalized = passphrase.normalize("NFC");
  if (new TextEncoder().encode(normalized).byteLength > 1024) {
    throw new TypeError("Complete Export passphrase exceeds the portable bound");
  }
  return derivePassphraseKey({
    passphrase: normalized,
    salt: validated.salt,
    operations: validated.iterations,
    memoryBytes: validated.memoryKiB * 1024,
  });
}

function assertCompleteExportEntryHeader(
  input: CompleteExportEntryHeader,
): CompleteExportEntryHeader {
  if (input.kind !== 1 && input.kind !== 2 && input.kind !== 3) {
    throw new TypeError("Complete Export entry kind is unsupported");
  }
  if (input.entryId.byteLength !== 32) {
    throw new TypeError("Complete Export Entry ID must contain exactly 32 bytes");
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new TypeError("Complete Export entry byte length must be a nonnegative safe integer");
  }
  if (input.byteDigest.byteLength !== 32) {
    throw new TypeError("Complete Export entry digest must contain exactly 32 bytes");
  }
  return {
    kind: input.kind,
    entryId: Uint8Array.from(input.entryId),
    byteLength: input.byteLength,
    byteDigest: Uint8Array.from(input.byteDigest),
  };
}

export function encodeCompleteExportEntryHeader(input: CompleteExportEntryHeader): Uint8Array {
  const value = assertCompleteExportEntryHeader(input);
  return encodeCanonicalValue(
    canonicalMap([
      [0, value.kind],
      [1, value.entryId],
      [2, value.byteLength],
      [3, value.byteDigest],
    ]),
  );
}

export function decodeCompleteExportEntryHeader(bytes: Uint8Array): CompleteExportEntryHeader {
  const decoded = decodeCanonicalValue(bytes);
  if (!(decoded instanceof Map) || decoded.size !== 4) {
    throw new TypeError("Complete Export entry header must contain the exact fields");
  }
  for (let index = 0; index < 4; index += 1) {
    if (!decoded.has(index)) {
      throw new TypeError("Complete Export entry header must contain the exact fields");
    }
  }
  const kind = decoded.get(0);
  const byteLength = decoded.get(2);
  const value = assertCompleteExportEntryHeader({
    kind: kind as CompleteExportEntryKind,
    entryId: exactBytes(decoded.get(1) ?? null, 32, "Complete Export Entry ID"),
    byteLength:
      typeof byteLength === "number" && Number.isSafeInteger(byteLength) ? byteLength : -1,
    byteDigest: exactBytes(decoded.get(3) ?? null, 32, "Complete Export entry digest"),
  });
  if (!bytesEqual(bytes, encodeCompleteExportEntryHeader(value))) {
    throw new TypeError("Complete Export entry header is not canonical");
  }
  return value;
}

function completeExportEntryIdentityHasher(kind: CompleteExportEntryKind, byteLength: number) {
  if (kind === 2) return createStorageItemIdHasher(byteLength);
  const hasher = sha256.create();
  hasher.update(
    concatBytes([
      new TextEncoder().encode(
        kind === 1
          ? "awsm:complete-export-manifest-entry-id:v1"
          : "awsm:complete-export-key-inventory-entry-id:v1",
      ),
      Uint8Array.of(0),
      uint32be(1),
      uint64be(byteLength),
    ]),
  );
  return {
    update(bytes: Uint8Array): void {
      hasher.update(bytes);
    },
    digest(): Uint8Array {
      return hasher.digest();
    },
  };
}

export function prepareCompleteExportEntry(
  kind: CompleteExportEntryKind,
  bytes: Uint8Array,
): CompleteExportEntry {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Complete Export entry requires bytes");
  const exact = Uint8Array.from(bytes);
  const identity = completeExportEntryIdentityHasher(kind, exact.byteLength);
  identity.update(exact);
  const header = assertCompleteExportEntryHeader({
    kind,
    entryId: identity.digest(),
    byteLength: exact.byteLength,
    byteDigest: sha256(exact),
  });
  return {
    header,
    bytes: {
      async *[Symbol.asyncIterator]() {
        if (exact.byteLength > 0) yield Uint8Array.from(exact);
      },
    },
  };
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

export async function* sequenceCompleteExportEntries(
  entries: Iterable<CompleteExportEntry> | AsyncIterable<CompleteExportEntry>,
): AsyncGenerator<Uint8Array> {
  let entryIndex = 0;
  let previousOpaqueId: Uint8Array | undefined;
  let sawKeyInventory = false;
  for await (const entry of entries) {
    const headerBytes = encodeCompleteExportEntryHeader(entry.header);
    const header = decodeCompleteExportEntryHeader(headerBytes);
    if (entryIndex === 0 && header.kind !== 1) {
      throw new TypeError("Complete Export must place the Manifest first");
    }
    if (entryIndex > 0 && header.kind === 1) {
      throw new TypeError("Complete Export may contain only one Manifest first");
    }
    if (sawKeyInventory) {
      throw new TypeError("Complete Export Key Inventory must be last");
    }
    if (header.kind === 3) sawKeyInventory = true;
    if (header.kind === 2) {
      if (previousOpaqueId !== undefined && compareBytes(previousOpaqueId, header.entryId) >= 0) {
        throw new TypeError("Complete Export opaque Entry IDs must be sorted unique");
      }
      previousOpaqueId = header.entryId;
    }

    yield uint32be(headerBytes.byteLength);
    yield headerBytes;
    const digest = sha256.create();
    const identity = completeExportEntryIdentityHasher(header.kind, header.byteLength);
    let observedLength = 0;
    for await (const chunk of entry.bytes) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        throw new TypeError("Complete Export entry chunks must contain bytes");
      }
      observedLength += chunk.byteLength;
      if (observedLength > header.byteLength) {
        throw new TypeError("Complete Export entry exceeds its declared byte length");
      }
      digest.update(chunk);
      identity.update(chunk);
      yield chunk;
    }
    if (observedLength !== header.byteLength) {
      throw new TypeError("Complete Export entry ended before its declared byte length");
    }
    if (!bytesEqual(digest.digest(), header.byteDigest)) {
      throw new TypeError("Complete Export entry byte digest is invalid");
    }
    if (!bytesEqual(identity.digest(), header.entryId)) {
      throw new TypeError("Complete Export Entry ID is invalid");
    }
    entryIndex += 1;
  }
  if (entryIndex === 0) throw new TypeError("Complete Export must place the Manifest first");
  if (!sawKeyInventory) throw new TypeError("Complete Export Key Inventory must be last");
}

function assertFrameInput(input: {
  readonly key: Uint8Array;
  readonly headerBytes: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly index: number;
}): void {
  if (input.key.byteLength !== 32) throw new TypeError("Complete Export key must contain 32 bytes");
  if (input.headerBytes.byteLength === 0) throw new TypeError("Complete Export header is empty");
  if (input.baseNonce.byteLength !== 24) {
    throw new TypeError("Complete Export base nonce must contain 24 bytes");
  }
  if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index > 0xffff_ffff) {
    throw new RangeError("Complete Export frame index must fit uint32");
  }
}

function frameAad(input: {
  readonly headerBytes: Uint8Array;
  readonly index: number;
  readonly final: boolean;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
}): Uint8Array {
  return transcript("awsm:complete-export-frame:v1", [
    input.headerBytes,
    uint32be(input.index),
    uint8(input.final ? 1 : 0),
    uint32be(input.plaintextLength),
    uint32be(input.ciphertextLength),
  ]);
}

export async function sealCompleteExportFrame(input: {
  readonly key: Uint8Array;
  readonly headerBytes: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly index: number;
  readonly final: boolean;
  readonly plaintext: Uint8Array;
}): Promise<Uint8Array> {
  assertFrameInput(input);
  if (input.plaintext.byteLength > COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT) {
    throw new TypeError("Complete Export frame exceeds the plaintext limit");
  }
  if (!input.final && input.plaintext.byteLength !== COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT) {
    throw new TypeError("A non-final Complete Export frame must be full");
  }
  const ciphertextLength = input.plaintext.byteLength + FRAME_TAG_LENGTH;
  const ciphertext = await xchachaEncrypt({
    plaintext: input.plaintext,
    aad: frameAad({ ...input, plaintextLength: input.plaintext.byteLength, ciphertextLength }),
    nonce: frameNonce(input.baseNonce, input.index),
    key: input.key,
  });
  return concatBytes([
    uint32be(input.index),
    uint8(input.final ? 1 : 0),
    uint32be(ciphertext.byteLength),
    ciphertext,
  ]);
}

export async function openCompleteExportFrame(input: {
  readonly key: Uint8Array;
  readonly headerBytes: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly frameBytes: Uint8Array;
  readonly expectedIndex: number;
}): Promise<{
  readonly index: number;
  readonly final: boolean;
  readonly plaintext: Uint8Array;
}> {
  assertFrameInput({ ...input, index: input.expectedIndex });
  if (input.frameBytes.byteLength < FRAME_PREFIX_LENGTH + FRAME_TAG_LENGTH) {
    throw new TypeError("Complete Export frame is truncated");
  }
  const view = new DataView(
    input.frameBytes.buffer,
    input.frameBytes.byteOffset,
    FRAME_PREFIX_LENGTH,
  );
  const index = view.getUint32(0, false);
  const flags = view.getUint8(4);
  const ciphertextLength = view.getUint32(5, false);
  if (index !== input.expectedIndex) throw new TypeError("Complete Export frame index is invalid");
  if ((flags & 0xfe) !== 0) throw new TypeError("Complete Export frame flag is invalid");
  const final = (flags & 1) === 1;
  if (input.frameBytes.byteLength !== FRAME_PREFIX_LENGTH + ciphertextLength) {
    throw new TypeError("Complete Export frame length is invalid");
  }
  const plaintextLength = ciphertextLength - FRAME_TAG_LENGTH;
  if (
    plaintextLength < 0 ||
    plaintextLength > COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT ||
    (!final && plaintextLength !== COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT)
  ) {
    throw new TypeError("Complete Export frame ciphertext length is invalid");
  }
  const plaintext = await xchachaDecrypt({
    ciphertext: input.frameBytes.slice(FRAME_PREFIX_LENGTH),
    aad: frameAad({
      headerBytes: input.headerBytes,
      index,
      final,
      plaintextLength,
      ciphertextLength,
    }),
    nonce: frameNonce(input.baseNonce, index),
    key: input.key,
  });
  return { index, final, plaintext };
}

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private firstOffset = 0;
  private done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(minimum: number): Promise<void> {
    while (this.queuedBytes < minimum && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Complete Export stream chunks must contain bytes");
      }
      this.queued.push(next.value);
      this.queuedBytes += next.value.byteLength;
    }
  }

  async exactOrEof(length: number): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new TypeError("Complete Export stream read length must be positive");
    }
    await this.fill(length);
    if (this.queuedBytes === 0 && this.done) return null;
    if (this.queuedBytes < length) throw new TypeError("Complete Export stream is truncated");
    const output = new Uint8Array(length);
    let outputOffset = 0;
    while (outputOffset < length) {
      const first = this.queued[0];
      if (first === undefined) throw new TypeError("Complete Export stream is truncated");
      const available = first.byteLength - this.firstOffset;
      const take = Math.min(available, length - outputOffset);
      output.set(first.subarray(this.firstOffset, this.firstOffset + take), outputOffset);
      outputOffset += take;
      this.firstOffset += take;
      this.queuedBytes -= take;
      if (this.firstOffset === first.byteLength) {
        this.queued.shift();
        this.firstOffset = 0;
      }
    }
    return output;
  }
}

export async function sealCompleteExportStream(input: {
  readonly passphrase: string;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly plaintext: AsyncIterable<Uint8Array>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
}): Promise<{ readonly frameCount: number }> {
  const prefixBytes = encodeCompleteExportPrefix(input);
  const prefix = decodeCompleteExportPrefix(prefixBytes);
  const key = await deriveCompleteExportKey(input.passphrase, prefix);
  let pending = new Uint8Array(COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT);
  let pendingLength = 0;
  let heldFullFrame: Uint8Array | null = null;
  let frameIndex = 0;
  const emit = async (plaintext: Uint8Array, final: boolean): Promise<void> => {
    const frame = await sealCompleteExportFrame({
      key,
      headerBytes: prefix.bytes,
      baseNonce: prefix.nonce,
      index: frameIndex,
      final,
      plaintext,
    });
    await input.write(frame);
    frameIndex += 1;
  };
  try {
    await input.write(prefixBytes);
    for await (const chunk of input.plaintext) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        throw new TypeError("Complete Export plaintext chunks must contain bytes");
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const take = Math.min(
          COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT - pendingLength,
          chunk.byteLength - offset,
        );
        pending.set(chunk.subarray(offset, offset + take), pendingLength);
        pendingLength += take;
        offset += take;
        if (pendingLength === COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT) {
          if (heldFullFrame !== null) await emit(heldFullFrame, false);
          heldFullFrame = pending;
          pending = new Uint8Array(COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT);
          pendingLength = 0;
        }
      }
    }
    if (pendingLength > 0) {
      if (heldFullFrame !== null) await emit(heldFullFrame, false);
      await emit(pending.slice(0, pendingLength), true);
    } else if (heldFullFrame !== null) {
      await emit(heldFullFrame, true);
    } else {
      await emit(new Uint8Array(), true);
    }
    return { frameCount: frameIndex };
  } finally {
    key.fill(0);
    pending.fill(0);
    heldFullFrame?.fill(0);
  }
}

export async function openCompleteExportStream(input: {
  readonly passphrase: string;
  readonly encrypted: AsyncIterable<Uint8Array>;
  readonly writePlaintext: (bytes: Uint8Array, frameIndex: number) => Promise<void>;
}): Promise<{ readonly frameCount: number; readonly prefix: CompleteExportPrefix }> {
  const reader = new AsyncByteReader(input.encrypted);
  const fixed = await reader.exactOrEof(COMPLETE_EXPORT_MAGIC.byteLength + 4);
  if (fixed === null) throw new TypeError("Complete Export stream is truncated");
  if (!bytesEqual(fixed.slice(0, COMPLETE_EXPORT_MAGIC.byteLength), COMPLETE_EXPORT_MAGIC)) {
    throw new TypeError("Complete Export magic is invalid");
  }
  const headerLength = new DataView(
    fixed.buffer,
    fixed.byteOffset + COMPLETE_EXPORT_MAGIC.byteLength,
    4,
  ).getUint32(0, false);
  if (headerLength < 1 || headerLength > 4096) {
    throw new TypeError("Complete Export header length is invalid");
  }
  const header = await reader.exactOrEof(headerLength);
  if (header === null) throw new TypeError("Complete Export stream is truncated");
  const prefix = decodeCompleteExportPrefix(concatBytes([fixed, header]));
  const key = await deriveCompleteExportKey(input.passphrase, prefix);
  let expectedIndex = 0;
  try {
    while (true) {
      const framePrefix = await reader.exactOrEof(FRAME_PREFIX_LENGTH);
      if (framePrefix === null) {
        throw new TypeError("Complete Export stream is missing its final frame");
      }
      const view = new DataView(framePrefix.buffer, framePrefix.byteOffset, framePrefix.byteLength);
      const ciphertextLength = view.getUint32(5, false);
      if (
        ciphertextLength < FRAME_TAG_LENGTH ||
        ciphertextLength > COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH
      ) {
        throw new TypeError("Complete Export frame ciphertext length is invalid");
      }
      const ciphertext = await reader.exactOrEof(ciphertextLength);
      if (ciphertext === null) throw new TypeError("Complete Export stream is truncated");
      const opened = await openCompleteExportFrame({
        key,
        headerBytes: prefix.bytes,
        baseNonce: prefix.nonce,
        frameBytes: concatBytes([framePrefix, ciphertext]),
        expectedIndex,
      });
      await input.writePlaintext(opened.plaintext, opened.index);
      expectedIndex += 1;
      if (opened.final) {
        if ((await reader.exactOrEof(1)) !== null) {
          throw new TypeError("Complete Export stream contains trailing bytes");
        }
        return { frameCount: expectedIndex, prefix };
      }
    }
  } finally {
    key.fill(0);
  }
}

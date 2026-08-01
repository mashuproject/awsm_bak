import { sha256 } from "@noble/hashes/sha2.js";
import { type Identifier, identifier } from "../domain/canonical/identifiers";
import { concatBytes, uint8, uint32be, uint64be } from "../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../domain/canonical/value";
import { bytesEqual } from "../domain/hash";

export const OPAQUE_ENVELOPE_MAGIC = Uint8Array.of(0x41, 0x57, 0x53, 0x4d, 0x53, 0x45, 0x01, 0x00);
export const STORAGE_ENVELOPE_FORMAT = 1 as const;
export const COMPACT_STORAGE_CLASS = 1 as const;
export const STREAMABLE_STORAGE_CLASS = 2 as const;
export const FRAME_PLAINTEXT_LIMIT = 1_048_576 as const;
export const FRAME_TAG_LENGTH = 16 as const;
export const PORTABLE_COMPACT_CEILING = 16 * 1024 * 1024;

export type StorageClass = typeof COMPACT_STORAGE_CLASS | typeof STREAMABLE_STORAGE_CLASS;

export interface OpaqueEnvelope {
  readonly storageClass: StorageClass;
  readonly protectionParameters: Uint8Array;
  readonly ciphertextLength: number;
  readonly ciphertextDigest: Uint8Array;
  readonly framePlaintextLimit: 0 | typeof FRAME_PLAINTEXT_LIMIT;
  readonly headerBytes: Uint8Array;
  readonly prefixBytes: Uint8Array;
  readonly payload: Uint8Array;
  readonly bytes: Uint8Array;
  readonly storageItemId: Identifier<"StorageItem">;
}

export interface OpaqueEnvelopePrefix {
  readonly storageClass: StorageClass;
  readonly protectionParameters: Uint8Array;
  readonly ciphertextLength: number;
  readonly ciphertextDigest: Uint8Array;
  readonly framePlaintextLimit: 0 | typeof FRAME_PLAINTEXT_LIMIT;
  readonly headerBytes: Uint8Array;
  readonly prefixBytes: Uint8Array;
}

function exactBytes(value: CanonicalValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new TypeError(`${field} must contain exactly ${length} bytes`);
  }
  return Uint8Array.from(value);
}

function integer(value: CanonicalValue, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value;
}

export function createStorageItemIdHasher(envelopeByteLength: number) {
  if (!Number.isSafeInteger(envelopeByteLength) || envelopeByteLength < 1) {
    throw new TypeError("Opaque envelope byte length must be a positive safe integer");
  }
  const hasher = sha256.create();
  hasher.update(
    concatBytes([
      new TextEncoder().encode("awsm:storage-item-id:v1"),
      Uint8Array.of(0),
      uint32be(1),
      uint64be(envelopeByteLength),
    ]),
  );
  let observed = 0;
  let finished = false;
  return {
    update(bytes: Uint8Array): void {
      if (finished) throw new TypeError("Storage Item ID hasher is already finalized");
      observed += bytes.byteLength;
      if (observed > envelopeByteLength) {
        throw new TypeError("Opaque envelope exceeds its declared byte length");
      }
      hasher.update(bytes);
    },
    digest(): Identifier<"StorageItem"> {
      if (finished) throw new TypeError("Storage Item ID hasher is already finalized");
      if (observed !== envelopeByteLength) {
        throw new TypeError("Opaque envelope ended before its declared byte length");
      }
      finished = true;
      return identifier("StorageItem", hasher.digest());
    },
  };
}

function storageItemId(bytes: Uint8Array): Identifier<"StorageItem"> {
  const hasher = createStorageItemIdHasher(bytes.byteLength);
  hasher.update(bytes);
  return hasher.digest();
}

function validateStreamPayload(payload: Uint8Array): void {
  let offset = 0;
  let expectedIndex = 0;
  let sawFinal = false;
  while (offset < payload.byteLength) {
    if (payload.byteLength - offset < 9 || sawFinal) {
      throw new TypeError("Invalid Streamable frame prefix or trailing bytes");
    }
    const view = new DataView(payload.buffer, payload.byteOffset + offset, 9);
    const index = view.getUint32(0, false);
    const flags = view.getUint8(4);
    const ciphertextLength = view.getUint32(5, false);
    if (index !== expectedIndex) throw new TypeError("Streamable frame indexes must be contiguous");
    if ((flags & 0xfe) !== 0) throw new TypeError("Streamable frame has an unknown flag");
    const final = (flags & 1) === 1;
    const minimum = final ? FRAME_TAG_LENGTH : FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH;
    const maximum = FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH;
    if (ciphertextLength < minimum || ciphertextLength > maximum) {
      throw new TypeError("Streamable frame ciphertext length is invalid");
    }
    offset += 9;
    if (payload.byteLength - offset < ciphertextLength) {
      throw new TypeError("Streamable frame ciphertext is truncated");
    }
    offset += ciphertextLength;
    expectedIndex += 1;
    sawFinal = final;
  }
  if (!sawFinal || expectedIndex === 0)
    throw new TypeError("Streamable payload requires one final frame");
}

function validatePayload(
  storageClass: StorageClass,
  payload: Uint8Array,
  compactCeiling: number,
): void {
  if (storageClass === COMPACT_STORAGE_CLASS) {
    if (payload.byteLength < FRAME_TAG_LENGTH || payload.byteLength > compactCeiling) {
      throw new TypeError("Compact ciphertext length is outside the accepted bounds");
    }
    return;
  }
  validateStreamPayload(payload);
}

export function encodeStreamFrame(input: {
  readonly index: number;
  readonly final: boolean;
  readonly ciphertext: Uint8Array;
}): Uint8Array {
  if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index > 0xffff_ffff) {
    throw new RangeError("Streamable frame index must fit uint32");
  }
  const expectedLength = input.final
    ? { minimum: FRAME_TAG_LENGTH, maximum: FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH }
    : {
        minimum: FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH,
        maximum: FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH,
      };
  if (
    input.ciphertext.byteLength < expectedLength.minimum ||
    input.ciphertext.byteLength > expectedLength.maximum
  ) {
    throw new TypeError("Streamable frame ciphertext length is invalid");
  }
  return concatBytes([
    uint32be(input.index),
    uint8(input.final ? 1 : 0),
    uint32be(input.ciphertext.byteLength),
    input.ciphertext,
  ]);
}

export function encodeOpaqueEnvelope(input: {
  readonly storageClass: StorageClass;
  readonly protectionParameters: Uint8Array;
  readonly payload: Uint8Array;
  readonly compactCeiling?: number;
}): OpaqueEnvelope {
  if (input.protectionParameters.byteLength !== 64) {
    throw new TypeError("Protection parameters must contain exactly 64 bytes");
  }
  const compactCeiling = input.compactCeiling ?? PORTABLE_COMPACT_CEILING;
  validatePayload(input.storageClass, input.payload, compactCeiling);
  const prefix = encodeOpaqueEnvelopePrefix({
    storageClass: input.storageClass,
    protectionParameters: input.protectionParameters,
    ciphertextLength: input.payload.byteLength,
    ciphertextDigest: sha256(input.payload),
  });
  const envelopeBytes = concatBytes([prefix.prefixBytes, input.payload]);
  return {
    ...prefix,
    payload: Uint8Array.from(input.payload),
    bytes: envelopeBytes,
    storageItemId: storageItemId(envelopeBytes),
  };
}

export function encodeOpaqueEnvelopePrefix(input: {
  readonly storageClass: StorageClass;
  readonly protectionParameters: Uint8Array;
  readonly ciphertextLength: number;
  readonly ciphertextDigest: Uint8Array;
}): OpaqueEnvelopePrefix {
  if (
    input.storageClass !== COMPACT_STORAGE_CLASS &&
    input.storageClass !== STREAMABLE_STORAGE_CLASS
  ) {
    throw new TypeError("Unknown storage class");
  }
  if (input.protectionParameters.byteLength !== 64) {
    throw new TypeError("Protection parameters must contain exactly 64 bytes");
  }
  if (!Number.isSafeInteger(input.ciphertextLength) || input.ciphertextLength < FRAME_TAG_LENGTH) {
    throw new TypeError("Ciphertext length is outside the accepted bounds");
  }
  if (input.ciphertextDigest.byteLength !== 32) {
    throw new TypeError("Ciphertext digest must contain exactly 32 bytes");
  }
  const framePlaintextLimit =
    input.storageClass === COMPACT_STORAGE_CLASS ? 0 : FRAME_PLAINTEXT_LIMIT;
  const headerBytes = encodeCanonicalValue(
    canonicalMap([
      [0, STORAGE_ENVELOPE_FORMAT],
      [1, input.storageClass],
      [2, input.protectionParameters],
      [3, input.ciphertextLength],
      [4, input.ciphertextDigest],
      [5, framePlaintextLimit],
    ]),
  );
  if (headerBytes.byteLength < 1 || headerBytes.byteLength > 4096) {
    throw new TypeError("Opaque envelope header is outside the portable bounds");
  }
  const prefixBytes = concatBytes([
    OPAQUE_ENVELOPE_MAGIC,
    uint32be(headerBytes.byteLength),
    headerBytes,
  ]);
  return {
    storageClass: input.storageClass,
    protectionParameters: Uint8Array.from(input.protectionParameters),
    ciphertextLength: input.ciphertextLength,
    ciphertextDigest: Uint8Array.from(input.ciphertextDigest),
    framePlaintextLimit,
    headerBytes,
    prefixBytes,
  };
}

export function decodeOpaqueEnvelope(
  bytes: Uint8Array,
  options: { readonly compactCeiling?: number } = {},
): OpaqueEnvelope {
  if (bytes.byteLength < OPAQUE_ENVELOPE_MAGIC.byteLength + 4 + 1) {
    throw new TypeError("Opaque envelope is truncated");
  }
  if (!bytesEqual(bytes.slice(0, 8), OPAQUE_ENVELOPE_MAGIC)) {
    throw new TypeError("Opaque envelope magic is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + 8, 4);
  const headerLength = view.getUint32(0, false);
  if (headerLength < 1 || headerLength > 4096 || bytes.byteLength < 12 + headerLength) {
    throw new TypeError("Opaque envelope header length is invalid");
  }
  const headerBytes = bytes.slice(12, 12 + headerLength);
  const decoded = decodeCanonicalValue(headerBytes);
  if (
    !(decoded instanceof Map) ||
    decoded.size !== 6 ||
    [...Array(6).keys()].some((key) => !decoded.has(key))
  ) {
    throw new TypeError("Opaque envelope header contains missing or unknown fields");
  }
  const format = integer(decoded.get(0) ?? null, "Storage envelope format");
  const storageClass = integer(decoded.get(1) ?? null, "Storage class") as StorageClass;
  const protectionParameters = exactBytes(decoded.get(2) ?? null, 64, "Protection parameters");
  const ciphertextLength = integer(decoded.get(3) ?? null, "Ciphertext length");
  const ciphertextDigest = exactBytes(decoded.get(4) ?? null, 32, "Ciphertext digest");
  const framePlaintextLimit = integer(decoded.get(5) ?? null, "Frame plaintext limit");
  if (format !== STORAGE_ENVELOPE_FORMAT) throw new TypeError("Unknown storage envelope format");
  if (storageClass !== COMPACT_STORAGE_CLASS && storageClass !== STREAMABLE_STORAGE_CLASS) {
    throw new TypeError("Unknown storage class");
  }
  const expectedFrameLimit = storageClass === COMPACT_STORAGE_CLASS ? 0 : FRAME_PLAINTEXT_LIMIT;
  if (framePlaintextLimit !== expectedFrameLimit)
    throw new TypeError("Frame plaintext limit is invalid");
  if (bytes.byteLength !== 12 + headerLength + ciphertextLength) {
    throw new TypeError("Opaque envelope ciphertext length is invalid");
  }
  const payload = bytes.slice(12 + headerLength);
  if (!bytesEqual(sha256(payload), ciphertextDigest)) {
    throw new TypeError("Opaque envelope ciphertext digest is invalid");
  }
  validatePayload(storageClass, payload, options.compactCeiling ?? PORTABLE_COMPACT_CEILING);
  const exactBytesCopy = Uint8Array.from(bytes);
  return {
    storageClass,
    protectionParameters,
    ciphertextLength,
    ciphertextDigest,
    framePlaintextLimit: expectedFrameLimit,
    headerBytes,
    prefixBytes: exactBytesCopy.slice(0, 12 + headerLength),
    payload,
    bytes: exactBytesCopy,
    storageItemId: storageItemId(exactBytesCopy),
  };
}

import { byteString, exactCode, exactMap, mapValue, textValue } from "../domain/canonical/schema";
import { uint32be } from "../domain/canonical/transcript";
import {
  assertCanonicalScopedKey,
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../domain/canonical/value";
import { bytesEqual } from "../domain/hash";

const INSTALLATION_WRAPPED_VALUE_FORMAT = 1 as const;
const MAX_INSTALLATION_VALUE_BYTES = 16 * 1024 * 1024;

function validateWrappingKey(key: CryptoKey): void {
  if (
    key.extractable ||
    key.algorithm.name !== "AES-KW" ||
    !key.usages.includes("wrapKey") ||
    !key.usages.includes("unwrapKey")
  ) {
    throw new TypeError("Installation wrapping key must be non-exportable AES-KW");
  }
}

function decodeUint32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
}

function variableBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytes`);
  return Uint8Array.from(value);
}

export async function wrapInstallationBytes(input: {
  readonly wrappingKey: CryptoKey;
  readonly domain: string;
  readonly context: Uint8Array;
  readonly bytes: Uint8Array;
  readonly padding?: Uint8Array;
}): Promise<Uint8Array> {
  validateWrappingKey(input.wrappingKey);
  assertCanonicalScopedKey(input.domain);
  if (input.context.byteLength > 4096) throw new TypeError("Installation context is too large");
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_INSTALLATION_VALUE_BYTES) {
    throw new TypeError("Installation value is outside the accepted bounds");
  }
  const payload = encodeCanonicalValue(
    canonicalMap([
      [0, INSTALLATION_WRAPPED_VALUE_FORMAT],
      [1, input.domain],
      [2, input.context],
      [3, input.bytes],
    ]),
  );
  const framedLength = 4 + payload.byteLength;
  const paddingLength = (8 - (framedLength % 8)) % 8;
  const padding = input.padding
    ? byteString(input.padding, paddingLength, "Installation padding")
    : crypto.getRandomValues(new Uint8Array(paddingLength));
  const plaintext = new Uint8Array(framedLength + paddingLength);
  plaintext.set(uint32be(payload.byteLength), 0);
  plaintext.set(payload, 4);
  plaintext.set(padding, framedLength);
  if (plaintext.byteLength < 16) throw new TypeError("Installation value is too small to wrap");

  const carrier = await crypto.subtle.importKey(
    "raw",
    plaintext,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.wrapKey("raw", carrier, input.wrappingKey, "AES-KW"));
}

export async function unwrapInstallationBytes(input: {
  readonly wrappingKey: CryptoKey;
  readonly domain: string;
  readonly context: Uint8Array;
  readonly wrappedBytes: Uint8Array;
}): Promise<Uint8Array> {
  validateWrappingKey(input.wrappingKey);
  assertCanonicalScopedKey(input.domain);
  if (
    input.wrappedBytes.byteLength < 24 ||
    input.wrappedBytes.byteLength % 8 !== 0 ||
    input.wrappedBytes.byteLength > MAX_INSTALLATION_VALUE_BYTES + 4096
  ) {
    throw new TypeError("Wrapped installation value is outside the accepted bounds");
  }
  const carrier = await crypto.subtle.unwrapKey(
    "raw",
    Uint8Array.from(input.wrappedBytes),
    input.wrappingKey,
    "AES-KW",
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign"],
  );
  const plaintext = new Uint8Array(await crypto.subtle.exportKey("raw", carrier));
  if (plaintext.byteLength < 4) throw new TypeError("Wrapped installation value is truncated");
  const payloadLength = decodeUint32(plaintext);
  if (payloadLength < 1 || payloadLength > plaintext.byteLength - 4) {
    throw new TypeError("Wrapped installation payload length is invalid");
  }
  const payload = plaintext.slice(4, 4 + payloadLength);
  const map = exactMap(decodeCanonicalValue(payload), [0, 1, 2, 3], "Wrapped installation value");
  exactCode(mapValue(map, 0), INSTALLATION_WRAPPED_VALUE_FORMAT, "Installation value format");
  const domain = textValue(mapValue(map, 1), "Installation value domain", {
    maxUtf8Bytes: 256,
  });
  assertCanonicalScopedKey(domain);
  const context = variableBytes(mapValue(map, 2), "Installation value context");
  const bytes = variableBytes(mapValue(map, 3), "Installation value bytes");
  if (domain !== input.domain || !bytesEqual(context, input.context)) {
    throw new TypeError("Wrapped installation value belongs to another context");
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INSTALLATION_VALUE_BYTES) {
    throw new TypeError("Installation value is outside the accepted bounds");
  }
  return bytes;
}

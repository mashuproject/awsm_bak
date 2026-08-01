import { decode, encode, rfc8949EncodeOptions } from "cborg";

import { bytesEqual } from "../hash";

export type CanonicalMapKey = number | bigint | string;
export type CanonicalValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly CanonicalValue[]
  | ReadonlyMap<CanonicalMapKey, CanonicalValue>;

const MIN_CBOR_INTEGER = -(1n << 64n);
const MAX_CBOR_INTEGER = (1n << 64n) - 1n;
const SCOPED_KEY = /^[a-z](?:[a-z0-9]|[._-](?=[a-z0-9])){0,127}$/u;

export class CanonicalValueError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "CanonicalValueError";
  }
}

export function assertCanonicalScopedKey(value: string): string {
  if (
    !SCOPED_KEY.test(value) ||
    !value.includes(".") ||
    value.includes("..") ||
    value.includes("._") ||
    value.includes(".-") ||
    value.includes("_.") ||
    value.includes("__") ||
    value.includes("_-") ||
    value.includes("-.") ||
    value.includes("-_") ||
    value.includes("--")
  ) {
    throw new CanonicalValueError("Invalid canonical scoped key");
  }
  return value;
}

function assertInteger(value: number | bigint, field: string): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalValueError(`${field} must be a safe integer`);
    }
    return;
  }
  if (value < MIN_CBOR_INTEGER || value > MAX_CBOR_INTEGER) {
    throw new CanonicalValueError(`${field} is outside the canonical 64-bit CBOR range`);
  }
}

function assertMapKey(value: CanonicalMapKey): void {
  if (typeof value === "string") {
    assertCanonicalScopedKey(value);
    return;
  }
  assertInteger(value, "Map key");
  if (value < 0) throw new CanonicalValueError("Canonical numeric map keys must be unsigned");
}

export function assertCanonicalValue(
  value: unknown,
  path = "value",
): asserts value is CanonicalValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" || typeof value === "bigint") {
    assertInteger(value, path);
    return;
  }
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) {
      throw new CanonicalValueError(`${path} text must be Unicode NFC`);
    }
    return;
  }
  if (value instanceof Uint8Array) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertCanonicalValue(entry, `${path}[${index}]`);
    });
    return;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value.entries()) {
      if (typeof key !== "number" && typeof key !== "bigint" && typeof key !== "string") {
        throw new CanonicalValueError(`${path} has an unsupported map key type`);
      }
      assertMapKey(key);
      assertCanonicalValue(entry, `${path}[${String(key)}]`);
    }
    return;
  }
  throw new CanonicalValueError(`${path} contains a prohibited canonical CBOR value`);
}

export function encodeCanonicalValue(value: CanonicalValue): Uint8Array {
  assertCanonicalValue(value);
  return encode(value, rfc8949EncodeOptions);
}

export function decodeCanonicalValue(bytes: Uint8Array): CanonicalValue {
  let decoded: unknown;
  try {
    decoded = decode(bytes, {
      allowBigInt: true,
      allowIndefinite: false,
      allowInfinity: false,
      allowNaN: false,
      allowUndefined: false,
      rejectDuplicateMapKeys: true,
      strict: true,
      useMaps: true,
    });
  } catch (error) {
    throw new CanonicalValueError(
      `Invalid restricted canonical CBOR: ${error instanceof Error ? error.message : "decode failed"}`,
    );
  }
  assertCanonicalValue(decoded);
  if (!bytesEqual(bytes, encodeCanonicalValue(decoded))) {
    throw new CanonicalValueError("CBOR bytes are not in the one canonical representation");
  }
  return decoded;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

export function canonicalSet<T extends CanonicalValue>(values: readonly T[]): readonly T[] {
  const entries = values.map((value) => ({ bytes: encodeCanonicalValue(value), value }));
  entries.sort((left, right) => compareBytes(left.bytes, right.bytes));
  for (let index = 1; index < entries.length; index += 1) {
    if (
      bytesEqual(
        entries[index - 1]?.bytes ?? new Uint8Array(),
        entries[index]?.bytes ?? new Uint8Array(),
      )
    ) {
      throw new CanonicalValueError("Canonical set contains a duplicate value");
    }
  }
  return entries.map(({ value }) => value);
}

export function canonicalMap(
  entries: readonly (readonly [number, CanonicalValue])[],
): ReadonlyMap<number, CanonicalValue> {
  const map = new Map<number, CanonicalValue>();
  for (const [key, value] of entries) {
    if (!Number.isSafeInteger(key) || key < 0 || map.has(key)) {
      throw new CanonicalValueError("Canonical map contains an invalid or duplicate numeric key");
    }
    map.set(key, value);
  }
  return map;
}

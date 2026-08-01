import { bytesEqual } from "../hash";
import { type Identifier, type IdentifierKind, identifier } from "./identifiers";
import {
  type CanonicalMapKey,
  type CanonicalValue,
  canonicalSet,
  encodeCanonicalValue,
} from "./value";

export function exactMap(
  value: CanonicalValue,
  expectedKeys: readonly CanonicalMapKey[],
  field: string,
): ReadonlyMap<CanonicalMapKey, CanonicalValue> {
  if (!(value instanceof Map)) throw new TypeError(`${field} must be a canonical map`);
  if (value.size !== expectedKeys.length || expectedKeys.some((key) => !value.has(key))) {
    throw new TypeError(`${field} contains missing or unknown fields`);
  }
  return value;
}

export function mapValue(
  map: ReadonlyMap<CanonicalMapKey, CanonicalValue>,
  key: CanonicalMapKey,
  field = `canonical field ${String(key)}`,
): CanonicalValue {
  if (!map.has(key)) throw new TypeError(`Missing ${field}`);
  return map.get(key) as CanonicalValue;
}

export function integer(value: CanonicalValue, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}

export function signedInteger(value: CanonicalValue, field: string): number | bigint {
  if ((typeof value !== "number" || !Number.isSafeInteger(value)) && typeof value !== "bigint") {
    throw new TypeError(`${field} must be an integer`);
  }
  return value;
}

export function nonnegativeInteger(value: CanonicalValue, field: string): number {
  const parsed = integer(value, field);
  if (parsed < 0) throw new TypeError(`${field} must be nonnegative`);
  return parsed;
}

export function exactCode<const Code extends number>(
  value: CanonicalValue,
  expected: Code,
  field: string,
): Code {
  if (integer(value, field) !== expected) throw new TypeError(`${field} must be ${expected}`);
  return expected;
}

export function oneOfCodes<const Code extends number>(
  value: CanonicalValue,
  expected: readonly Code[],
  field: string,
): Code {
  const parsed = integer(value, field);
  if (!expected.includes(parsed as Code)) throw new TypeError(`${field} is unknown`);
  return parsed as Code;
}

export function byteString(value: CanonicalValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new TypeError(`${field} must contain exactly ${length} bytes`);
  }
  return Uint8Array.from(value);
}

export function identifierValue<Kind extends IdentifierKind>(
  value: CanonicalValue,
  kind: Kind,
  field = `${kind} ID`,
): Identifier<Kind> {
  return identifier(kind, byteString(value, 32, field));
}

export function nullable<T>(
  value: CanonicalValue,
  parse: (present: CanonicalValue) => T,
): T | null {
  return value === null ? null : parse(value);
}

export function booleanValue(value: CanonicalValue, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

export interface TextOptions {
  readonly allowLineFeed?: boolean;
  readonly allowEmpty?: boolean;
  readonly maxUtf8Bytes?: number;
}

export function textValue(value: CanonicalValue, field: string, options: TextOptions = {}): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  if (!options.allowEmpty && value.length === 0) throw new TypeError(`${field} must not be empty`);
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 0x20 || codePoint === 0x7f) &&
      !(options.allowLineFeed && codePoint === 0x0a)
    ) {
      throw new TypeError(`${field} contains a prohibited control character`);
    }
  }
  if (
    options.maxUtf8Bytes !== undefined &&
    new TextEncoder().encode(value).byteLength > options.maxUtf8Bytes
  ) {
    throw new TypeError(`${field} exceeds its UTF-8 byte limit`);
  }
  return value;
}

export function arrayValue(value: CanonicalValue, field: string): readonly CanonicalValue[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

export function nonemptyArray(value: CanonicalValue, field: string): readonly CanonicalValue[] {
  const result = arrayValue(value, field);
  if (result.length === 0) throw new TypeError(`${field} must not be empty`);
  return result;
}

export function canonicalSetValue<T extends CanonicalValue>(
  value: CanonicalValue,
  field: string,
  parse: (entry: CanonicalValue, index: number) => T,
  options: { readonly nonempty?: boolean } = {},
): readonly T[] {
  const input = arrayValue(value, field);
  if (options.nonempty && input.length === 0) throw new TypeError(`${field} must not be empty`);
  const parsed = input.map(parse);
  const normalized = canonicalSet(parsed);
  if (!bytesEqual(encodeCanonicalValue(input), encodeCanonicalValue(normalized))) {
    throw new TypeError(`${field} must be a sorted duplicate-free canonical set`);
  }
  return parsed;
}

export function idSetValue<Kind extends IdentifierKind>(
  value: CanonicalValue,
  kind: Kind,
  field: string,
  options: { readonly nonempty?: boolean } = {},
): readonly Identifier<Kind>[] {
  return canonicalSetValue(value, field, (entry) => identifierValue(entry, kind), options);
}

export function exactEmptyMap(value: CanonicalValue, field: string): void {
  exactMap(value, [], field);
}

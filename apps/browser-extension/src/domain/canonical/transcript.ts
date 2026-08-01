const encoder = new TextEncoder();
const LABEL = /^awsm:[a-z0-9:-]+:v1$/u;

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function uint8(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError("Value does not fit uint8");
  }
  return Uint8Array.of(value);
}

export function uint32be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Value does not fit uint32");
  }
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

export function uint64be(value: number | bigint): Uint8Array {
  const integer = typeof value === "number" ? BigInt(value) : value;
  if (
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    integer < 0n ||
    integer > 0xffff_ffff_ffff_ffffn
  ) {
    throw new RangeError("Value does not fit uint64");
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, integer, false);
  return output;
}

export function transcript(label: string, parts: readonly Uint8Array[]): Uint8Array {
  if (!LABEL.test(label)) throw new TypeError("Invalid transcript label");
  if (parts.length > 0xffff_ffff) throw new RangeError("Too many transcript parts");
  return concatBytes([
    encoder.encode(label),
    Uint8Array.of(0),
    uint32be(parts.length),
    ...parts.flatMap((part) => [uint64be(part.byteLength), part]),
  ]);
}

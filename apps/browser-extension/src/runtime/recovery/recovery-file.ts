import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { bytes } from "../../domain/validation";
import { type RecoveryKitV1, sha256, validateRecoveryKitMetadata } from "./kit";

const MAGIC = new TextEncoder().encode("AWSMREC1");
const MAX_HEADER_LENGTH = 65_536;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function encodeRecoveryFile(kit: RecoveryKitV1): Uint8Array {
  const metadata = validateRecoveryKitMetadata(kit.metadata);
  bytes(kit.ciphertext, metadata.ciphertextLength, "recoveryKit.ciphertext");
  const header = encodeCanonicalCbor(metadata);
  if (header.byteLength > MAX_HEADER_LENGTH) throw new Error("Invalid Recovery file");
  const output = new Uint8Array(12 + header.byteLength + kit.ciphertext.byteLength);
  output.set(MAGIC, 0);
  new DataView(output.buffer).setUint32(8, header.byteLength, false);
  output.set(header, 12);
  output.set(kit.ciphertext, 12 + header.byteLength);
  return output;
}

export async function decodeRecoveryFile(value: Uint8Array): Promise<RecoveryKitV1> {
  if (value.byteLength < 12 || !sameBytes(value.subarray(0, 8), MAGIC)) {
    throw new Error("Invalid Recovery file");
  }
  const headerLength = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(
    8,
    false,
  );
  if (
    headerLength === 0 ||
    headerLength > MAX_HEADER_LENGTH ||
    12 + headerLength > value.byteLength
  ) {
    throw new Error("Invalid Recovery file");
  }
  const header = value.subarray(12, 12 + headerLength);
  const decoded = decodeCanonicalCbor(header);
  if (!sameBytes(encodeCanonicalCbor(decoded), header)) throw new Error("Invalid Recovery file");
  const metadata = validateRecoveryKitMetadata(decoded);
  const ciphertext = value.subarray(12 + headerLength);
  if (
    ciphertext.byteLength !== metadata.ciphertextLength ||
    !sameBytes(await sha256(ciphertext), metadata.ciphertextSha256)
  ) {
    throw new Error("Invalid Recovery file");
  }
  return { metadata, ciphertext: Uint8Array.from(ciphertext) };
}

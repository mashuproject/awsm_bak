import type { Identifier } from "../domain/canonical/identifiers";
import { transcript, uint8, uint64be } from "../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../domain/canonical/value";
import {
  COMPACT_STORAGE_CLASS,
  decodeOpaqueEnvelope,
  encodeOpaqueEnvelope,
  type OpaqueEnvelope,
} from "../storage/opaque-envelope";
import { compactItemKey } from "./canonical";
import { xchachaDecrypt, xchachaEncrypt } from "./xchacha";

export type CompactPayloadType = 1 | 2 | 3 | 4;

export interface OpenedCompactItem {
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly payloadType: CompactPayloadType;
  readonly payloadBytes: Uint8Array;
  readonly envelope: OpaqueEnvelope;
}

function protectedPlaintext(
  keyEpochId: Identifier<"KeyEpoch">,
  payloadType: CompactPayloadType,
  payloadBytes: Uint8Array,
): Uint8Array {
  if (![1, 2, 3, 4].includes(payloadType)) throw new TypeError("Unknown Compact payload type");
  return encodeCanonicalValue(
    canonicalMap([
      [0, keyEpochId],
      [1, payloadType],
      [2, payloadBytes],
    ]),
  );
}

function compactAad(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly protectionParameters: Uint8Array;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
}): Uint8Array {
  return transcript("awsm:compact-item-aad:v1", [
    input.vaultId,
    input.keyEpochId,
    uint8(COMPACT_STORAGE_CLASS),
    input.protectionParameters,
    uint64be(input.plaintextLength),
    uint64be(input.ciphertextLength),
  ]);
}

export async function sealCompactItem(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly payloadType: CompactPayloadType;
  readonly payloadBytes: Uint8Array;
  readonly protectionParameters?: Uint8Array;
}): Promise<OpaqueEnvelope> {
  const protectionParameters = input.protectionParameters
    ? Uint8Array.from(input.protectionParameters)
    : crypto.getRandomValues(new Uint8Array(64));
  if (protectionParameters.byteLength !== 64) {
    throw new TypeError("Protection parameters must contain exactly 64 bytes");
  }
  const plaintext = protectedPlaintext(input.keyEpochId, input.payloadType, input.payloadBytes);
  const ciphertextLength = plaintext.byteLength + 16;
  const key = compactItemKey({ ...input, protectionParameters });
  const payload = await xchachaEncrypt({
    plaintext,
    aad: compactAad({
      ...input,
      protectionParameters,
      plaintextLength: plaintext.byteLength,
      ciphertextLength,
    }),
    nonce: protectionParameters.slice(0, 24),
    key,
  });
  return encodeOpaqueEnvelope({
    storageClass: COMPACT_STORAGE_CLASS,
    protectionParameters,
    payload,
  });
}

function mapField(map: ReadonlyMap<unknown, CanonicalValue>, key: number): CanonicalValue {
  const value = map.get(key);
  if (value === undefined) throw new TypeError(`Compact plaintext is missing field ${key}`);
  return value;
}

export async function openCompactItem(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly envelopeBytes: Uint8Array;
}): Promise<OpenedCompactItem> {
  const envelope = decodeOpaqueEnvelope(input.envelopeBytes);
  if (envelope.storageClass !== COMPACT_STORAGE_CLASS) throw new TypeError("Item is not Compact");
  const plaintextLength = envelope.ciphertextLength - 16;
  const key = compactItemKey({ ...input, protectionParameters: envelope.protectionParameters });
  const plaintext = await xchachaDecrypt({
    ciphertext: envelope.payload,
    aad: compactAad({
      ...input,
      protectionParameters: envelope.protectionParameters,
      plaintextLength,
      ciphertextLength: envelope.ciphertextLength,
    }),
    nonce: envelope.protectionParameters.slice(0, 24),
    key,
  });
  const value = decodeCanonicalValue(plaintext);
  if (!(value instanceof Map) || value.size !== 3 || [0, 1, 2].some((field) => !value.has(field))) {
    throw new TypeError("Compact plaintext contains missing or unknown fields");
  }
  const epoch = mapField(value, 0);
  const payloadType = mapField(value, 1);
  const payloadBytes = mapField(value, 2);
  if (
    !(epoch instanceof Uint8Array) ||
    epoch.byteLength !== 32 ||
    !epoch.every((byte, index) => byte === input.keyEpochId[index])
  ) {
    throw new TypeError("Compact plaintext Key Epoch ID is invalid");
  }
  if (typeof payloadType !== "number" || ![1, 2, 3, 4].includes(payloadType)) {
    throw new TypeError("Compact plaintext payload type is invalid");
  }
  if (!(payloadBytes instanceof Uint8Array))
    throw new TypeError("Compact plaintext payload must be bytes");
  return {
    keyEpochId: input.keyEpochId,
    payloadType: payloadType as CompactPayloadType,
    payloadBytes: Uint8Array.from(payloadBytes),
    envelope,
  };
}

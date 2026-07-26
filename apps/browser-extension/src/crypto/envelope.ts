import { decodeCanonicalCbor, encodeCanonicalCbor } from "../domain/cbor";
import type { EncryptedEnvelopeV1 } from "../domain/contracts";
import { decodeEncryptedEnvelope } from "../domain/decode-storage";
import { CryptoOperationError } from "./errors";
import { xchachaDecrypt, xchachaEncrypt } from "./xchacha";

export interface EncryptEnvelopeInput {
  readonly objectType: EncryptedEnvelopeV1["objectType"];
  readonly objectId: string;
  readonly keyEpochId: string;
  readonly plaintext: Uint8Array;
  readonly key: Uint8Array;
  readonly nonce?: Uint8Array;
}

function header(envelope: EncryptedEnvelopeV1): Readonly<Record<string, unknown>> {
  return {
    formatVersion: envelope.formatVersion,
    objectType: envelope.objectType,
    algorithm: envelope.algorithm,
    keyEpochId: envelope.keyEpochId,
    objectId: envelope.objectId,
    payloadLength: envelope.payloadLength,
  };
}

function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(24));
}

export async function encryptEnvelope(input: EncryptEnvelopeInput): Promise<EncryptedEnvelopeV1> {
  const nonce = input.nonce === undefined ? randomNonce() : Uint8Array.from(input.nonce);
  const unsigned: EncryptedEnvelopeV1 = {
    formatVersion: 1,
    objectType: input.objectType,
    algorithm: "enc:xchacha20poly1305:v1",
    keyEpochId: input.keyEpochId,
    objectId: input.objectId,
    payloadLength: input.plaintext.byteLength,
    nonce,
    ciphertext: new Uint8Array(input.plaintext.byteLength + 16),
  };
  const ciphertext = await xchachaEncrypt({
    plaintext: input.plaintext,
    aad: encodeCanonicalCbor(header(unsigned)),
    nonce,
    key: input.key,
  });
  return { ...unsigned, ciphertext };
}

export async function decryptEnvelope(
  value: EncryptedEnvelopeV1,
  key: Uint8Array,
  expectedKeyEpochId: string,
): Promise<Uint8Array> {
  try {
    const envelope = decodeEncryptedEnvelope(value);
    if (envelope.keyEpochId !== expectedKeyEpochId) throw new CryptoOperationError();
    return await xchachaDecrypt({
      ciphertext: envelope.ciphertext,
      aad: encodeCanonicalCbor(header(envelope)),
      nonce: envelope.nonce,
      key,
    });
  } catch {
    throw new CryptoOperationError();
  }
}

export function encodeEncryptedEnvelope(envelope: EncryptedEnvelopeV1): Uint8Array {
  return encodeCanonicalCbor(envelope);
}

export function decodeEncryptedEnvelopeBytes(bytes: Uint8Array): EncryptedEnvelopeV1 {
  return decodeEncryptedEnvelope(decodeCanonicalCbor(bytes));
}

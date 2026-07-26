import { encodeCanonicalCbor } from "../domain/cbor";

export interface HkdfInput {
  readonly inputKeyMaterial: Uint8Array;
  readonly salt: Uint8Array;
  readonly info: Uint8Array;
  readonly length: number;
}

export async function hkdfSha256(input: HkdfInput): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(input.inputKeyMaterial),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Uint8Array.from(input.salt),
      info: Uint8Array.from(input.info),
    },
    key,
    input.length * 8,
  );
  return new Uint8Array(bits);
}

export type KeyDomain =
  | "vault:bundle-descriptor:v1"
  | "vault:artifact:v1"
  | "vault:event:v1"
  | "vault:projection:v1"
  | "vault:generation:v1"
  | "vault:verifier:v1";

export interface ContextDescriptor {
  readonly vaultId: string;
  readonly keyEpochId: string;
  readonly domain: KeyDomain;
  readonly contextId: string;
  readonly keyVersion: 1;
}

export interface ContextKeyInput extends ContextDescriptor {
  readonly rootKey: Uint8Array;
}

export function encodeDerivationContext(input: ContextDescriptor): {
  readonly salt: Uint8Array;
  readonly info: Uint8Array;
} {
  return {
    salt: encodeCanonicalCbor([
      "awsm:hkdf-salt:v1",
      uuidBytes(input.vaultId),
      uuidBytes(input.keyEpochId),
    ]),
    info: encodeCanonicalCbor([input.domain, input.keyVersion, input.contextId]),
  };
}

function uuidBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))
    throw new TypeError("Invalid key derivation UUID");
  return Uint8Array.from(value.replaceAll("-", "").match(/../gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

export async function deriveContextKey(input: ContextKeyInput): Promise<Uint8Array> {
  const rootKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(input.rootKey),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return deriveContextKeyFromCryptoKey(rootKey, input);
}

export async function deriveContextKeyFromCryptoKey(
  rootKey: CryptoKey,
  input: ContextDescriptor,
): Promise<Uint8Array> {
  const context = encodeDerivationContext(input);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Uint8Array.from(context.salt),
      info: Uint8Array.from(context.info),
    },
    rootKey,
    256,
  );
  return new Uint8Array(bits);
}

import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { hkdfSha256 } from "../../crypto/hkdf";
import { DomainValidationError } from "../../domain/errors";

const encoder = new TextEncoder();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INVALID_PHRASE = "That Recovery Phrase is not valid. Check all 12 words and try again.";

function uuidBytes(value: string): Uint8Array {
  if (!UUID_PATTERN.test(value)) {
    throw new DomainValidationError("vaultId", "must be a lowercase UUID");
  }
  return Uint8Array.from(value.replaceAll("-", "").match(/../gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

export function normalizeRecoveryPhrase(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase("en-US").trim().split(/\s+/u).join(" ");
}

export function encodeRecoveryPhrase(entropy: Uint8Array): string {
  if (entropy.byteLength !== 16) {
    throw new DomainValidationError("recoveryEntropy", "must contain 16 bytes");
  }
  return entropyToMnemonic(entropy, wordlist);
}

export function generateRecoveryPhrase(): string {
  return encodeRecoveryPhrase(crypto.getRandomValues(new Uint8Array(16)));
}

export function decodeRecoveryPhrase(value: string): Uint8Array {
  const phrase = normalizeRecoveryPhrase(value);
  try {
    if (phrase.split(" ").length !== 12 || !validateMnemonic(phrase, wordlist)) {
      throw new Error(INVALID_PHRASE);
    }
    const entropy = Uint8Array.from(mnemonicToEntropy(phrase, wordlist));
    if (entropy.byteLength !== 16) throw new Error(INVALID_PHRASE);
    return entropy;
  } catch {
    throw new Error(INVALID_PHRASE);
  }
}

export async function deriveRecoveryKeys(input: {
  readonly entropy: Uint8Array;
  readonly vaultId: string;
}): Promise<{
  readonly recoveryKitWrappingKey: Uint8Array;
  readonly recoveryAdministratorSeed: Uint8Array;
}> {
  if (input.entropy.byteLength !== 16) {
    throw new DomainValidationError("recoveryEntropy", "must contain 16 bytes");
  }
  const salt = uuidBytes(input.vaultId);
  const [recoveryKitWrappingKey, recoveryAdministratorSeed] = await Promise.all([
    hkdfSha256({
      inputKeyMaterial: input.entropy,
      salt,
      info: encoder.encode("awsm:recovery-kit-wrapping:v1"),
      length: 32,
    }),
    hkdfSha256({
      inputKeyMaterial: input.entropy,
      salt,
      info: encoder.encode("awsm:recovery-administrator-ed25519-seed:v1"),
      length: 32,
    }),
  ]);
  return { recoveryKitWrappingKey, recoveryAdministratorSeed };
}

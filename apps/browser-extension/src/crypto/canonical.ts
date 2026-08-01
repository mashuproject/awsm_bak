import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { type Identifier, keyEpochId } from "../domain/canonical/identifiers";
import { concatBytes, transcript, uint8, uint64be } from "../domain/canonical/transcript";
import { bytesEqual } from "../domain/hash";
import { readySodium } from "./sodium";

const encoder = new TextEncoder();
const RECOVERY_ROOT_SALT = sha256(encoder.encode("awsm:recovery-root:v1"));

export interface RecoveryCredentialKeys {
  readonly signingSeed: Uint8Array;
  readonly signingPublicKey: Uint8Array;
  readonly signingSecretKey: Uint8Array;
  readonly wrappingPrivateKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
}

export interface KeyEpoch {
  readonly id: Identifier<"KeyEpoch">;
  readonly key: Uint8Array;
}

function exactBytes(value: Uint8Array, length: number, field: string): Uint8Array {
  if (value.byteLength !== length)
    throw new TypeError(`${field} must contain exactly ${length} bytes`);
  return Uint8Array.from(value);
}

export function normalizeRecoveryPhrase(value: string): string {
  return value.normalize("NFKD").trim().split(/\s+/u).join(" ");
}

export function encodeRecoveryPhrase(entropy: Uint8Array): string {
  return entropyToMnemonic(exactBytes(entropy, 16, "Recovery entropy"), wordlist);
}

export function generateRecoveryPhrase(): string {
  return encodeRecoveryPhrase(crypto.getRandomValues(new Uint8Array(16)));
}

export function decodeRecoveryPhrase(value: string): Uint8Array {
  const phrase = normalizeRecoveryPhrase(value);
  if (phrase.split(" ").length !== 12 || !validateMnemonic(phrase, wordlist)) {
    throw new TypeError("Invalid 12-word English Recovery Phrase");
  }
  const entropy = Uint8Array.from(mnemonicToEntropy(phrase, wordlist));
  return exactBytes(entropy, 16, "Recovery entropy");
}

export async function deriveRecoveryCredential(
  entropy: Uint8Array,
): Promise<RecoveryCredentialKeys> {
  const recoveryPrk = extract(
    sha256,
    exactBytes(entropy, 16, "Recovery entropy"),
    RECOVERY_ROOT_SALT,
  );
  const signingSeed = expand(
    sha256,
    recoveryPrk,
    transcript("awsm:recovery-signing-key:v1", []),
    32,
  );
  const wrappingPrivateKey = expand(
    sha256,
    recoveryPrk,
    transcript("awsm:recovery-wrapping-key:v1", []),
    32,
  );
  const sodium = await readySodium();
  const signing = sodium.crypto_sign_seed_keypair(signingSeed);
  return {
    signingSeed,
    signingPublicKey: Uint8Array.from(signing.publicKey),
    signingSecretKey: Uint8Array.from(signing.privateKey),
    wrappingPrivateKey,
    wrappingPublicKey: Uint8Array.from(sodium.crypto_scalarmult_base(wrappingPrivateKey)),
  };
}

export function recoveryPublicFingerprint(wrappingPublicKey: Uint8Array): Uint8Array {
  return sha256(
    transcript("awsm:recovery-public-fingerprint:v1", [
      exactBytes(wrappingPublicKey, 32, "Recovery wrapping public key"),
    ]),
  );
}

export function createKeyEpoch(vaultId: Identifier<"Vault">): KeyEpoch {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return { id: keyEpochId(vaultId, key), key };
}

export function epochPrk(
  vaultId: Identifier<"Vault">,
  epochId: Identifier<"KeyEpoch">,
  epochKey: Uint8Array,
): Uint8Array {
  const key = exactBytes(epochKey, 32, "Key Epoch Key");
  if (!bytesEqual(keyEpochId(vaultId, key), epochId)) {
    throw new TypeError("Key Epoch ID does not match its Vault and Key Epoch Key");
  }
  const salt = sha256(transcript("awsm:key-epoch-extract:v1", [vaultId, epochId]));
  return extract(sha256, key, salt);
}

function protectionParameters(value: Uint8Array): Uint8Array {
  return exactBytes(value, 64, "Protection parameters");
}

export function compactItemKey(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly protectionParameters: Uint8Array;
}): Uint8Array {
  return expand(
    sha256,
    epochPrk(input.vaultId, input.keyEpochId, input.keyEpochKey),
    transcript("awsm:compact-item-key:v1", [
      input.vaultId,
      input.keyEpochId,
      uint8(1),
      protectionParameters(input.protectionParameters),
    ]),
    32,
  );
}

export function artifactWrapperKey(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly artifactId: Identifier<"Artifact">;
  readonly protectionParameters: Uint8Array;
}): Uint8Array {
  return expand(
    sha256,
    epochPrk(input.vaultId, input.keyEpochId, input.keyEpochKey),
    transcript("awsm:artifact-wrapper-key:v1", [
      input.vaultId,
      input.keyEpochId,
      input.artifactId,
      uint8(2),
      protectionParameters(input.protectionParameters),
    ]),
    32,
  );
}

export function frameNonce(baseNonce: Uint8Array, frameIndex: number): Uint8Array {
  const nonce = exactBytes(baseNonce, 24, "Artifact base nonce");
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex > 0xffff_ffff) {
    throw new RangeError("Artifact frame index must fit uint32");
  }
  return concatBytes([nonce.slice(0, 16), uint64be(frameIndex)]);
}

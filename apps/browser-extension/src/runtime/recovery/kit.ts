import { readySodium, wipe } from "../../crypto/sodium";
import { xchachaDecrypt, xchachaEncrypt } from "../../crypto/xchacha";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { bytes, canonicalRecord, integer, literal, string, uuid } from "../../domain/validation";
import { base64UrlToBytes, bytesToBase64Url } from "../account/wire";

export const RECOVERY_DERIVATION_ALGORITHM = "kdf:hkdf-sha256:recovery-entropy:v1" as const;
export const RECOVERY_WRAPPING_ALGORITHM = "wrap:xchacha20poly1305:recovery-kit:v1" as const;
export const RECOVERY_ADMINISTRATOR_ALGORITHM = "sign:ed25519:recovery-administrator:v1" as const;

export interface RecoveryKeyEpochV1 {
  readonly keyEpochId: string;
  readonly ordinal: number;
  readonly rootKey: Uint8Array;
}

export interface RecoveryKeyringV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly activeKeyEpochId: string;
  readonly keyEpochs: readonly RecoveryKeyEpochV1[];
}

export interface RecoveryKitMetadataV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly derivationAlgorithm: typeof RECOVERY_DERIVATION_ALGORITHM;
  readonly wrappingAlgorithm: typeof RECOVERY_WRAPPING_ALGORITHM;
  readonly administratorSigningAlgorithm: typeof RECOVERY_ADMINISTRATOR_ALGORITHM;
  readonly administratorPublicKey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertextLength: number;
  readonly ciphertextSha256: Uint8Array;
}

export interface RecoveryKitV1 {
  readonly metadata: RecoveryKitMetadataV1;
  readonly ciphertext: Uint8Array;
}

export interface RecoveryKitWireV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly derivationAlgorithm: typeof RECOVERY_DERIVATION_ALGORITHM;
  readonly wrappingAlgorithm: typeof RECOVERY_WRAPPING_ALGORITHM;
  readonly administratorSigningAlgorithm: typeof RECOVERY_ADMINISTRATOR_ALGORITHM;
  readonly administratorPublicKey: string;
  readonly nonce: string;
  readonly ciphertextLength: number;
  readonly ciphertextSha256: string;
  readonly ciphertext: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(value)));
}

export function recoveryKitAad(metadata: RecoveryKitMetadataV1): Uint8Array {
  return encodeCanonicalCbor({
    version: metadata.version,
    vaultId: metadata.vaultId,
    recoveryGenerationId: metadata.recoveryGenerationId,
    derivationAlgorithm: metadata.derivationAlgorithm,
    wrappingAlgorithm: metadata.wrappingAlgorithm,
    administratorSigningAlgorithm: metadata.administratorSigningAlgorithm,
    administratorPublicKey: metadata.administratorPublicKey,
    nonce: metadata.nonce,
    ciphertextLength: metadata.ciphertextLength,
  });
}

function validateKeyring(value: unknown): RecoveryKeyringV1 {
  const input = canonicalRecord(value, "recoveryKeyring", [
    "version",
    "vaultId",
    "recoveryGenerationId",
    "activeKeyEpochId",
    "keyEpochs",
  ]);
  if (!Array.isArray(input.keyEpochs) || input.keyEpochs.length === 0) {
    throw new Error("Invalid Recovery Kit");
  }
  const seen = new Set<string>();
  const keyEpochs = input.keyEpochs.map((candidate, ordinal) => {
    const epoch = canonicalRecord(candidate, "recoveryKeyEpoch", [
      "keyEpochId",
      "ordinal",
      "rootKey",
    ]);
    const keyEpochId = uuid(epoch.keyEpochId, "recoveryKeyEpoch.keyEpochId");
    if (integer(epoch.ordinal, "recoveryKeyEpoch.ordinal") !== ordinal || seen.has(keyEpochId)) {
      throw new Error("Invalid Recovery Kit");
    }
    seen.add(keyEpochId);
    return {
      keyEpochId,
      ordinal,
      rootKey: bytes(epoch.rootKey, 32, "recoveryKeyEpoch.rootKey"),
    };
  });
  const activeKeyEpochId = uuid(input.activeKeyEpochId, "recoveryKeyring.activeKeyEpochId");
  if (keyEpochs.at(-1)?.keyEpochId !== activeKeyEpochId) throw new Error("Invalid Recovery Kit");
  return {
    version: literal(input.version, 1, "recoveryKeyring.version"),
    vaultId: uuid(input.vaultId, "recoveryKeyring.vaultId"),
    recoveryGenerationId: uuid(input.recoveryGenerationId, "recoveryKeyring.recoveryGenerationId"),
    activeKeyEpochId,
    keyEpochs,
  };
}

export function validateRecoveryKitMetadata(value: unknown): RecoveryKitMetadataV1 {
  const input = canonicalRecord(value, "recoveryKitMetadata", [
    "version",
    "vaultId",
    "recoveryGenerationId",
    "derivationAlgorithm",
    "wrappingAlgorithm",
    "administratorSigningAlgorithm",
    "administratorPublicKey",
    "nonce",
    "ciphertextLength",
    "ciphertextSha256",
  ]);
  return {
    version: literal(input.version, 1, "recoveryKitMetadata.version"),
    vaultId: uuid(input.vaultId, "recoveryKitMetadata.vaultId"),
    recoveryGenerationId: uuid(
      input.recoveryGenerationId,
      "recoveryKitMetadata.recoveryGenerationId",
    ),
    derivationAlgorithm: literal(
      input.derivationAlgorithm,
      RECOVERY_DERIVATION_ALGORITHM,
      "recoveryKitMetadata.derivationAlgorithm",
    ),
    wrappingAlgorithm: literal(
      input.wrappingAlgorithm,
      RECOVERY_WRAPPING_ALGORITHM,
      "recoveryKitMetadata.wrappingAlgorithm",
    ),
    administratorSigningAlgorithm: literal(
      input.administratorSigningAlgorithm,
      RECOVERY_ADMINISTRATOR_ALGORITHM,
      "recoveryKitMetadata.administratorSigningAlgorithm",
    ),
    administratorPublicKey: bytes(
      input.administratorPublicKey,
      32,
      "recoveryKitMetadata.administratorPublicKey",
    ),
    nonce: bytes(input.nonce, 24, "recoveryKitMetadata.nonce"),
    ciphertextLength: integer(input.ciphertextLength, "recoveryKitMetadata.ciphertextLength"),
    ciphertextSha256: bytes(input.ciphertextSha256, 32, "recoveryKitMetadata.ciphertextSha256"),
  };
}

export function recoveryKitFromWire(value: unknown): RecoveryKitV1 {
  const input = canonicalRecord(value, "recoveryKit", [
    "version",
    "vaultId",
    "recoveryGenerationId",
    "derivationAlgorithm",
    "wrappingAlgorithm",
    "administratorSigningAlgorithm",
    "administratorPublicKey",
    "nonce",
    "ciphertextLength",
    "ciphertextSha256",
    "ciphertext",
  ]);
  const metadata = validateRecoveryKitMetadata({
    version: input.version,
    vaultId: input.vaultId,
    recoveryGenerationId: input.recoveryGenerationId,
    derivationAlgorithm: input.derivationAlgorithm,
    wrappingAlgorithm: input.wrappingAlgorithm,
    administratorSigningAlgorithm: input.administratorSigningAlgorithm,
    administratorPublicKey: base64UrlToBytes(
      string(input.administratorPublicKey, "recoveryKit.administratorPublicKey"),
      32,
    ),
    nonce: base64UrlToBytes(string(input.nonce, "recoveryKit.nonce"), 24),
    ciphertextLength: input.ciphertextLength,
    ciphertextSha256: base64UrlToBytes(
      string(input.ciphertextSha256, "recoveryKit.ciphertextSha256"),
      32,
    ),
  });
  const ciphertext = base64UrlToBytes(
    string(input.ciphertext, "recoveryKit.ciphertext"),
    metadata.ciphertextLength,
  );
  return { metadata, ciphertext };
}

export function recoveryKitToWire(kit: RecoveryKitV1): RecoveryKitWireV1 {
  const metadata = validateRecoveryKitMetadata(kit.metadata);
  bytes(kit.ciphertext, metadata.ciphertextLength, "recoveryKit.ciphertext");
  return {
    ...metadata,
    administratorPublicKey: bytesToBase64Url(metadata.administratorPublicKey),
    nonce: bytesToBase64Url(metadata.nonce),
    ciphertextSha256: bytesToBase64Url(metadata.ciphertextSha256),
    ciphertext: bytesToBase64Url(kit.ciphertext),
  };
}

export async function createRecoveryKit(input: {
  readonly keyring: RecoveryKeyringV1;
  readonly recoveryKitWrappingKey: Uint8Array;
  readonly recoveryAdministratorSeed: Uint8Array;
  readonly nonce?: Uint8Array;
}): Promise<RecoveryKitV1> {
  const keyring = validateKeyring(input.keyring);
  if (
    keyring.vaultId !== input.keyring.vaultId ||
    keyring.recoveryGenerationId !== input.keyring.recoveryGenerationId
  ) {
    throw new Error("Invalid Recovery Kit");
  }
  bytes(input.recoveryKitWrappingKey, 32, "recoveryKitWrappingKey");
  bytes(input.recoveryAdministratorSeed, 32, "recoveryAdministratorSeed");
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(24));
  bytes(nonce, 24, "recoveryKit.nonce");
  const sodium = await readySodium();
  const administrator = sodium.crypto_sign_seed_keypair(input.recoveryAdministratorSeed);
  const plaintext = encodeCanonicalCbor(keyring);
  const unsigned: RecoveryKitMetadataV1 = {
    version: 1,
    vaultId: keyring.vaultId,
    recoveryGenerationId: keyring.recoveryGenerationId,
    derivationAlgorithm: RECOVERY_DERIVATION_ALGORITHM,
    wrappingAlgorithm: RECOVERY_WRAPPING_ALGORITHM,
    administratorSigningAlgorithm: RECOVERY_ADMINISTRATOR_ALGORITHM,
    administratorPublicKey: Uint8Array.from(administrator.publicKey),
    nonce: Uint8Array.from(nonce),
    ciphertextLength: plaintext.byteLength + 16,
    ciphertextSha256: new Uint8Array(32),
  };
  try {
    const ciphertext = await xchachaEncrypt({
      plaintext,
      aad: recoveryKitAad(unsigned),
      nonce,
      key: input.recoveryKitWrappingKey,
    });
    return {
      metadata: { ...unsigned, ciphertextSha256: await sha256(ciphertext) },
      ciphertext,
    };
  } finally {
    await Promise.all([wipe(plaintext), wipe(Uint8Array.from(administrator.privateKey))]);
  }
}

export async function openRecoveryKit(
  input: RecoveryKitV1,
  recoveryKitWrappingKey: Uint8Array,
): Promise<RecoveryKeyringV1> {
  const metadata = validateRecoveryKitMetadata(input.metadata);
  bytes(recoveryKitWrappingKey, 32, "recoveryKitWrappingKey");
  if (
    input.ciphertext.byteLength !== metadata.ciphertextLength ||
    !sameBytes(await sha256(input.ciphertext), metadata.ciphertextSha256)
  ) {
    throw new Error("Invalid Recovery Kit");
  }
  const plaintext = await xchachaDecrypt({
    ciphertext: input.ciphertext,
    aad: recoveryKitAad(metadata),
    nonce: metadata.nonce,
    key: recoveryKitWrappingKey,
  });
  try {
    const decoded = decodeCanonicalCbor(plaintext);
    if (!sameBytes(encodeCanonicalCbor(decoded), plaintext))
      throw new Error("Invalid Recovery Kit");
    const keyring = validateKeyring(decoded);
    if (
      keyring.vaultId !== metadata.vaultId ||
      keyring.recoveryGenerationId !== metadata.recoveryGenerationId
    ) {
      throw new Error("Invalid Recovery Kit");
    }
    return keyring;
  } finally {
    await wipe(plaintext);
  }
}

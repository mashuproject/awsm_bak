import { derivePassphraseKey } from "../../crypto/passphrase";
import { xchachaDecrypt, xchachaEncrypt } from "../../crypto/xchacha";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { bytesEqual, sha256 } from "../../domain/hash";
import { bytes, canonicalRecord, integer, literal, uuid } from "../../domain/validation";
import type { ExportKeyEnvelopeV1 } from "./contracts";

export class ExportAuthenticationError extends Error {
  readonly id = "EXPORT_AUTHENTICATION_FAILED";

  constructor() {
    super("The Export could not be authenticated.");
    this.name = "ExportAuthenticationError";
  }
}

function validateExportPassphrase(passphrase: string): void {
  const codePoints = Array.from(passphrase).length;
  const utf8Length = new TextEncoder().encode(passphrase).byteLength;
  if (codePoints < 12 || utf8Length > 1024) throw new ExportAuthenticationError();
}

function aad(envelope: Omit<ExportKeyEnvelopeV1, "ciphertext">): Uint8Array {
  return encodeCanonicalCbor([
    envelope.exportKeyEnvelopeVersion,
    envelope.purpose,
    envelope.packageId,
    envelope.originatingVaultId,
    envelope.algorithm,
    envelope.kdf,
    envelope.operations,
    envelope.memoryBytes,
    envelope.salt,
    envelope.nonce,
    envelope.manifestChecksumAlgorithm,
    envelope.manifestChecksum,
  ]);
}

export async function createExportKeyEnvelope(input: {
  readonly packageId: string;
  readonly originatingVaultId: string;
  readonly manifestBytes: Uint8Array;
  readonly passphrase: string;
  readonly keyring: ExportedVaultKeyring;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
}): Promise<ExportKeyEnvelopeV1> {
  validateExportedKeyring(input.keyring);
  validateExportPassphrase(input.passphrase);
  const manifestChecksum = await sha256(input.manifestBytes);
  const fields = {
    exportKeyEnvelopeVersion: 1,
    purpose: "VaultExport",
    packageId: input.packageId,
    originatingVaultId: input.originatingVaultId,
    algorithm: "wrap:xchacha20poly1305:passphrase:v1",
    kdf: "kdf:argon2id:v1",
    operations: 3,
    memoryBytes: 67108864,
    salt: Uint8Array.from(input.salt),
    nonce: Uint8Array.from(input.nonce),
    manifestChecksumAlgorithm: "hash:sha256:v1",
    manifestChecksum,
  } as const;
  const key = await derivePassphraseKey({
    passphrase: input.passphrase,
    salt: fields.salt,
    operations: 3,
    memoryBytes: 67108864,
  });
  try {
    return {
      ...fields,
      ciphertext: await xchachaEncrypt({
        plaintext: encodeCanonicalCbor(input.keyring),
        aad: aad(fields),
        nonce: fields.nonce,
        key,
      }),
    };
  } finally {
    key.fill(0);
  }
}

export async function openExportKeyEnvelope(
  envelope: ExportKeyEnvelopeV1,
  manifestBytes: Uint8Array,
  passphrase: string,
): Promise<ExportedVaultKeyring> {
  validateExportPassphrase(passphrase);
  const actualManifestChecksum = await sha256(manifestBytes);
  if (!bytesEqual(actualManifestChecksum, envelope.manifestChecksum)) {
    throw new ExportAuthenticationError();
  }
  let key: Uint8Array | undefined;
  try {
    key = await derivePassphraseKey({
      passphrase,
      salt: envelope.salt,
      operations: 3,
      memoryBytes: 67108864,
    });
    const plaintext = await xchachaDecrypt({
      ciphertext: envelope.ciphertext,
      aad: aad(envelope),
      nonce: envelope.nonce,
      key,
    });
    const decoded = decodeExportedKeyring(plaintext);
    plaintext.fill(0);
    return decoded;
  } catch {
    throw new ExportAuthenticationError();
  } finally {
    key?.fill(0);
  }
}

export interface ExportedVaultKeyring {
  readonly version: 1;
  readonly vaultId: string;
  readonly activeKeyEpochId: string;
  readonly keyEpochs: readonly {
    readonly keyEpochId: string;
    readonly ordinal: number;
    readonly rootKey: Uint8Array;
  }[];
}

function validateExportedKeyring(value: ExportedVaultKeyring): void {
  if (
    value.keyEpochs.length === 0 ||
    value.keyEpochs.some(
      (epoch, index) =>
        epoch.ordinal !== index ||
        epoch.rootKey.byteLength !== 32 ||
        epoch.keyEpochId === value.keyEpochs[index - 1]?.keyEpochId,
    ) ||
    value.keyEpochs.at(-1)?.keyEpochId !== value.activeKeyEpochId
  )
    throw new ExportAuthenticationError();
  uuid(value.vaultId, "exportKeyring.vaultId");
  uuid(value.activeKeyEpochId, "exportKeyring.activeKeyEpochId");
  for (const epoch of value.keyEpochs) uuid(epoch.keyEpochId, "exportKeyring.keyEpochId");
}

function decodeExportedKeyring(encoded: Uint8Array): ExportedVaultKeyring {
  const input = canonicalRecord(decodeCanonicalCbor(encoded), "exportKeyring", [
    "version",
    "vaultId",
    "activeKeyEpochId",
    "keyEpochs",
  ]);
  if (!Array.isArray(input.keyEpochs)) throw new ExportAuthenticationError();
  const result: ExportedVaultKeyring = {
    version: literal(input.version, 1, "exportKeyring.version"),
    vaultId: uuid(input.vaultId, "exportKeyring.vaultId"),
    activeKeyEpochId: uuid(input.activeKeyEpochId, "exportKeyring.activeKeyEpochId"),
    keyEpochs: input.keyEpochs.map((value, index) => {
      const epoch = canonicalRecord(value, `exportKeyring.keyEpochs.${String(index)}`, [
        "keyEpochId",
        "ordinal",
        "rootKey",
      ]);
      return {
        keyEpochId: uuid(epoch.keyEpochId, "exportKeyring.keyEpochId"),
        ordinal: integer(epoch.ordinal, "exportKeyring.ordinal"),
        rootKey: bytes(epoch.rootKey, 32, "exportKeyring.rootKey"),
      };
    }),
  };
  validateExportedKeyring(result);
  return result;
}

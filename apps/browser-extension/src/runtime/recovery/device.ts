import { hkdfSha256 } from "../../crypto/hkdf";
import { readySodium, wipe } from "../../crypto/sodium";
import { xchachaDecrypt, xchachaEncrypt } from "../../crypto/xchacha";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import {
  bytes,
  canonicalRecord,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "../../domain/validation";
import { base64UrlToBytes, bytesToBase64Url } from "../account/wire";
import { sha256 } from "./kit";

const DEVICE_SIGNING_ALGORITHM = "sign:ed25519:device:v1" as const;
const DEVICE_WRAPPING_ALGORITHM = "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1" as const;
const encoder = new TextEncoder();

export type DeviceClientKind = "ChromeExtension" | "FirefoxExtension";

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly signingPublicKey: Uint8Array;
  readonly signingSecretKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
  readonly wrappingSecretKey: Uint8Array;
}

export interface DeviceCertificateContentV1 {
  readonly version: 1;
  readonly certificateId: string;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly clientKind: DeviceClientKind;
  readonly signingAlgorithm: typeof DEVICE_SIGNING_ALGORITHM;
  readonly signingPublicKey: Uint8Array;
  readonly wrappingAlgorithm: typeof DEVICE_WRAPPING_ALGORITHM;
  readonly wrappingPublicKey: Uint8Array;
  readonly issuedAt: string;
}

export interface DeviceCertificateV1 {
  readonly content: DeviceCertificateContentV1;
  readonly contentCbor: Uint8Array;
  readonly recoveryAdministratorPublicKey: Uint8Array;
  readonly signature: Uint8Array;
}

export interface DeviceKeyEnvelopeMetadataV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly keyEpochId: string;
  readonly deviceId: string;
  readonly algorithm: typeof DEVICE_WRAPPING_ALGORITHM;
  readonly ephemeralPublicKey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertextLength: number;
}

export interface DeviceKeyEnvelopeV1 {
  readonly metadata: DeviceKeyEnvelopeMetadataV1;
  readonly ciphertext: Uint8Array;
  readonly ciphertextSha256: Uint8Array;
  readonly administratorSignature: Uint8Array;
}

export interface DeviceCertificateWireV1 {
  readonly content: string;
  readonly recoveryAdministratorPublicKey: string;
  readonly signature: string;
}

export interface DeviceKeyEnvelopeWireV1 {
  readonly metadata: string;
  readonly ciphertext: string;
  readonly ciphertextSha256: string;
  readonly administratorSignature: string;
}

export function deviceCertificateToWire(certificate: DeviceCertificateV1): DeviceCertificateWireV1 {
  return {
    content: bytesToBase64Url(certificate.contentCbor),
    recoveryAdministratorPublicKey: bytesToBase64Url(certificate.recoveryAdministratorPublicKey),
    signature: bytesToBase64Url(certificate.signature),
  };
}

export function deviceKeyEnvelopeToWire(envelope: DeviceKeyEnvelopeV1): DeviceKeyEnvelopeWireV1 {
  return {
    metadata: bytesToBase64Url(encodeCanonicalCbor(envelope.metadata)),
    ciphertext: bytesToBase64Url(envelope.ciphertext),
    ciphertextSha256: bytesToBase64Url(envelope.ciphertextSha256),
    administratorSignature: bytesToBase64Url(envelope.administratorSignature),
  };
}

export function deviceCertificateFromWire(value: unknown): DeviceCertificateV1 {
  const input = canonicalRecord(value, "deviceCertificate", [
    "content",
    "recoveryAdministratorPublicKey",
    "signature",
  ]);
  const contentCbor = base64UrlToBytes(string(input.content, "deviceCertificate.content"));
  const content = validateCertificateContent(
    decodeCanonicalCbor(contentCbor) as DeviceCertificateContentV1,
  );
  return {
    content,
    contentCbor,
    recoveryAdministratorPublicKey: base64UrlToBytes(
      string(
        input.recoveryAdministratorPublicKey,
        "deviceCertificate.recoveryAdministratorPublicKey",
      ),
      32,
    ),
    signature: base64UrlToBytes(string(input.signature, "deviceCertificate.signature"), 64),
  };
}

export function deviceKeyEnvelopeFromWire(value: unknown): DeviceKeyEnvelopeV1 {
  const input = canonicalRecord(value, "deviceKeyEnvelope", [
    "metadata",
    "ciphertext",
    "ciphertextSha256",
    "administratorSignature",
  ]);
  const metadata = validateEnvelopeMetadata(
    decodeCanonicalCbor(
      base64UrlToBytes(string(input.metadata, "deviceKeyEnvelope.metadata")),
    ) as DeviceKeyEnvelopeMetadataV1,
  );
  return {
    metadata,
    ciphertext: base64UrlToBytes(
      string(input.ciphertext, "deviceKeyEnvelope.ciphertext"),
      metadata.ciphertextLength,
    ),
    ciphertextSha256: base64UrlToBytes(
      string(input.ciphertextSha256, "deviceKeyEnvelope.ciphertextSha256"),
      32,
    ),
    administratorSignature: base64UrlToBytes(
      string(input.administratorSignature, "deviceKeyEnvelope.administratorSignature"),
      64,
    ),
  };
}

function uuidBytes(value: string): Uint8Array {
  uuid(value, "UUID");
  return Uint8Array.from(value.replaceAll("-", "").match(/../gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function validateDisplayName(value: string): string {
  const displayName = value.trim();
  if (displayName.length === 0 || Array.from(displayName).length > 64) {
    throw new Error("Invalid Device certificate");
  }
  return displayName;
}

function validateClientKind(value: string): DeviceClientKind {
  if (value !== "ChromeExtension" && value !== "FirefoxExtension") {
    throw new Error("Invalid Device certificate");
  }
  return value;
}

function validateCertificateContent(value: DeviceCertificateContentV1): DeviceCertificateContentV1 {
  return {
    version: literal(value.version, 1, "deviceCertificate.version"),
    certificateId: uuid(value.certificateId, "deviceCertificate.certificateId"),
    vaultId: uuid(value.vaultId, "deviceCertificate.vaultId"),
    recoveryGenerationId: uuid(
      value.recoveryGenerationId,
      "deviceCertificate.recoveryGenerationId",
    ),
    deviceId: uuid(value.deviceId, "deviceCertificate.deviceId"),
    displayName: validateDisplayName(string(value.displayName, "deviceCertificate.displayName")),
    clientKind: validateClientKind(string(value.clientKind, "deviceCertificate.clientKind")),
    signingAlgorithm: literal(
      value.signingAlgorithm,
      DEVICE_SIGNING_ALGORITHM,
      "deviceCertificate.signingAlgorithm",
    ),
    signingPublicKey: bytes(value.signingPublicKey, 32, "deviceCertificate.signingPublicKey"),
    wrappingAlgorithm: literal(
      value.wrappingAlgorithm,
      DEVICE_WRAPPING_ALGORITHM,
      "deviceCertificate.wrappingAlgorithm",
    ),
    wrappingPublicKey: bytes(value.wrappingPublicKey, 32, "deviceCertificate.wrappingPublicKey"),
    issuedAt: timestamp(value.issuedAt, "deviceCertificate.issuedAt"),
  };
}

export async function createDeviceIdentity(input: {
  readonly deviceId: string;
  readonly signingSeed?: Uint8Array;
  readonly wrappingSecretKey?: Uint8Array;
}): Promise<DeviceIdentity> {
  const sodium = await readySodium();
  const signingSeed = input.signingSeed ?? sodium.randombytes_buf(32);
  const wrappingSecretKey = input.wrappingSecretKey ?? sodium.randombytes_buf(32);
  bytes(signingSeed, 32, "deviceSigningSeed");
  bytes(wrappingSecretKey, 32, "deviceWrappingSecretKey");
  const signing = sodium.crypto_sign_seed_keypair(signingSeed);
  return {
    deviceId: uuid(input.deviceId, "deviceId"),
    signingPublicKey: Uint8Array.from(signing.publicKey),
    signingSecretKey: Uint8Array.from(signing.privateKey),
    wrappingPublicKey: Uint8Array.from(sodium.crypto_scalarmult_base(wrappingSecretKey)),
    wrappingSecretKey: Uint8Array.from(wrappingSecretKey),
  };
}

export async function createDeviceCertificate(input: {
  readonly certificateId: string;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly identity: Pick<DeviceIdentity, "deviceId" | "signingPublicKey" | "wrappingPublicKey">;
  readonly displayName: string;
  readonly clientKind: DeviceClientKind;
  readonly issuedAt: string;
  readonly recoveryAdministratorSeed: Uint8Array;
}): Promise<DeviceCertificateV1> {
  const sodium = await readySodium();
  bytes(input.recoveryAdministratorSeed, 32, "recoveryAdministratorSeed");
  const administrator = sodium.crypto_sign_seed_keypair(input.recoveryAdministratorSeed);
  const content = validateCertificateContent({
    version: 1,
    certificateId: input.certificateId,
    vaultId: input.vaultId,
    recoveryGenerationId: input.recoveryGenerationId,
    deviceId: input.identity.deviceId,
    displayName: input.displayName,
    clientKind: input.clientKind,
    signingAlgorithm: DEVICE_SIGNING_ALGORITHM,
    signingPublicKey: input.identity.signingPublicKey,
    wrappingAlgorithm: DEVICE_WRAPPING_ALGORITHM,
    wrappingPublicKey: input.identity.wrappingPublicKey,
    issuedAt: input.issuedAt,
  });
  const contentCbor = encodeCanonicalCbor(content);
  try {
    return {
      content,
      contentCbor,
      recoveryAdministratorPublicKey: Uint8Array.from(administrator.publicKey),
      signature: Uint8Array.from(
        sodium.crypto_sign_detached(contentCbor, administrator.privateKey),
      ),
    };
  } finally {
    await wipe(Uint8Array.from(administrator.privateKey));
  }
}

export async function verifyDeviceCertificate(certificate: DeviceCertificateV1): Promise<void> {
  const sodium = await readySodium();
  const content = validateCertificateContent(certificate.content);
  bytes(certificate.contentCbor, undefined, "deviceCertificate.contentCbor");
  bytes(
    certificate.recoveryAdministratorPublicKey,
    32,
    "deviceCertificate.recoveryAdministratorPublicKey",
  );
  bytes(certificate.signature, 64, "deviceCertificate.signature");
  if (
    !sameBytes(encodeCanonicalCbor(content), certificate.contentCbor) ||
    !sodium.crypto_sign_verify_detached(
      certificate.signature,
      certificate.contentCbor,
      certificate.recoveryAdministratorPublicKey,
    )
  ) {
    throw new Error("Invalid Device certificate");
  }
}

async function enrollmentTranscript(input: {
  readonly certificate: DeviceCertificateV1;
  readonly accountSessionId: string;
}): Promise<Uint8Array> {
  return encodeCanonicalCbor({
    domain: "awsm:device-enrollment-proof:v1",
    certificateSha256: await sha256(input.certificate.contentCbor),
    certificateSignatureSha256: await sha256(input.certificate.signature),
    accountSessionId: uuid(input.accountSessionId, "accountSessionId"),
  });
}

export async function createDeviceEnrollmentProof(input: {
  readonly certificate: DeviceCertificateV1;
  readonly accountSessionId: string;
  readonly deviceSigningSecretKey: Uint8Array;
}): Promise<Uint8Array> {
  await verifyDeviceCertificate(input.certificate);
  bytes(input.deviceSigningSecretKey, 64, "deviceSigningSecretKey");
  const sodium = await readySodium();
  return Uint8Array.from(
    sodium.crypto_sign_detached(await enrollmentTranscript(input), input.deviceSigningSecretKey),
  );
}

export async function verifyDeviceEnrollmentProof(input: {
  readonly certificate: DeviceCertificateV1;
  readonly accountSessionId: string;
  readonly proof: Uint8Array;
}): Promise<void> {
  await verifyDeviceCertificate(input.certificate);
  bytes(input.proof, 64, "deviceEnrollmentProof");
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      input.proof,
      await enrollmentTranscript(input),
      input.certificate.content.signingPublicKey,
    )
  ) {
    throw new Error("Invalid Device enrollment proof");
  }
}

function envelopeAad(metadata: DeviceKeyEnvelopeMetadataV1): Uint8Array {
  return encodeCanonicalCbor(metadata);
}

function envelopeSignaturePayload(
  metadata: DeviceKeyEnvelopeMetadataV1,
  ciphertextSha256: Uint8Array,
): Uint8Array {
  return encodeCanonicalCbor({ metadata, ciphertextSha256 });
}

function validateEnvelopeMetadata(value: DeviceKeyEnvelopeMetadataV1): DeviceKeyEnvelopeMetadataV1 {
  return {
    version: literal(value.version, 1, "deviceKeyEnvelope.version"),
    vaultId: uuid(value.vaultId, "deviceKeyEnvelope.vaultId"),
    recoveryGenerationId: uuid(
      value.recoveryGenerationId,
      "deviceKeyEnvelope.recoveryGenerationId",
    ),
    keyEpochId: uuid(value.keyEpochId, "deviceKeyEnvelope.keyEpochId"),
    deviceId: uuid(value.deviceId, "deviceKeyEnvelope.deviceId"),
    algorithm: literal(value.algorithm, DEVICE_WRAPPING_ALGORITHM, "deviceKeyEnvelope.algorithm"),
    ephemeralPublicKey: bytes(value.ephemeralPublicKey, 32, "deviceKeyEnvelope.ephemeralPublicKey"),
    nonce: bytes(value.nonce, 24, "deviceKeyEnvelope.nonce"),
    ciphertextLength: integer(value.ciphertextLength, "deviceKeyEnvelope.ciphertextLength"),
  };
}

async function deviceWrappingKey(input: {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly keyEpochId: string;
}): Promise<Uint8Array> {
  const sodium = await readySodium();
  let shared: Uint8Array | undefined;
  try {
    shared = Uint8Array.from(sodium.crypto_scalarmult(input.secretKey, input.publicKey));
    if (shared.every((byte) => byte === 0)) throw new Error("Invalid Device key");
    return await hkdfSha256({
      inputKeyMaterial: shared,
      salt: uuidBytes(input.keyEpochId),
      info: encoder.encode("awsm:device-key-envelope:v1"),
      length: 32,
    });
  } catch {
    throw new Error("Invalid Device key");
  } finally {
    if (shared !== undefined) await wipe(shared);
  }
}

export async function createDeviceKeyEnvelope(input: {
  readonly certificate: DeviceCertificateV1;
  readonly keyEpochId: string;
  readonly epochRootKey: Uint8Array;
  readonly recoveryAdministratorSeed: Uint8Array;
  readonly ephemeralSecretKey?: Uint8Array;
  readonly nonce?: Uint8Array;
}): Promise<DeviceKeyEnvelopeV1> {
  await verifyDeviceCertificate(input.certificate);
  bytes(input.epochRootKey, 32, "epochRootKey");
  bytes(input.recoveryAdministratorSeed, 32, "recoveryAdministratorSeed");
  const sodium = await readySodium();
  const ephemeralSecretKey = input.ephemeralSecretKey ?? sodium.randombytes_buf(32);
  const ephemeralPublicKey = Uint8Array.from(sodium.crypto_scalarmult_base(ephemeralSecretKey));
  const nonce = input.nonce ?? sodium.randombytes_buf(24);
  const metadata = validateEnvelopeMetadata({
    version: 1,
    vaultId: input.certificate.content.vaultId,
    recoveryGenerationId: input.certificate.content.recoveryGenerationId,
    keyEpochId: input.keyEpochId,
    deviceId: input.certificate.content.deviceId,
    algorithm: DEVICE_WRAPPING_ALGORITHM,
    ephemeralPublicKey,
    nonce,
    ciphertextLength: 48,
  });
  const wrappingKey = await deviceWrappingKey({
    secretKey: ephemeralSecretKey,
    publicKey: input.certificate.content.wrappingPublicKey,
    keyEpochId: input.keyEpochId,
  });
  const administrator = sodium.crypto_sign_seed_keypair(input.recoveryAdministratorSeed);
  try {
    const ciphertext = await xchachaEncrypt({
      plaintext: input.epochRootKey,
      aad: envelopeAad(metadata),
      nonce,
      key: wrappingKey,
    });
    const ciphertextSha256 = await sha256(ciphertext);
    return {
      metadata,
      ciphertext,
      ciphertextSha256,
      administratorSignature: Uint8Array.from(
        sodium.crypto_sign_detached(
          envelopeSignaturePayload(metadata, ciphertextSha256),
          administrator.privateKey,
        ),
      ),
    };
  } finally {
    await Promise.all([
      wipe(Uint8Array.from(ephemeralSecretKey)),
      wipe(wrappingKey),
      wipe(Uint8Array.from(administrator.privateKey)),
    ]);
  }
}

export async function openDeviceKeyEnvelope(input: {
  readonly envelope: DeviceKeyEnvelopeV1;
  readonly certificate: DeviceCertificateV1;
  readonly deviceWrappingSecretKey: Uint8Array;
}): Promise<Uint8Array> {
  await verifyDeviceCertificate(input.certificate);
  const metadata = validateEnvelopeMetadata(input.envelope.metadata);
  bytes(input.envelope.ciphertext, metadata.ciphertextLength, "deviceKeyEnvelope.ciphertext");
  bytes(input.envelope.ciphertextSha256, 32, "deviceKeyEnvelope.ciphertextSha256");
  bytes(input.envelope.administratorSignature, 64, "deviceKeyEnvelope.administratorSignature");
  bytes(input.deviceWrappingSecretKey, 32, "deviceWrappingSecretKey");
  const matches =
    metadata.vaultId === input.certificate.content.vaultId &&
    metadata.recoveryGenerationId === input.certificate.content.recoveryGenerationId &&
    metadata.deviceId === input.certificate.content.deviceId &&
    sameBytes(await sha256(input.envelope.ciphertext), input.envelope.ciphertextSha256);
  const sodium = await readySodium();
  if (
    !matches ||
    !sodium.crypto_sign_verify_detached(
      input.envelope.administratorSignature,
      envelopeSignaturePayload(metadata, input.envelope.ciphertextSha256),
      input.certificate.recoveryAdministratorPublicKey,
    )
  ) {
    throw new Error("Invalid Device key envelope");
  }
  const wrappingKey = await deviceWrappingKey({
    secretKey: input.deviceWrappingSecretKey,
    publicKey: metadata.ephemeralPublicKey,
    keyEpochId: metadata.keyEpochId,
  });
  try {
    return await xchachaDecrypt({
      ciphertext: input.envelope.ciphertext,
      aad: envelopeAad(metadata),
      nonce: metadata.nonce,
      key: wrappingKey,
    });
  } finally {
    await wipe(wrappingKey);
  }
}

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

function header(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length <= 0xff) return Buffer.from([(major << 5) | 24, length]);
  if (length <= 0xffff) {
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(5);
  bytes[0] = (major << 5) | 26;
  bytes.writeUInt32BE(length, 1);
  return bytes;
}

function canonicalCbor(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([header(2, bytes.length), bytes]);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([header(3, bytes.length), bytes]);
  }
  if (Number.isSafeInteger(value) && value >= 0) return header(0, value);
  if (Array.isArray(value)) {
    return Buffer.concat([header(4, value.length), ...value.map(canonicalCbor)]);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .map(([key, item]) => [canonicalCbor(key), canonicalCbor(item)])
      .sort(([left], [right]) => left.length - right.length || Buffer.compare(left, right));
    return Buffer.concat([
      header(5, entries.length),
      ...entries.flatMap(([key, item]) => [key, item]),
    ]);
  }
  throw new TypeError("Unsupported canonical CBOR proof value");
}

function rawEd25519PublicKey(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).subarray(-32);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest();
}

export function createInitialVaultAuthority(
  accountSessionId,
  generationBytes,
  clientKind = "ChromeExtension",
) {
  const vaultId = randomUUID();
  const recoveryGenerationId = randomUUID();
  const keyEpochId = randomUUID();
  const deviceId = randomUUID();
  const certificateId = randomUUID();
  const generationId = randomUUID();
  const administrator = generateKeyPairSync("ed25519");
  const device = generateKeyPairSync("ed25519");
  const administratorPublicKey = rawEd25519PublicKey(administrator.publicKey);
  const devicePublicKey = rawEd25519PublicKey(device.publicKey);
  const activatedAt = new Date().toISOString();
  const certificateContent = canonicalCbor({
    version: 1,
    certificateId,
    vaultId,
    recoveryGenerationId,
    deviceId,
    displayName: "Coordination proof",
    clientKind,
    signingAlgorithm: "sign:ed25519:device:v1",
    signingPublicKey: devicePublicKey,
    wrappingAlgorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
    wrappingPublicKey: randomBytes(32),
    issuedAt: activatedAt,
  });
  const certificateSignature = sign(null, certificateContent, administrator.privateKey);
  const envelopeCiphertext = randomBytes(48);
  const envelopeMetadata = {
    version: 1,
    vaultId,
    recoveryGenerationId,
    keyEpochId,
    deviceId,
    algorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
    ephemeralPublicKey: randomBytes(32),
    nonce: randomBytes(24),
    ciphertextLength: envelopeCiphertext.length,
  };
  const envelopeDigest = digest(envelopeCiphertext);
  const recoveryCiphertext = randomBytes(64);
  const enrollmentTranscript = canonicalCbor({
    domain: "awsm:device-enrollment-proof:v1",
    certificateSha256: digest(certificateContent),
    certificateSignatureSha256: digest(certificateSignature),
    accountSessionId,
  });
  const encode = (bytes) => Buffer.from(bytes).toString("base64url");
  return {
    vaultId,
    generationId,
    keyEpochId,
    body: {
      vaultId,
      recoveryGeneration: {
        version: 1,
        vaultId,
        recoveryGenerationId,
        derivationAlgorithm: "kdf:hkdf-sha256:recovery-entropy:v1",
        wrappingAlgorithm: "wrap:xchacha20poly1305:recovery-kit:v1",
        administratorSigningAlgorithm: "sign:ed25519:recovery-administrator:v1",
        administratorPublicKey: encode(administratorPublicKey),
        nonce: encode(randomBytes(24)),
        ciphertextLength: recoveryCiphertext.length,
        ciphertextSha256: encode(digest(recoveryCiphertext)),
        ciphertext: encode(recoveryCiphertext),
      },
      keyEpochs: [{ keyEpochId, ordinal: 0, activatedAt }],
      activeKeyEpochId: keyEpochId,
      deviceCertificate: {
        content: encode(certificateContent),
        recoveryAdministratorPublicKey: encode(administratorPublicKey),
        signature: encode(certificateSignature),
      },
      deviceKeyEnvelopes: [
        {
          metadata: encode(canonicalCbor(envelopeMetadata)),
          ciphertext: encode(envelopeCiphertext),
          ciphertextSha256: encode(envelopeDigest),
          administratorSignature: encode(
            sign(
              null,
              canonicalCbor({
                metadata: envelopeMetadata,
                ciphertextSha256: envelopeDigest,
              }),
              administrator.privateKey,
            ),
          ),
        },
      ],
      deviceProofSignature: encode(sign(null, enrollmentTranscript, device.privateKey)),
      generationId,
      generationNumber: 0,
      generationObject: {
        objectId: generationId,
        objectType: "VaultGeneration",
        keyEpochId,
        byteLength: generationBytes.length,
        sha256: encode(digest(generationBytes)),
      },
    },
  };
}

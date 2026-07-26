import { describe, expect, it } from "vitest";

import {
  decodeEncryptedEnvelopeBytes,
  decryptEnvelope,
  encodeEncryptedEnvelope,
  encryptEnvelope,
} from "../../src/crypto/envelope";
import { deriveContextKey, hkdfSha256 } from "../../src/crypto/hkdf";
import { derivePassphraseKey } from "../../src/crypto/passphrase";
import { xchachaDecrypt, xchachaEncrypt } from "../../src/crypto/xchacha";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyEpochId = "00000000-0000-4000-8000-000000000009";

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("cryptographic contracts", () => {
  it("matches RFC 5869 HKDF-SHA256 test case 1", async () => {
    const output = await hkdfSha256({
      inputKeyMaterial: new Uint8Array(22).fill(0x0b),
      salt: fromHex("000102030405060708090a0b0c"),
      info: fromHex("f0f1f2f3f4f5f6f7f8f9"),
      length: 42,
    });

    expect(toHex(output)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a" +
        "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
        "34007208d5b887185865",
    );
  });

  it("domain-separates descriptor, Artifact, Event, and Projection keys", async () => {
    const rootKey = new Uint8Array(32).fill(7);
    const common = {
      rootKey,
      vaultId: "00000000-0000-4000-8000-000000000001",
      keyEpochId,
      contextId: "00000000-0000-4000-8000-000000000002",
      keyVersion: 1,
    } as const;

    const descriptor = await deriveContextKey({
      ...common,
      domain: "vault:bundle-descriptor:v1",
    });
    const artifact = await deriveContextKey({ ...common, domain: "vault:artifact:v1" });
    const event = await deriveContextKey({ ...common, domain: "vault:event:v1" });
    const projection = await deriveContextKey({ ...common, domain: "vault:projection:v1" });

    expect(toHex(descriptor)).not.toBe(toHex(artifact));
    expect(toHex(artifact)).not.toBe(toHex(event));
    expect(toHex(event)).not.toBe(toHex(projection));
    expect(await deriveContextKey({ ...common, domain: "vault:bundle-descriptor:v1" })).toEqual(
      descriptor,
    );
  });

  it("matches a fixed XChaCha20-Poly1305 vector", async () => {
    const key = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    const nonce = fromHex("000102030405060708090a0b0c0d0e0f1011121314151617");
    const aad = encoder.encode("awsm-header");
    const plaintext = encoder.encode("preserve this");

    const ciphertext = await xchachaEncrypt({ plaintext, aad, nonce, key });

    expect(toHex(ciphertext)).toBe("eeb06a0cf5a0fbcb13304ea7b87bc935a88ce37bc8a1fc17aad000f798");
    expect(decoder.decode(await xchachaDecrypt({ ciphertext, aad, nonce, key }))).toBe(
      "preserve this",
    );
  });

  it("matches the fixed Argon2id onboarding parameters", async () => {
    const output = await derivePassphraseKey({
      passphrase: "correct horse battery staple",
      salt: fromHex("000102030405060708090a0b0c0d0e0f"),
      operations: 3,
      memoryBytes: 64 * 1024 * 1024,
    });

    expect(toHex(output)).toBe("0d1a3c6523c8f06e4e0af9c515aa5b5448cfebd6838f2d52c3d8b6ef8ddc3c2e");
  });

  it("authenticates every envelope header field before exposing plaintext", async () => {
    const key = new Uint8Array(32).fill(9);
    const plaintext = encoder.encode("private title and MHTML");
    const envelope = await encryptEnvelope({
      objectType: "BundleDescriptor",
      objectId: "00000000-0000-4000-8000-000000000003",
      keyEpochId,
      plaintext,
      key,
      nonce: new Uint8Array(24).fill(4),
    });

    expect(await decryptEnvelope(envelope, key, keyEpochId)).toEqual(plaintext);

    const mutations = [
      { ...envelope, objectType: "Event" as const },
      { ...envelope, objectId: "00000000-0000-4000-8000-000000000004" },
      { ...envelope, keyEpochId: "00000000-0000-4000-8000-000000000008" },
      { ...envelope, payloadLength: envelope.payloadLength + 1 },
      { ...envelope, nonce: envelope.nonce.map((byte, index) => (index === 0 ? byte ^ 1 : byte)) },
      {
        ...envelope,
        ciphertext: envelope.ciphertext.map((byte, index) => (index === 0 ? byte ^ 1 : byte)),
      },
    ];

    for (const mutation of mutations) {
      await expect(decryptEnvelope(mutation, key, keyEpochId)).rejects.toMatchObject({
        id: "CRYPTO_AUTHENTICATION_FAILED",
      });
    }
  });

  it("serializes an envelope without exposing its plaintext", async () => {
    const plaintext = encoder.encode("https://secret.example/private-title");
    const envelope = await encryptEnvelope({
      objectType: "Projection",
      objectId: "00000000-0000-4000-8000-000000000005",
      keyEpochId,
      plaintext,
      key: new Uint8Array(32).fill(5),
      nonce: new Uint8Array(24).fill(6),
    });
    const encoded = encodeEncryptedEnvelope(envelope);

    expect(decoder.decode(encoded)).not.toContain("secret.example");
    expect(decodeEncryptedEnvelopeBytes(encoded)).toEqual(envelope);
  });
});

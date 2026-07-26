import { describe, expect, it } from "vitest";
import {
  createRecoveryKit,
  openRecoveryKit,
  type RecoveryKeyringV1,
} from "../../src/runtime/recovery/kit";
import {
  decodeRecoveryPhrase,
  deriveRecoveryKeys,
  encodeRecoveryPhrase,
  normalizeRecoveryPhrase,
} from "../../src/runtime/recovery/phrase";
import { decodeRecoveryFile, encodeRecoveryFile } from "../../src/runtime/recovery/recovery-file";

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Recovery Phrase and Recovery Kit", () => {
  const vaultId = "01900000-0000-7000-8000-000000000011";
  const recoveryGenerationId = "01900000-0000-7000-8000-000000000012";
  const keyEpochId = "01900000-0000-7000-8000-000000000013";
  const entropy = new Uint8Array(16);

  it("encodes exactly 128 bits as 12 English BIP39 words and normalizes input", () => {
    const phrase = encodeRecoveryPhrase(entropy);

    expect(phrase.split(" ")).toHaveLength(12);
    expect(decodeRecoveryPhrase(phrase)).toEqual(entropy);
    expect(normalizeRecoveryPhrase(`  ${phrase.toUpperCase().replaceAll(" ", " \n ")}  `)).toBe(
      phrase,
    );
    expect(() => decodeRecoveryPhrase(`${phrase} abandon`)).toThrow(
      "That Recovery Phrase is not valid.",
    );
    expect(() => decodeRecoveryPhrase(phrase.replace(/about$/u, "zoo"))).toThrow(
      "That Recovery Phrase is not valid.",
    );
  });

  it("matches the AWSM-specific HKDF recovery vectors", async () => {
    const keys = await deriveRecoveryKeys({ entropy, vaultId });

    expect(toHex(keys.recoveryKitWrappingKey)).toBe(
      "d463e0cc96d80c2ebe4bd44754469754341b458e4859493efcf8c3ce8d7f14b1",
    );
    expect(toHex(keys.recoveryAdministratorSeed)).toBe(
      "42253b84ecce64150182d448b736222cc36e826bd62d3ed380fe2000583f6df0",
    );
  });

  it("encrypts every contiguous key epoch and round-trips the self-describing file", async () => {
    const keyring: RecoveryKeyringV1 = {
      version: 1,
      vaultId,
      recoveryGenerationId,
      activeKeyEpochId: keyEpochId,
      keyEpochs: [
        {
          keyEpochId,
          ordinal: 0,
          rootKey: new Uint8Array(32).fill(0x41),
        },
      ],
    };
    const keys = await deriveRecoveryKeys({ entropy, vaultId });
    const kit = await createRecoveryKit({
      keyring,
      recoveryKitWrappingKey: keys.recoveryKitWrappingKey,
      recoveryAdministratorSeed: keys.recoveryAdministratorSeed,
      nonce: new Uint8Array(24).fill(0x31),
    });

    expect(kit.metadata).toMatchObject({
      version: 1,
      vaultId,
      recoveryGenerationId,
      derivationAlgorithm: "kdf:hkdf-sha256:recovery-entropy:v1",
      wrappingAlgorithm: "wrap:xchacha20poly1305:recovery-kit:v1",
      administratorSigningAlgorithm: "sign:ed25519:recovery-administrator:v1",
      nonce: new Uint8Array(24).fill(0x31),
    });
    expect(kit.metadata.administratorPublicKey).toHaveLength(32);
    expect(kit.metadata.ciphertextSha256).toHaveLength(32);
    await expect(openRecoveryKit(kit, keys.recoveryKitWrappingKey)).resolves.toEqual(keyring);

    const file = encodeRecoveryFile(kit);
    expect(new TextDecoder().decode(file.subarray(0, 8))).toBe("AWSMREC1");
    await expect(decodeRecoveryFile(file)).resolves.toEqual(kit);
  });

  it("rejects metadata, ciphertext, file-length, and keyring tampering", async () => {
    const keys = await deriveRecoveryKeys({ entropy, vaultId });
    const kit = await createRecoveryKit({
      keyring: {
        version: 1,
        vaultId,
        recoveryGenerationId,
        activeKeyEpochId: keyEpochId,
        keyEpochs: [
          {
            keyEpochId,
            ordinal: 0,
            rootKey: new Uint8Array(32).fill(0x41),
          },
        ],
      },
      recoveryKitWrappingKey: keys.recoveryKitWrappingKey,
      recoveryAdministratorSeed: keys.recoveryAdministratorSeed,
      nonce: new Uint8Array(24).fill(0x31),
    });

    await expect(
      openRecoveryKit(
        { ...kit, metadata: { ...kit.metadata, vaultId: crypto.randomUUID() } },
        keys.recoveryKitWrappingKey,
      ),
    ).rejects.toThrow();

    const corrupted = Uint8Array.from(kit.ciphertext);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    await expect(
      openRecoveryKit({ ...kit, ciphertext: corrupted }, keys.recoveryKitWrappingKey),
    ).rejects.toThrow();

    const file = encodeRecoveryFile(kit);
    await expect(decodeRecoveryFile(file.subarray(0, file.byteLength - 1))).rejects.toThrow();

    const wrongKey = fromHex("ff".repeat(32));
    await expect(openRecoveryKit(kit, wrongKey)).rejects.toThrow();
  });
});

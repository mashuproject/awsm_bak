import { describe, expect, it } from "vitest";

import {
  artifactWrapperKey,
  compactItemKey,
  decodeRecoveryPhrase,
  deriveRecoveryCredential,
  encodeRecoveryPhrase,
  epochPrk,
  frameNonce,
  normalizeRecoveryPhrase,
  recoveryPublicFingerprint,
} from "../../src/crypto/canonical";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("canonical Recovery derivation", () => {
  it("uses the BIP39 English 128-bit entropy form without PBKDF2", () => {
    const entropy = new Uint8Array(16);
    const phrase =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    expect(encodeRecoveryPhrase(entropy)).toBe(phrase);
    expect(decodeRecoveryPhrase(phrase)).toEqual(entropy);
    expect(normalizeRecoveryPhrase(`  ${phrase.replaceAll(" ", "  ")}  `)).toBe(phrase);
    expect(() => decodeRecoveryPhrase(phrase.replace("about", "abandon"))).toThrow();
    expect(() => decodeRecoveryPhrase(phrase.toUpperCase())).toThrow();
  });

  it("matches fixed Recovery signing, wrapping, and fingerprint vectors", async () => {
    const keys = await deriveRecoveryCredential(new Uint8Array(16));

    expect({
      signingSeed: hex(keys.signingSeed),
      signingPublicKey: hex(keys.signingPublicKey),
      wrappingPrivateKey: hex(keys.wrappingPrivateKey),
      wrappingPublicKey: hex(keys.wrappingPublicKey),
      fingerprint: hex(recoveryPublicFingerprint(keys.wrappingPublicKey)),
    }).toEqual({
      signingSeed: "248341a7e632dd9056e64df62d9e491ddf1061f7e217763ce81879d0658a3692",
      signingPublicKey: "8fec89ba830e118bbcdb4acd0dbfee7177a4c15e3981248b75aa957439aab1e6",
      wrappingPrivateKey: "206ba938240700bb78552f7757e3f47274dc8a171fa1ad374a5378a288583845",
      wrappingPublicKey: "cf75c09361520c7abe1c5766688c3f7f10fb95225342f40bf40eddc31a320a4f",
      fingerprint: "fe9de1824d7d2713a1079e3c17f237a1f0658e711fdb793c9db0e57614127f0b",
    });
  });
});

describe("canonical Key Epoch derivation", () => {
  it("matches fixed Epoch, compact item, wrapper, and frame vectors", () => {
    const vaultId = identifier("Vault", new Uint8Array(32).fill(1));
    const epochKey = new Uint8Array(32).fill(2);
    const epochId = keyEpochId(vaultId, epochKey);
    const parameters = new Uint8Array(64).map((_, index) => index);
    const artifactId = identifier("Artifact", new Uint8Array(32).fill(3));

    expect({
      epochId: hex(epochId),
      epochPrk: hex(epochPrk(vaultId, epochId, epochKey)),
      compactKey: hex(
        compactItemKey({
          vaultId,
          keyEpochId: epochId,
          keyEpochKey: epochKey,
          protectionParameters: parameters,
        }),
      ),
      wrapperKey: hex(
        artifactWrapperKey({
          vaultId,
          keyEpochId: epochId,
          keyEpochKey: epochKey,
          artifactId,
          protectionParameters: parameters,
        }),
      ),
      firstNonce: hex(frameNonce(parameters.slice(0, 24), 0)),
      lastNonce: hex(frameNonce(parameters.slice(0, 24), 0xffff_ffff)),
    }).toEqual({
      epochId: "a15170f58c3006fed403e67173e76668462671109a847ac064e259db6a558f3e",
      epochPrk: "aa523e025bb325795c97afbbf56927b3170da55f36475742a3d5edba743d5394",
      compactKey: "cf39f0b9bcf7578f25f72837ab0cc08f7bfa77bcbe78bbaf54072874fbcb98e1",
      wrapperKey: "8f2efabac1766c3f795cd724ef8121de07f95e91d9263d45ab6617822a7642a7",
      firstNonce: "000102030405060708090a0b0c0d0e0f0000000000000000",
      lastNonce: "000102030405060708090a0b0c0d0e0f00000000ffffffff",
    });
  });

  it("fails closed on mismatched context and out-of-range frames", () => {
    const vaultId = identifier("Vault", new Uint8Array(32).fill(1));
    const otherVaultId = identifier("Vault", new Uint8Array(32).fill(2));
    const epochKey = new Uint8Array(32).fill(3);
    const epochId = keyEpochId(vaultId, epochKey);

    expect(() => epochPrk(otherVaultId, epochId, epochKey)).toThrow(/does not match/u);
    expect(() => frameNonce(new Uint8Array(24), -1)).toThrow();
    expect(() => frameNonce(new Uint8Array(24), 0x1_0000_0000)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import vectors from "../../../test-vectors/canonical-v1.json";

import {
  artifactWrapperKey,
  compactItemKey,
  deriveRecoveryCredential,
  encodeRecoveryPhrase,
  epochPrk,
  frameNonce,
} from "../../src/crypto/canonical";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("shared browser/Go canonical crypto vectors", () => {
  it("matches the committed Recovery and Key Epoch corpus", async () => {
    const recovery = vectors.recovery;
    expect(encodeRecoveryPhrase(bytes(recovery.entropy))).toBe(recovery.phrase);
    const keys = await deriveRecoveryCredential(bytes(recovery.entropy));
    expect({
      signingSeed: hex(keys.signingSeed),
      signingPublicKey: hex(keys.signingPublicKey),
      wrappingPrivateKey: hex(keys.wrappingPrivateKey),
      wrappingPublicKey: hex(keys.wrappingPublicKey),
    }).toEqual({
      signingSeed: recovery.signingSeed,
      signingPublicKey: recovery.signingPublicKey,
      wrappingPrivateKey: recovery.wrappingPrivateKey,
      wrappingPublicKey: recovery.wrappingPublicKey,
    });

    const keyEpoch = vectors.keyEpoch;
    const vaultId = identifier("Vault", bytes(keyEpoch.vaultId));
    const epochKey = bytes(keyEpoch.key);
    const epochId = keyEpochId(vaultId, epochKey);
    expect(hex(epochId)).toBe(keyEpoch.id);
    expect(hex(epochPrk(vaultId, epochId, epochKey))).toBe(keyEpoch.epochPrk);
    const protectionParameters = bytes(keyEpoch.protection);
    expect(
      hex(
        compactItemKey({
          vaultId,
          keyEpochId: epochId,
          keyEpochKey: epochKey,
          protectionParameters,
        }),
      ),
    ).toBe(keyEpoch.compactKey);
    expect(
      hex(
        artifactWrapperKey({
          vaultId,
          keyEpochId: epochId,
          keyEpochKey: epochKey,
          artifactId: identifier("Artifact", bytes(keyEpoch.artifactId)),
          protectionParameters,
        }),
      ),
    ).toBe(keyEpoch.wrapperKey);
    const baseNonce = protectionParameters.slice(0, 24);
    expect(hex(frameNonce(baseNonce, 0))).toBe(keyEpoch.firstNonce);
    expect(hex(frameNonce(baseNonce, 0xffff_ffff))).toBe(keyEpoch.lastNonce);
  });
});

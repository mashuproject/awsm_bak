import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import { createKeyEpoch, deriveRecoveryCredential } from "../../src/crypto/canonical";
import { openKeyEnvelope, sealKeyEnvelope } from "../../src/crypto/key-envelope";
import { readySodium } from "../../src/crypto/sodium";
import {
  advisoryExtensions,
  EMPTY_REQUIRED_FEATURE_SET_ID,
} from "../../src/domain/canonical/features";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  BUNDLE_DESCRIPTOR_OBJECT,
  decodeVaultObject,
  encodeVaultObject,
  NOTE_CONTENT_OBJECT,
} from "../../src/domain/canonical/object";
import { transcript } from "../../src/domain/canonical/transcript";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../src/domain/canonical/value";

function id<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, fill: number) {
  return identifier(kind, new Uint8Array(32).fill(fill));
}

function map(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("canonical Vault Objects", () => {
  const vaultId = id("Vault", 1);
  const extensions = advisoryExtensions([]);
  const payload = new TextEncoder().encode("artifact payload");
  const payloadDigest = sha256(transcript("awsm:artifact-payload:v1", [payload]));

  const artifact = encodeVaultObject({
    vaultId,
    objectType: ARTIFACT_OBJECT,
    requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
    extensions,
    body: map(
      1,
      "awsm.artifact.capture",
      "application/vnd.awsm.web-page+zip",
      "awsm.representation.page-snapshot-v1",
      payload.byteLength,
      payloadDigest,
      map(1, 1_048_576, 16, payload.byteLength, payloadDigest),
      new Uint8Array(),
    ),
  });

  it("round-trips Artifact, Descriptor, and Note Object envelopes", () => {
    expect(decodeVaultObject(artifact.bytes)).toEqual(artifact);
    expect(artifactId(artifact)).toEqual(artifact.objectId);

    const descriptor = encodeVaultObject({
      vaultId,
      objectType: BUNDLE_DESCRIPTOR_OBJECT,
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      extensions,
      body: map(
        1,
        id("Bundle", 2),
        1_725_000_000_000,
        "https://example.com/original?x=1",
        "https://example.com/final",
        "awsm.capture.web-page-snapshot",
        "awsm.adapter.browser-extension",
        0,
        "Example",
        canonicalSet([map(artifact.objectId, "awsm.artifact.primary")]),
        [],
        map(1, new Uint8Array()),
      ),
    });
    expect(descriptor.referencedObjectIds).toEqual([artifact.objectId]);
    expect(decodeVaultObject(descriptor.bytes)).toEqual(descriptor);

    const note = encodeVaultObject({
      vaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      extensions,
      body: map(1, "Research", "A **portable** note.\n", "awsm.note.commonmark"),
    });
    expect(decodeVaultObject(note.bytes)).toEqual(note);
  });

  it("binds wrapper contract fields and rejects active Note content", () => {
    expect(() =>
      encodeVaultObject({
        vaultId,
        objectType: ARTIFACT_OBJECT,
        requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
        extensions,
        body: map(
          1,
          "awsm.artifact.capture",
          "application/octet-stream",
          "awsm.representation.binary",
          payload.byteLength,
          payloadDigest,
          map(1, 1_048_576, 16, payload.byteLength + 1, payloadDigest),
          new Uint8Array(),
        ),
      }),
    ).toThrow(/length/u);
    expect(() =>
      encodeVaultObject({
        vaultId,
        objectType: NOTE_CONTENT_OBJECT,
        requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
        extensions,
        body: map(1, null, "<script>alert(1)</script>", "awsm.note.commonmark"),
      }),
    ).toThrow(/prohibited/u);
  });
});

describe("RFC 9180 Key Envelopes", () => {
  it("opens a Recovery target and binds the logical plaintext independently of outer randomness", async () => {
    const vaultId = id("Vault", 20);
    const epochKey = new Uint8Array(32).fill(24);
    const epoch = { id: keyEpochId(vaultId, epochKey), key: epochKey };
    const recovery = await deriveRecoveryCredential(new Uint8Array(16).fill(21));
    const targetCredentialId = id("RecoveryCredential", 22);
    const sealed = await sealKeyEnvelope({
      vaultId,
      keyEpochId: epoch.id,
      keyEpochKey: epoch.key,
      targetKind: 1,
      targetCredentialId,
      targetRevision: 0,
      recipientWrappingPublicKey: recovery.wrappingPublicKey,
      outerPadding: new Uint8Array(32).fill(23),
    });
    const opened = await openKeyEnvelope({
      targetKind: 1,
      recipientWrappingPrivateKey: recovery.wrappingPrivateKey,
      envelopeBytes: sealed.envelope.bytes,
    });
    expect(opened.id).toEqual(sealed.id);
    expect(opened.keyEpochKey).toEqual(epoch.key);
    expect(opened.targetCredentialId).toEqual(targetCredentialId);
    expect(sealed.envelope.protectionParameters.slice(32)).toEqual(new Uint8Array(32).fill(23));
    expect(hex(sealed.id)).toBe("d86ce16336356b6331586f5cc3e97d2d061a58d2bcec68607c755fd9eb3e3ab7");
  });

  it("fails closed for a wrong private key, target domain, or modified ciphertext", async () => {
    const sodium = await readySodium();
    const vaultId = id("Vault", 30);
    const epoch = createKeyEpoch(vaultId);
    const privateKey = new Uint8Array(32).fill(31);
    const publicKey = Uint8Array.from(sodium.crypto_scalarmult_base(privateKey));
    const sealed = await sealKeyEnvelope({
      vaultId,
      keyEpochId: epoch.id,
      keyEpochKey: epoch.key,
      targetKind: 2,
      targetCredentialId: id("ClientCredential", 32),
      targetRevision: null,
      recipientWrappingPublicKey: publicKey,
    });
    await expect(
      openKeyEnvelope({
        targetKind: 2,
        recipientWrappingPrivateKey: new Uint8Array(32).fill(33),
        envelopeBytes: sealed.envelope.bytes,
      }),
    ).rejects.toThrow();
    await expect(
      openKeyEnvelope({
        targetKind: 1,
        recipientWrappingPrivateKey: privateKey,
        envelopeBytes: sealed.envelope.bytes,
      }),
    ).rejects.toThrow();
    const tampered = Uint8Array.from(sealed.envelope.bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await expect(
      openKeyEnvelope({
        targetKind: 2,
        recipientWrappingPrivateKey: privateKey,
        envelopeBytes: tampered,
      }),
    ).rejects.toThrow();
  });
});

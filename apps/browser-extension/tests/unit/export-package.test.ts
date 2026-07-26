import { describe, expect, it } from "vitest";

import { encodeCanonicalCbor } from "../../src/domain/cbor";
import {
  createExportKeyEnvelope,
  decodeExportKeyEnvelope,
  decodeExportManifest,
  type ExportManifestV1,
  openExportKeyEnvelope,
} from "../../src/runtime/export";

const packageId = "10000000-0000-4000-8000-000000000001";
const vaultId = "20000000-0000-4000-8000-000000000002";
const generationId = "30000000-0000-4000-8000-000000000003";

function manifest(): ExportManifestV1 {
  return {
    exportFormatVersion: 1,
    packageId,
    createdAt: "2026-07-18T20:00:00.000Z",
    originatingVaultId: vaultId,
    generationId,
    generationNumber: 0,
    coverage: "Complete",
    objectCount: 0,
    eventCount: 0,
    artifactPayloadCount: 0,
    supportedFeatures: ["artifact-graph", "selective-coverage", "vault-generation"],
    entries: [],
    omissions: [],
    contentIntegrity: {
      algorithm: "hash:sha256:v1",
      checksum: new Uint8Array(32),
    },
  };
}

describe("Vault Package contracts", () => {
  it("strictly decodes the canonical Manifest and rejects unknown fields", () => {
    const value = manifest();
    expect(decodeExportManifest(encodeCanonicalCbor(value))).toEqual(value);
    expect(() => decodeExportManifest(encodeCanonicalCbor({ ...value, optional: true }))).toThrow(
      /canonical schema/u,
    );
  });

  it("wraps the Root Key for only the exact Manifest and passphrase", async () => {
    const manifestBytes = encodeCanonicalCbor(manifest());
    const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const keyring = {
      version: 1 as const,
      vaultId,
      activeKeyEpochId: "00000000-0000-4000-8000-000000000009",
      keyEpochs: [
        {
          keyEpochId: "00000000-0000-4000-8000-000000000009",
          ordinal: 0,
          rootKey,
        },
      ],
    };
    const envelope = await createExportKeyEnvelope({
      packageId,
      originatingVaultId: vaultId,
      manifestBytes,
      passphrase: "correct horse battery staple",
      keyring,
      salt: new Uint8Array(16).fill(7),
      nonce: new Uint8Array(24).fill(9),
    });
    const encoded = encodeCanonicalCbor(envelope);
    const decoded = decodeExportKeyEnvelope(encoded);

    await expect(
      openExportKeyEnvelope(decoded, manifestBytes, "correct horse battery staple"),
    ).resolves.toEqual(keyring);
    await expect(
      openExportKeyEnvelope(decoded, manifestBytes, "correct horse battery stapler"),
    ).rejects.toMatchObject({ id: "EXPORT_AUTHENTICATION_FAILED" });
    await expect(
      openExportKeyEnvelope(
        { ...decoded, packageId: "40000000-0000-4000-8000-000000000004" },
        manifestBytes,
        "correct horse battery staple",
      ),
    ).rejects.toMatchObject({ id: "EXPORT_AUTHENTICATION_FAILED" });
  }, 30_000);
});

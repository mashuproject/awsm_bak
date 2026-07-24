import { describe, expect, it } from "vitest";
import { decodeEncryptedEnvelopeBytes, decryptEnvelope } from "../../src/crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../src/crypto/hkdf";
import {
  type ArtifactReferenceV1,
  type CaptureMetadataV1,
  decodeBundleDescriptor,
} from "../../src/domain/artifact-graph";
import { decodeCanonicalCbor } from "../../src/domain/cbor";
import type { StoredArtifactObjectV1 } from "../../src/drivers/indexeddb";
import { prepareCaptureRegistration } from "../../src/runtime/capture/registration";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const capturedAt = "2026-07-16T17:00:00.000Z";
const metadata: CaptureMetadataV1 = {
  version: 1,
  originalUrl: "https://private.example/article",
  finalUrl: "https://private.example/final",
  title: "Private page title",
  capturedAt,
  contentType: "text/html",
  viewport: { width: 800, height: 600 },
  document: { width: 800, height: 1200 },
  browserName: "Chrome",
  browserVersion: "149.0.0.0",
  extensionVersion: "0.1.0",
  captureProfileId: "WebPageSnapshot-v1",
  captureProfileVersion: 1,
};

async function rootKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(32).fill(9), "HKDF", false, ["deriveBits"]);
}

function artifact(
  objectId: string,
  role: ArtifactReferenceV1["role"],
  kind: ArtifactReferenceV1["kind"],
  mimeType: string,
): { object: StoredArtifactObjectV1; reference: ArtifactReferenceV1 } {
  return {
    object: {
      version: 1,
      objectId,
      objectType: "Artifact",
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
      envelopeByteLength: 128,
      envelopeChecksumAlgorithm: "hash:sha256:v1",
      envelopeChecksum: new Uint8Array(32).fill(1),
    },
    reference: {
      artifactVersion: 1,
      artifactObjectId: objectId,
      kind,
      role,
      mimeType,
      acquiredAt: capturedAt,
      plaintextByteLength: role === "TEXT_EXTRACTED" ? 0 : 10,
      checksumAlgorithm: "hash:sha256:v1",
      plaintextChecksum: new Uint8Array(32).fill(2),
    },
  };
}

describe("encrypted Artifact graph registration", () => {
  it("encrypts one descriptor and registers its exact Artifact closure", async () => {
    const key = await rootKey();
    const artifacts = [
      artifact(id(20), "PRIMARY", "CAPTURE", "application/vnd.awsm.web-page+zip"),
      artifact(id(21), "SCREENSHOT_FULL", "IMAGE", "image/webp"),
      artifact(id(22), "THUMBNAIL", "IMAGE", "image/webp"),
      artifact(id(23), "TEXT_EXTRACTED", "TEXT", "text/plain;charset=utf-8"),
      artifact(id(24), "CONTENT_STRUCTURED", "STRUCTURED_CONTENT", "application/cbor-seq"),
    ];
    const registration = await prepareCaptureRegistration({
      rootKey: key,
      vaultId: id(1),
      deviceId: id(2),
      commandId: id(3),
      bundleId: id(4),
      descriptorObjectId: id(5),
      eventId: id(6),
      collectionId: id(7),
      capturedAt,
      metadata,
      artifacts,
      thumbnailWebp: new Uint8Array([1, 2, 3]),
      warnings: [],
      clientVersion: "0.1.0",
    });
    expect(registration.objects.map((object) => object.objectId)).toEqual([
      id(5),
      id(20),
      id(21),
      id(22),
      id(23),
      id(24),
    ]);
    expect(registration.event.referencedObjectIds).toEqual([
      id(5),
      id(20),
      id(21),
      id(22),
      id(23),
      id(24),
    ]);
    expect(registration.outcome.descriptorObjectId).toBe(id(5));

    const descriptorRecord = registration.objects[0];
    if (descriptorRecord?.objectType !== "BundleDescriptor") throw new Error("missing descriptor");
    const descriptorKey = await deriveContextKeyFromCryptoKey(key, {
      vaultId: id(1),
      domain: "vault:bundle-descriptor:v1",
      contextId: id(4),
      keyVersion: 1,
    });
    const descriptor = decodeBundleDescriptor(
      await decryptEnvelope(
        decodeEncryptedEnvelopeBytes(descriptorRecord.envelopeBytes),
        descriptorKey,
      ),
    );
    expect(descriptor.metadata.title).toBe("Private page title");
    expect(descriptor.artifacts.map((entry) => entry.role).toSorted()).toEqual([
      "CONTENT_STRUCTURED",
      "PRIMARY",
      "SCREENSHOT_FULL",
      "TEXT_EXTRACTED",
      "THUMBNAIL",
    ]);

    const eventKey = await deriveContextKeyFromCryptoKey(key, {
      vaultId: id(1),
      domain: "vault:event:v1",
      contextId: id(6),
      keyVersion: 1,
    });
    expect(
      decodeCanonicalCbor(
        await decryptEnvelope(
          decodeEncryptedEnvelopeBytes(registration.event.envelopeBytes),
          eventKey,
        ),
      ),
    ).toMatchObject({
      eventType: "BundleRegistered",
      descriptorObjectId: id(5),
      artifactObjectIds: [id(20), id(21), id(22), id(23), id(24)],
    });
  });

  it("rejects a prepared record/reference identity mismatch", async () => {
    const mismatched = artifact(id(20), "PRIMARY", "CAPTURE", "application/vnd.awsm.web-page+zip");
    mismatched.reference = { ...mismatched.reference, artifactObjectId: id(21) };
    await expect(
      prepareCaptureRegistration({
        rootKey: await rootKey(),
        vaultId: id(1),
        deviceId: id(2),
        commandId: id(3),
        bundleId: id(4),
        descriptorObjectId: id(5),
        eventId: id(6),
        collectionId: id(7),
        capturedAt,
        metadata,
        artifacts: [mismatched],
        warnings: [],
        clientVersion: "0.1.0",
      }),
    ).rejects.toThrow(/match/u);
  });
});

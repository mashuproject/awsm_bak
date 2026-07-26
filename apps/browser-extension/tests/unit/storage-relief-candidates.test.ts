import { describe, expect, it } from "vitest";

import type { ArtifactReferenceV1, CaptureMetadataV1 } from "../../src/domain/artifact-graph";
import type { StoredArtifactObjectV1, StoredObjectV1 } from "../../src/drivers/indexeddb";
import { prepareCaptureRegistration } from "../../src/runtime/capture/registration";
import { StorageReliefCandidateEnumerator } from "../../src/runtime/storage-relief/candidates";
import { testKeyring } from "../helpers/keyring";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const capturedAt = "2026-07-21T00:00:00.000Z";

function artifact(
  objectId: string,
  role: ArtifactReferenceV1["role"],
  envelopeByteLength: number,
): { object: StoredArtifactObjectV1; reference: ArtifactReferenceV1 } {
  const properties = {
    PRIMARY: ["CAPTURE", "application/vnd.awsm.web-page+zip"],
    SCREENSHOT_FULL: ["IMAGE", "image/webp"],
    TEXT_EXTRACTED: ["TEXT", "text/plain;charset=utf-8"],
  } as const;
  const [kind, mimeType] = properties[role as keyof typeof properties];
  return {
    object: {
      version: 1,
      objectId,
      objectType: "Artifact",
      keyEpochId: "00000000-0000-4000-8000-000000000009",
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
      envelopeByteLength,
      envelopeChecksumAlgorithm: "hash:sha256:v1",
      envelopeChecksum: new Uint8Array(32).fill(envelopeByteLength % 255),
    },
    reference: {
      artifactVersion: 1,
      artifactObjectId: objectId,
      kind,
      role,
      mimeType,
      acquiredAt: capturedAt,
      plaintextByteLength: 10,
      checksumAlgorithm: "hash:sha256:v1",
      plaintextChecksum: new Uint8Array(32),
    },
  };
}

describe("StorageReliefCandidateEnumerator", () => {
  it("authenticates Bundle closure and counts only local heavy wrappers with safe large totals", async () => {
    const rootKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(7),
      "HKDF",
      false,
      ["deriveBits"],
    );
    const primary = artifact(id(10), "PRIMARY", 4_294_967_300);
    const screenshot = artifact(id(11), "SCREENSHOT_FULL", 900);
    const text = artifact(id(12), "TEXT_EXTRACTED", 200);
    const metadata: CaptureMetadataV1 = {
      version: 1,
      originalUrl: "https://example.test",
      finalUrl: "https://example.test",
      title: "Candidate fixture",
      capturedAt,
      contentType: "text/html",
      viewport: { width: 800, height: 600 },
      document: { width: 800, height: 1200 },
      browserName: "Chrome",
      browserVersion: "149",
      extensionVersion: "0.1.0",
      captureProfileId: "WebPageSnapshot-v1",
      captureProfileVersion: 1,
    };
    const registration = await prepareCaptureRegistration({
      keyring: testKeyring(rootKey),
      vaultId: id(1),
      deviceId: id(2),
      commandId: id(3),
      bundleId: id(4),
      descriptorObjectId: id(5),
      eventId: id(6),
      collectionId: id(7),
      capturedAt,
      metadata,
      artifacts: [primary, screenshot, text],
      warnings: ["THUMBNAIL_CAPTURE_FAILED", "STRUCTURED_CONTENT_EXTRACTION_FAILED"],
      clientVersion: "0.1.0",
    });
    const objects = new Map<string, StoredObjectV1>(
      registration.objects.map((value) => [value.objectId, value]),
    );
    const result = await new StorageReliefCandidateEnumerator(
      {
        listStoredEvents: async () => [registration.event],
        getStoredObject: async (objectId) => objects.get(objectId),
      },
      { has: async () => true },
      {
        isArtifactRemoteOnly: async (_vaultId, objectId) => objectId === screenshot.object.objectId,
      },
    ).enumerate(id(1), testKeyring(rootKey));

    expect(result).toEqual({
      candidateArtifacts: 1,
      candidateBytes: 4_294_967_300,
      candidates: [
        {
          object: primary.object,
          descriptorObjectId: id(5),
          registrationEventId: id(6),
          dependencyObjectIds: [id(5), id(10), id(11), id(12)],
        },
      ],
    });
  });
});

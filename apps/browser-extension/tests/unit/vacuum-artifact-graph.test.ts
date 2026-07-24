import { describe, expect, it } from "vitest";
import type { ArtifactReferenceV1, CaptureMetadataV1 } from "../../src/domain/artifact-graph";
import type { StoredArtifactObjectV1 } from "../../src/drivers/indexeddb";
import { prepareCaptureRegistration } from "../../src/runtime/capture/registration";
import { objectIdsForBundles, storedObjectByteLength } from "../../src/runtime/library/vacuum";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const capturedAt = "2026-07-18T20:00:00.000Z";

async function rootKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(32).fill(3), "HKDF", false, ["deriveBits"]);
}

function artifact(objectId: string, role: ArtifactReferenceV1["role"]) {
  const properties = {
    PRIMARY: ["CAPTURE", "application/vnd.awsm.web-page+zip"],
    TEXT_EXTRACTED: ["TEXT", "text/plain;charset=utf-8"],
    CONTENT_STRUCTURED: ["STRUCTURED_CONTENT", "application/cbor-seq"],
  } as const;
  const [kind, mimeType] = properties[role as keyof typeof properties];
  const object: StoredArtifactObjectV1 = {
    version: 1,
    objectId,
    objectType: "Artifact",
    envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
    envelopeByteLength: 4_294_967_297,
    envelopeChecksumAlgorithm: "hash:sha256:v1",
    envelopeChecksum: new Uint8Array(32),
  };
  return {
    object,
    reference: {
      artifactVersion: 1 as const,
      artifactObjectId: objectId,
      kind,
      role,
      mimeType,
      acquiredAt: capturedAt,
      plaintextByteLength: role === "PRIMARY" ? 1 : 0,
      checksumAlgorithm: "hash:sha256:v1" as const,
      plaintextChecksum: new Uint8Array(32),
    },
  };
}

describe("Vacuum Artifact graph reachability", () => {
  it("selects the complete descriptor-plus-Artifact closure for a deleted Bundle", async () => {
    const root = await rootKey();
    const vaultId = id(1);
    const metadata: CaptureMetadataV1 = {
      version: 1,
      originalUrl: "https://example.test/",
      finalUrl: "https://example.test/",
      title: "Fixture",
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
    const first = await prepareCaptureRegistration({
      rootKey: root,
      vaultId,
      deviceId: id(2),
      commandId: id(3),
      bundleId: id(4),
      descriptorObjectId: id(5),
      eventId: id(6),
      collectionId: id(7),
      capturedAt,
      metadata,
      artifacts: [
        artifact(id(20), "PRIMARY"),
        artifact(id(21), "TEXT_EXTRACTED"),
        artifact(id(22), "CONTENT_STRUCTURED"),
      ],
      warnings: [],
      clientVersion: "0.1.0",
    });
    const second = await prepareCaptureRegistration({
      rootKey: root,
      vaultId,
      deviceId: id(2),
      commandId: id(30),
      bundleId: id(31),
      descriptorObjectId: id(32),
      eventId: id(33),
      collectionId: id(7),
      capturedAt,
      metadata,
      artifacts: [
        artifact(id(40), "PRIMARY"),
        artifact(id(41), "TEXT_EXTRACTED"),
        artifact(id(42), "CONTENT_STRUCTURED"),
      ],
      warnings: [],
      clientVersion: "0.1.0",
    });
    await expect(
      objectIdsForBundles(
        [first.event, second.event],
        new Set([first.outcome.bundleId]),
        root,
        vaultId,
      ),
    ).resolves.toEqual(new Set(first.event.referencedObjectIds));
  });

  it("counts exact external wrapper lengths beyond four GiB", () => {
    const external = artifact(id(20), "PRIMARY").object;
    expect(storedObjectByteLength(external)).toBe(4_294_967_297);
    expect(
      storedObjectByteLength({
        version: 1,
        objectId: id(5),
        objectType: "BundleDescriptor",
        envelopeBytes: new Uint8Array(37),
      }),
    ).toBe(37);
  });
});

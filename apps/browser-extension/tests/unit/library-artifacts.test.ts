import { describe, expect, it, vi } from "vitest";
import { encodeEncryptedEnvelope, encryptEnvelope } from "../../src/crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../src/crypto/hkdf";
import {
  type ArtifactReferenceV1,
  type BundleDescriptorV1,
  encodeBundleDescriptor,
} from "../../src/domain/artifact-graph";
import { encodeCanonicalCbor } from "../../src/domain/cbor";
import type { LibraryItemV1 } from "../../src/domain/contracts";
import type { StoredObjectV1, StoredProjectionV1 } from "../../src/drivers/indexeddb";
import type { ArtifactStore } from "../../src/runtime/artifact";
import { LibraryService } from "../../src/runtime/library/service";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const capturedAt = "2026-07-18T20:00:00.000Z";

async function rootKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "HKDF", false, ["deriveBits"]);
}

async function encrypted(
  root: CryptoKey,
  vaultId: string,
  domain: "vault:bundle-descriptor:v1" | "vault:projection:v1",
  contextId: string,
  objectType: "BundleDescriptor" | "Projection",
  objectId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveContextKeyFromCryptoKey(root, {
    vaultId,
    domain,
    contextId,
    keyVersion: 1,
  });
  return encodeEncryptedEnvelope(await encryptEnvelope({ objectType, objectId, plaintext, key }));
}

function reference(objectId: string, role: ArtifactReferenceV1["role"]): ArtifactReferenceV1 {
  const properties = {
    PRIMARY: ["CAPTURE", "application/vnd.awsm.web-page+zip"],
    SCREENSHOT_FULL: ["IMAGE", "image/webp"],
    THUMBNAIL: ["IMAGE", "image/webp"],
    TEXT_EXTRACTED: ["TEXT", "text/plain;charset=utf-8"],
    CONTENT_STRUCTURED: ["STRUCTURED_CONTENT", "application/cbor-seq"],
  } as const;
  const [kind, mimeType] = properties[role];
  return {
    artifactVersion: 1,
    artifactObjectId: objectId,
    kind,
    role,
    mimeType,
    acquiredAt: capturedAt,
    plaintextByteLength: 5,
    checksumAlgorithm: "hash:sha256:v1",
    plaintextChecksum: new Uint8Array(32),
  };
}

async function fixture(warnings: LibraryItemV1["warnings"] = []) {
  const root = await rootKey();
  const vaultId = id(1);
  const bundleId = id(2);
  const descriptorObjectId = id(3);
  const references = [
    reference(id(10), "PRIMARY"),
    reference(id(11), "SCREENSHOT_FULL"),
    reference(id(12), "TEXT_EXTRACTED"),
  ];
  const descriptor: BundleDescriptorV1 = {
    descriptorVersion: 1,
    bundleId,
    createdAt: capturedAt,
    clientVersion: "0.1.0",
    captureProfileId: "WebPageSnapshot-v1",
    captureAdapterVersion: 1,
    metadata: {
      version: 1,
      originalUrl: "https://example.test/article",
      finalUrl: "https://example.test/article",
      title: "Artifact fixture",
      capturedAt,
      contentType: "text/html",
      viewport: { width: 800, height: 600 },
      document: { width: 800, height: 1200 },
      browserName: "Chrome",
      browserVersion: "149",
      extensionVersion: "0.1.0",
      captureProfileId: "WebPageSnapshot-v1",
      captureProfileVersion: 1,
    },
    artifacts: references,
  };
  const item: LibraryItemV1 = {
    version: 1,
    bundleId,
    descriptorObjectId,
    assignedCollectionId: id(4),
    title: descriptor.metadata.title,
    originalUrl: descriptor.metadata.originalUrl,
    capturedAt,
    artifactRoles: references.map((entry) => entry.role).toSorted(),
    status: "Active",
    warnings,
  };
  const projection: StoredProjectionV1 = {
    version: 1,
    bundleId,
    envelopeBytes: await encrypted(
      root,
      vaultId,
      "vault:projection:v1",
      `LibraryItem-v1:${bundleId}`,
      "Projection",
      bundleId,
      encodeCanonicalCbor(item),
    ),
  };
  const objects = new Map<string, StoredObjectV1>();
  objects.set(descriptorObjectId, {
    version: 1,
    objectId: descriptorObjectId,
    objectType: "BundleDescriptor",
    envelopeBytes: await encrypted(
      root,
      vaultId,
      "vault:bundle-descriptor:v1",
      bundleId,
      "BundleDescriptor",
      descriptorObjectId,
      encodeBundleDescriptor(descriptor),
    ),
  });
  for (const entry of references)
    objects.set(entry.artifactObjectId, {
      version: 1,
      objectId: entry.artifactObjectId,
      objectType: "Artifact",
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
      envelopeByteLength: 100,
      envelopeChecksumAlgorithm: "hash:sha256:v1",
      envelopeChecksum: new Uint8Array(32),
    });
  const artifactStore = {
    openPlaintext: vi.fn(async () => new Blob(["hello"]).stream()),
  } as unknown as ArtifactStore;
  const availability = {
    isArtifactRemoteOnly: vi.fn(
      async (_vaultId: string, artifactObjectId: string) => artifactObjectId === id(11),
    ),
  };
  return {
    service: new LibraryService(
      {
        listEncryptedProjections: async () => [projection],
        getCollectionProjection: async () => undefined,
        getStoredObject: async (objectId) => objects.get(objectId),
      },
      root,
      vaultId,
      artifactStore,
      availability,
    ),
    artifactStore,
    bundleId,
  };
}

describe("Library Artifact detail", () => {
  it("lists all canonical roles and exposes actions only for present Artifacts", async () => {
    const { service, bundleId } = await fixture([
      "THUMBNAIL_CAPTURE_FAILED",
      "STRUCTURED_CONTENT_EXTRACTION_FAILED",
    ]);
    const detail = await service.detail(bundleId);
    expect(detail.artifacts.map((artifact) => [artifact.role, artifact.state])).toEqual([
      ["PRIMARY", "Present"],
      ["SCREENSHOT_FULL", "Present"],
      ["THUMBNAIL", "Failed"],
      ["TEXT_EXTRACTED", "Present"],
      ["CONTENT_STRUCTURED", "Failed"],
    ]);
    expect(detail.artifacts.find((artifact) => artifact.role === "PRIMARY")).toMatchObject({
      availability: "Local",
      canDownload: true,
      canInspect: false,
      canPreview: false,
    });
    expect(detail.artifacts.find((artifact) => artifact.role === "SCREENSHOT_FULL")).toMatchObject({
      availability: "RemoteOnly",
      canDownload: false,
      canInspect: false,
      canPreview: true,
    });
    expect(detail.artifacts.find((artifact) => artifact.role === "TEXT_EXTRACTED")).toMatchObject({
      canDownload: false,
      canInspect: true,
    });
    expect(detail.artifacts.find((artifact) => artifact.role === "THUMBNAIL")).not.toHaveProperty(
      "availability",
    );
  });

  it("opens only the requested authenticated Artifact record", async () => {
    const { service, artifactStore, bundleId } = await fixture();
    const opened = await service.openArtifact(bundleId, "TEXT_EXTRACTED");
    expect(opened.reference.role).toBe("TEXT_EXTRACTED");
    expect(await new Response(opened.stream).text()).toBe("hello");
    expect(artifactStore.openPlaintext).toHaveBeenCalledOnce();
    await expect(service.openArtifact(bundleId, "THUMBNAIL")).rejects.toMatchObject({
      id: "BUNDLE_INVALID",
    });
  });
});

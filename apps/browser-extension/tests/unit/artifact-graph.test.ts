import { describe, expect, it } from "vitest";
import {
  type BundleDescriptorV1,
  decodeBundleDescriptor,
  encodeBundleDescriptor,
} from "../../src/domain/artifact-graph";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function descriptor(): BundleDescriptorV1 {
  return {
    descriptorVersion: 1,
    bundleId: id(1),
    createdAt: "2026-07-18T00:00:00.000Z",
    clientVersion: "0.1.0",
    captureProfileId: "WebPageSnapshot-v1",
    captureAdapterVersion: 1,
    metadata: {
      version: 1,
      originalUrl: "https://example.test/",
      finalUrl: "https://example.test/final",
      title: "Example",
      capturedAt: "2026-07-18T00:00:00.000Z",
      contentType: "text/html",
      viewport: { width: 1280, height: 720 },
      document: { width: 1280, height: 2400 },
      browserName: "Chrome",
      browserVersion: "140",
      extensionVersion: "0.1.0",
      captureProfileId: "WebPageSnapshot-v1",
      captureProfileVersion: 1,
    },
    artifacts: [
      {
        artifactVersion: 1,
        artifactObjectId: id(2),
        kind: "CAPTURE",
        role: "PRIMARY",
        mimeType: "application/vnd.awsm.web-page+zip",
        acquiredAt: "2026-07-18T00:00:01.000Z",
        plaintextByteLength: 9,
        checksumAlgorithm: "hash:sha256:v1",
        plaintextChecksum: new Uint8Array(32).fill(1),
      },
      {
        artifactVersion: 1,
        artifactObjectId: id(3),
        kind: "TEXT",
        role: "TEXT_EXTRACTED",
        mimeType: "text/plain;charset=utf-8",
        acquiredAt: "2026-07-18T00:00:02.000Z",
        plaintextByteLength: 0,
        checksumAlgorithm: "hash:sha256:v1",
        plaintextChecksum: new Uint8Array(32).fill(2),
      },
    ],
  };
}

describe("Bundle Descriptor graph", () => {
  it("round-trips strict canonical descriptor bytes", () => {
    const value = descriptor();
    const bytes = encodeBundleDescriptor(value);
    expect(decodeBundleDescriptor(bytes)).toEqual(value);
    expect(encodeBundleDescriptor(decodeBundleDescriptor(bytes))).toEqual(bytes);
  });

  it("requires one PRIMARY and unique sorted Object IDs and Roles", () => {
    const value = descriptor();
    const [primary, text] = value.artifacts;
    if (primary === undefined || text === undefined) throw new Error("invalid test fixture");
    expect(() =>
      encodeBundleDescriptor({ ...value, artifacts: value.artifacts.slice(1) }),
    ).toThrow();
    expect(() =>
      encodeBundleDescriptor({ ...value, artifacts: [...value.artifacts].reverse() }),
    ).toThrow();
    expect(() =>
      encodeBundleDescriptor({
        ...value,
        artifacts: [primary, { ...text, role: "PRIMARY" }],
      }),
    ).toThrow();
  });

  it("rejects Role/Kind/MIME mismatches and unknown fields", () => {
    const value = descriptor();
    const [primary, text] = value.artifacts;
    if (primary === undefined || text === undefined) throw new Error("invalid test fixture");
    expect(() =>
      encodeBundleDescriptor({
        ...value,
        artifacts: [{ ...primary, mimeType: "text/html" }, text],
      }),
    ).toThrow();
    expect(() =>
      encodeBundleDescriptor({ ...value, unsupported: true } as BundleDescriptorV1),
    ).toThrow();
  });
});

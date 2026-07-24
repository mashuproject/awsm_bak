import { describe, expect, it } from "vitest";
import {
  decodeBundleRegisteredPayload,
  validateArtifactWarnings,
} from "../../src/runtime/capture/contracts";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function payload(): Record<string, unknown> {
  return {
    version: 1,
    eventType: "BundleRegistered",
    eventVersion: 1,
    payloadVersion: 1,
    vaultId: id(1),
    deviceId: id(2),
    timestamp: "2026-07-18T00:00:00.000Z",
    protocolVersion: 1,
    correlationId: id(3),
    bundleId: id(4),
    descriptorObjectId: id(5),
    artifactObjectIds: [id(6), id(7)],
    collectionId: id(8),
    captureProfileId: "WebPageSnapshot-v1",
    warnings: ["TEXT_EXTRACTION_FAILED"],
  };
}

describe("BundleRegistered Artifact closure", () => {
  it("accepts only an exact sorted descriptor-plus-Artifact Object closure", () => {
    expect(decodeBundleRegisteredPayload(payload(), [id(5), id(6), id(7)])).toMatchObject({
      descriptorObjectId: id(5),
      artifactObjectIds: [id(6), id(7)],
    });
  });

  it("rejects missing, extra, duplicate, and unsorted closure identifiers", () => {
    expect(() => decodeBundleRegisteredPayload(payload(), [id(5), id(6)])).toThrow();
    expect(() => decodeBundleRegisteredPayload(payload(), [id(5), id(6), id(7), id(9)])).toThrow();
    expect(() => decodeBundleRegisteredPayload(payload(), [id(5), id(6), id(6), id(7)])).toThrow();
    expect(() => decodeBundleRegisteredPayload(payload(), [id(7), id(6), id(5)])).toThrow();
  });

  it("rejects unknown fields and unknown warnings", () => {
    expect(() =>
      decodeBundleRegisteredPayload({ ...payload(), unsupportedField: id(9) }, [
        id(5),
        id(6),
        id(7),
      ]),
    ).toThrow();
    expect(() =>
      decodeBundleRegisteredPayload({ ...payload(), warnings: ["UNKNOWN_WARNING"] }, [
        id(5),
        id(6),
        id(7),
      ]),
    ).toThrow();
  });

  it("requires failure warnings to agree with produced optional Artifact roles", () => {
    expect(() =>
      validateArtifactWarnings(["PRIMARY", "SCREENSHOT_FULL"], ["SCREENSHOT_CAPTURE_FAILED"]),
    ).toThrow();
    expect(() =>
      validateArtifactWarnings(["PRIMARY", "THUMBNAIL"], ["THUMBNAIL_CAPTURE_FAILED"]),
    ).toThrow();
    expect(() =>
      validateArtifactWarnings(["PRIMARY", "TEXT_EXTRACTED"], ["TEXT_EXTRACTION_FAILED"]),
    ).toThrow();
    expect(() =>
      validateArtifactWarnings(
        ["PRIMARY", "SCREENSHOT_FULL"],
        [
          "THUMBNAIL_CAPTURE_FAILED",
          "TEXT_EXTRACTION_FAILED",
          "STRUCTURED_CONTENT_EXTRACTION_FAILED",
        ],
      ),
    ).not.toThrow();
  });
});

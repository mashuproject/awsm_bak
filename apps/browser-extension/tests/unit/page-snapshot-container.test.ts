import { describe, expect, it } from "vitest";
import { encodeCanonicalCbor } from "../../src/domain/cbor";
import {
  createPageSnapshotBlob,
  decodePageSnapshotManifest,
  PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE,
  PAGE_SNAPSHOT_PROFILE_KEY,
  validatePageSnapshot,
} from "../../src/runtime/page-snapshot";

const encoder = new TextEncoder();
const capturedAt = Date.parse("2026-07-23T12:00:00.000Z");

describe("canonical page snapshot container", () => {
  it("uses the canonical scoped Capture Profile key and Unix-millisecond timestamp", () => {
    const manifest = {
      version: 1,
      captureProfileKey: "awsm.capture.web-page-snapshot",
      capturedAt: 1_800_000_000_000,
      originalUrl: "https://example.test/",
      finalUrl: "https://example.test/",
      topDocumentId: "d000000",
      documents: [
        {
          id: "d000000",
          originalUrl: "https://example.test/",
          finalUrl: "https://example.test/",
          member: "documents/000000.html",
          mediaType: PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE,
          byteLength: 1,
          sha256: new Uint8Array(32),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
      omissions: [],
    } as const;

    expect(decodePageSnapshotManifest(encodeCanonicalCbor(manifest))).toMatchObject({
      captureProfileKey: "awsm.capture.web-page-snapshot",
      capturedAt: 1_800_000_000_000,
    });
    expect(() =>
      decodePageSnapshotManifest(
        encodeCanonicalCbor({
          ...manifest,
          captureProfileKey: undefined,
          captureProfileId: "WebPageSnapshot-v1",
        }),
      ),
    ).toThrow();
  });

  it("writes and validates canonical document/resource/manifest members", async () => {
    const result = await createPageSnapshotBlob({
      capturedAt,
      originalUrl: "https://example.test/original",
      finalUrl: "https://example.test/final",
      documents: [
        {
          originalUrl: "https://example.test/original",
          finalUrl: "https://example.test/final",
          bytes: encoder.encode("<!doctype html><html><body>Frozen</body></html>"),
          scrollX: 2,
          scrollY: 3,
        },
      ],
      resources: [
        {
          ownerDocumentId: "d000000",
          requestedUrl: "https://example.test/site.css",
          finalUrl: "https://example.test/site.css",
          bytes: encoder.encode("body { color: green }"),
          mediaType: "text/css",
          status: 200,
          acquisition: "Network",
          compression: "Deflate",
        },
      ],
      omissions: [],
    });

    const validated = await validatePageSnapshot(result.blob);
    expect(validated.manifest).toMatchObject({
      version: 1,
      captureProfileKey: PAGE_SNAPSHOT_PROFILE_KEY,
      topDocumentId: "d000000",
      documents: [
        {
          id: "d000000",
          member: "documents/000000.html",
          mediaType: PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE,
        },
      ],
      resources: [{ id: "r000000", member: "resources/000000.bin" }],
    });
    expect([...validated.members.keys()]).toEqual([
      "documents/000000.html",
      "resources/000000.bin",
      "manifest.cbor",
    ]);
  });

  it("rejects an unknown manifest field", async () => {
    const result = await createPageSnapshotBlob({
      capturedAt,
      originalUrl: "https://example.test/",
      finalUrl: "https://example.test/",
      documents: [
        {
          originalUrl: "https://example.test/",
          finalUrl: "https://example.test/",
          bytes: encoder.encode("<!doctype html><title>Frozen</title>"),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
      omissions: [],
    });
    expect(() =>
      decodePageSnapshotManifest(
        encodeCanonicalCbor({
          ...result.manifest,
          unknown: true,
        }),
      ),
    ).toThrow(/canonical schema/u);
  });

  it("rejects unresolved document ownership and contradictory frame omissions", async () => {
    const base = {
      version: 1,
      captureProfileKey: PAGE_SNAPSHOT_PROFILE_KEY,
      capturedAt,
      originalUrl: "https://example.test/",
      finalUrl: "https://example.test/",
      topDocumentId: "d000000",
      documents: [
        {
          id: "d000000",
          originalUrl: "https://example.test/",
          finalUrl: "https://example.test/",
          member: "documents/000000.html",
          mediaType: PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE,
          byteLength: 1,
          sha256: new Uint8Array(32),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
    } as const;
    expect(() =>
      decodePageSnapshotManifest(
        encodeCanonicalCbor({
          ...base,
          omissions: [
            {
              ownerDocumentId: "d000001",
              url: "https://example.test/frame",
              subject: "Frame",
              reason: "InaccessibleFrame",
            },
          ],
        }),
      ),
    ).toThrow(/unknown owner/u);
    expect(() =>
      decodePageSnapshotManifest(
        encodeCanonicalCbor({
          ...base,
          omissions: [
            {
              ownerDocumentId: "d000000",
              url: "https://example.test/",
              subject: "Frame",
              reason: "InaccessibleFrame",
            },
          ],
        }),
      ),
    ).toThrow(/contradicts/u);
  });
});

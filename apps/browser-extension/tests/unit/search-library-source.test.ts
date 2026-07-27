import { describe, expect, it, vi } from "vitest";
import { encodeStructuredContentSequence } from "../../src/domain/structured-content";
import { AuthoritativeSearchSource } from "../../src/runtime/search/library-source";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "20000000-0000-4000-8000-000000000002";
const COLLECTION_ID = "30000000-0000-4000-8000-000000000003";
const STRUCTURED_ID = "40000000-0000-4000-8000-000000000004";
const TEXT_ID = "50000000-0000-4000-8000-000000000005";

const item = {
  version: 1,
  bundleId: BUNDLE_ID,
  descriptorObjectId: "60000000-0000-4000-8000-000000000006",
  assignedCollectionId: COLLECTION_ID,
  title: "Hybrid Search",
  originalUrl: "https://example.com/search",
  capturedAt: "2026-07-26T00:00:00.000Z",
  artifactRoles: ["CONTENT_STRUCTURED", "TEXT_EXTRACTED"],
  status: "Active",
  warnings: [],
} as const;

const group = {
  collectionId: COLLECTION_ID,
  title: "Research",
  originalUrl: item.originalUrl,
  knownUrls: [item.originalUrl],
  latest: item,
  captures: [item],
  captureThumbnails: [],
} as const;

function bytes(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function artifact(
  role: "CONTENT_STRUCTURED" | "TEXT_EXTRACTED",
  availability: "Local" | "RemoteOnly" = "Local",
) {
  return {
    role,
    state: "Present",
    kind: role === "CONTENT_STRUCTURED" ? "STRUCTURED_CONTENT" : "TEXT",
    mimeType: role === "CONTENT_STRUCTURED" ? "application/cbor-seq" : "text/plain;charset=utf-8",
    byteLength: 12,
    acquiredAt: "2026-07-26T00:00:00.000Z",
    availability,
    canPreview: false,
    canInspect: true,
    canDownload: false,
  } as const;
}

function reference(role: "CONTENT_STRUCTURED" | "TEXT_EXTRACTED", value: Uint8Array) {
  return {
    artifactVersion: 1,
    artifactObjectId: role === "CONTENT_STRUCTURED" ? STRUCTURED_ID : TEXT_ID,
    kind: role === "CONTENT_STRUCTURED" ? "STRUCTURED_CONTENT" : "TEXT",
    role,
    mimeType: role === "CONTENT_STRUCTURED" ? "application/cbor-seq" : "text/plain;charset=utf-8",
    acquiredAt: "2026-07-26T00:00:00.000Z",
    plaintextByteLength: value.byteLength,
    checksumAlgorithm: "hash:sha256:v1",
    plaintextChecksum: new Uint8Array(32).fill(role === "CONTENT_STRUCTURED" ? 4 : 5),
  } as const;
}

describe("authoritative Search source", () => {
  it("prefers local structured content and discovers deterministic source revisions", async () => {
    const structured = encodeStructuredContentSequence([
      {
        blockVersion: 1,
        blockId: "B000001",
        kind: "Paragraph",
        text: "Private local passage.",
        links: [],
      },
    ]);
    const openArtifact = vi.fn(async (_bundleId, role) => ({
      item,
      reference: reference(role, structured),
      stream: bytes(structured),
    }));
    const source = new AuthoritativeSearchSource(VAULT_ID, {
      groups: async () => [group],
      deletedGroups: async () => [],
      detail: async () => ({
        item,
        metadata: {
          version: 1,
          originalUrl: item.originalUrl,
          finalUrl: item.originalUrl,
          title: item.title,
          capturedAt: item.capturedAt,
          contentType: "text/html",
          viewport: { width: 100, height: 100 },
          document: { width: 100, height: 100 },
          browserName: "Chromium",
          browserVersion: "1",
          extensionVersion: "1",
          captureProfileId: "WebPageSnapshot-v1",
          captureProfileVersion: 1,
        },
        artifacts: [artifact("CONTENT_STRUCTURED"), artifact("TEXT_EXTRACTED")],
      }),
      openArtifact,
    });

    const discovered = await Array.fromAsync(source.discover(new AbortController().signal));
    const row = await source.loadKeywordRow(VAULT_ID, BUNDLE_ID, new AbortController().signal);

    expect(discovered).toEqual([
      { bundleId: BUNDLE_ID, sourceRevision: row.document.sourceRevision },
    ]);
    expect(row.document.passages.map(({ text }) => text)).toContain("Private local passage.");
    expect(openArtifact).toHaveBeenCalledTimes(2);
    expect(openArtifact).toHaveBeenNthCalledWith(1, BUNDLE_ID, "CONTENT_STRUCTURED");
    expect(openArtifact).toHaveBeenNthCalledWith(2, BUNDLE_ID, "CONTENT_STRUCTURED");
  });

  it("falls back to local extracted text and never opens a remote-only Artifact", async () => {
    const extracted = new TextEncoder().encode("Fallback passage.");
    const openArtifact = vi.fn(async (_bundleId, role) => ({
      item,
      reference: reference(role, extracted),
      stream: bytes(extracted),
    }));
    const source = new AuthoritativeSearchSource(VAULT_ID, {
      groups: async () => [group],
      deletedGroups: async () => [],
      detail: async () => ({
        item,
        metadata: {} as never,
        artifacts: [artifact("CONTENT_STRUCTURED", "RemoteOnly"), artifact("TEXT_EXTRACTED")],
      }),
      openArtifact,
    });

    const row = await source.loadKeywordRow(VAULT_ID, BUNDLE_ID, new AbortController().signal);

    expect(row.document.passages.map(({ text }) => text)).toContain("Fallback passage.");
    expect(openArtifact).toHaveBeenCalledOnce();
    expect(openArtifact).toHaveBeenCalledWith(BUNDLE_ID, "TEXT_EXTRACTED");
  });
});

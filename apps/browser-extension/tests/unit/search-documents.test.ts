import { describe, expect, it } from "vitest";
import type { StructuredBlockV1 } from "../../src/domain/structured-content";
import { buildSearchDocument } from "../../src/runtime/search/documents";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "20000000-0000-4000-8000-000000000002";
const COLLECTION_ID = "30000000-0000-4000-8000-000000000003";
const ARTIFACT_ID = "40000000-0000-4000-8000-000000000004";

function input(
  source:
    | { readonly role: "CONTENT_STRUCTURED"; readonly blocks: readonly StructuredBlockV1[] }
    | { readonly role: "TEXT_EXTRACTED"; readonly text: string },
) {
  return {
    vaultId: VAULT_ID,
    bundleId: BUNDLE_ID,
    collectionId: COLLECTION_ID,
    collectionTitle: "Research",
    status: "Active" as const,
    title: "  Café   systems ",
    canonicalUrl: "https://example.com/articles/search",
    knownUrls: ["https://example.com/articles/search?ref=2", "https://example.com/articles/search"],
    capturedAt: "2026-07-26T00:00:00.000Z",
    artifactObjectId: ARTIFACT_ID,
    artifactChecksum: Uint8Array.from({ length: 32 }, (_, index) => index),
    source,
  };
}

describe("Search document construction", () => {
  it("renders structured blocks and stable source locators deterministically", async () => {
    const blocks: readonly StructuredBlockV1[] = [
      {
        blockVersion: 1,
        blockId: "B000001",
        kind: "Heading",
        level: 2,
        text: "  Hybrid   Search ",
        links: [],
      },
      {
        blockVersion: 1,
        blockId: "B000002",
        kind: "Paragraph",
        text: "Find\u00a0the right Capture.",
        links: [],
      },
      {
        blockVersion: 1,
        blockId: "B000003",
        kind: "Table",
        rows: [
          ["Local", "Private"],
          ["Remote", "Opt in"],
        ],
      },
    ];

    const first = await buildSearchDocument(input({ role: "CONTENT_STRUCTURED", blocks }));
    const second = await buildSearchDocument(input({ role: "CONTENT_STRUCTURED", blocks }));

    expect(first).toEqual(second);
    expect(first.host).toBe("example.com");
    expect(first.knownUrls).toEqual([
      "https://example.com/articles/search",
      "https://example.com/articles/search?ref=2",
    ]);
    expect(first.passages.map(({ text }) => text)).toEqual([
      "Café systems\nhttps://example.com/articles/search",
      "Hybrid Search Find the right Capture.",
      "Local | Private\nRemote | Opt in",
    ]);
    expect(first.passages[1]?.source).toEqual({
      role: "CONTENT_STRUCTURED",
      firstBlockId: "B000001",
      lastBlockId: "B000002",
      startOffset: 0,
      endOffset: 23,
    });
    expect(first.sourceRevision).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.passages.every(({ passageId }) => /^[0-9a-f]{64}$/u.test(passageId))).toBe(true);
  });

  it("uses normalized extracted text as the body fallback", async () => {
    const document = await buildSearchDocument(
      input({ role: "TEXT_EXTRACTED", text: "  First\r\n\r\nsecond\u0301  " }),
    );

    expect(document.passages.map(({ text }) => text)).toEqual([
      "Café systems\nhttps://example.com/articles/search",
      "First second́",
    ]);
    expect(document.passages[1]?.source).toEqual({
      role: "TEXT_EXTRACTED",
      startOffset: 0,
      endOffset: 13,
    });
  });

  it("builds a deterministic metadata-only document when no body Artifact exists", async () => {
    const withBody = input({ role: "TEXT_EXTRACTED", text: "ignored" });
    const {
      artifactObjectId: _artifactObjectId,
      artifactChecksum: _artifactChecksum,
      ...metadata
    } = withBody;
    const document = await buildSearchDocument({ ...metadata, source: undefined });

    expect(document.passages).toHaveLength(1);
    expect(document.passages[0]).toMatchObject({
      ordinal: 0,
      text: "Café systems\nhttps://example.com/articles/search",
      source: {
        role: "METADATA",
        startOffset: 0,
        endOffset: 48,
      },
    });
    expect(document.sourceRevision).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("bounds prose passages and retains a twenty-word overlap", async () => {
    const words = Array.from({ length: 180 }, (_, index) =>
      index === 140 ? "overlap-start" : "w",
    );
    const blocks: readonly StructuredBlockV1[] = [
      {
        blockVersion: 1,
        blockId: "B000001",
        kind: "Paragraph",
        text: words.join(" "),
        links: [],
      },
    ];

    const document = await buildSearchDocument(input({ role: "CONTENT_STRUCTURED", blocks }));
    const body = document.passages.slice(1);

    expect(body.length).toBeGreaterThan(1);
    expect(body[1]?.text.startsWith("overlap-start ")).toBe(true);
    for (const passage of body) {
      expect(new TextEncoder().encode(passage.text).byteLength).toBeLessThanOrEqual(768);
      expect(passage.text.split(/\s+/u).length).toBeLessThanOrEqual(160);
    }
  });

  it("splits an oversized Unicode token without dropping scalars or splitting surrogate pairs", async () => {
    const text = "😀".repeat(400);
    const document = await buildSearchDocument(input({ role: "TEXT_EXTRACTED", text }));
    const body = document.passages.slice(1);

    expect(body.map(({ text: passageText }) => passageText).join("")).toBe(text);
    expect(body[0]?.source).toMatchObject({ startOffset: 0, endOffset: 384 });
    expect(body[1]?.source).toMatchObject({ startOffset: 384, endOffset: 768 });
    expect(body[2]?.source).toMatchObject({ startOffset: 768, endOffset: 800 });
    for (const passage of body) {
      expect(new TextEncoder().encode(passage.text).byteLength).toBeLessThanOrEqual(768);
    }
  });

  it("splits oversized preformatted blocks at newlines before scalar boundaries", async () => {
    const firstLine = `${"a".repeat(500)}  `;
    const secondLine = `\t${"😀".repeat(250)}`;
    const text = `${firstLine}\n${secondLine}`;
    const blocks: readonly StructuredBlockV1[] = [
      {
        blockVersion: 1,
        blockId: "B000001",
        kind: "Preformatted",
        text,
      },
    ];

    const document = await buildSearchDocument(input({ role: "CONTENT_STRUCTURED", blocks }));
    const body = document.passages.slice(1);

    expect(body.length).toBeGreaterThan(2);
    expect(body[0]?.text).toBe(`${firstLine}\n`);
    expect(body.map(({ text: passageText }) => passageText).join("")).toBe(text);
    expect(body.map(({ source }) => source)).toEqual(
      body.map((_passage, index) => ({
        role: "CONTENT_STRUCTURED",
        firstBlockId: "B000001",
        lastBlockId: "B000001",
        startOffset: body.slice(0, index).reduce((total, item) => total + item.text.length, 0),
        endOffset: body.slice(0, index + 1).reduce((total, item) => total + item.text.length, 0),
      })),
    );
    for (const passage of body) {
      expect(new TextEncoder().encode(passage.text).byteLength).toBeLessThanOrEqual(768);
      expect(Array.from(passage.text.matchAll(/\S+/gu))).toHaveLength(1);
    }
  });
});

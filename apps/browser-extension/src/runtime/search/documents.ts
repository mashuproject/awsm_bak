import { encodeCanonicalCbor } from "../../domain/cbor";
import { sha256 } from "../../domain/hash";
import type { StructuredBlockV1 } from "../../domain/structured-content";
import { bytes, httpUrl, timestamp, uuid } from "../../domain/validation";

const MAX_PASSAGE_WORDS = 160;
const MAX_PASSAGE_BYTES = 768;
const PASSAGE_OVERLAP_WORDS = 20;
const textEncoder = new TextEncoder();

export type SearchPassageSource =
  | {
      readonly role: "CONTENT_STRUCTURED";
      readonly firstBlockId: string;
      readonly lastBlockId: string;
      readonly startOffset: number;
      readonly endOffset: number;
    }
  | {
      readonly role: "TEXT_EXTRACTED" | "METADATA";
      readonly startOffset: number;
      readonly endOffset: number;
    };

export interface SearchPassage {
  readonly version: 1;
  readonly passageId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly source: SearchPassageSource;
}

export interface SearchDocument {
  readonly version: 1;
  readonly vaultId: string;
  readonly bundleId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly status: "Active" | "Deleted";
  readonly title: string;
  readonly canonicalUrl: string;
  readonly knownUrls: readonly string[];
  readonly host: string;
  readonly capturedAt: string;
  readonly sourceRevision: string;
  readonly passages: readonly SearchPassage[];
}

interface BuildSearchDocumentMetadata {
  readonly vaultId: string;
  readonly bundleId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly status: "Active" | "Deleted";
  readonly title: string;
  readonly canonicalUrl: string;
  readonly knownUrls: readonly string[];
  readonly capturedAt: string;
}

export type BuildSearchDocumentInput = BuildSearchDocumentMetadata &
  (
    | {
        readonly artifactObjectId: string;
        readonly artifactChecksum: Uint8Array;
        readonly source:
          | { readonly role: "CONTENT_STRUCTURED"; readonly blocks: readonly StructuredBlockV1[] }
          | { readonly role: "TEXT_EXTRACTED"; readonly text: string };
      }
    | {
        readonly artifactObjectId?: never;
        readonly artifactChecksum?: never;
        readonly source?: undefined;
      }
  );

interface PassageDraft {
  readonly text: string;
  readonly source: SearchPassageSource;
}

interface RenderedBlock {
  readonly blockId: string;
  readonly kind: StructuredBlockV1["kind"];
  readonly text: string;
}

interface LocatedWord {
  readonly text: string;
  readonly blockId?: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function prose(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function preformatted(value: string): string {
  return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function renderBlock(block: StructuredBlockV1): RenderedBlock | undefined {
  const text =
    block.kind === "Table"
      ? block.rows
          .map((row) => row.map(prose).join(" | "))
          .join("\n")
          .trim()
      : block.kind === "Preformatted"
        ? preformatted(block.text)
        : prose(block.text);
  return text.length === 0 ? undefined : { blockId: block.blockId, kind: block.kind, text };
}

function words(value: string, blockId?: string): readonly LocatedWord[] {
  return Array.from(value.matchAll(/\S+/gu), (match) => ({
    text: match[0],
    ...(blockId === undefined ? {} : { blockId }),
    startOffset: match.index,
    endOffset: match.index + match[0].length,
  }));
}

function fitsPassage(value: readonly LocatedWord[]): boolean {
  return (
    value.length <= MAX_PASSAGE_WORDS &&
    textEncoder.encode(value.map(({ text }) => text).join(" ")).byteLength <= MAX_PASSAGE_BYTES
  );
}

function wordPassages(
  locatedWords: readonly LocatedWord[],
  role: "CONTENT_STRUCTURED" | "TEXT_EXTRACTED",
): readonly PassageDraft[] {
  const output: PassageDraft[] = [];
  let start = 0;
  while (start < locatedWords.length) {
    let end = start;
    while (end < locatedWords.length && fitsPassage(locatedWords.slice(start, end + 1))) end += 1;
    if (end === start) {
      const word = locatedWords[start];
      if (word === undefined) break;
      const scalars = Array.from(word.text);
      let scalarStart = 0;
      let codeUnitOffset = word.startOffset;
      while (scalarStart < scalars.length) {
        let scalarEnd = scalarStart;
        while (
          scalarEnd < scalars.length &&
          textEncoder.encode(scalars.slice(scalarStart, scalarEnd + 1).join("")).byteLength <=
            MAX_PASSAGE_BYTES
        )
          scalarEnd += 1;
        if (scalarEnd === scalarStart)
          throw new Error("A Unicode scalar exceeded the Search passage limit.");
        const text = scalars.slice(scalarStart, scalarEnd).join("");
        output.push({
          text,
          source:
            role === "CONTENT_STRUCTURED"
              ? {
                  role,
                  firstBlockId: word.blockId ?? "",
                  lastBlockId: word.blockId ?? "",
                  startOffset: codeUnitOffset,
                  endOffset: codeUnitOffset + text.length,
                }
              : {
                  role,
                  startOffset: codeUnitOffset,
                  endOffset: codeUnitOffset + text.length,
                },
        });
        codeUnitOffset += text.length;
        scalarStart = scalarEnd;
      }
      start += 1;
      continue;
    }
    const selected = locatedWords.slice(start, end);
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) break;
    output.push({
      text: selected.map(({ text }) => text).join(" "),
      source:
        role === "CONTENT_STRUCTURED"
          ? {
              role,
              firstBlockId: first.blockId ?? "",
              lastBlockId: last.blockId ?? "",
              startOffset: first.startOffset,
              endOffset: last.endOffset,
            }
          : {
              role,
              startOffset: first.startOffset,
              endOffset: last.endOffset,
            },
    });
    if (end === locatedWords.length) break;
    start = Math.max(start + 1, end - PASSAGE_OVERLAP_WORDS);
  }
  return output;
}

function exactBlockPassages(block: RenderedBlock): readonly PassageDraft[] {
  const output: PassageDraft[] = [];
  let startOffset = 0;
  while (startOffset < block.text.length) {
    let endOffset = startOffset;
    for (const scalar of block.text.slice(startOffset)) {
      const candidateEnd = endOffset + scalar.length;
      const candidate = block.text.slice(startOffset, candidateEnd);
      if (
        textEncoder.encode(candidate).byteLength > MAX_PASSAGE_BYTES ||
        words(candidate).length > MAX_PASSAGE_WORDS
      )
        break;
      endOffset = candidateEnd;
    }
    if (endOffset === startOffset)
      throw new Error("A Unicode scalar exceeded the Search passage limit.");
    if (endOffset < block.text.length) {
      const newlineOffset = block.text.lastIndexOf("\n", endOffset - 1);
      if (newlineOffset >= startOffset) endOffset = newlineOffset + 1;
    }
    const text = block.text.slice(startOffset, endOffset);
    if (text.length === 0) throw new Error("Search passage splitting made no progress.");
    output.push({
      text,
      source: {
        role: "CONTENT_STRUCTURED",
        firstBlockId: block.blockId,
        lastBlockId: block.blockId,
        startOffset,
        endOffset,
      },
    });
    startOffset = endOffset;
  }
  return output;
}

function structuredPassages(blocks: readonly StructuredBlockV1[]): readonly PassageDraft[] {
  const rendered = blocks.map(renderBlock).filter((block) => block !== undefined);
  const output: PassageDraft[] = [];
  let proseWords: LocatedWord[] = [];
  const flushProse = (): void => {
    output.push(...wordPassages(proseWords, "CONTENT_STRUCTURED"));
    proseWords = [];
  };

  for (const block of rendered) {
    if (block.kind === "Preformatted" || block.kind === "Table") {
      flushProse();
      if (
        textEncoder.encode(block.text).byteLength <= MAX_PASSAGE_BYTES &&
        words(block.text).length <= MAX_PASSAGE_WORDS
      ) {
        output.push({
          text: block.text,
          source: {
            role: "CONTENT_STRUCTURED",
            firstBlockId: block.blockId,
            lastBlockId: block.blockId,
            startOffset: 0,
            endOffset: block.text.length,
          },
        });
      } else {
        output.push(...exactBlockPassages(block));
      }
      continue;
    }
    proseWords.push(...words(block.text, block.blockId));
  }
  flushProse();
  return output;
}

async function revision(
  input: BuildSearchDocumentInput,
  knownUrls: readonly string[],
): Promise<string> {
  return hex(
    await sha256(
      encodeCanonicalCbor({
        version: 1,
        vaultId: input.vaultId,
        bundleId: input.bundleId,
        collectionId: input.collectionId,
        collectionTitle: input.collectionTitle.normalize("NFC"),
        status: input.status,
        title: prose(input.title),
        canonicalUrl: input.canonicalUrl,
        knownUrls,
        capturedAt: input.capturedAt,
        ...(input.source === undefined
          ? { sourceRole: "METADATA" }
          : {
              artifactObjectId: input.artifactObjectId,
              artifactChecksum: input.artifactChecksum,
              sourceRole: input.source.role,
              source:
                input.source.role === "CONTENT_STRUCTURED"
                  ? input.source.blocks
                  : prose(input.source.text),
            }),
        passageBuilderVersion: 1,
        keywordTokenizerVersion: 1,
      }),
    ),
  );
}

async function passage(
  draft: PassageDraft,
  ordinal: number,
  bundleId: string,
  sourceRevision: string,
): Promise<SearchPassage> {
  const passageId = hex(
    await sha256(
      encodeCanonicalCbor(["SearchPassage-v1", bundleId, sourceRevision, ordinal, draft.source]),
    ),
  );
  return { version: 1, passageId, ordinal, text: draft.text, source: draft.source };
}

export async function buildSearchDocument(
  input: BuildSearchDocumentInput,
): Promise<SearchDocument> {
  uuid(input.vaultId, "searchDocument.vaultId");
  uuid(input.bundleId, "searchDocument.bundleId");
  uuid(input.collectionId, "searchDocument.collectionId");
  timestamp(input.capturedAt, "searchDocument.capturedAt");
  if (input.source !== undefined) {
    uuid(input.artifactObjectId, "searchDocument.artifactObjectId");
    bytes(input.artifactChecksum, 32, "searchDocument.artifactChecksum");
  }
  const canonicalUrl = httpUrl(input.canonicalUrl, "searchDocument.canonicalUrl");
  const parsedUrl = new URL(canonicalUrl);
  if (parsedUrl.href !== canonicalUrl) throw new Error("Search document URL must be canonical.");
  const knownUrls = Array.from(
    new Set(
      input.knownUrls.map((value) => {
        const candidate = httpUrl(value, "searchDocument.knownUrls");
        if (new URL(candidate).href !== candidate)
          throw new Error("Known Search document URLs must be canonical.");
        return candidate;
      }),
    ),
  ).sort();
  if (input.status !== "Active" && input.status !== "Deleted")
    throw new Error("Search document status is invalid.");

  const title = prose(input.title);
  const sourceRevision = await revision(input, knownUrls);
  const metadataText = `${title}\n${canonicalUrl}`;
  const drafts: PassageDraft[] = [
    {
      text: metadataText,
      source: { role: "METADATA", startOffset: 0, endOffset: metadataText.length },
    },
    ...(input.source === undefined
      ? []
      : input.source.role === "CONTENT_STRUCTURED"
        ? structuredPassages(input.source.blocks)
        : wordPassages(words(prose(input.source.text)), "TEXT_EXTRACTED")),
  ];

  return {
    version: 1,
    vaultId: input.vaultId,
    bundleId: input.bundleId,
    collectionId: input.collectionId,
    collectionTitle: input.collectionTitle.normalize("NFC"),
    status: input.status,
    title,
    canonicalUrl,
    knownUrls,
    host: parsedUrl.hostname.toLocaleLowerCase("en-US"),
    capturedAt: input.capturedAt,
    sourceRevision,
    passages: await Promise.all(
      drafts.map((draft, ordinal) => passage(draft, ordinal, input.bundleId, sourceRevision)),
    ),
  };
}

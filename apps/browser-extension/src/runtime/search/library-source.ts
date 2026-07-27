import type { ArtifactRole } from "../../domain/artifact-graph";
import { decodeStructuredContentSequence } from "../../domain/structured-content";
import type { LibraryDetailV1, LibraryPageGroupV1, OpenArtifactResult } from "../library/service";
import { buildSearchDocument } from "./documents";
import type { SearchKeywordRowSource } from "./indexer";
import { buildKeywordRow, type KeywordRow } from "./keyword";

interface SearchLibraryReader {
  groups(): Promise<readonly LibraryPageGroupV1[]>;
  deletedGroups(): Promise<readonly LibraryPageGroupV1[]>;
  detail(bundleId: string): Promise<LibraryDetailV1>;
  openArtifact(bundleId: string, role: ArtifactRole): Promise<OpenArtifactResult>;
}

interface SearchCatalogEntry {
  readonly group: LibraryPageGroupV1;
  readonly item: LibraryPageGroupV1["captures"][number];
}

export interface DiscoveredSearchCapture {
  readonly bundleId: string;
  readonly sourceRevision: string;
}

async function readArtifact(opened: OpenArtifactResult, signal: AbortSignal): Promise<Uint8Array> {
  const expected = opened.reference.plaintextByteLength;
  const output = new Uint8Array(expected);
  const reader = opened.stream.getReader();
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expected)
        throw new Error("Search source Artifact exceeded its authenticated length.");
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expected)
      throw new Error("Search source Artifact ended before its authenticated length.");
    return output;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class AuthoritativeSearchSource implements SearchKeywordRowSource {
  private catalogPromise: Promise<ReadonlyMap<string, SearchCatalogEntry>> | undefined;

  constructor(
    private readonly vaultId: string,
    private readonly library: SearchLibraryReader,
  ) {}

  async *discover(
    signal: AbortSignal,
    skip = new Set<string>(),
  ): AsyncGenerator<DiscoveredSearchCapture> {
    const catalog = await this.catalog();
    for (const bundleId of [...catalog.keys()].sort()) {
      signal.throwIfAborted();
      if (skip.has(bundleId)) continue;
      const row = await this.loadKeywordRow(this.vaultId, bundleId, signal);
      yield { bundleId, sourceRevision: row.document.sourceRevision };
    }
  }

  async loadKeywordRow(
    vaultId: string,
    bundleId: string,
    signal: AbortSignal,
  ): Promise<KeywordRow> {
    if (vaultId !== this.vaultId) throw new Error("Search source Vault changed.");
    signal.throwIfAborted();
    const entry = (await this.catalog()).get(bundleId);
    if (entry === undefined) throw new Error("Search source Capture is unavailable.");
    const detail = await this.library.detail(bundleId);
    signal.throwIfAborted();

    const common = {
      vaultId,
      bundleId,
      collectionId: entry.group.collectionId,
      collectionTitle: entry.group.title,
      status: entry.item.status,
      title: entry.item.title,
      canonicalUrl: entry.item.originalUrl,
      knownUrls: entry.group.knownUrls,
      capturedAt: entry.item.capturedAt,
    } as const;
    const structured = detail.artifacts.find(
      ({ role, state, availability }) =>
        role === "CONTENT_STRUCTURED" && state === "Present" && availability === "Local",
    );
    if (structured !== undefined) {
      try {
        const opened = await this.library.openArtifact(bundleId, "CONTENT_STRUCTURED");
        const body = await readArtifact(opened, signal);
        return buildKeywordRow(
          await buildSearchDocument({
            ...common,
            artifactObjectId: opened.reference.artifactObjectId,
            artifactChecksum: opened.reference.plaintextChecksum,
            source: {
              role: "CONTENT_STRUCTURED",
              blocks: decodeStructuredContentSequence(body),
            },
          }),
        );
      } catch {
        signal.throwIfAborted();
      }
    }
    const extracted = detail.artifacts.find(
      ({ role, state, availability }) =>
        role === "TEXT_EXTRACTED" && state === "Present" && availability === "Local",
    );
    if (extracted !== undefined) {
      const opened = await this.library.openArtifact(bundleId, "TEXT_EXTRACTED");
      const body = await readArtifact(opened, signal);
      return buildKeywordRow(
        await buildSearchDocument({
          ...common,
          artifactObjectId: opened.reference.artifactObjectId,
          artifactChecksum: opened.reference.plaintextChecksum,
          source: {
            role: "TEXT_EXTRACTED",
            text: new TextDecoder("utf-8", { fatal: true }).decode(body),
          },
        }),
      );
    }
    return buildKeywordRow(await buildSearchDocument({ ...common, source: undefined }));
  }

  private async catalog(): Promise<ReadonlyMap<string, SearchCatalogEntry>> {
    this.catalogPromise ??= Promise.all([this.library.groups(), this.library.deletedGroups()]).then(
      ([active, deleted]) => {
        const catalog = new Map<string, SearchCatalogEntry>();
        for (const group of [...active, ...deleted]) {
          for (const item of group.captures) {
            if (catalog.has(item.bundleId)) throw new Error("Search source Capture is duplicated.");
            catalog.set(item.bundleId, { group, item });
          }
        }
        return catalog;
      },
    );
    return this.catalogPromise;
  }
}

import { describe, expect, it } from "vitest";
import type { SearchDocument } from "../../src/runtime/search/documents";
import { fuseHybridResults } from "../../src/runtime/search/hybrid";
import {
  buildKeywordRow,
  buildKeywordStatistics,
  rankKeywordRows,
} from "../../src/runtime/search/keyword";
import { parseSearchQuery } from "../../src/runtime/search/query";
import {
  quantizeEmbedding,
  rankSemanticCandidates,
  type SearchSemanticCapture,
  type SearchSemanticPassages,
} from "../../src/runtime/search/semantic";

const RUN_PERFORMANCE = process.env.AWSM_SEARCH_PERFORMANCE === "1";
const CAPTURE_COUNT = 10_000;
const DIMENSIONS = 384;

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function identifier(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("Search 10,000-Capture performance gates", () => {
  it.skipIf(!RUN_PERFORMANCE)("keeps warm common-term keyword ranking at p95 <= 100 ms", () => {
    const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    collect?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const rows = Array.from({ length: CAPTURE_COUNT }, (_, index) => {
      const passageCount = index % 10 === 0 ? 40 : 12;
      const document: SearchDocument = {
        version: 1,
        vaultId: identifier(1),
        bundleId: identifier(index + 10),
        collectionId: identifier(100 + (index % 100)),
        collectionTitle: `Collection ${String(index % 100)}`,
        status: index % 5 === 0 ? "Deleted" : "Active",
        title: `Archive capture ${String(index)}`,
        canonicalUrl: `https://example.test/${String(index)}`,
        knownUrls: [`https://example.test/${String(index)}`],
        host: `host-${String(index % 500)}.example.test`,
        capturedAt: "2026-07-26T00:00:00.000Z",
        sourceRevision: "ab".repeat(32),
        passages: Array.from({ length: passageCount }, (_, ordinal) => ({
          version: 1 as const,
          passageId: `${index.toString(16).padStart(32, "0")}${ordinal
            .toString(16)
            .padStart(32, "0")}`,
          ordinal,
          text:
            ordinal % 3 === 0
              ? `private archive prose passage ${String(ordinal)} with deterministic fixture words`
              : ordinal % 3 === 1
                ? `private archive preformatted\nrow ${String(ordinal)}\tfixture`
                : `private | archive | table | row ${String(ordinal)}`,
          source: { role: "TEXT_EXTRACTED" as const, startOffset: 0, endOffset: 1 },
        })),
      };
      return buildKeywordRow(document);
    });
    collect?.();
    const keywordHeapMiB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
    const statistics = buildKeywordStatistics(rows);
    const query = parseSearchQuery("archive");
    const filters = { scope: "Active" as const, hosts: [], collectionIds: [] };
    rankKeywordRows(query, rows, statistics, filters);
    const serializationSamples: number[] = [];
    const samples = Array.from({ length: 20 }, () => {
      const started = performance.now();
      const result = rankKeywordRows(query, rows, statistics, filters);
      const rankedAt = performance.now();
      const serializationStarted = performance.now();
      JSON.stringify(result.slice(0, 50));
      serializationSamples.push(performance.now() - serializationStarted);
      return rankedAt - started;
    });
    const measuredP95 = p95(samples);
    console.info(`Search keyword 10k p95: ${measuredP95.toFixed(2)} ms`);
    const serializationP95 = p95(serializationSamples);
    console.info(`Search first-50 serialization p95: ${serializationP95.toFixed(2)} ms`);
    expect(serializationP95).toBeLessThanOrEqual(50);
    if (collect !== undefined) {
      console.info(`Search keyword 10k retained heap: ${keywordHeapMiB.toFixed(2)} MiB`);
      expect(keywordHeapMiB).toBeLessThan(256);
    }
    expect(measuredP95).toBeLessThanOrEqual(100);
  });

  it.skipIf(!RUN_PERFORMANCE)(
    "keeps 10,000-Capture semantic ranking and fusion at p95 <= 500 ms",
    () => {
      const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
      collect?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const unit = new Float32Array(DIMENSIONS);
      unit[0] = 1;
      const vector = { version: 1 as const, ...quantizeEmbedding(unit) };
      const captures: SearchSemanticCapture[] = [];
      const passages = new Map<string, SearchSemanticPassages>();
      for (let index = 0; index < CAPTURE_COUNT; index += 1) {
        const bundleId = identifier(index + 10);
        const passageCount = index % 10 === 0 ? 40 : 12;
        captures.push({
          version: 1,
          bundleId,
          sourceRevision: "ab".repeat(32),
          providerIdentityHash: "cd".repeat(32),
          collectionId: identifier(100 + (index % 100)),
          status: index % 5 === 0 ? "Deleted" : "Active",
          host: `host-${String(index % 500)}.example.test`,
          capturedAt: "2026-07-26T00:00:00.000Z",
          centroids: [{ passageId: "ef".repeat(32), passageOrdinal: 0, vector }],
        });
        passages.set(bundleId, {
          version: 1,
          bundleId,
          sourceRevision: "ab".repeat(32),
          providerIdentityHash: "cd".repeat(32),
          passages: Array.from({ length: passageCount }, (_, passageOrdinal) => ({
            passageId: `${index.toString(16).padStart(32, "0")}${passageOrdinal
              .toString(16)
              .padStart(32, "0")}`,
            passageOrdinal,
            vector,
          })),
        });
      }
      collect?.();
      const semanticHeapMiB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
      const run = () => {
        const semantic = rankSemanticCandidates({
          query: unit,
          captures,
          passages,
          providerIdentityHash: "cd".repeat(32),
          filters: { scope: "Active", hosts: [], collectionIds: [] },
        });
        return fuseHybridResults({ exact: [], keyword: [], semantic });
      };
      run();
      const samples = Array.from({ length: 20 }, () => {
        const started = performance.now();
        run();
        return performance.now() - started;
      });
      const measuredP95 = p95(samples);
      console.info(`Search semantic 10k p95: ${measuredP95.toFixed(2)} ms`);
      if (collect !== undefined) {
        console.info(`Search semantic 10k retained heap: ${semanticHeapMiB.toFixed(2)} MiB`);
        expect(semanticHeapMiB).toBeLessThan(256);
      }
      expect(measuredP95).toBeLessThanOrEqual(500);
    },
  );
});

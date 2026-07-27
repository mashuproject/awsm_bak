import { describe, expect, it } from "vitest";
import {
  buildSemanticMaterializations,
  cosineSimilarity,
  normalizeEmbedding,
  providerIdentityHash,
  quantizeEmbedding,
  rankSemanticCandidates,
  SemanticCentroidCollector,
  selectCaptureCentroids,
} from "../../src/runtime/search/semantic";

describe("semantic Search vector contracts", () => {
  it("normalizes and quantizes with signed bytes and ties away from zero", () => {
    const normalized = normalizeEmbedding([3, -4, 0]);
    expect(Array.from(normalized)).toEqual([0.6000000238418579, -0.800000011920929, 0]);

    const quantized = quantizeEmbedding(Float32Array.from([127, -63.5, 0.5]));
    expect(quantized.dimensions).toBe(3);
    expect(quantized.scale).toBe(1);
    expect(Array.from(new Int8Array(quantized.values.buffer))).toEqual([127, -64, 1]);
  });

  it("rejects malformed embeddings", () => {
    for (const value of [[], [0, 0], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]]) {
      expect(() => normalizeEmbedding(value)).toThrow();
    }
  });

  it("calculates cosine after dequantization", () => {
    const stored = quantizeEmbedding(normalizeEmbedding([1, 1, 0]));
    expect(cosineSimilarity(normalizeEmbedding([1, 0, 0]), stored)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it("selects deterministic farthest-first passage centroids", () => {
    const passages = [
      { passageId: "p0", passageOrdinal: 0, vector: normalizeEmbedding([1, 0]) },
      { passageId: "p1", passageOrdinal: 1, vector: normalizeEmbedding([0.9, 0.1]) },
      { passageId: "p2", passageOrdinal: 2, vector: normalizeEmbedding([-1, 0]) },
      { passageId: "p3", passageOrdinal: 3, vector: normalizeEmbedding([0, 1]) },
      { passageId: "p4", passageOrdinal: 4, vector: normalizeEmbedding([0, -1]) },
    ];

    expect(selectCaptureCentroids(passages).map(({ passageId }) => passageId)).toEqual([
      "p0",
      "p2",
      "p3",
      "p4",
    ]);
  });

  it("hashes the complete canonical provider identity", async () => {
    const base = {
      version: 1,
      kind: "LocalMiniLm",
      model: "model",
      modelRevision: "revision",
      dimensions: 2,
      pooling: "Mean",
      normalized: true,
    } as const;
    expect(await providerIdentityHash(base)).toMatch(/^[0-9a-f]{64}$/u);
    expect(await providerIdentityHash(base)).not.toBe(
      await providerIdentityHash({ ...base, modelRevision: "other" }),
    );
  });

  it("prefilters by centroids then reranks every passage for the best passage", () => {
    const capture = (
      bundleId: string,
      capturedAt: string,
      vectors: readonly (readonly number[])[],
    ) =>
      buildSemanticMaterializations({
        document: {
          version: 1,
          vaultId: "10000000-0000-4000-8000-000000000001",
          bundleId,
          collectionId: "30000000-0000-4000-8000-000000000003",
          collectionTitle: "",
          status: "Active",
          title: "",
          canonicalUrl: "https://example.com/",
          knownUrls: ["https://example.com/"],
          host: "example.com",
          capturedAt,
          sourceRevision: "0".repeat(64),
          passages: vectors.map((_, ordinal) => ({
            version: 1,
            passageId: String(ordinal).padStart(64, "0"),
            ordinal,
            text: `passage ${ordinal}`,
            source: { role: "METADATA", startOffset: 0, endOffset: 1 },
          })),
        },
        providerIdentityHash: "a".repeat(64),
        embeddings: vectors.map((vector, passageOrdinal) => ({
          passageId: String(passageOrdinal).padStart(64, "0"),
          passageOrdinal,
          vector: normalizeEmbedding(vector),
        })),
      });
    const first = capture("20000000-0000-4000-8000-000000000002", "2026-01-01T00:00:00.000Z", [
      [0, 1],
      [1, 0],
    ]);
    const second = capture("20000000-0000-4000-8000-000000000003", "2026-01-02T00:00:00.000Z", [
      [0.7, 0.7],
    ]);

    expect(
      rankSemanticCandidates({
        query: normalizeEmbedding([1, 0]),
        captures: [first.capture, second.capture],
        passages: new Map([
          [first.capture.bundleId, first.passages],
          [second.capture.bundleId, second.passages],
        ]),
      }),
    ).toMatchObject([
      { bundleId: first.capture.bundleId, passageId: "1".padStart(64, "0") },
      { bundleId: second.capture.bundleId, passageId: "0".padStart(64, "0") },
    ]);

    const collector = new SemanticCentroidCollector({
      query: normalizeEmbedding([1, 0]),
      providerIdentityHash: "a".repeat(64),
      filters: {
        scope: "Active",
        hosts: ["example.com"],
        collectionIds: [],
      },
    });
    collector.add([first.capture, second.capture]);
    collector.add(
      Array.from({ length: 150 }, (_, index) => ({
        ...second.capture,
        bundleId: `20000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      })),
    );
    expect(collector.captures()).toHaveLength(100);
    expect(
      new SemanticCentroidCollector({
        query: normalizeEmbedding([1, 0]),
        providerIdentityHash: "b".repeat(64),
        filters: { scope: "Active", hosts: [], collectionIds: [] },
      }).captures(),
    ).toEqual([]);
  });
});

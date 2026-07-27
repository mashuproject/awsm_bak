import { describe, expect, it } from "vitest";
import { fuseHybridResults } from "../../src/runtime/search/hybrid";

describe("hybrid Search ranking", () => {
  it("pins exact tiers before reciprocal-rank fusion and removes duplicates", () => {
    const results = fuseHybridResults({
      exact: [
        { bundleId: "title", reason: "ExactTitle", keywordScore: 1, capturedAt: "2026-01-01" },
        { bundleId: "url", reason: "ExactUrl", keywordScore: 99, capturedAt: "2026-01-02" },
      ],
      keyword: [
        { bundleId: "both", passageId: "keyword-both", score: 4, capturedAt: "2026-01-03" },
        { bundleId: "keyword", passageId: "keyword-only", score: 3, capturedAt: "2026-01-04" },
        { bundleId: "title", passageId: "exact-duplicate", score: 2, capturedAt: "2026-01-01" },
      ],
      semantic: [
        { bundleId: "semantic", passageId: "semantic-only", score: 0.9, capturedAt: "2026-01-02" },
        { bundleId: "both", passageId: "semantic-both", score: 0.8, capturedAt: "2026-01-03" },
      ],
    });

    expect(results.map(({ bundleId }) => bundleId)).toEqual([
      "title",
      "url",
      "both",
      "semantic",
      "keyword",
    ]);
    expect(results.find(({ bundleId }) => bundleId === "both")).toMatchObject({
      match: "KeywordAndSemantic",
      passageId: "keyword-both",
    });
  });

  it("uses captured time then Bundle identifier for deterministic fusion ties", () => {
    const results = fuseHybridResults({
      exact: [],
      keyword: [
        { bundleId: "c", passageId: "c", score: 1, capturedAt: "2026-01-02" },
        { bundleId: "a", passageId: "a", score: 1, capturedAt: "2026-01-01" },
        { bundleId: "b", passageId: "b", score: 1, capturedAt: "2026-01-01" },
      ],
      semantic: [],
    });

    expect(results.map(({ bundleId }) => bundleId)).toEqual(["c", "a", "b"]);
  });
});

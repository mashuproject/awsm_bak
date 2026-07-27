import { describe, expect, it } from "vitest";
import {
  combineWindowEmbeddings,
  meanPoolLastHiddenState,
  splitContentTokenIds,
} from "../../src/runtime/search/local-model/math";

describe("local MiniLM token windows and pooling", () => {
  it("uses 254-content-token windows with document overlap and no query overlap", () => {
    const tokenIds = Array.from({ length: 600 }, (_, index) => index);
    const document = splitContentTokenIds(tokenIds, "Document");
    const query = splitContentTokenIds(tokenIds, "Query");

    expect(document.map((window) => [window[0], window.at(-1), window.length])).toEqual([
      [0, 253, 254],
      [222, 475, 254],
      [444, 599, 156],
    ]);
    expect(query.map((window) => [window[0], window.at(-1), window.length])).toEqual([
      [0, 253, 254],
      [254, 507, 254],
      [508, 599, 92],
    ]);
    expect(splitContentTokenIds([], "Document")).toEqual([[]]);
  });

  it("mean-pools only attention-mask tokens with float64 accumulation and L2 normalization", () => {
    const pooled = meanPoolLastHiddenState({
      lastHiddenState: new Float32Array([3, 0, 0, 4, 100, 100]),
      attentionMask: new Uint8Array([1, 1, 0]),
      tokenCount: 3,
      dimensions: 2,
    });

    expect(pooled[0]).toBeCloseTo(0.6);
    expect(pooled[1]).toBeCloseTo(0.8);
    expect(() =>
      meanPoolLastHiddenState({
        lastHiddenState: new Float32Array([1, 2]),
        attentionMask: new Uint8Array([0]),
        tokenCount: 1,
        dimensions: 2,
      }),
    ).toThrow();
  });

  it("averages normalized window vectors in float64 and normalizes the final vector", () => {
    const combined = combineWindowEmbeddings([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(combined[0]).toBeCloseTo(Math.SQRT1_2);
    expect(combined[1]).toBeCloseTo(Math.SQRT1_2);
    expect(() =>
      combineWindowEmbeddings([new Float32Array([1, 0]), new Float32Array([1, 0, 0])]),
    ).toThrow();
  });
});

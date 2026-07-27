import { describe, expect, it } from "vitest";
import { parseSearchQuery, tokenizeSearchText } from "../../src/runtime/search/query";

describe("Search query parsing", () => {
  it("normalizes unquoted terms and balanced phrases without escape semantics", () => {
    expect(parseSearchQuery('  Résumé  "Exact   Phrase" path\\name  ')).toEqual({
      normalized: 'Résumé "Exact Phrase" path\\name',
      semanticText: "Résumé Exact Phrase path\\name",
      exactValue: "résumé exact phrase path\\name",
      terms: ["résumé", "path", "name"],
      phrases: [{ text: "Exact Phrase", tokens: ["exact", "phrase"] }],
    });
  });

  it("treats an unmatched quote as ordinary punctuation", () => {
    expect(parseSearchQuery('alpha "beta gamma')).toMatchObject({
      terms: ["alpha", "beta", "gamma"],
      phrases: [],
      semanticText: 'alpha "beta gamma',
    });
  });

  it("ignores empty phrases and scores unique query terms", () => {
    expect(parseSearchQuery('alpha alpha "" "  " beta')).toMatchObject({
      terms: ["alpha", "beta"],
      phrases: [],
      exactValue: "alpha alpha beta",
    });
  });

  it("rejects empty, punctuation-only, and oversized queries", () => {
    for (const query of ["", "   ", '""', "!!!", "a".repeat(1_025)]) {
      expect(() => parseSearchQuery(query)).toThrow();
    }
  });

  it("tokenizes Unicode letters, marks, and numbers without stemming", () => {
    expect(tokenizeSearchText("CAFÉ cafe\u0301 runners running 42 foo-bar")).toEqual([
      "café",
      "café",
      "runners",
      "running",
      "42",
      "foo",
      "bar",
    ]);
  });
});

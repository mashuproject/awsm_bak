import { describe, expect, it } from "vitest";
import type { SearchDocument } from "../../src/runtime/search/documents";
import {
  buildKeywordRow,
  buildKeywordStatistics,
  rankKeywordRows,
} from "../../src/runtime/search/keyword";
import { parseSearchQuery } from "../../src/runtime/search/query";

function document(
  bundleId: string,
  values: {
    readonly title: string;
    readonly body: string;
    readonly host?: string;
    readonly capturedAt?: string;
    readonly status?: "Active" | "Deleted";
    readonly collectionId?: string;
  },
): SearchDocument {
  return {
    version: 1,
    vaultId: "10000000-0000-4000-8000-000000000001",
    bundleId,
    collectionId: values.collectionId ?? "30000000-0000-4000-8000-000000000003",
    collectionTitle: "Research",
    status: values.status ?? "Active",
    title: values.title,
    canonicalUrl: `https://${values.host ?? "example.com"}/${bundleId}`,
    knownUrls: [`https://${values.host ?? "example.com"}/${bundleId}`],
    host: values.host ?? "example.com",
    capturedAt: values.capturedAt ?? "2026-07-26T00:00:00.000Z",
    sourceRevision: bundleId.padEnd(64, "0").slice(0, 64),
    passages: [
      {
        version: 1,
        passageId: `${bundleId}-metadata`,
        ordinal: 0,
        text: `${values.title}\nhttps://${values.host ?? "example.com"}/${bundleId}`,
        source: { role: "METADATA", startOffset: 0, endOffset: values.title.length },
      },
      {
        version: 1,
        passageId: `${bundleId}-body`,
        ordinal: 1,
        text: values.body,
        source: { role: "TEXT_EXTRACTED", startOffset: 0, endOffset: values.body.length },
      },
    ],
  };
}

describe("keyword Search ranking", () => {
  it("applies field-weighted BM25 and chooses the contributing passage", () => {
    const rows = [
      buildKeywordRow(document("title", { title: "semantic archive", body: "unrelated" })),
      buildKeywordRow(document("body", { title: "other", body: "semantic archive" })),
    ];
    const results = rankKeywordRows(
      parseSearchQuery("semantic archive"),
      rows,
      buildKeywordStatistics(rows),
      { scope: "Active", hosts: [], collectionIds: [] },
    );

    expect(results.map(({ bundleId }) => bundleId)).toEqual(["title", "body"]);
    expect(results[0]?.passageId).toBe("title-metadata");
    expect(results[1]?.passageId).toBe("body-body");
  });

  it("enforces every phrase and at least one unquoted term", () => {
    const rows = [
      buildKeywordRow(document("match", { title: "alpha", body: "exact phrase appears here" })),
      buildKeywordRow(document("wrong-order", { title: "alpha", body: "phrase exact appears" })),
      buildKeywordRow(document("missing-term", { title: "beta", body: "exact phrase appears" })),
    ];
    const results = rankKeywordRows(
      parseSearchQuery('alpha "exact phrase"'),
      rows,
      buildKeywordStatistics(rows),
      { scope: "Active", hosts: [], collectionIds: [] },
    );

    expect(results.map(({ bundleId }) => bundleId)).toEqual(["match"]);
  });

  it("applies scope, host, date, and Collection filters before ranking", () => {
    const rows = [
      buildKeywordRow(
        document("wanted", {
          title: "alpha",
          body: "",
          host: "wanted.example",
          capturedAt: "2026-07-20T00:00:00.000Z",
        }),
      ),
      buildKeywordRow(
        document("deleted", {
          title: "alpha",
          body: "",
          host: "wanted.example",
          status: "Deleted",
        }),
      ),
      buildKeywordRow(document("other-host", { title: "alpha", body: "" })),
    ];
    const results = rankKeywordRows(parseSearchQuery("alpha"), rows, buildKeywordStatistics(rows), {
      scope: "Active",
      hosts: ["wanted.example"],
      collectionIds: ["30000000-0000-4000-8000-000000000003"],
      capturedFrom: "2026-07-01T00:00:00.000Z",
      capturedBefore: "2026-08-01T00:00:00.000Z",
    });

    expect(results.map(({ bundleId }) => bundleId)).toEqual(["wanted"]);
  });
});

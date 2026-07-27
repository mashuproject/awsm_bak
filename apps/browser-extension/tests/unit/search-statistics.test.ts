import { describe, expect, it } from "vitest";
import { buildSearchDocument } from "../../src/runtime/search/documents";
import { buildKeywordRow } from "../../src/runtime/search/keyword";
import {
  applyKeywordStatisticsChange,
  createKeywordStatistics,
  projectionGeneration,
} from "../../src/runtime/search/statistics";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "20000000-0000-4000-8000-000000000002";
const GENERATION_ID = "30000000-0000-4000-8000-000000000003";

async function row(status: "Active" | "Deleted", body: string) {
  return buildKeywordRow(
    await buildSearchDocument({
      vaultId: VAULT_ID,
      bundleId: BUNDLE_ID,
      collectionId: "40000000-0000-4000-8000-000000000004",
      collectionTitle: "Research",
      status,
      title: "Private Search",
      canonicalUrl: "https://example.com/search",
      knownUrls: ["https://example.com/search"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: "50000000-0000-4000-8000-000000000005",
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: body },
    }),
  );
}

describe("keyword Search projection statistics", () => {
  it("updates Active and Deleted totals and averages incrementally", async () => {
    const active = await row("Active", "one two three");
    const deleted = await row("Deleted", "one two three four five");
    const initial = createKeywordStatistics(GENERATION_ID);
    const afterActive = applyKeywordStatisticsChange(initial, undefined, active);
    const afterDeleted = applyKeywordStatisticsChange(afterActive, active, deleted);

    expect(projectionGeneration(initial)).toBe(`${GENERATION_ID}:0`);
    expect(afterActive.revision).toBe(1);
    expect(afterActive.Active.documentCount).toBe(1);
    expect(afterActive.Active.totalFieldLengths.Body).toBe(3);
    expect(afterActive.Active.averageFieldLengths.Body).toBe(3);
    expect(afterDeleted.revision).toBe(2);
    expect(afterDeleted.Active.documentCount).toBe(0);
    expect(afterDeleted.Active.averageFieldLengths.Body).toBe(0);
    expect(afterDeleted.Deleted.documentCount).toBe(1);
    expect(afterDeleted.Deleted.totalFieldLengths.Body).toBe(5);
    expect(afterDeleted.Deleted.averageFieldLengths.Body).toBe(5);
    expect(projectionGeneration(afterDeleted)).toBe(`${GENERATION_ID}:2`);
  });

  it("rejects mismatched Capture replacement and revision overflow", async () => {
    const active = await row("Active", "one");
    const other = {
      ...active,
      document: {
        ...active.document,
        bundleId: "60000000-0000-4000-8000-000000000006",
      },
    };
    expect(() =>
      applyKeywordStatisticsChange(createKeywordStatistics(GENERATION_ID), active, other),
    ).toThrow();
    expect(() =>
      applyKeywordStatisticsChange(
        { ...createKeywordStatistics(GENERATION_ID), revision: Number.MAX_SAFE_INTEGER },
        undefined,
        active,
      ),
    ).toThrow();
  });
});

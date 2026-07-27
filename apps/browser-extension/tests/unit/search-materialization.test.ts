import { describe, expect, it } from "vitest";
import { encodeCanonicalCbor } from "../../src/domain/cbor";
import { buildSearchDocument } from "../../src/runtime/search/documents";
import { buildKeywordRow } from "../../src/runtime/search/keyword";
import {
  decodeKeywordMaterialization,
  decodeKeywordStatisticsMaterialization,
  decodeSemanticCaptureMaterialization,
  decodeSemanticPassagesMaterialization,
  encodeKeywordMaterialization,
  encodeKeywordStatisticsMaterialization,
  encodeSemanticCaptureMaterialization,
  encodeSemanticPassagesMaterialization,
} from "../../src/runtime/search/materialization";
import {
  buildSemanticMaterializations,
  normalizeEmbedding,
  providerIdentityHash,
} from "../../src/runtime/search/semantic";
import {
  applyKeywordStatisticsChange,
  createKeywordStatistics,
} from "../../src/runtime/search/statistics";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "20000000-0000-4000-8000-000000000002";

async function row() {
  return buildKeywordRow(
    await buildSearchDocument({
      vaultId: VAULT_ID,
      bundleId: BUNDLE_ID,
      collectionId: "30000000-0000-4000-8000-000000000003",
      collectionTitle: "Research",
      status: "Active",
      title: "Private Search",
      canonicalUrl: "https://example.com/search",
      knownUrls: ["https://example.com/search"],
      capturedAt: "2026-07-26T00:00:00.000Z",
      artifactObjectId: "40000000-0000-4000-8000-000000000004",
      artifactChecksum: new Uint8Array(32),
      source: { role: "TEXT_EXTRACTED", text: "Find the right Capture passage." },
    }),
  );
}

describe("keyword Search materialization", () => {
  it("round-trips the canonical encrypted-row plaintext and reconstructs deterministic fields", async () => {
    const expected = await row();
    const encoded = encodeKeywordMaterialization(expected);
    const decoded = decodeKeywordMaterialization(encoded);

    expect(decoded).toEqual(expected);
    expect(encodeKeywordMaterialization(decoded)).toEqual(encoded);
  });

  it("rejects noncanonical bytes, unknown fields, and forged derived keyword fields", async () => {
    const expected = await row();
    const canonical = {
      version: 1,
      document: expected.document,
      fields: expected.fields,
    };
    const forgedFields = expected.fields.map((field, index) =>
      index === 0 ? { ...field, tokens: ["forged"] } : field,
    );

    for (const encoded of [
      new Uint8Array([...encodeKeywordMaterialization(expected), 0]),
      encodeCanonicalCbor({ ...canonical, plaintextLeak: "no" }),
      encodeCanonicalCbor({ ...canonical, fields: forgedFields }),
      encodeCanonicalCbor({
        ...canonical,
        document: { ...canonical.document, bundleId: "not-a-uuid" },
      }),
    ]) {
      expect(() => decodeKeywordMaterialization(encoded)).toThrow();
    }
  });

  it("round-trips strict generation statistics and rejects inconsistent averages", async () => {
    const statistics = applyKeywordStatisticsChange(
      createKeywordStatistics("60000000-0000-4000-8000-000000000006"),
      undefined,
      await row(),
    );
    const encoded = encodeKeywordStatisticsMaterialization(statistics);

    expect(decodeKeywordStatisticsMaterialization(encoded)).toEqual(statistics);
    expect(() =>
      decodeKeywordStatisticsMaterialization(
        encodeCanonicalCbor({
          ...statistics,
          Active: {
            ...statistics.Active,
            averageFieldLengths: {
              ...statistics.Active.averageFieldLengths,
              Body: 999,
            },
          },
        }),
      ),
    ).toThrow();
  });
});

describe("semantic Search materialization", () => {
  it("round-trips strict Capture centroids and complete passage vectors", async () => {
    const document = (await row()).document;
    const identity = {
      version: 1,
      kind: "LocalMiniLm",
      model: "Xenova/all-MiniLM-L6-v2",
      modelRevision: "revision",
      dimensions: 3,
      pooling: "Mean",
      normalized: true,
    } as const;
    const identityHash = await providerIdentityHash(identity);
    const materializations = buildSemanticMaterializations({
      document,
      providerIdentityHash: identityHash,
      embeddings: document.passages.map((passage, index) => ({
        passageId: passage.passageId,
        passageOrdinal: passage.ordinal,
        vector: normalizeEmbedding([1, index + 1, index + 2]),
      })),
    });

    const captureBytes = encodeSemanticCaptureMaterialization(materializations.capture);
    const passageBytes = encodeSemanticPassagesMaterialization(materializations.passages);
    expect(decodeSemanticCaptureMaterialization(captureBytes)).toEqual(materializations.capture);
    expect(decodeSemanticPassagesMaterialization(passageBytes)).toEqual(materializations.passages);
    expect(() =>
      decodeSemanticCaptureMaterialization(
        encodeCanonicalCbor({ ...materializations.capture, plaintextLeak: "no" }),
      ),
    ).toThrow();
    expect(() =>
      decodeSemanticPassagesMaterialization(
        encodeCanonicalCbor({
          ...materializations.passages,
          passages: materializations.passages.passages.slice(1),
        }),
      ),
    ).toThrow();
  });
});

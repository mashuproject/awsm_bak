import { describe, expect, it } from "vitest";
import type { ExportJobV1, StoredVaultHeadV1 } from "../../src/drivers/indexeddb/schema";
import { assertReplacementExportGate } from "../../src/runtime/recovery/replacement-gate";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const head: StoredVaultHeadV1 = {
  version: 1,
  vaultId: id(1),
  generationId: id(2),
  generationNumber: 3,
  appendedObjectIds: [id(3)],
  appendedEventIds: [id(4)],
};

const completeExport: ExportJobV1 = {
  version: 1,
  vaultId: head.vaultId,
  jobId: id(5),
  packageId: id(6),
  state: "Succeeded",
  stage: "Download",
  createdAt: "2026-07-25T22:00:00.000Z",
  updatedAt: "2026-07-25T22:01:00.000Z",
  completedEntries: 5,
  totalEntries: 5,
  processedBytes: 100,
  totalBytes: 100,
  cancellationRequested: false,
  verifiedSnapshot: {
    vaultId: head.vaultId,
    generationId: head.generationId,
    generationNumber: head.generationNumber,
    appendedObjectIds: head.appendedObjectIds,
    appendedEventIds: head.appendedEventIds,
    coverage: "Complete",
    verifiedAt: "2026-07-25T22:00:59.000Z",
    downloadedAt: "2026-07-25T22:01:00.000Z",
  },
};

describe("full replacement Complete Export gate", () => {
  it("accepts only a verified current Complete Export confirmed safely stored", () => {
    expect(
      assertReplacementExportGate({
        vaultId: head.vaultId,
        currentHead: head,
        latestExport: completeExport,
        safelyStoredConfirmed: true,
      }),
    ).toEqual(completeExport.verifiedSnapshot);

    expect(() =>
      assertReplacementExportGate({
        vaultId: head.vaultId,
        currentHead: { ...head, appendedEventIds: [id(7)] },
        latestExport: completeExport,
        safelyStoredConfirmed: true,
      }),
    ).toThrowError(expect.objectContaining({ id: "VAULT_REPLACEMENT_EXPORT_REQUIRED" }));
    expect(() =>
      assertReplacementExportGate({
        vaultId: head.vaultId,
        currentHead: head,
        latestExport: completeExport,
        safelyStoredConfirmed: false,
      }),
    ).toThrowError(expect.objectContaining({ id: "VAULT_REPLACEMENT_EXPORT_REQUIRED" }));
  });
});

import { describe, expect, it } from "vitest";
import type { ServerSwitchJobV1 } from "../../src/drivers/indexeddb/schema";
import { serverSwitchRaceDisposition } from "../../src/runtime/synchronization/server-switch-race";

function job(overrides: Partial<ServerSwitchJobV1> = {}): ServerSwitchJobV1 {
  return {
    version: 1,
    jobId: "01900000-0000-7000-8000-000000000001",
    sourceOrigin: "https://source.example",
    candidateOrigin: "https://candidate.example",
    candidateRegistration: { enabled: false },
    vaultId: "01900000-0000-7000-8000-000000000002",
    state: "Running",
    stage: "PrepareRemote",
    direction: "Union",
    expectedLocalHead: {
      version: 1,
      vaultId: "01900000-0000-7000-8000-000000000002",
      generationId: "01900000-0000-7000-8000-000000000003",
      generationNumber: 0,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    completedItems: 0,
    totalItems: 0,
    processedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
    candidateAuthorityChanged: false,
    attachIdempotencyKey: "01900000-0000-7000-8000-000000000004",
    candidateIdempotencyKey: "01900000-0000-7000-8000-000000000005",
    ...overrides,
  };
}

describe("Server Switch candidate-head races", () => {
  it.each(["VAULT_HEAD_CHANGED", "VAULT_GENERATION_SUPERSEDED"])(
    "permits one read-only reclassification for %s",
    (errorId) => {
      expect(serverSwitchRaceDisposition(job(), errorId)).toEqual({ kind: "Recompare" });
      expect(serverSwitchRaceDisposition(job({ retryCount: 1 }), errorId)).toEqual({
        kind: "Conflict",
        candidateAuthorityChanged: false,
      });
    },
  );

  it("reports a truthful terminal conflict after accepted candidate authority", () => {
    expect(
      serverSwitchRaceDisposition(job({ candidateAuthorityChanged: true }), "VAULT_HEAD_CHANGED"),
    ).toEqual({ kind: "Conflict", candidateAuthorityChanged: true });
  });

  it("does not classify unrelated failures or terminal Jobs as head races", () => {
    expect(serverSwitchRaceDisposition(job(), "SYNCHRONIZATION_INTERRUPTED")).toBeUndefined();
    expect(
      serverSwitchRaceDisposition(job({ state: "Conflict" }), "VAULT_HEAD_CHANGED"),
    ).toBeUndefined();
  });
});

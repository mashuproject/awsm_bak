import { describe, expect, it } from "vitest";
import type { ServerSwitchJobV1 } from "../../src/drivers/indexeddb/schema";
import { shouldFailUncommittedServerSwitch } from "../../src/runtime/synchronization/server-switch-failure";

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
    direction: "PublishLocal",
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

describe("Server Switch pre-promotion failures", () => {
  it.each(["Compare", "PrepareRemote", "ActivateRemote", "PrepareLocal", "ActivateLocal"] as const)(
    "terminalizes an uncommitted failure during %s",
    (stage) => {
      expect(shouldFailUncommittedServerSwitch(job({ stage }))).toBe(true);
    },
  );

  it("does not rewrite a candidate-authentication pause or accepted candidate authority", () => {
    expect(
      shouldFailUncommittedServerSwitch(
        job({ state: "AuthenticationRequired", stage: "AuthenticateCandidate" }),
      ),
    ).toBe(false);
    expect(shouldFailUncommittedServerSwitch(job({ candidateAuthorityChanged: true }))).toBe(false);
  });

  it.each(["PromoteContext", "RevokePriorSession", "Terminal"] as const)(
    "does not treat %s as an uncommitted failure boundary",
    (stage) => {
      expect(shouldFailUncommittedServerSwitch(job({ stage }))).toBe(false);
    },
  );
});

import { describe, expect, it } from "vitest";
import type { ServerSwitchJobV1 } from "../../src/drivers/indexeddb/schema";
import { serverSwitchStartupDecision } from "../../src/runtime/synchronization/server-switch-startup";

const base: ServerSwitchJobV1 = {
  version: 1,
  jobId: "01900000-0000-7000-8000-000000000001",
  sourceOrigin: "https://source.example",
  candidateOrigin: "https://candidate.example",
  candidateRegistration: { enabled: false },
  vaultId: "01900000-0000-7000-8000-000000000002",
  state: "Running",
  stage: "Compare",
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
};

describe("Server Switch startup decisions", () => {
  it.each([
    [{ state: "AuthenticationRequired", stage: "AuthenticateCandidate" }, "PresentAuthentication"],
    [{ state: "Conflict", stage: "Terminal" }, "CleanupFailure"],
    [{ state: "Failed", stage: "Terminal" }, "CleanupFailure"],
    [{ state: "Succeeded", stage: "Terminal" }, "CleanupSuccess"],
    [{ state: "Running", stage: "Compare" }, "Compare"],
    [{ state: "Running", stage: "PrepareRemote" }, "ApplyRemote"],
    [{ state: "Running", stage: "ActivateRemote" }, "CompleteRemoteActivation"],
    [{ state: "Running", stage: "PrepareLocal" }, "ApplyLocal"],
    [{ state: "WaitingForUnlock", stage: "ActivateLocal" }, "ApplyLocal"],
    [{ state: "Running", stage: "PromoteContext" }, "PromoteUnchangedLocal"],
    [{ state: "Running", stage: "RevokePriorSession" }, "RevokePriorSession"],
  ] as const)("repeats the same decision for %o", (state, expected) => {
    const job = { ...base, ...state } as ServerSwitchJobV1;
    expect(serverSwitchStartupDecision(job, true)).toBe(expected);
    expect(serverSwitchStartupDecision(job, true)).toBe(expected);
  });

  it.each(["Union", "FastForwardLocal"] as const)(
    "redownloads before atomic promotion for %s",
    (direction) => {
      expect(
        serverSwitchStartupDecision({ ...base, stage: "PromoteContext", direction }, true),
      ).toBe("ApplyLocal");
    },
  );

  it("waits for unlock without advancing any running stage", () => {
    for (const stage of [
      "Compare",
      "PrepareRemote",
      "ActivateRemote",
      "PrepareLocal",
      "ActivateLocal",
      "PromoteContext",
      "RevokePriorSession",
    ] as const) {
      expect(serverSwitchStartupDecision({ ...base, stage }, false)).toBe("WaitForUnlock");
    }
  });
});

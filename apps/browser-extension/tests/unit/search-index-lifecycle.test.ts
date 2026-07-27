import { describe, expect, it } from "vitest";
import type { SearchIndexJobV1 } from "../../src/drivers/indexeddb/schema";
import {
  claimSearchIndexLease,
  completeSearchIndexJob,
  failSearchIndexJob,
  indexingWaitState,
  pauseSearchIndexJob,
  releaseSearchIndexLease,
  renewSearchIndexLease,
  resumeSearchIndexJob,
} from "../../src/runtime/search/index-lifecycle";

const job: SearchIndexJobV1 = {
  version: 1,
  jobId: "10000000-0000-4000-8000-000000000001",
  vaultId: "20000000-0000-4000-8000-000000000002",
  state: "Created",
  stage: "Keyword",
  projectionGeneration: "30000000-0000-4000-8000-000000000003:0",
  completedCaptures: 0,
  totalCaptures: 1,
  failedCaptures: 0,
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z",
};

describe("Search indexing lifecycle", () => {
  it("claims for thirty seconds, rejects contention, renews, and permits expired takeover", () => {
    const claimed = claimSearchIndexLease(job, "library-a", "2026-07-26T00:00:01.000Z");
    if (claimed === undefined) throw new Error("Expected lease claim.");
    expect(claimed).toMatchObject({
      state: "Running",
      leaseOwner: "library-a",
      leaseExpiresAt: "2026-07-26T00:00:31.000Z",
    });
    expect(claimSearchIndexLease(claimed, "library-b", "2026-07-26T00:00:30.999Z")).toBeUndefined();
    expect(renewSearchIndexLease(claimed, "library-a", "2026-07-26T00:00:10.000Z")).toMatchObject({
      leaseExpiresAt: "2026-07-26T00:00:40.000Z",
    });
    expect(claimSearchIndexLease(claimed, "library-b", "2026-07-26T00:00:31.000Z")).toMatchObject({
      leaseOwner: "library-b",
      leaseExpiresAt: "2026-07-26T00:01:01.000Z",
    });
  });

  it("releases durable work into the exact waiting state without retaining a lease", () => {
    const claimed = claimSearchIndexLease(job, "library-a", "2026-07-26T00:00:01.000Z");
    if (claimed === undefined) throw new Error("Expected lease claim.");
    const waiting = releaseSearchIndexLease(
      claimed,
      "library-a",
      "WaitingForLibrary",
      "2026-07-26T00:00:02.000Z",
    );

    expect(waiting).toEqual({
      ...job,
      state: "WaitingForLibrary",
      updatedAt: "2026-07-26T00:00:02.000Z",
    });
    expect(() => renewSearchIndexLease(claimed, "library-b", "2026-07-26T00:00:10.000Z")).toThrow();
  });

  it("completes only an owned fully-accounted Job and clears its lease", () => {
    const claimed = claimSearchIndexLease(
      { ...job, totalCaptures: 0 },
      "library-a",
      "2026-07-26T00:00:01.000Z",
    );
    if (claimed === undefined) throw new Error("Expected lease claim.");
    expect(completeSearchIndexJob(claimed, "library-a", "2026-07-26T00:00:02.000Z")).toEqual({
      ...job,
      totalCaptures: 0,
      state: "Succeeded",
      stage: "Terminal",
      updatedAt: "2026-07-26T00:00:02.000Z",
    });
    expect(() =>
      completeSearchIndexJob(
        { ...claimed, totalCaptures: 1 },
        "library-a",
        "2026-07-26T00:00:02.000Z",
      ),
    ).toThrow();
  });

  it("records a safe durable failure and retry time without retaining its lease", () => {
    const claimed = claimSearchIndexLease(job, "library-a", "2026-07-26T00:00:01.000Z");
    if (claimed === undefined) throw new Error("Expected lease claim.");
    expect(
      failSearchIndexJob(
        claimed,
        "library-a",
        "SEARCH_PROVIDER_UNAVAILABLE",
        "2026-07-26T00:00:02.000Z",
        "2026-07-26T00:05:02.000Z",
      ),
    ).toEqual({
      ...job,
      state: "Failed",
      updatedAt: "2026-07-26T00:00:02.000Z",
      retryAt: "2026-07-26T00:05:02.000Z",
      errorId: "SEARCH_PROVIDER_UNAVAILABLE",
    });
  });

  it("maps visibility, unlock, pause, permission, and network gates deterministically", () => {
    const ready = {
      connected: true,
      visible: true,
      expectedVaultActive: true,
      unlocked: true,
      paused: false,
      permissionPresent: true,
      online: true,
    };
    expect(indexingWaitState(ready)).toBeUndefined();
    expect(indexingWaitState({ ...ready, connected: false })).toBe("WaitingForLibrary");
    expect(indexingWaitState({ ...ready, visible: false })).toBe("WaitingForLibrary");
    expect(indexingWaitState({ ...ready, unlocked: false })).toBe("WaitingForUnlock");
    expect(indexingWaitState({ ...ready, expectedVaultActive: false })).toBe("WaitingForUnlock");
    expect(indexingWaitState({ ...ready, paused: true })).toBe("Paused");
    expect(indexingWaitState({ ...ready, permissionPresent: false })).toBe("WaitingForPermission");
    expect(indexingWaitState({ ...ready, online: false })).toBe("WaitingForNetwork");
  });

  it("pauses an owned Job without retaining its lease and resumes durable progress", () => {
    const claimed = claimSearchIndexLease(job, "library-a", "2026-07-26T00:00:01.000Z");
    if (claimed === undefined) throw new Error("Expected lease claim.");
    const paused = pauseSearchIndexJob(claimed, "2026-07-26T00:00:02.000Z");
    expect(paused).toEqual({
      ...job,
      state: "Paused",
      updatedAt: "2026-07-26T00:00:02.000Z",
    });
    expect(resumeSearchIndexJob(paused, "2026-07-26T00:00:03.000Z")).toEqual({
      ...job,
      state: "Created",
      updatedAt: "2026-07-26T00:00:03.000Z",
    });
  });
});

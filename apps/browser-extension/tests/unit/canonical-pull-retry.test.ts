import { describe, expect, it } from "vitest";

import {
  nextCanonicalPullRetry,
  resumeCanonicalPullRetry,
} from "../../src/runtime/synchronization/canonical-pull-retry";
import type { CanonicalPullSynchronizationJob } from "../../src/runtime/synchronization/canonical-state";

const job = (attempt = 0): CanonicalPullSynchronizationJob => ({
  jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
  vaultId: new Uint8Array(32).fill(1) as CanonicalPullSynchronizationJob["vaultId"],
  remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
  realm: { kind: "Test", id: "retry" },
  stage: 1,
  state: 1,
  snapshotCursor: null,
  nextPosition: null,
  attempt,
  retryAfterMs: null,
  quarantineReferences: [],
  progress: {
    discoveredItemCount: 0,
    downloadedItemCount: 0,
    promotedItemCount: 0,
    rejectedItemCount: 0,
  },
});

describe("canonical pull retry", () => {
  it("uses bounded jittered retry delays and preserves the exact Job input", () => {
    expect(
      nextCanonicalPullRetry({
        previous: job(),
        nowMs: 10_000,
        random: () => 0,
        hostRetryAfterMs: 2_000,
      }),
    ).toMatchObject({
      state: 2,
      attempt: 1,
      retryAfterMs: 12_000,
      quarantineReferences: [],
    });

    expect(
      nextCanonicalPullRetry({
        previous: job(7),
        nowMs: 10_000,
        random: () => 1,
        hostRetryAfterMs: null,
      }),
    ).toMatchObject({
      state: 2,
      attempt: 8,
      retryAfterMs: 202_000,
    });
  });

  it("preserves a terminal retry Job until an explicit pull restarts it", () => {
    const exhausted = nextCanonicalPullRetry({
      previous: job(8),
      nowMs: 10_000,
      random: () => 0.5,
      hostRetryAfterMs: null,
    });
    expect(exhausted).toMatchObject({ state: 4, attempt: 8, retryAfterMs: null });
    expect(resumeCanonicalPullRetry({ job: exhausted, nowMs: 10_000, force: false })).toBe(
      exhausted,
    );
    expect(resumeCanonicalPullRetry({ job: exhausted, nowMs: 10_000, force: true })).toMatchObject({
      state: 1,
      attempt: 0,
      retryAfterMs: null,
    });
  });
});

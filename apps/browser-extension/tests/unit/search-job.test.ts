import { describe, expect, it } from "vitest";
import {
  decodeSearchIndexCheckpoint,
  decodeSearchIndexJob,
} from "../../src/drivers/indexeddb/search-decode";

const VAULT_ID = "10000000-0000-4000-8000-000000000001";
const JOB_ID = "20000000-0000-4000-8000-000000000002";
const BUNDLE_ID = "30000000-0000-4000-8000-000000000003";
const GENERATION = "40000000-0000-4000-8000-000000000004:7";

const job = {
  version: 1,
  jobId: JOB_ID,
  vaultId: VAULT_ID,
  state: "Running",
  stage: "Keyword",
  projectionGeneration: GENERATION,
  completedCaptures: 4,
  totalCaptures: 10,
  failedCaptures: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:01.000Z",
  leaseOwner: "library-instance",
  leaseExpiresAt: "2026-07-26T00:00:31.000Z",
} as const;

const checkpoint = {
  version: 1,
  vaultId: VAULT_ID,
  jobId: JOB_ID,
  bundleId: BUNDLE_ID,
  sourceRevision: "ab".repeat(32),
  keywordState: "Committed",
  semanticState: "NotConfigured",
  attemptCount: 1,
  updatedAt: "2026-07-26T00:00:01.000Z",
} as const;

describe("Search indexing persistence records", () => {
  it("strictly decodes canonical Jobs and checkpoints", () => {
    expect(decodeSearchIndexJob(job)).toEqual(job);
    expect(decodeSearchIndexCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("rejects invalid progress, leases, state fields, and unknown fields", () => {
    for (const value of [
      { ...job, completedCaptures: 10, failedCaptures: 1 },
      { ...job, leaseExpiresAt: undefined },
      { ...job, state: "Paused", leaseOwner: "library-instance", leaseExpiresAt: undefined },
      { ...job, projectionGeneration: `${VAULT_ID}:9007199254740992` },
      { ...job, plaintextQuery: "private" },
    ]) {
      expect(() => decodeSearchIndexJob(value)).toThrow();
    }
    for (const value of [
      { ...checkpoint, sourceRevision: "invalid" },
      { ...checkpoint, keywordState: "Unknown" },
      { ...checkpoint, errorId: "SEARCH_INDEX_CORRUPT" },
      { ...checkpoint, plaintextTitle: "private" },
    ]) {
      expect(() => decodeSearchIndexCheckpoint(value)).toThrow();
    }
  });
});

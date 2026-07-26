import { describe, expect, it } from "vitest";

import type {
  StorageReliefCheckpointV1,
  StorageReliefJobV1,
} from "../../src/drivers/indexeddb/storage-relief-schema";
import { aggregateStorageReliefCheckpoints } from "../../src/drivers/indexeddb/storage-relief-state";
import {
  StorageReliefJobRunner,
  type StorageReliefProof,
} from "../../src/runtime/storage-relief/runner";

const IDS = {
  account: "00000000-0000-4000-8000-000000000001",
  artifact: "00000000-0000-4000-8000-000000000002",
  bundle: "00000000-0000-4000-8000-000000000003",
  descriptor: "00000000-0000-4000-8000-000000000004",
  event: "00000000-0000-4000-8000-000000000005",
  generation: "00000000-0000-4000-8000-000000000006",
  job: "00000000-0000-4000-8000-000000000007",
  vault: "00000000-0000-4000-8000-000000000008",
} as const;

const checksum = new Uint8Array(32).fill(9);
const head = {
  version: 1,
  vaultId: IDS.vault,
  generationId: IDS.generation,
  generationNumber: 3,
  appendedObjectIds: [],
  appendedEventIds: [],
} as const;

function created(): StorageReliefJobV1 {
  return {
    version: 1,
    vaultId: IDS.vault,
    jobId: IDS.job,
    state: "Created",
    stage: "Synchronize",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    expectedServerOrigin: "https://sync.example.test",
    expectedAccountId: IDS.account,
    candidateArtifacts: 1,
    candidateBytes: 123,
    verifiedArtifacts: 0,
    verifiedBytes: 0,
    evictedArtifacts: 0,
    freedBytes: 0,
    skippedArtifacts: 0,
    skippedBytes: 0,
    cancellationRequested: false,
  };
}

function candidate(): StorageReliefCheckpointV1 {
  return {
    version: 1,
    vaultId: IDS.vault,
    jobId: IDS.job,
    artifactObjectId: IDS.artifact,
    keyEpochId: "00000000-0000-4000-8000-000000000009",
    envelopeByteLength: 123,
    envelopeChecksum: checksum,
    state: "Candidate",
  };
}

function proof(overrides: Partial<StorageReliefProof> = {}): StorageReliefProof {
  return {
    generationId: IDS.generation,
    generationNumber: 3,
    records: new Map([
      [
        IDS.artifact,
        {
          objectType: "Artifact",
          keyEpochId: "00000000-0000-4000-8000-000000000009",
          byteLength: 123,
          sha256: checksum,
        },
      ],
      [
        IDS.descriptor,
        {
          objectType: "BundleDescriptor",
          keyEpochId: "00000000-0000-4000-8000-000000000009",
          byteLength: 50,
          sha256: checksum,
        },
      ],
      [
        IDS.event,
        {
          objectType: "Event",
          keyEpochId: "00000000-0000-4000-8000-000000000009",
          byteLength: 60,
          sha256: checksum,
          dependencyObjectIds: [IDS.artifact, IDS.descriptor].toSorted(),
        },
      ],
    ]),
    closures: new Map([
      [
        IDS.artifact,
        {
          descriptorObjectId: IDS.descriptor,
          registrationEventId: IDS.event,
          dependencyObjectIds: [IDS.artifact, IDS.descriptor].toSorted(),
        },
      ],
    ]),
    ...overrides,
  };
}

function fixture(
  options: {
    cancelAfterVerify?: boolean;
    cancelAfterEvictionAt?: string;
    proof?: StorageReliefProof;
    restartAfterRemoval?: boolean;
    remoteFenceChanged?: boolean;
    synchronizationErrorId?: string;
    unlocked?: boolean;
    authenticated?: boolean;
    contextVaultId?: string;
  } = {},
) {
  let job: StorageReliefJobV1 = options.restartAfterRemoval
    ? {
        ...created(),
        state: "Running",
        stage: "Evict",
        expectedLocalHead: head,
        expectedGenerationId: IDS.generation,
        expectedGenerationNumber: 3,
      }
    : created();
  let checkpoint: StorageReliefCheckpointV1 = options.restartAfterRemoval
    ? {
        ...candidate(),
        state: "Evicting",
        remoteGenerationId: IDS.generation,
        remoteGenerationNumber: 3,
      }
    : candidate();
  let localPresent = options.restartAfterRemoval !== true;
  let unlocked = options.unlocked ?? true;
  let authenticated = options.authenticated ?? true;
  const transitions: string[] = [];
  const runner = new StorageReliefJobRunner(
    {
      latestStorageReliefJob: async () => job,
      listStorageReliefCheckpoints: async () => [checkpoint],
      saveStorageReliefJob: async (next) => {
        job = next;
        transitions.push(`${next.stage}:${next.state}`);
      },
      saveStorageReliefCheckpoint: async (next) => {
        checkpoint = next;
        job = { ...job, ...aggregateStorageReliefCheckpoints([checkpoint]) };
        if (options.cancelAfterVerify && next.state === "Verified")
          job = { ...job, cancellationRequested: true };
      },
      markArtifactRemoteOnly: async ({ checkpoint: next }) => {
        checkpoint = next;
        job = { ...job, ...aggregateStorageReliefCheckpoints([checkpoint]) };
        if (options.cancelAfterEvictionAt !== undefined)
          job = {
            ...job,
            cancellationRequested: true,
            updatedAt: options.cancelAfterEvictionAt,
          };
      },
    },
    {
      has: async () => localPresent,
      verifyEncrypted: async () => localPresent,
      remove: async () => {
        localPresent = false;
      },
    },
    {
      current: async () => ({
        vaultId: options.contextVaultId ?? IDS.vault,
        accountId: IDS.account,
        serverOrigin: "https://sync.example.test",
        unlocked,
        authenticated,
        head,
      }),
      synchronize: async () => {
        if (options.synchronizationErrorId !== undefined)
          throw Object.assign(new Error("synchronization failed"), {
            id: options.synchronizationErrorId,
          });
      },
      prove: async () => options.proof ?? proof(),
      recheckRemoteFence: async () => ({
        generationId: IDS.generation,
        generationNumber: options.remoteFenceChanged ? 4 : 3,
      }),
    },
  );
  return {
    runner,
    setUnlocked: (value: boolean) => {
      unlocked = value;
    },
    setAuthenticated: (value: boolean) => {
      authenticated = value;
    },
    result: () => ({ job, checkpoint, localPresent, transitions }),
  };
}

describe("StorageReliefJobRunner", () => {
  it("persists proof before removing a wrapper and commits RemoteOnly afterward", async () => {
    const test = fixture();

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: { state: "Succeeded", stage: "Checkpoint", evictedArtifacts: 1, freedBytes: 123 },
      checkpoint: { state: "Evicted", remoteGenerationId: IDS.generation },
      localPresent: false,
    });
  });

  it("retains a local wrapper when the active server metadata differs", async () => {
    const mismatched = proof({
      records: new Map([
        [
          IDS.artifact,
          {
            objectType: "Artifact",
            keyEpochId: "00000000-0000-4000-8000-000000000009",
            byteLength: 124,
            sha256: checksum,
          },
        ],
      ]),
    });
    const test = fixture({ proof: mismatched });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: { state: "Succeeded", skippedArtifacts: 1, freedBytes: 0 },
      checkpoint: { state: "Skipped", skipReason: "RemoteMetadataMismatch" },
      localPresent: true,
    });
  });

  it("honors cancellation between verified candidates without deleting the next wrapper", async () => {
    const test = fixture({ cancelAfterVerify: true });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: { state: "Cancelled", stage: "Checkpoint", freedBytes: 0 },
      checkpoint: { state: "Verified" },
      localPresent: true,
    });
  });

  it("does not regress the persisted timestamp when cancellation arrives during eviction", async () => {
    const cancellationTime = "2026-07-21T00:00:20.000Z";
    const test = fixture({ cancelAfterEvictionAt: cancellationTime });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: {
        state: "Cancelled",
        stage: "Checkpoint",
        cancellationRequested: true,
        updatedAt: cancellationTime,
      },
      checkpoint: { state: "Evicted" },
      localPresent: false,
    });
  });

  it("commits RemoteOnly when restart finds an Evicting wrapper already removed", async () => {
    const test = fixture({ restartAfterRemoval: true });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: { state: "Succeeded", freedBytes: 123 },
      checkpoint: { state: "Evicted" },
      localPresent: false,
    });
  });

  it("fails before deletion when the active remote Generation changes", async () => {
    const test = fixture({ remoteFenceChanged: true });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: { state: "Failed", errorId: "SYNCHRONIZATION_CONFLICT", freedBytes: 0 },
      checkpoint: { state: "Verified" },
      localPresent: true,
    });
  });

  it("waits for authentication when foreground synchronization expires", async () => {
    const test = fixture({ synchronizationErrorId: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED" });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: { state: "AuthenticationRequired", stage: "Synchronize", freedBytes: 0 },
      checkpoint: { state: "Candidate" },
      localPresent: true,
    });
  });

  it("waits while locked and resumes the same candidate after unlock", async () => {
    const test = fixture({ unlocked: false });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");
    expect(test.result()).toMatchObject({
      job: { state: "WaitingForUnlock", stage: "Synchronize", freedBytes: 0 },
      checkpoint: { state: "Candidate" },
      localPresent: true,
    });

    test.setUnlocked(true);
    await test.runner.run(IDS.vault, "2026-07-21T00:00:11.000Z");
    expect(test.result()).toMatchObject({
      job: { state: "Succeeded", freedBytes: 123 },
      checkpoint: { state: "Evicted" },
      localPresent: false,
    });
  });

  it("waits while signed out and resumes the same candidate after authentication", async () => {
    const test = fixture({ authenticated: false });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");
    expect(test.result()).toMatchObject({
      job: { state: "AuthenticationRequired", stage: "Synchronize", freedBytes: 0 },
      checkpoint: { state: "Candidate" },
      localPresent: true,
    });

    test.setAuthenticated(true);
    await test.runner.run(IDS.vault, "2026-07-21T00:00:11.000Z");
    expect(test.result()).toMatchObject({
      job: { state: "Succeeded", freedBytes: 123 },
      checkpoint: { state: "Evicted" },
      localPresent: false,
    });
  });

  it("fails without deletion when the active Vault context changes", async () => {
    const test = fixture({ contextVaultId: IDS.bundle });

    await test.runner.run(IDS.vault, "2026-07-21T00:00:10.000Z");

    expect(test.result()).toMatchObject({
      job: { state: "Failed", errorId: "VAULT_CONTEXT_CHANGED", freedBytes: 0 },
      checkpoint: { state: "Candidate" },
      localPresent: true,
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import {
  identifierStorageKey,
  type ReplicaMutationCommit,
} from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import {
  decodeReplicaGarbageCollectionJob,
  encodeReplicaGarbageCollectionJob,
  type ReplicaGarbageCollectionJob,
  replicaGarbageCollectionIdempotencyKey,
} from "../../src/runtime/storage/garbage-collection-job";
import { CanonicalReplicaGarbageCollectionService } from "../../src/runtime/storage/garbage-collection-service";
import {
  decodeCanonicalReplicaState,
  encodeCanonicalReplicaState,
  type LogicalResolution,
} from "../../src/runtime/vault/canonical-local-state";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required test fixture value is missing");
  return value;
}

function resolution(
  vaultId: ReturnType<typeof filled<"Vault">>,
  kind: LogicalResolution["kind"],
  logicalId: Uint8Array,
  storageByte: number,
  epochByte: number,
): LogicalResolution {
  return {
    vaultId,
    kind,
    logicalId,
    storageItemId: filled("StorageItem", storageByte),
    keyEpochId: filled("KeyEpoch", epochByte),
    availability: 1,
  };
}

function fixture(
  options: {
    readonly fenced?: boolean;
    readonly orphanedActiveJob?: boolean;
    readonly removalFailure?: boolean;
    readonly retainedTerminal?: boolean;
    readonly resumeState?: "ready" | "running";
    readonly resumeWithPendingCompactState?: boolean;
    readonly nowMs?: number;
  } = {},
) {
  const vaultId = filled("Vault", 1);
  const currentRecord = filled("VaultRecord", 2);
  const predecessorRecord = filled("VaultRecord", 3);
  const currentArtifact = filled("Artifact", 4);
  const predecessorArtifact = filled("Artifact", 5);
  const activeEpoch = filled("KeyEpoch", 6);
  const oldEpoch = filled("KeyEpoch", 7);
  const cleanupEpoch = options.resumeWithPendingCompactState ? filled("KeyEpoch", 18) : activeEpoch;
  const pendingRecord = filled("VaultRecord", 19);
  const unrelatedPendingEpoch = filled("KeyEpoch", 20);
  const replicaStateStorageBytes = Uint8Array.of(8, 9);
  const resumeCandidates = [
    {
      artifactId: predecessorArtifact,
      storageItemId: filled("StorageItem", 16),
      keyEpochId: cleanupEpoch,
    },
  ];
  const resumeJob: ReplicaGarbageCollectionJob | undefined =
    options.resumeState === undefined
      ? undefined
      : {
          jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
          vaultId,
          idempotencyKey: replicaGarbageCollectionIdempotencyKey(vaultId, resumeCandidates),
          createdAtMs: 1_785_658_300_000,
          state: options.resumeState === "ready" ? 1 : 2,
          stage: 1,
          attempt: options.resumeState === "ready" ? 0 : 1,
          lease:
            options.resumeState === "ready"
              ? null
              : {
                  ownerId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
                  expiresAtMs: 1_785_658_350_000,
                },
          cancellationRequested: false,
          compactOutcome: {
            removedCompactItemCount: 1,
            removedResolutionCount: 1,
            removedEpochSecretCount: 1,
          },
          terminalOutcome: null,
          candidates: resumeCandidates,
        };
  const resumeJobBytes =
    resumeJob === undefined ? undefined : encodeReplicaGarbageCollectionJob(resumeJob);
  const retainedTerminalJob: ReplicaGarbageCollectionJob | undefined = options.retainedTerminal
    ? {
        jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
        vaultId,
        idempotencyKey: replicaGarbageCollectionIdempotencyKey(vaultId, resumeCandidates),
        createdAtMs: 1_785_658_200_000,
        state: 3,
        stage: 1,
        attempt: 1,
        lease: null,
        cancellationRequested: false,
        compactOutcome: {
          removedCompactItemCount: 1,
          removedResolutionCount: 1,
          removedEpochSecretCount: 1,
        },
        terminalOutcome: {
          removedCompactItemCount: 1,
          removedResolutionCount: 2,
          removedEpochSecretCount: 1,
          removedArtifactCount: 1,
        },
        candidates: resumeCandidates,
      }
    : undefined;
  const retainedTerminalJobBytes =
    retainedTerminalJob === undefined
      ? undefined
      : encodeReplicaGarbageCollectionJob(retainedTerminalJob);
  const commitReplicaMutation = vi.fn(async (_input: ReplicaMutationCommit) => undefined);
  const vault = {
    replicaState: {
      vaultId,
      generationId: filled("Generation", 10),
      baselineId: currentRecord,
      causalFrontier: [currentRecord],
      authorityFrontier: [currentRecord],
      continuityRecordIds: [currentRecord],
      preservationRoots: [],
      garbageCollectionFences:
        resumeJob === undefined
          ? options.fenced
            ? [
                {
                  artifactId: filled("Artifact", 11),
                  storageItemId: filled("StorageItem", 11),
                },
              ]
            : []
          : options.orphanedActiveJob
            ? []
            : [{ artifactId: predecessorArtifact, storageItemId: filled("StorageItem", 16) }],
      adoption: { vacuumEventRecordId: currentRecord },
      currentKeyEpochId: activeEpoch,
      requiredFeatureSetId: filled("RequiredFeatureSet", 12),
      authoringClientCredentialId: null,
      memberId: null,
      lifecycle: 1 as const,
    },
    replicaStateStorageBytes,
  };
  const replays = {
    replay: vi.fn(async () => ({ vault })),
    vaults: {
      realm: NORMAL_STORAGE_REALM,
      storage: {
        commitReplicaMutation,
        listBytes: vi.fn(async () =>
          resumeJobBytes === undefined
            ? retainedTerminalJobBytes === undefined
              ? []
              : [
                  {
                    namespace: NAMESPACES.replicaGarbageCollectionJob.key,
                    scopeKey: identifierStorageKey(vaultId),
                    itemKey: required(retainedTerminalJob).jobId,
                    realmKey: "Normal:default",
                    bytes: retainedTerminalJobBytes,
                  },
                ]
            : [
                {
                  namespace: NAMESPACES.replicaGarbageCollectionJob.key,
                  scopeKey: identifierStorageKey(vaultId),
                  itemKey: required(resumeJob).jobId,
                  realmKey: "Normal:default",
                  bytes: resumeJobBytes,
                },
              ],
        ),
      },
    },
  };
  const collectReachability = vi.fn(async () => ({
    typedLogicalRoots: [],
    recordIds: [currentRecord],
    vaultObjectIds: [],
    keyEnvelopeIds: [],
    featureManifestIds: [],
    artifactIds: [currentArtifact, ...(options.orphanedActiveJob ? [predecessorArtifact] : [])],
  }));
  const loadInventory = vi.fn(async () => ({
    resolutions: [
      resolution(vaultId, 1, currentRecord, 13, 6),
      resolution(vaultId, 1, predecessorRecord, 14, 7),
      resolution(vaultId, 5, currentArtifact, 15, 6),
      resolution(
        vaultId,
        5,
        predecessorArtifact,
        16,
        options.resumeWithPendingCompactState ? 18 : 6,
      ),
      ...(options.resumeWithPendingCompactState
        ? [resolution(vaultId, 1, pendingRecord, 17, 18)]
        : []),
    ],
    compactItems: [
      { kind: 1 as const, logicalId: currentRecord },
      { kind: 1 as const, logicalId: predecessorRecord },
      ...(options.resumeWithPendingCompactState
        ? [{ kind: 1 as const, logicalId: pendingRecord }]
        : []),
    ],
    epochSecretIds: [
      activeEpoch,
      oldEpoch,
      ...(options.resumeWithPendingCompactState ? [cleanupEpoch, unrelatedPendingEpoch] : []),
    ],
  }));
  const remove = vi.fn(async () => {
    if (options.removalFailure) throw new Error("injected Artifact removal failure");
  });
  const service = new CanonicalReplicaGarbageCollectionService({
    replays: replays as never,
    collectReachability,
    loadInventory,
    artifacts: { remove },
    randomUuid: () => "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
    now: () => options.nowMs ?? 1_785_658_400_000,
    wrapReplicaState: async (state) => ({
      namespace: NAMESPACES.replicaState.key,
      scopeKey: identifierStorageKey(vaultId),
      itemKey: "current",
      bytes: encodeCanonicalReplicaState(state),
    }),
  });
  return {
    service,
    vaultId,
    predecessorRecord,
    oldEpoch,
    replicaStateStorageBytes,
    commitReplicaMutation,
    collectReachability,
    loadInventory,
    remove,
  };
}

describe("canonical Replica Garbage Collection service", () => {
  it("commits compact reclamation against the exact prior Replica Safety State", async () => {
    const subject = fixture();

    const outcome = await subject.service.collect(subject.vaultId);

    expect(outcome).toMatchObject({
      removedCompactItemCount: 1,
      removedResolutionCount: 2,
      removedEpochSecretCount: 1,
      removedArtifactCount: 1,
    });
    expect(subject.commitReplicaMutation).toHaveBeenCalledTimes(3);
    const commit = subject.commitReplicaMutation.mock.calls[0]?.[0];
    const vaultKey = identifierStorageKey(subject.vaultId);
    expect(commit).toMatchObject({
      realm: NORMAL_STORAGE_REALM,
      expectedReplicaState: subject.replicaStateStorageBytes,
      nextReplicaState: {
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultKey,
        itemKey: "current",
      },
    });
    expect(
      decodeCanonicalReplicaState(required(commit).nextReplicaState.bytes).garbageCollectionFences,
    ).toEqual([{ artifactId: filled("Artifact", 5), storageItemId: filled("StorageItem", 16) }]);
    expect(commit?.deletedItems).toEqual(
      expect.arrayContaining([
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(subject.predecessorRecord),
        },
        {
          namespace: NAMESPACES.logicalResolution.key,
          scopeKey: vaultKey,
          itemKey: `1:${identifierStorageKey(subject.predecessorRecord)}`,
        },
        {
          namespace: NAMESPACES.epochSecret.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(subject.oldEpoch),
        },
      ]),
    );
    const readyJobItem = commit?.mutableItems?.find(
      ({ namespace }) => namespace === NAMESPACES.replicaGarbageCollectionJob.key,
    );
    const leaseCommit = subject.commitReplicaMutation.mock.calls[1]?.[0];
    const runningJobItem = leaseCommit?.mutableItems?.find(
      ({ namespace }) => namespace === NAMESPACES.replicaGarbageCollectionJob.key,
    );
    expect(leaseCommit?.expectedMutableItems).toEqual([
      {
        namespace: NAMESPACES.replicaGarbageCollectionJob.key,
        scopeKey: vaultKey,
        itemKey: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
        bytes: readyJobItem?.bytes,
      },
    ]);
    expect(decodeReplicaGarbageCollectionJob(required(runningJobItem).bytes)).toMatchObject({
      state: 2,
      attempt: 1,
      lease: {
        ownerId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
      },
    });
    expect(subject.remove).toHaveBeenCalledWith(filled("StorageItem", 16));
    const finalize = subject.commitReplicaMutation.mock.calls[2]?.[0];
    expect(
      decodeCanonicalReplicaState(required(finalize).nextReplicaState.bytes)
        .garbageCollectionFences,
    ).toEqual([]);
    const terminalJobItem = finalize?.mutableItems?.find(
      ({ namespace }) => namespace === NAMESPACES.replicaGarbageCollectionJob.key,
    );
    expect(decodeReplicaGarbageCollectionJob(required(terminalJobItem).bytes)).toMatchObject({
      state: 3,
      attempt: 1,
      lease: null,
      terminalOutcome: {
        removedCompactItemCount: 1,
        removedResolutionCount: 2,
        removedEpochSecretCount: 1,
        removedArtifactCount: 1,
      },
    });
    expect(finalize?.deletedItems).toEqual(
      expect.arrayContaining([
        {
          namespace: NAMESPACES.logicalResolution.key,
          scopeKey: vaultKey,
          itemKey: `5:${identifierStorageKey(filled("Artifact", 5))}`,
        },
      ]),
    );
    expect(finalize?.deletedItems).not.toContainEqual({
      namespace: NAMESPACES.replicaGarbageCollectionJob.key,
      scopeKey: vaultKey,
      itemKey: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
    });
  });

  it("retires the prior terminal Job atomically when a new heavy cleanup begins", async () => {
    const subject = fixture({ retainedTerminal: true });

    await subject.service.collect(subject.vaultId);

    const install = subject.commitReplicaMutation.mock.calls[0]?.[0];
    const priorJobItem = {
      namespace: NAMESPACES.replicaGarbageCollectionJob.key,
      scopeKey: identifierStorageKey(subject.vaultId),
      itemKey: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
    } as const;
    expect(install?.expectedMutableItems).toEqual([
      {
        ...priorJobItem,
        bytes: expect.any(Uint8Array),
      },
    ]);
    expect(install?.deletedItems).toContainEqual(priorJobItem);
  });

  it("does not trace or mutate while a Garbage Collection fence is active", async () => {
    const subject = fixture({ fenced: true });

    await expect(subject.service.collect(subject.vaultId)).rejects.toMatchObject({
      id: "GARBAGE_COLLECTION_FENCED",
    });
    expect(subject.collectReachability).not.toHaveBeenCalled();
    expect(subject.loadInventory).not.toHaveBeenCalled();
    expect(subject.commitReplicaMutation).not.toHaveBeenCalled();
  });

  it("fails closed on an active Job whose safety fence is absent even when no wrapper is reclaimable", async () => {
    const subject = fixture({ resumeState: "ready", orphanedActiveJob: true });

    await expect(subject.service.collect(subject.vaultId)).rejects.toMatchObject({
      id: "GARBAGE_COLLECTION_FENCED",
    });
    expect(subject.collectReachability).not.toHaveBeenCalled();
    expect(subject.commitReplicaMutation).not.toHaveBeenCalled();
  });

  it("persists exact cleanup identity and fences before deleting an Artifact wrapper", async () => {
    const subject = fixture({ removalFailure: true });

    await expect(subject.service.collect(subject.vaultId)).rejects.toThrow(
      "injected Artifact removal failure",
    );

    const install = subject.commitReplicaMutation.mock.calls[0]?.[0];
    const jobItem = install?.mutableItems?.find(
      ({ namespace }) => namespace === NAMESPACES.replicaGarbageCollectionJob.key,
    );
    expect(jobItem).toBeDefined();
    const job = decodeReplicaGarbageCollectionJob(required(jobItem).bytes);
    expect(job.candidates).toEqual([
      {
        artifactId: filled("Artifact", 5),
        storageItemId: filled("StorageItem", 16),
        keyEpochId: filled("KeyEpoch", 6),
      },
    ]);
    expect(
      decodeCanonicalReplicaState(required(install).nextReplicaState.bytes).garbageCollectionFences,
    ).toEqual([{ artifactId: filled("Artifact", 5), storageItemId: filled("StorageItem", 16) }]);
  });

  it("resumes a fenced cleanup Job after restart instead of treating its own fence as corruption", async () => {
    const subject = fixture({ resumeState: "ready" });

    const outcome = await subject.service.collect(subject.vaultId);

    expect(outcome).toMatchObject({
      removedCompactItemCount: 1,
      removedResolutionCount: 2,
      removedEpochSecretCount: 1,
      removedArtifactCount: 1,
    });
    expect(subject.commitReplicaMutation).toHaveBeenCalledTimes(2);
    expect(subject.remove).toHaveBeenCalledWith(filled("StorageItem", 16));
    const finalize = subject.commitReplicaMutation.mock.calls[1]?.[0];
    expect(
      decodeCanonicalReplicaState(required(finalize).nextReplicaState.bytes)
        .garbageCollectionFences,
    ).toEqual([]);
  });

  it("reclaims an expired cleanup lease with a higher durable attempt", async () => {
    const subject = fixture({ resumeState: "running" });

    await subject.service.collect(subject.vaultId);

    const acquired = subject.commitReplicaMutation.mock.calls[0]?.[0].mutableItems?.[0];
    expect(decodeReplicaGarbageCollectionJob(required(acquired).bytes)).toMatchObject({
      state: 2,
      attempt: 2,
    });
  });

  it("retains an Epoch needed by compact state discovered after the Job's compact commit", async () => {
    const subject = fixture({
      resumeState: "running",
      resumeWithPendingCompactState: true,
    });

    await subject.service.collect(subject.vaultId);

    const finalize = subject.commitReplicaMutation.mock.calls[1]?.[0];
    expect(finalize?.deletedItems).not.toContainEqual({
      namespace: NAMESPACES.epochSecret.key,
      scopeKey: identifierStorageKey(subject.vaultId),
      itemKey: identifierStorageKey(filled("KeyEpoch", 18)),
    });
    expect(finalize?.deletedItems).not.toContainEqual({
      namespace: NAMESPACES.epochSecret.key,
      scopeKey: identifierStorageKey(subject.vaultId),
      itemKey: identifierStorageKey(filled("KeyEpoch", 20)),
    });
  });

  it("does not duplicate physical cleanup while another lease remains live", async () => {
    const subject = fixture({ resumeState: "running", nowMs: 1_785_658_340_000 });

    await expect(subject.service.collect(subject.vaultId)).rejects.toMatchObject({
      id: "GARBAGE_COLLECTION_BUSY",
    });
    expect(subject.commitReplicaMutation).not.toHaveBeenCalled();
    expect(subject.remove).not.toHaveBeenCalled();
  });
});

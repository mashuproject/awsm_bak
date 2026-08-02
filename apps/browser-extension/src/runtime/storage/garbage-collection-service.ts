import type { Identifier } from "../../domain/canonical/identifiers";
import { decodeVaultObject, type VaultObject } from "../../domain/canonical/object";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import type { CanonicalReplayService } from "../projection/canonical-replay";
import {
  type CanonicalReplicaState,
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import {
  loadReplicaGarbageCollectionInventory,
  type ReplicaGarbageCollectionInventory,
} from "./garbage-collection-inventory";
import {
  decodeReplicaGarbageCollectionJob,
  encodeReplicaGarbageCollectionJob,
  type ReplicaGarbageCollectionJob,
  replicaGarbageCollectionIdempotencyKey,
} from "./garbage-collection-job";
import {
  type GarbageCollectionCompactItem,
  planReplicaGarbageCollection,
} from "./garbage-collection-plan";
import {
  collectReplicaGarbageCollectionReachability,
  type ReplicaGarbageCollectionReachabilityInput,
} from "./garbage-collection-reachability";

type VaultRecord = AuthenticatedVaultEvent | VaultBaseline;

type CollectReachability = (
  input: ReplicaGarbageCollectionReachabilityInput,
) => ReturnType<typeof collectReplicaGarbageCollectionReachability>;

interface CanonicalReplicaGarbageCollectionDependencies {
  readonly replays: CanonicalReplayService;
  readonly artifacts: Pick<CanonicalArtifactStore, "remove">;
  readonly collectReachability?: CollectReachability;
  readonly loadInventory?: typeof loadReplicaGarbageCollectionInventory;
  readonly randomUuid?: () => string;
  readonly now?: () => number;
  readonly wrapReplicaState?: (
    state: CanonicalReplicaState,
    vault: Awaited<ReturnType<CanonicalReplayService["replay"]>>["vault"],
  ) => Promise<{
    readonly namespace: typeof NAMESPACES.replicaState.key;
    readonly scopeKey: string;
    readonly itemKey: string;
    readonly bytes: Uint8Array;
  }>;
}

export interface CanonicalReplicaGarbageCollectionOutcome {
  readonly removedCompactItemCount: number;
  readonly removedResolutionCount: number;
  readonly removedEpochSecretCount: number;
  readonly removedArtifactCount: number;
  readonly removedArtifactStorageItemIds: readonly Identifier<"StorageItem">[];
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function decodeRecord(bytes: Uint8Array): VaultRecord {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Garbage Collection Record is not a map");
  if (value.get(6) === 1) return decodeVaultEvent(bytes);
  if (value.get(6) === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Garbage Collection Record kind is unsupported");
}

function compactNamespace(kind: GarbageCollectionCompactItem["kind"]) {
  switch (kind) {
    case 1:
      return NAMESPACES.vaultRecord.key;
    case 2:
      return NAMESPACES.keyEnvelope.key;
    case 3:
      return NAMESPACES.vaultObject.key;
    case 4:
      return NAMESPACES.featureManifest.key;
  }
}

export class CanonicalReplicaGarbageCollectionService {
  private readonly collectReachability: CollectReachability;
  private readonly loadInventory: typeof loadReplicaGarbageCollectionInventory;
  private readonly randomUuid: () => string;
  private readonly now: () => number;
  private readonly leaseDurationMs = 30_000;

  constructor(private readonly dependencies: CanonicalReplicaGarbageCollectionDependencies) {
    this.collectReachability =
      dependencies.collectReachability ?? collectReplicaGarbageCollectionReachability;
    this.loadInventory = dependencies.loadInventory ?? loadReplicaGarbageCollectionInventory;
    this.randomUuid = dependencies.randomUuid ?? (() => crypto.randomUUID());
    this.now = dependencies.now ?? (() => Date.now());
  }

  async collect(vaultId: Identifier<"Vault">): Promise<CanonicalReplicaGarbageCollectionOutcome> {
    const replay = await this.dependencies.replays.replay(vaultId);
    const { vault } = replay;
    same(vault.replicaState.vaultId, vaultId, "Garbage Collection Vault ID");
    if (vault.replicaState.garbageCollectionFences.length > 0) {
      return this.resumeCleanup(vaultId, vault);
    }
    const terminalJobs = await this.loadTerminalJobs(vaultId);

    const reachability = await this.collectReachability(
      this.reachabilityInput(vaultId, replay.vault),
    );
    const inventory: ReplicaGarbageCollectionInventory = await this.loadInventory(
      this.dependencies.replays.vaults,
      vault,
    );
    const plan = planReplicaGarbageCollection({
      currentKeyEpochId: vault.replicaState.currentKeyEpochId,
      reachability,
      ...inventory,
    });
    const vaultKey = identifierStorageKey(vaultId);
    const deletedItems = [
      ...plan.deleteCompactItems.map((item) => ({
        namespace: compactNamespace(item.kind),
        scopeKey: vaultKey,
        itemKey: identifierStorageKey(item.logicalId as Identifier<"VaultRecord">),
      })),
      ...plan.deleteResolutions.map((resolution) => ({
        namespace: NAMESPACES.logicalResolution.key,
        scopeKey: vaultKey,
        itemKey: `${resolution.kind}:${identifierStorageKey(
          resolution.logicalId as Identifier<"VaultRecord">,
        )}`,
      })),
      ...plan.deleteEpochSecretIds.map((epochId) => ({
        namespace: NAMESPACES.epochSecret.key,
        scopeKey: vaultKey,
        itemKey: identifierStorageKey(epochId),
      })),
    ];
    const cleanupJob = this.cleanupJob(vaultId, plan);
    const nextReplicaState =
      cleanupJob === null
        ? {
            namespace: NAMESPACES.replicaState.key,
            scopeKey: vaultKey,
            itemKey: "current",
            bytes: vault.replicaStateStorageBytes,
          }
        : await this.wrapReplicaState(
            {
              ...vault.replicaState,
              garbageCollectionFences: plan.artifactCleanupCandidates.map(
                ({ artifactId, storageItemId }) => ({ artifactId, storageItemId }),
              ),
            },
            vault,
          );
    const cleanupJobBytes =
      cleanupJob === null ? undefined : encodeReplicaGarbageCollectionJob(cleanupJob);
    if (cleanupJob !== null && terminalJobs.some(({ item }) => item.itemKey === cleanupJob.jobId)) {
      throw new TypeError("Garbage Collection Job identity collides with retained state");
    }
    const priorTerminalJobs = cleanupJob === null ? [] : terminalJobs;
    if (deletedItems.length > 0 || cleanupJob !== null) {
      await this.dependencies.replays.vaults.storage.commitReplicaMutation({
        realm: this.dependencies.replays.vaults.realm,
        expectedReplicaState: vault.replicaStateStorageBytes,
        nextReplicaState,
        expectedMutableItems: priorTerminalJobs.map(({ item, bytes }) => ({ ...item, bytes })),
        mutableItems:
          cleanupJob === null
            ? []
            : [
                {
                  namespace: NAMESPACES.replicaGarbageCollectionJob.key,
                  scopeKey: vaultKey,
                  itemKey: cleanupJob.jobId,
                  bytes: cleanupJobBytes as Uint8Array,
                },
              ],
        deletedItems: [...deletedItems, ...priorTerminalJobs.map(({ item }) => item)],
      });
    }
    if (cleanupJob !== null && cleanupJobBytes !== undefined) {
      return this.runCleanup(
        vaultId,
        {
          ...vault,
          replicaState: {
            ...vault.replicaState,
            garbageCollectionFences: plan.artifactCleanupCandidates.map(
              ({ artifactId, storageItemId }) => ({ artifactId, storageItemId }),
            ),
          },
          replicaStateStorageBytes: nextReplicaState.bytes,
        },
        cleanupJob,
        cleanupJobBytes,
        inventory,
        plan,
        plan.deleteResolutions,
        plan.deleteEpochSecretIds,
      );
    }
    return {
      removedCompactItemCount: plan.deleteCompactItems.length,
      removedResolutionCount: plan.deleteResolutions.length,
      removedEpochSecretCount: plan.deleteEpochSecretIds.length,
      removedArtifactCount: 0,
      removedArtifactStorageItemIds: [],
    };
  }

  private async resumeCleanup(
    vaultId: Identifier<"Vault">,
    vault: Awaited<ReturnType<CanonicalReplayService["replay"]>>["vault"],
  ): Promise<CanonicalReplicaGarbageCollectionOutcome> {
    const vaultKey = identifierStorageKey(vaultId);
    const storedJobs = await this.dependencies.replays.vaults.storage.listBytes(
      this.dependencies.replays.vaults.realm,
      NAMESPACES.replicaGarbageCollectionJob.key,
      vaultKey,
    );
    const decodedJobs = storedJobs.map((storedJob) => {
      const job = decodeReplicaGarbageCollectionJob(storedJob.bytes);
      same(job.vaultId, vaultId, "Garbage Collection Job Vault ID");
      if (storedJob.itemKey !== job.jobId) {
        throw new TypeError("Garbage Collection Job storage identity does not match");
      }
      return { storedJob, job };
    });
    const activeJobs = decodedJobs.filter(({ job }) => job.state !== 3);
    if (activeJobs.length !== 1 || decodedJobs.length !== 1) {
      throw Object.assign(
        new Error("Garbage Collection fences do not have one resumable local Job."),
        { id: "GARBAGE_COLLECTION_FENCED" },
      );
    }
    const activeJob = activeJobs[0];
    if (activeJob === undefined) throw new TypeError("Garbage Collection Job inventory changed");
    const { storedJob, job } = activeJob;
    const reachability = await this.collectReachability(this.reachabilityInput(vaultId, vault));
    const inventory = await this.loadInventory(this.dependencies.replays.vaults, vault);
    const plan = planReplicaGarbageCollection({
      currentKeyEpochId: vault.replicaState.currentKeyEpochId,
      reachability,
      ...inventory,
    });
    return this.runCleanup(vaultId, vault, job, storedJob.bytes, inventory, plan, [], []);
  }

  private async runCleanup(
    vaultId: Identifier<"Vault">,
    vault: Awaited<ReturnType<CanonicalReplayService["replay"]>>["vault"],
    job: ReplicaGarbageCollectionJob,
    jobBytes: Uint8Array,
    inventory: ReplicaGarbageCollectionInventory,
    plan: ReturnType<typeof planReplicaGarbageCollection>,
    alreadyRemovedResolutions: ReplicaGarbageCollectionInventory["resolutions"],
    alreadyRemovedEpochSecretIds: readonly Identifier<"KeyEpoch">[],
  ): Promise<CanonicalReplicaGarbageCollectionOutcome> {
    const vaultKey = identifierStorageKey(vaultId);
    const physicalIds = [
      ...new Map(
        job.candidates.map(({ storageItemId }) => [key(storageItemId), storageItemId]),
      ).values(),
    ].toSorted((left, right) => key(left).localeCompare(key(right)));
    const fenceKey = (value: {
      readonly artifactId: Uint8Array;
      readonly storageItemId: Uint8Array;
    }) => `${key(value.artifactId)}:${key(value.storageItemId)}`;
    const fenceKeys = vault.replicaState.garbageCollectionFences.map(fenceKey).toSorted();
    const candidateFenceKeys = job.candidates.map(fenceKey).toSorted();
    if (
      fenceKeys.length !== candidateFenceKeys.length ||
      fenceKeys.some((fence, index) => fence !== candidateFenceKeys[index])
    ) {
      throw Object.assign(new Error("Garbage Collection Job candidates do not match its fences."), {
        id: "GARBAGE_COLLECTION_FENCED",
      });
    }
    const plannedCandidates = new Map(
      plan.artifactCleanupCandidates.map((candidate) => [key(candidate.artifactId), candidate]),
    );
    for (const candidate of job.candidates) {
      const planned = plannedCandidates.get(key(candidate.artifactId));
      if (
        planned === undefined ||
        !bytesEqual(planned.storageItemId, candidate.storageItemId) ||
        !bytesEqual(planned.keyEpochId, candidate.keyEpochId)
      ) {
        throw Object.assign(
          new Error("Garbage Collection cleanup identity is no longer unreachable."),
          { id: "GARBAGE_COLLECTION_CONTEXT_CHANGED" },
        );
      }
    }
    const now = this.now();
    if (job.state === 2 && job.lease !== null && job.lease.expiresAtMs > now) {
      throw Object.assign(new Error("Replica Garbage Collection is already running."), {
        id: "GARBAGE_COLLECTION_BUSY",
      });
    }
    const runningJob: ReplicaGarbageCollectionJob = {
      ...job,
      state: 2,
      attempt: job.attempt + 1,
      lease: { ownerId: this.randomUuid(), expiresAtMs: now + this.leaseDurationMs },
      terminalOutcome: null,
    };
    const runningJobBytes = encodeReplicaGarbageCollectionJob(runningJob);
    const replicaItem = {
      namespace: NAMESPACES.replicaState.key,
      scopeKey: vaultKey,
      itemKey: "current",
      bytes: vault.replicaStateStorageBytes,
    } as const;
    const jobItem = {
      namespace: NAMESPACES.replicaGarbageCollectionJob.key,
      scopeKey: vaultKey,
      itemKey: job.jobId,
    } as const;
    await this.dependencies.replays.vaults.storage.commitReplicaMutation({
      realm: this.dependencies.replays.vaults.realm,
      expectedReplicaState: vault.replicaStateStorageBytes,
      expectedMutableItems: [{ ...jobItem, bytes: jobBytes }],
      nextReplicaState: replicaItem,
      mutableItems: [{ ...jobItem, bytes: runningJobBytes }],
    });
    for (const storageItemId of physicalIds)
      await this.dependencies.artifacts.remove(storageItemId);

    const candidateArtifactKeys = new Set(job.candidates.map(({ artifactId }) => key(artifactId)));
    const compactResolutionKeys = new Set(
      alreadyRemovedResolutions.map(({ kind, logicalId }) => `${kind}:${key(logicalId)}`),
    );
    const retainedEpochKeys = new Set<string>([key(vault.replicaState.currentKeyEpochId)]);
    for (const resolution of inventory.resolutions) {
      if (
        compactResolutionKeys.has(`${resolution.kind}:${key(resolution.logicalId)}`) ||
        (resolution.kind === 5 && candidateArtifactKeys.has(key(resolution.logicalId)))
      ) {
        continue;
      }
      retainedEpochKeys.add(key(resolution.keyEpochId));
    }
    const candidateEpochKeys = new Set(job.candidates.map(({ keyEpochId }) => key(keyEpochId)));
    const alreadyDeletedEpochKeys = new Set(alreadyRemovedEpochSecretIds.map(key));
    const finalEpochSecretIds = inventory.epochSecretIds.filter(
      (epochId) =>
        candidateEpochKeys.has(key(epochId)) &&
        !retainedEpochKeys.has(key(epochId)) &&
        !alreadyDeletedEpochKeys.has(key(epochId)),
    );
    const finalReplicaState = await this.wrapReplicaState(
      { ...vault.replicaState, garbageCollectionFences: [] },
      vault,
    );
    const terminalOutcome = {
      removedCompactItemCount: job.compactOutcome.removedCompactItemCount,
      removedResolutionCount: job.compactOutcome.removedResolutionCount + job.candidates.length,
      removedEpochSecretCount:
        job.compactOutcome.removedEpochSecretCount + finalEpochSecretIds.length,
      removedArtifactCount: physicalIds.length,
    };
    const succeededJob: ReplicaGarbageCollectionJob = {
      ...runningJob,
      state: 3,
      lease: null,
      terminalOutcome,
    };
    await this.dependencies.replays.vaults.storage.commitReplicaMutation({
      realm: this.dependencies.replays.vaults.realm,
      expectedReplicaState: vault.replicaStateStorageBytes,
      expectedMutableItems: [{ ...jobItem, bytes: runningJobBytes }],
      nextReplicaState: finalReplicaState,
      mutableItems: [{ ...jobItem, bytes: encodeReplicaGarbageCollectionJob(succeededJob) }],
      deletedItems: [
        ...job.candidates.map(({ artifactId }) => ({
          namespace: NAMESPACES.logicalResolution.key,
          scopeKey: vaultKey,
          itemKey: `5:${identifierStorageKey(artifactId)}`,
        })),
        ...finalEpochSecretIds.map((epochId) => ({
          namespace: NAMESPACES.epochSecret.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(epochId),
        })),
      ],
    });
    return {
      ...terminalOutcome,
      removedArtifactStorageItemIds: physicalIds,
    };
  }

  private cleanupJob(
    vaultId: Identifier<"Vault">,
    plan: ReturnType<typeof planReplicaGarbageCollection>,
  ): ReplicaGarbageCollectionJob | null {
    if (plan.artifactCleanupCandidates.length === 0) return null;
    const createdAtMs = this.now();
    return {
      jobId: this.randomUuid(),
      vaultId,
      idempotencyKey: replicaGarbageCollectionIdempotencyKey(
        vaultId,
        plan.artifactCleanupCandidates,
      ),
      createdAtMs,
      state: 1,
      stage: 1,
      attempt: 0,
      lease: null,
      cancellationRequested: false,
      compactOutcome: {
        removedCompactItemCount: plan.deleteCompactItems.length,
        removedResolutionCount: plan.deleteResolutions.length,
        removedEpochSecretCount: plan.deleteEpochSecretIds.length,
      },
      terminalOutcome: null,
      candidates: plan.artifactCleanupCandidates,
    };
  }

  private async loadTerminalJobs(vaultId: Identifier<"Vault">): Promise<
    readonly {
      readonly item: {
        readonly namespace: typeof NAMESPACES.replicaGarbageCollectionJob.key;
        readonly scopeKey: string;
        readonly itemKey: string;
      };
      readonly bytes: Uint8Array;
    }[]
  > {
    const vaultKey = identifierStorageKey(vaultId);
    const storedJobs = await this.dependencies.replays.vaults.storage.listBytes(
      this.dependencies.replays.vaults.realm,
      NAMESPACES.replicaGarbageCollectionJob.key,
      vaultKey,
    );
    const jobs = storedJobs.map((storedJob) => {
      const job = decodeReplicaGarbageCollectionJob(storedJob.bytes);
      same(job.vaultId, vaultId, "Garbage Collection Job Vault ID");
      if (storedJob.itemKey !== job.jobId) {
        throw new TypeError("Garbage Collection Job storage identity does not match");
      }
      if (job.state !== 3) {
        throw Object.assign(
          new Error("Garbage Collection has an active Job without its safety fences."),
          { id: "GARBAGE_COLLECTION_FENCED" },
        );
      }
      return {
        item: {
          namespace: NAMESPACES.replicaGarbageCollectionJob.key,
          scopeKey: vaultKey,
          itemKey: job.jobId,
        },
        bytes: storedJob.bytes,
      };
    });
    if (jobs.length > 1) {
      throw Object.assign(
        new Error("Garbage Collection has multiple terminal Jobs for one Vault."),
        { id: "GARBAGE_COLLECTION_FENCED" },
      );
    }
    return jobs;
  }

  private async wrapReplicaState(
    state: CanonicalReplicaState,
    vault: Awaited<ReturnType<CanonicalReplayService["replay"]>>["vault"],
  ) {
    if (this.dependencies.wrapReplicaState !== undefined) {
      return this.dependencies.wrapReplicaState(state, vault);
    }
    return prepareWrappedLocalStateItem({
      namespace: NAMESPACES.replicaState.key,
      scopeKey: identifierStorageKey(state.vaultId),
      itemKey: "current",
      wrappingKey: vault.installationWrappingKey,
      domain: "awsm.local.replica-state",
      context: canonicalLocalStorageContext(state.vaultId, state.generationId),
      bytes: encodeCanonicalReplicaState(state),
    });
  }

  private reachabilityInput(
    vaultId: Identifier<"Vault">,
    vault: Awaited<ReturnType<CanonicalReplayService["replay"]>>["vault"],
  ): ReplicaGarbageCollectionReachabilityInput {
    const records = new Map<string, VaultRecord>();
    const objects = new Map<string, VaultObject>();
    const loadRecord = async (id: Identifier<"VaultRecord">): Promise<VaultRecord> => {
      const itemKey = key(id);
      const cached = records.get(itemKey);
      if (cached !== undefined) return cached;
      const opened = await this.dependencies.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 1,
        logicalId: id,
        namespace: NAMESPACES.vaultRecord.key,
        payloadType: 1,
      });
      const record = decodeRecord(opened.payloadBytes);
      same(record.recordId, id, "Garbage Collection Record ID");
      records.set(itemKey, record);
      return record;
    };
    const loadObject = async (id: Identifier<"VaultObject">): Promise<VaultObject> => {
      const itemKey = key(id);
      const cached = objects.get(itemKey);
      if (cached !== undefined) return cached;
      const opened = await this.dependencies.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 3,
        logicalId: id,
        namespace: NAMESPACES.vaultObject.key,
        payloadType: 2,
      });
      const object = decodeVaultObject(opened.payloadBytes);
      same(object.objectId, id, "Garbage Collection Object ID");
      objects.set(itemKey, object);
      return object;
    };
    return {
      vaultId,
      generationId: vault.replicaState.generationId,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      baselineId: vault.replicaState.baselineId,
      causalFrontier: vault.replicaState.causalFrontier,
      authorityFrontier: vault.replicaState.authorityFrontier,
      continuityRecordIds: vault.replicaState.continuityRecordIds,
      preservationRoots: vault.replicaState.preservationRoots,
      adopted: vault.replicaState.adoption !== null,
      loadRecord,
      loadObject,
      loadFeatureManifest: async (id) =>
        (
          await this.dependencies.replays.vaults.openResolvedCompactItem({
            vault,
            kind: 4,
            logicalId: id,
            namespace: NAMESPACES.featureManifest.key,
            payloadType: 3,
          })
        ).payloadBytes,
    };
  }
}

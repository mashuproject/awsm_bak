import type { VaultReplacementJobV1 } from "../../drivers/indexeddb/schema";
import type {
  AtomicVaultReplacementPromotion,
  VaultReplacementPromotionResult,
} from "../../drivers/indexeddb/workspace-repository";
import type { ArtifactStore } from "../artifact";

interface ReplacementPromotionWorkspace {
  commitVaultReplacement(
    input: AtomicVaultReplacementPromotion,
  ): Promise<VaultReplacementPromotionResult>;
}

interface ReplacementPromotionRepository {
  clearSensitive(job: VaultReplacementJobV1): Promise<void>;
  save(job: VaultReplacementJobV1, expectedUpdatedAt: string): Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

export class VaultReplacementLocalPromoter {
  constructor(
    private readonly workspace: ReplacementPromotionWorkspace,
    private readonly artifacts: Pick<ArtifactStore, "reconcile">,
    private readonly jobs: ReplacementPromotionRepository,
  ) {}

  async promote(input: AtomicVaultReplacementPromotion): Promise<VaultReplacementJobV1> {
    const promoted = await this.workspace.commitVaultReplacement(input);
    await this.finishLocalCleanup(promoted.job);
    return promoted.job;
  }

  async finishLocalCleanup(job: VaultReplacementJobV1): Promise<void> {
    if (job.stage !== "PurgeSource" || job.purgeId === undefined)
      throw integrity("Replacement source cleanup is not authorized.");
    await this.artifacts.reconcile(job.sourceVaultId, new Set());
    await this.jobs.clearSensitive(job);
  }

  async finishServerPurge(
    job: VaultReplacementJobV1,
    completedAt: string,
  ): Promise<VaultReplacementJobV1> {
    if (job.state !== "Running" || job.stage !== "PurgeSource" || job.purgeId === undefined)
      throw integrity("Replacement purge completion is not authorized.");
    const completed: VaultReplacementJobV1 = {
      ...job,
      state: "Succeeded",
      stage: "Terminal",
      updatedAt: completedAt,
      completedItems: job.totalItems,
      processedBytes: job.totalBytes,
    };
    await this.jobs.save(completed, job.updatedAt);
    return completed;
  }
}

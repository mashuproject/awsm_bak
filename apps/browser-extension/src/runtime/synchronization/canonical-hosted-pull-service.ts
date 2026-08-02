import { wipe } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import type { AuthenticatedVaultEvent } from "../../domain/canonical/record";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { CanonicalReplayService } from "../projection/canonical-replay";
import type { CanonicalVaultService } from "../vault/canonical-service";
import { CanonicalHostedReplicaHttp } from "./canonical-host-http";
import type { CanonicalPulledCompactCandidate } from "./canonical-pull-candidate";
import { CanonicalPullContentPromotionService } from "./canonical-pull-content-promotion";
import {
  type CanonicalPullContentValidation,
  CanonicalPullContentValidationService,
} from "./canonical-pull-content-validation";
import { CanonicalPullInventoryRunner } from "./canonical-pull-inventory-runner";
import { nextCanonicalPullRetry, resumeCanonicalPullRetry } from "./canonical-pull-retry";
import type { CanonicalPullSynchronizationJobService } from "./canonical-pull-synchronization-job-service";
import { CanonicalPullValidationRunner } from "./canonical-pull-validation-runner";
import type { CanonicalReplicaRemoteService } from "./canonical-remote-service";
import type { CanonicalPullSynchronizationJob } from "./canonical-state";

type PullJobPort = Pick<
  CanonicalPullSynchronizationJobService,
  | "checkpoint"
  | "completeValidation"
  | "create"
  | "findActive"
  | "promoteValidated"
  | "readQuarantine"
  | "recordQuarantine"
>;

type VaultPort = Pick<
  CanonicalVaultService,
  | "hasVerifiedCompactStorageItem"
  | "hasVerifiedCompactLogicalItem"
  | "listEpochSecrets"
  | "openResolvedCompactItem"
  | "openVault"
  | "readResolvedOpaqueItem"
>;

function retryableHostDelay(error: unknown): number | null | undefined {
  if (typeof error !== "object" || error === null || !("retryable" in error)) return undefined;
  if (error.retryable !== true) return undefined;
  if (!("retryAfterSeconds" in error) || error.retryAfterSeconds === null) return null;
  if (
    typeof error.retryAfterSeconds !== "number" ||
    !Number.isSafeInteger(error.retryAfterSeconds) ||
    error.retryAfterSeconds < 0 ||
    error.retryAfterSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    throw new TypeError("Retryable Replica Host failure has an invalid retry delay");
  }
  return error.retryAfterSeconds * 1_000;
}

function contentBranchRoots(
  candidates: readonly CanonicalPulledCompactCandidate[],
): readonly Identifier<"VaultRecord">[] {
  type ContentCandidate = Extract<
    CanonicalPulledCompactCandidate,
    { readonly kind: "VaultRecord" }
  > & { readonly record: AuthenticatedVaultEvent };
  const records = candidates.filter(
    (candidate): candidate is ContentCandidate =>
      candidate.kind === "VaultRecord" &&
      "family" in candidate.record &&
      candidate.record.family === 2,
  );
  const parents = new Set(
    records.flatMap(({ record }) => record.parentRecordIds.map(identifierStorageKey)),
  );
  const roots = records
    .map(({ logicalId }) => logicalId)
    .filter((recordId) => !parents.has(identifierStorageKey(recordId)));
  if (roots.length === 0 && records.length > 0) {
    throw new TypeError("Pulled Content candidates have no causal branch root");
  }
  return roots;
}

/** Runs one receiver-initiated pull for one local Vault/Hosted Replica channel. */
export class CanonicalHostedPullService {
  constructor(
    private readonly dependencies: {
      readonly remotes: Pick<CanonicalReplicaRemoteService, "load">;
      readonly vaults: VaultPort;
      readonly jobs: PullJobPort;
      readonly createHttp?: (input: {
        readonly endpoint: string;
        readonly bearerToken: string;
      }) => Pick<CanonicalHostedReplicaHttp, "inventory" | "item">;
      readonly now?: () => number;
      readonly random?: () => number;
    },
  ) {}

  async pull(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
    readonly force?: boolean;
  }): Promise<CanonicalPullSynchronizationJob> {
    const { remote, bearerToken } = await this.dependencies.remotes.load(input);
    if (!remote.enabled) throw new TypeError("Cannot pull from a disabled Replica Remote");
    if (remote.remoteId !== input.remoteId || !bytesEqual(remote.vaultId, input.vaultId)) {
      throw new TypeError("Configured Replica Remote does not match the requested Vault");
    }
    let job =
      (await this.dependencies.jobs.findActive(input)) ??
      (await this.dependencies.jobs.create({ vaultId: input.vaultId, remoteId: input.remoteId }));
    const nowMs = this.dependencies.now?.() ?? Date.now();
    const resumed = resumeCanonicalPullRetry({
      job,
      nowMs,
      force: input.force ?? false,
    });
    if (resumed !== job) {
      await this.dependencies.jobs.checkpoint({ previous: job, next: resumed });
      job = resumed;
    }
    if (job.state !== 1) return job;
    if (job.stage === 1) {
      const http =
        this.dependencies.createHttp?.({ endpoint: remote.endpoint, bearerToken }) ??
        new CanonicalHostedReplicaHttp({ endpoint: remote.endpoint, bearerToken });
      try {
        job = await new CanonicalPullInventoryRunner({
          inventory: http.inventory.bind(http),
          item: http.item.bind(http),
          checkpoint: this.dependencies.jobs.checkpoint.bind(this.dependencies.jobs),
          recordQuarantine: this.dependencies.jobs.recordQuarantine.bind(this.dependencies.jobs),
          hasStoredStorageItem: (storageItemId) =>
            this.dependencies.vaults.hasVerifiedCompactStorageItem({
              vaultId: input.vaultId,
              storageItemId,
            }),
        }).run({ remote, job });
      } catch (error) {
        const hostRetryAfterMs = retryableHostDelay(error);
        if (hostRetryAfterMs === undefined) throw error;
        const next = nextCanonicalPullRetry({
          previous: job,
          nowMs,
          random: this.dependencies.random ?? Math.random,
          hostRetryAfterMs,
        });
        await this.dependencies.jobs.checkpoint({ previous: job, next });
        return next;
      }
    }
    if (job.stage !== 2 || job.state !== 1) return job;

    const initialVault = await this.dependencies.vaults.openVault(input.vaultId);
    const epochSecrets = await this.dependencies.vaults.listEpochSecrets(initialVault);
    try {
      const validated = await new CanonicalPullValidationRunner({
        readQuarantine: this.dependencies.jobs.readQuarantine.bind(this.dependencies.jobs),
      }).run({ remote, job, epochSecrets });
      const rootRecordIds = contentBranchRoots(validated.candidates);
      if (rootRecordIds.length === 0) {
        return job.quarantineReferences.length === 0
          ? this.dependencies.jobs.completeValidation(job)
          : job;
      }
      let result = job;
      for (const rootRecordId of rootRecordIds) {
        const vault = await this.dependencies.vaults.openVault(input.vaultId);
        let contentValidation: CanonicalPullContentValidation;
        try {
          contentValidation = await new CanonicalPullContentValidationService(
            new CanonicalReplayService(this.dependencies.vaults as never),
            { readQuarantine: this.dependencies.jobs.readQuarantine.bind(this.dependencies.jobs) },
          ).validate({
            remoteId: remote.remoteId,
            vault,
            candidates: validated.candidates,
            rootRecordIds: [rootRecordId],
          });
        } catch (error) {
          if (error instanceof TypeError) continue;
          throw error;
        }
        if (contentValidation.acceptedCandidates.length === 0) continue;
        result = await new CanonicalPullContentPromotionService(this.dependencies.jobs).promote({
          vault,
          previous: result,
          validation: contentValidation,
          readQuarantine: this.dependencies.jobs.readQuarantine.bind(this.dependencies.jobs),
        });
        if (result.stage !== 2 || result.state !== 1) break;
      }
      return result;
    } finally {
      await Promise.all(epochSecrets.map(({ key }) => wipe(key)));
    }
  }
}

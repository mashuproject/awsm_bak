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
import { CanonicalPullContentValidationService } from "./canonical-pull-content-validation";
import { CanonicalPullInventoryRunner } from "./canonical-pull-inventory-runner";
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
    },
  ) {}

  async pull(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<CanonicalPullSynchronizationJob> {
    const { remote, bearerToken } = await this.dependencies.remotes.load(input);
    if (!remote.enabled) throw new TypeError("Cannot pull from a disabled Replica Remote");
    if (remote.remoteId !== input.remoteId || !bytesEqual(remote.vaultId, input.vaultId)) {
      throw new TypeError("Configured Replica Remote does not match the requested Vault");
    }
    let job =
      (await this.dependencies.jobs.findActive(input)) ??
      (await this.dependencies.jobs.create({ vaultId: input.vaultId, remoteId: input.remoteId }));
    if (job.stage === 1) {
      const http =
        this.dependencies.createHttp?.({ endpoint: remote.endpoint, bearerToken }) ??
        new CanonicalHostedReplicaHttp({ endpoint: remote.endpoint, bearerToken });
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
    }
    if (job.stage !== 2 || job.state !== 1) return job;

    const vault = await this.dependencies.vaults.openVault(input.vaultId);
    const epochSecrets = await this.dependencies.vaults.listEpochSecrets(vault);
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
      const contentValidation = await new CanonicalPullContentValidationService(
        new CanonicalReplayService(this.dependencies.vaults as never),
        { readQuarantine: this.dependencies.jobs.readQuarantine.bind(this.dependencies.jobs) },
      ).validate({
        remoteId: remote.remoteId,
        vault,
        candidates: validated.candidates,
        rootRecordIds,
      });
      if (contentValidation.acceptedCandidates.length === 0) return job;
      return new CanonicalPullContentPromotionService(this.dependencies.jobs).promote({
        vault,
        previous: job,
        validation: contentValidation,
        readQuarantine: this.dependencies.jobs.readQuarantine.bind(this.dependencies.jobs),
      });
    } finally {
      await Promise.all(epochSecrets.map(({ key }) => wipe(key)));
    }
  }
}

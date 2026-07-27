import { wipe } from "../../crypto/sodium";
import type {
  StoredAccountMetadataV1,
  VaultReplacementJobV1,
} from "../../drivers/indexeddb/schema";
import type { AtomicVaultReplacementPromotion } from "../../drivers/indexeddb/workspace-repository";
import type { PreparedVault } from "../vault/contracts";
import type { WorkspaceVaultNameCacheV1 } from "../vault/workspace-name-cache";
import type { InitialDeviceAuthority } from "./initial-attachment";
import {
  decodeVaultReplacementSensitiveCheckpoint,
  encodeVaultReplacementSensitiveCheckpoint,
  type VaultReplacementSensitiveCheckpointV1,
} from "./replacement-checkpoint";
import type { VaultReplacementLocalPromoter } from "./replacement-promotion";
import type {
  ReplacementCandidateAuthority,
  ReplacementRemoteGraph,
  ReplacementRemoteIdempotency,
  ReplacementSourceFence,
  StagedVaultReplacement,
  VaultReplacementRemote,
} from "./replacement-remote";
import type { VaultReplacementGraphUploader } from "./replacement-upload";

interface ReplacementRunnerRepository {
  openCheckpoint(job: VaultReplacementJobV1): Promise<Uint8Array | undefined>;
  save(job: VaultReplacementJobV1, expectedUpdatedAt: string): Promise<void>;
  sealCheckpoint(input: {
    readonly job: VaultReplacementJobV1;
    readonly targetVaultId: string;
    readonly plaintext: Uint8Array;
    readonly updatedAt: string;
  }): Promise<void>;
}

export interface RestartedReplacementGraph {
  readonly target: PreparedVault;
  readonly replacement: ReplacementRemoteGraph;
}

interface ReplacementRunnerLocal {
  hasStagedVaultReplacement(input: {
    readonly sourceVaultId: string;
    readonly targetVaultId: string;
    readonly jobId: string;
  }): Promise<boolean>;
  loadStagedGraph(
    job: VaultReplacementJobV1,
    rootKey: Uint8Array,
  ): Promise<RestartedReplacementGraph>;
  loadReplacementNameCache(
    job: VaultReplacementJobV1,
    rootKey: Uint8Array,
  ): Promise<WorkspaceVaultNameCacheV1>;
  loadReplacementAccessToken(job: VaultReplacementJobV1): Promise<string>;
}

interface ReplacementRunnerValidation {
  validateRemoteGraph(job: VaultReplacementJobV1, graph: RestartedReplacementGraph): Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

function sourceFence(job: VaultReplacementJobV1): ReplacementSourceFence {
  return {
    sourceVaultId: job.sourceVaultId,
    generationId: job.sourceHead.generationId,
    generationNumber: job.sourceHead.generationNumber,
    headCursor: job.sourceHeadCursor,
  };
}

function idempotency(job: VaultReplacementJobV1): ReplacementRemoteIdempotency {
  return {
    candidateIdempotencyKey: job.candidateIdempotencyKey,
    generationUploadCompleteIdempotencyKey: job.generationUploadCompleteIdempotencyKey,
    candidateCompleteIdempotencyKey: job.candidateCompleteIdempotencyKey,
    activationIdempotencyKey: job.activationIdempotencyKey,
  };
}

async function wipeCheckpoint(checkpoint: VaultReplacementSensitiveCheckpointV1): Promise<void> {
  await Promise.all([
    wipe(checkpoint.rootKey),
    wipe(checkpoint.deviceProofSignature),
    wipe(checkpoint.identity.signingSecretKey),
    wipe(checkpoint.identity.wrappingSecretKey),
  ]);
}

export class VaultReplacementRunner {
  constructor(
    private readonly jobs: ReplacementRunnerRepository,
    private readonly local: ReplacementRunnerLocal,
    private readonly remote: VaultReplacementRemote,
    private readonly uploader: VaultReplacementGraphUploader,
    private readonly validation: ReplacementRunnerValidation,
    private readonly promoter: VaultReplacementLocalPromoter,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(
    initialJob: VaultReplacementJobV1,
    account: StoredAccountMetadataV1,
  ): Promise<VaultReplacementJobV1> {
    if (initialJob.accountId !== account.accountId || account.scope !== "Account")
      throw integrity("Replacement Account authority changed.");
    let job = initialJob;
    if (job.state === "Succeeded" || job.state === "Failed" || job.state === "Aborted") return job;
    if (job.stage === "PurgeSource")
      return this.resumePurge(job, await this.local.loadReplacementAccessToken(job));
    const encoded = await this.jobs.openCheckpoint(job);
    if (encoded === undefined) throw integrity("Replacement authority checkpoint is unavailable.");
    let checkpoint: VaultReplacementSensitiveCheckpointV1 | undefined;
    try {
      checkpoint = decodeVaultReplacementSensitiveCheckpoint(encoded);
      this.assertAuthority(job, account, checkpoint);
      if (
        !(await this.local.hasStagedVaultReplacement({
          sourceVaultId: job.sourceVaultId,
          targetVaultId: checkpoint.targetVaultId,
          jobId: job.jobId,
        }))
      )
        throw integrity("Staged replacement Vault is unavailable.");

      if (job.stage === "StageRemote") {
        const graph = await this.local.loadStagedGraph(job, checkpoint.rootKey);
        if (checkpoint.session === undefined) {
          const authority: ReplacementCandidateAuthority = {
            account,
            target: graph.target,
            keyEpochActivatedAt: graph.target.records.metadata.createdAt,
            certificate: checkpoint.certificate,
            envelope: checkpoint.envelope,
            recoveryKit: checkpoint.recoveryKit,
            deviceProofSignature: checkpoint.deviceProofSignature,
          };
          const staged = await this.remote.stage({
            source: sourceFence(job),
            authority,
            replacement: graph.replacement,
            idempotency: idempotency(job),
          });
          await this.reseal(job, { ...checkpoint, session: staged.session });
          checkpoint = { ...checkpoint, session: staged.session };
        } else {
          this.remote.useSession(checkpoint.session);
        }
        job = await this.advance(job, "Upload");
      }

      if (job.stage === "Upload") {
        this.requireSession(checkpoint);
        this.remote.useSession(checkpoint.session);
        await this.uploader.run(job, this.now());
        job = await this.advance(job, "CompleteRemote");
      }

      if (job.stage === "CompleteRemote") {
        this.requireSession(checkpoint);
        this.remote.useSession(checkpoint.session);
        const graph = await this.local.loadStagedGraph(job, checkpoint.rootKey);
        await this.validation.validateRemoteGraph(job, graph);
        job = await this.advance(job, "ActivateRemote");
      }

      if (job.stage === "ActivateRemote") {
        this.requireSession(checkpoint);
        this.remote.useSession(checkpoint.session);
        const activated = await this.remote.activate(this.stagedAuthority(job, checkpoint));
        const activatedJob: VaultReplacementJobV1 = {
          ...job,
          stage: "PromoteLocal",
          updatedAt: this.now(),
          targetHeadCursor: activated.targetHeadCursor,
          purgeId: activated.purge.purgeId,
        };
        await this.jobs.save(activatedJob, job.updatedAt);
        job = activatedJob;
      }

      if (job.stage === "PromoteLocal") {
        this.requireSession(checkpoint);
        const authority = this.localAuthority(job, checkpoint);
        const nameCache = await this.local.loadReplacementNameCache(job, checkpoint.rootKey);
        job = await this.promoter.promote({
          job,
          authority,
          nameCache,
          promotedAt: this.now(),
        } satisfies AtomicVaultReplacementPromotion);
      }

      if (job.stage === "PurgeSource") {
        this.requireSession(checkpoint);
        job = await this.resumePurge(job, checkpoint.session.accessToken);
      }
      return job;
    } finally {
      await wipe(encoded);
      if (checkpoint !== undefined) await wipeCheckpoint(checkpoint);
    }
  }

  private assertAuthority(
    job: VaultReplacementJobV1,
    account: StoredAccountMetadataV1,
    checkpoint: VaultReplacementSensitiveCheckpointV1,
  ): void {
    if (
      job.targetVaultId !== checkpoint.targetVaultId ||
      job.targetRecoveryGenerationId !== checkpoint.recoveryGenerationId ||
      job.targetDeviceId !== checkpoint.identity.deviceId ||
      account.sessionId !== checkpoint.accountSessionId ||
      (checkpoint.session?.account.accountId !== undefined &&
        checkpoint.session.account.accountId !== job.accountId)
    )
      throw integrity("Replacement checkpoint differs from its Job.");
  }

  private requireSession(
    checkpoint: VaultReplacementSensitiveCheckpointV1,
  ): asserts checkpoint is VaultReplacementSensitiveCheckpointV1 & {
    readonly session: NonNullable<VaultReplacementSensitiveCheckpointV1["session"]>;
  } {
    if (checkpoint.session === undefined)
      throw integrity("Replacement Device session is unavailable.");
  }

  private async reseal(
    job: VaultReplacementJobV1,
    checkpoint: VaultReplacementSensitiveCheckpointV1,
  ): Promise<void> {
    const plaintext = encodeVaultReplacementSensitiveCheckpoint(checkpoint);
    try {
      await this.jobs.sealCheckpoint({
        job,
        targetVaultId: checkpoint.targetVaultId,
        plaintext,
        updatedAt: this.now(),
      });
    } finally {
      await wipe(plaintext);
    }
  }

  private async advance(
    job: VaultReplacementJobV1,
    stage: VaultReplacementJobV1["stage"],
  ): Promise<VaultReplacementJobV1> {
    const advanced = {
      ...job,
      state: "Running" as const,
      stage,
      updatedAt: this.now(),
    };
    await this.jobs.save(advanced, job.updatedAt);
    return advanced;
  }

  private stagedAuthority(
    job: VaultReplacementJobV1,
    checkpoint: VaultReplacementSensitiveCheckpointV1 & {
      readonly session: NonNullable<VaultReplacementSensitiveCheckpointV1["session"]>;
    },
  ): StagedVaultReplacement {
    if (
      job.targetVaultId === undefined ||
      job.targetGenerationId === undefined ||
      job.targetGenerationNumber === undefined
    )
      throw integrity("Replacement activation authority is incomplete.");
    return {
      source: sourceFence(job),
      targetVaultId: job.targetVaultId,
      targetGenerationId: job.targetGenerationId,
      targetGenerationNumber: job.targetGenerationNumber,
      session: checkpoint.session,
      idempotency: idempotency(job),
    };
  }

  private localAuthority(
    job: VaultReplacementJobV1,
    checkpoint: VaultReplacementSensitiveCheckpointV1 & {
      readonly session: NonNullable<VaultReplacementSensitiveCheckpointV1["session"]>;
    },
  ): InitialDeviceAuthority {
    if (
      job.targetVaultId === undefined ||
      job.targetGenerationId === undefined ||
      job.targetGenerationNumber === undefined ||
      job.targetHeadCursor === undefined
    )
      throw integrity("Replacement promotion authority is incomplete.");
    return {
      accountId: job.accountId,
      vaultId: job.targetVaultId,
      recoveryGenerationId: checkpoint.recoveryGenerationId,
      identity: checkpoint.identity,
      certificate: checkpoint.certificate,
      envelopes: [checkpoint.envelope],
      keyEpochs: [
        {
          keyEpochId: checkpoint.envelope.metadata.keyEpochId,
          ordinal: 0,
          rootKey: checkpoint.rootKey,
        },
      ],
      recoveryKit: checkpoint.recoveryKit,
      remoteGenerationId: job.targetGenerationId,
      remoteGenerationNumber: job.targetGenerationNumber,
      remoteHeadCursor: job.targetHeadCursor,
      session: checkpoint.session,
    };
  }

  private async resumePurge(
    job: VaultReplacementJobV1,
    accessToken: string,
  ): Promise<VaultReplacementJobV1> {
    if (job.purgeId === undefined || job.targetVaultId === undefined)
      throw integrity("Replacement purge authority is incomplete.");
    this.remote.useAccessToken(accessToken);
    const purge = await this.remote.purgeStatus(job.sourceVaultId, job.purgeId);
    if (purge.state !== "Succeeded") return job;
    if (purge.stage !== "Complete") throw integrity("Completed replacement purge is inconsistent.");
    return this.promoter.finishServerPurge(job, this.now());
  }
}

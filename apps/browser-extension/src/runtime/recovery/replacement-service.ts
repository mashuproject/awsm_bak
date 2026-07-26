import { wipe } from "../../crypto/sodium";
import type {
  ExportJobV1,
  StoredAccountMetadataV1,
  StoredEvent,
  StoredObjectV1,
  StoredVaultHeadV1,
  VaultReplacementJobV1,
} from "../../drivers/indexeddb/schema";
import type { AtomicVaultReplacementStage } from "../../drivers/indexeddb/workspace-repository";
import type { ArtifactStore } from "../artifact";
import type { VaultRecordsV1 } from "../vault/contracts";
import { verifyVaultGeneration } from "../vault/generation";
import type { VaultKeyring } from "../vault/keyring";
import { VaultService } from "../vault/service";
import {
  confirmReplacementPhrase,
  type PreparedReplacementAuthority,
  prepareReplacementAuthority,
  wipeReplacementAuthority,
} from "./replacement-authority";
import { encodeVaultReplacementSensitiveCheckpoint } from "./replacement-checkpoint";
import { assertReplacementExportGate } from "./replacement-gate";
import { type PreparedVaultReplacement, VaultReplacementRewriter } from "./replacement-rewrite";

interface ReplacementJobRepository {
  create(job: VaultReplacementJobV1): Promise<void>;
  find(jobId: string): Promise<VaultReplacementJobV1 | undefined>;
  save(job: VaultReplacementJobV1, expectedUpdatedAt: string): Promise<void>;
  sealCheckpoint(input: {
    readonly job: VaultReplacementJobV1;
    readonly targetVaultId: string;
    readonly plaintext: Uint8Array;
    readonly updatedAt: string;
  }): Promise<void>;
  clearSensitive(job: VaultReplacementJobV1): Promise<void>;
}

interface ReplacementWorkspace {
  stageVaultReplacement(input: AtomicVaultReplacementStage): Promise<void>;
  discardStagedVaultReplacement(job: VaultReplacementJobV1): Promise<void>;
}

export interface ReplacementSourceSnapshot {
  readonly records: VaultRecordsV1;
  readonly head: StoredVaultHeadV1;
  readonly headCursor: number;
  readonly keyring: VaultKeyring;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
}

interface PreparedInteractiveReplacement {
  readonly job: VaultReplacementJobV1;
  readonly authority: PreparedReplacementAuthority;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

function sameHead(left: StoredVaultHeadV1, right: StoredVaultHeadV1): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.generationId === right.generationId &&
    left.generationNumber === right.generationNumber &&
    left.appendedObjectIds.join("\n") === right.appendedObjectIds.join("\n") &&
    left.appendedEventIds.join("\n") === right.appendedEventIds.join("\n")
  );
}

export class VaultReplacementService {
  private readonly interactive = new Map<string, PreparedInteractiveReplacement>();

  constructor(
    private readonly jobs: ReplacementJobRepository,
    private readonly workspace: ReplacementWorkspace,
    private readonly artifacts: Pick<ArtifactStore, "openPlaintext" | "prepare" | "remove">,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async prepare(input: {
    readonly account: StoredAccountMetadataV1;
    readonly source: ReplacementSourceSnapshot;
    readonly latestExport: ExportJobV1 | undefined;
    readonly safelyStoredConfirmed: boolean;
    readonly vaultName: string;
    readonly displayName: string;
    readonly clientKind: "ChromeExtension" | "FirefoxExtension";
  }): Promise<{
    readonly replacementId: string;
    readonly recoveryPhrase: string;
    readonly recoveryFile: Uint8Array;
  }> {
    if (
      input.account.scope !== "Account" ||
      input.source.records.metadata.vaultId !== input.source.head.vaultId ||
      input.source.records.generation.generationId !== input.source.head.generationId ||
      input.source.records.generation.generationNumber !== input.source.head.generationNumber
    )
      throw integrity("Replacement source authority is inconsistent.");
    assertReplacementExportGate({
      vaultId: input.source.head.vaultId,
      currentHead: input.source.head,
      latestExport: input.latestExport,
      safelyStoredConfirmed: input.safelyStoredConfirmed,
    });
    if (input.latestExport === undefined)
      throw integrity("Replacement requires a verified Export.");
    const createdAt = this.now();
    const job: VaultReplacementJobV1 = {
      version: 1,
      jobId: this.randomUuid(),
      accountId: input.account.accountId,
      sourceVaultId: input.source.head.vaultId,
      sourceHead: input.source.head,
      sourceHeadCursor: input.source.headCursor,
      verifiedExportJobId: input.latestExport.jobId,
      safelyStoredConfirmed: true,
      candidateIdempotencyKey: this.randomUuid(),
      generationUploadCompleteIdempotencyKey: this.randomUuid(),
      candidateCompleteIdempotencyKey: this.randomUuid(),
      activationIdempotencyKey: this.randomUuid(),
      state: "Created",
      stage: "ExportGate",
      createdAt,
      updatedAt: createdAt,
      completedItems: 0,
      totalItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      retryCount: 0,
    };
    await this.jobs.create(job);
    let authority: PreparedReplacementAuthority | undefined;
    try {
      const target = await new VaultService({
        load: async () => undefined,
        setManualLock: async () => undefined,
      }).prepareCreate({
        name: input.vaultName,
        createdAt: this.now(),
      });
      const prepared = await prepareReplacementAuthority({
        account: input.account,
        target,
        displayName: input.displayName,
        clientKind: input.clientKind,
        randomUuid: this.randomUuid,
        now: this.now,
      });
      authority = prepared.prepared;
      const waiting: VaultReplacementJobV1 = {
        ...job,
        state: "WaitingForPhraseConfirmation",
        stage: "PrepareAuthority",
        updatedAt: this.now(),
        targetVaultId: target.records.metadata.vaultId,
        targetDeviceId: target.records.metadata.deviceId,
        targetRecoveryGenerationId: prepared.prepared.recoveryGenerationId,
        targetKeyEpochId: target.records.metadata.activeKeyEpochId,
        targetGenerationId: target.records.generation.generationId,
        targetGenerationNumber: target.records.generation.generationNumber,
      };
      await this.jobs.save(waiting, job.updatedAt);
      this.interactive.set(job.jobId, {
        job: waiting,
        authority: prepared.prepared,
      });
      return {
        replacementId: job.jobId,
        recoveryPhrase: prepared.phrase,
        recoveryFile: prepared.recoveryFile,
      };
    } catch (error) {
      if (authority !== undefined) await wipeReplacementAuthority(authority);
      const failed: VaultReplacementJobV1 = {
        ...job,
        state: "Failed",
        stage: "Terminal",
        updatedAt: this.now(),
        errorId:
          error instanceof Error && "id" in error
            ? String(error.id)
            : "SYNCHRONIZATION_INTEGRITY_FAILED",
      };
      await this.jobs.save(failed, job.updatedAt).catch(() => undefined);
      throw error;
    }
  }

  async confirmAndStage(input: {
    readonly replacementId: string;
    readonly recoveryPhrase: string;
    readonly source: ReplacementSourceSnapshot;
  }): Promise<VaultReplacementJobV1> {
    const interactive = this.interactive.get(input.replacementId);
    if (interactive === undefined)
      throw Object.assign(new Error("Restart replacement phrase preparation."), {
        id: "VAULT_REPLACEMENT_CONFLICT",
      });
    const { authority } = interactive;
    await confirmReplacementPhrase(authority, input.recoveryPhrase);
    let replacement: PreparedVaultReplacement | undefined;
    let stageJob: VaultReplacementJobV1 | undefined;
    let stagePersisted = false;
    let checkpointBytes: Uint8Array | undefined;
    try {
      if (
        !sameHead(interactive.job.sourceHead, input.source.head) ||
        input.source.headCursor !== interactive.job.sourceHeadCursor ||
        input.source.records.metadata.vaultId !== interactive.job.sourceVaultId
      )
        throw Object.assign(new Error("The source Vault changed during replacement."), {
          id: "VAULT_REPLACEMENT_CONFLICT",
        });
      const retained = await verifyVaultGeneration(
        input.source.keyring,
        input.source.head.vaultId,
        input.source.records.generation,
      );
      replacement = await new VaultReplacementRewriter(
        this.artifacts,
        this.randomUuid,
        this.now,
      ).prepare({
        sourceVaultId: input.source.head.vaultId,
        sourceDeviceId: input.source.records.metadata.deviceId,
        sourceHead: input.source.head,
        sourceRetainedEventIds: retained.retainedEventIds,
        sourceRetainedObjectIds: retained.retainedObjectIds,
        sourceKeyring: input.source.keyring,
        sourceEvents: input.source.events,
        sourceObjects: input.source.objects,
        targetVaultId: authority.target.records.metadata.vaultId,
        targetDeviceId: authority.target.records.metadata.deviceId,
        targetKeyring: authority.target.keyring,
      });
      stageJob = {
        ...interactive.job,
        state: "Running",
        stage: "StageRemote",
        updatedAt: this.now(),
        targetGenerationId: replacement.generation.generationId,
        targetGenerationNumber: replacement.generation.generationNumber,
        completedItems: 0,
        totalItems: replacement.objects.length + replacement.events.length,
        processedBytes: 0,
        totalBytes: [...replacement.objects, ...replacement.events].reduce(
          (total, record) =>
            total +
            ("envelopeBytes" in record
              ? record.envelopeBytes.byteLength
              : record.envelopeByteLength),
          0,
        ),
      };
      await this.jobs.save(stageJob, interactive.job.updatedAt);
      stagePersisted = true;
      await this.workspace.stageVaultReplacement({
        job: stageJob,
        records: {
          ...authority.target.records,
          generation: replacement.generation,
          head: replacement.head,
        },
        events: replacement.events,
        objects: replacement.objects,
        libraryProjections: replacement.projections.itemProjections,
        collectionProjection: replacement.projections.collectionProjection,
        vaultNameProjection: replacement.projections.vaultNameProjection,
        preparedArtifactObjectIds: replacement.preparedArtifactObjectIds,
      });
      checkpointBytes = encodeVaultReplacementSensitiveCheckpoint({
        version: 1,
        targetVaultId: authority.target.records.metadata.vaultId,
        recoveryGenerationId: authority.recoveryGenerationId,
        accountSessionId: authority.account.sessionId,
        deviceProofSignature: authority.deviceProofSignature,
        rootKey: authority.rootKey,
        identity: authority.identity,
        certificate: authority.certificate,
        envelope: authority.envelope,
        recoveryKit: authority.recoveryKit,
        identifierMappings: replacement.identifierMappings,
      });
      await this.jobs.sealCheckpoint({
        job: stageJob,
        targetVaultId: authority.target.records.metadata.vaultId,
        plaintext: checkpointBytes,
        updatedAt: this.now(),
      });
      return stageJob;
    } catch (error) {
      if (stageJob !== undefined && stagePersisted) {
        await this.workspace.discardStagedVaultReplacement(stageJob).catch(() => undefined);
      }
      const failedFrom = stageJob !== undefined && stagePersisted ? stageJob : interactive.job;
      await this.jobs
        .save(
          {
            ...failedFrom,
            state: "Failed",
            stage: "Terminal",
            updatedAt: this.now(),
            errorId:
              error instanceof Error && "id" in error
                ? String(error.id)
                : "SYNCHRONIZATION_INTEGRITY_FAILED",
          },
          failedFrom.updatedAt,
        )
        .catch(() => undefined);
      if (replacement !== undefined)
        await Promise.all(
          replacement.preparedArtifactObjectIds.map((objectId) =>
            this.artifacts.remove(authority.target.records.metadata.vaultId, objectId),
          ),
        );
      throw error;
    } finally {
      this.interactive.delete(input.replacementId);
      if (checkpointBytes !== undefined) await wipe(checkpointBytes);
      await wipeReplacementAuthority(authority);
    }
  }

  async cancel(replacementId: string): Promise<void> {
    const interactive = this.interactive.get(replacementId);
    const job = interactive?.job ?? (await this.jobs.find(replacementId));
    if (
      job === undefined ||
      job.state === "Succeeded" ||
      job.state === "Failed" ||
      job.state === "Aborted"
    )
      return;
    if (job.stage !== "PrepareAuthority")
      throw Object.assign(new Error("Running Vault replacement cannot be cancelled here."), {
        id: "VAULT_REPLACEMENT_CONFLICT",
      });
    this.interactive.delete(replacementId);
    const aborted: VaultReplacementJobV1 = {
      ...job,
      state: "Aborted",
      stage: "Terminal",
      updatedAt: this.now(),
    };
    await this.jobs.save(aborted, job.updatedAt);
    await this.jobs.clearSensitive(aborted);
    if (interactive !== undefined) await wipeReplacementAuthority(interactive.authority);
  }
}

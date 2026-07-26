import type {
  StoredEvent,
  StoredObjectV1,
  SynchronizationCheckpointV1,
  SynchronizationJobV1,
  VaultReplacementJobV1,
} from "../../drivers/indexeddb/schema";
import type { ArtifactStore } from "../artifact";
import { UploadRunner } from "../synchronization/upload";

interface ReplacementUploadRepository {
  synchronizationCheckpoint(
    vaultId: string,
    kind: "Object" | "Event",
    entityId: string,
  ): Promise<SynchronizationCheckpointV1 | undefined>;
  saveSynchronizationCheckpoint(checkpoint: SynchronizationCheckpointV1): Promise<void>;
}

interface ReplacementUploadSource {
  getVaultHead(): Promise<
    | {
        readonly appendedObjectIds: readonly string[];
        readonly appendedEventIds: readonly string[];
      }
    | undefined
  >;
  listStoredObjects(): Promise<readonly StoredObjectV1[]>;
  listStoredEvents(): Promise<readonly StoredEvent[]>;
}

interface ReplacementUploadTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

function syntheticSynchronizationJob(job: VaultReplacementJobV1): SynchronizationJobV1 & {
  readonly vaultId: string;
  readonly generationId: string;
  readonly generationNumber: number;
} {
  if (
    job.state !== "Running" ||
    job.stage !== "Upload" ||
    job.targetVaultId === undefined ||
    job.targetGenerationId === undefined ||
    job.targetGenerationNumber === undefined
  )
    throw integrity("Replacement upload authority is incomplete.");
  return {
    version: 1,
    jobId: job.jobId,
    accountId: job.accountId,
    vaultId: job.targetVaultId,
    generationId: job.targetGenerationId,
    generationNumber: job.targetGenerationNumber,
    state: "Running",
    stage: "UploadObjects",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    snapshotCursor: 0,
    completedItems: job.completedItems,
    totalItems: job.totalItems,
    processedBytes: job.processedBytes,
    totalBytes: job.totalBytes,
    retryCount: job.retryCount,
    attachIdempotencyKey: job.jobId,
  };
}

export class VaultReplacementGraphUploader {
  constructor(
    private readonly checkpoints: ReplacementUploadRepository,
    private readonly source: ReplacementUploadSource,
    private readonly artifacts: Pick<ArtifactStore, "openEncrypted">,
    private readonly transport: ReplacementUploadTransport,
    private readonly beforeEventCommits?: () => Promise<void>,
  ) {}

  async run(replacementJob: VaultReplacementJobV1, now = new Date().toISOString()): Promise<void> {
    const job = syntheticSynchronizationJob(replacementJob);
    const state = {
      latestSynchronizationJob: async () => job,
      saveSynchronizationJob: async (_progress: SynchronizationJobV1): Promise<void> => undefined,
      synchronizationCheckpoint: (vaultId: string, kind: "Object" | "Event", entityId: string) =>
        this.checkpoints.synchronizationCheckpoint(vaultId, kind, entityId),
      saveSynchronizationCheckpoint: (checkpoint: SynchronizationCheckpointV1) =>
        this.checkpoints.saveSynchronizationCheckpoint(checkpoint),
    };
    await new UploadRunner(
      state,
      this.source,
      this.artifacts,
      this.transport,
      this.beforeEventCommits,
    ).run(now);

    const head = await this.source.getVaultHead();
    if (head === undefined) throw integrity("Replacement head is unavailable.");
    const checkpoints = await Promise.all([
      ...head.appendedObjectIds.map((objectId) =>
        this.checkpoints.synchronizationCheckpoint(job.vaultId, "Object", objectId),
      ),
      ...head.appendedEventIds.map((eventId) =>
        this.checkpoints.synchronizationCheckpoint(job.vaultId, "Event", eventId),
      ),
    ]);
    if (
      checkpoints.some((checkpoint, index) =>
        index < head.appendedObjectIds.length
          ? checkpoint?.state !== "Durable"
          : checkpoint?.state !== "Committed",
      )
    )
      throw integrity("Replacement graph is not durably committed.");
  }
}

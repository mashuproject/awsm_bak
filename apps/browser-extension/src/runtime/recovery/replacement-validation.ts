import type { SynchronizationJobV1, VaultReplacementJobV1 } from "../../drivers/indexeddb/schema";
import { RemoteReplicaDownloader } from "../synchronization/download";
import type { RestartedReplacementGraph } from "./replacement-runner";

interface ReplacementValidationTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  getTransfer(url: string, expectedByteLength: number): Promise<ReadableStream<Uint8Array>>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.join("\n") === right.join("\n");
}

export class VaultReplacementRemoteValidator {
  constructor(private readonly transport: ReplacementValidationTransport) {}

  async validateRemoteGraph(
    job: VaultReplacementJobV1,
    graph: RestartedReplacementGraph,
  ): Promise<void> {
    if (
      job.state !== "Running" ||
      job.stage !== "CompleteRemote" ||
      job.targetVaultId === undefined ||
      job.targetGenerationId === undefined ||
      job.targetGenerationNumber === undefined
    )
      throw integrity("Replacement validation authority is incomplete.");
    const downloadJob: SynchronizationJobV1 = {
      version: 1,
      jobId: job.jobId,
      accountId: job.accountId,
      vaultId: job.targetVaultId,
      generationId: job.targetGenerationId,
      generationNumber: job.targetGenerationNumber,
      state: "Running",
      stage: "DownloadRecords",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      snapshotCursor: 0,
      completedItems: 0,
      totalItems: job.totalItems,
      processedBytes: 0,
      totalBytes: job.totalBytes,
      retryCount: job.retryCount,
      attachIdempotencyKey: job.jobId,
    };
    const remote = await new RemoteReplicaDownloader(this.transport, {
      prepareEncrypted: async () => {
        throw integrity("Replacement server contains an unexpected Artifact.");
      },
    }).prepare(downloadJob, graph.target.keyring, {
      generation: graph.replacement.generation,
      events: graph.replacement.events,
      objects: graph.replacement.objects,
    });
    if (
      remote.generation.generationId !== graph.replacement.generation.generationId ||
      remote.generation.generationNumber !== graph.replacement.generation.generationNumber ||
      remote.head.vaultId !== graph.replacement.head.vaultId ||
      !sameIds(remote.head.appendedObjectIds, graph.replacement.head.appendedObjectIds) ||
      !sameIds(remote.head.appendedEventIds, graph.replacement.head.appendedEventIds) ||
      remote.objects.length !== graph.replacement.objects.length ||
      remote.events.length !== graph.replacement.events.length
    )
      throw integrity("Replacement server graph differs from local authority.");
  }
}

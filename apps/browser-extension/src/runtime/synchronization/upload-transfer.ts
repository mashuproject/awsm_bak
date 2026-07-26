import type {
  SynchronizationCheckpointV1,
  SynchronizationJobV1,
} from "../../drivers/indexeddb/schema";

interface UploadStateRepository {
  synchronizationCheckpoint(
    vaultId: string,
    kind: "Object" | "Event",
    entityId: string,
  ): Promise<SynchronizationCheckpointV1 | undefined>;
  saveSynchronizationCheckpoint(checkpoint: SynchronizationCheckpointV1): Promise<void>;
}

interface UploadTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Object.assign(new Error("Synchronization response is invalid"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  return value as Record<string, unknown>;
}

async function readPart(
  iterator: AsyncIterator<Uint8Array>,
  pending: Uint8Array,
  partSize: number,
): Promise<{ readonly bytes: Uint8Array; readonly pending: Uint8Array; readonly done: boolean }> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let remainder = pending;
  while (length < partSize) {
    if (remainder.byteLength === 0) {
      const next = await iterator.next();
      if (next.done) break;
      remainder = next.value;
    }
    const take = Math.min(partSize - length, remainder.byteLength);
    chunks.push(remainder.subarray(0, take));
    length += take;
    remainder = remainder.subarray(take);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, pending: remainder, done: length === 0 };
}

export class UploadTransfer {
  constructor(
    private readonly state: UploadStateRepository,
    private readonly transport: UploadTransport,
    private readonly afterUploadPart?: () => Promise<void>,
  ) {}

  async upload(
    job: SynchronizationJobV1 & { vaultId: string; generationId: string; generationNumber: number },
    kind: "Object" | "Event",
    entityId: string,
    objectType: "BundleDescriptor" | "Artifact" | "Event",
    keyEpochId: string,
    byteLength: number,
    sha256: string,
    bytes: AsyncIterable<Uint8Array>,
    eventMetadata?: {
      readonly orderingTimestamp: string;
      readonly dependencyObjectIds: readonly string[];
    },
  ): Promise<SynchronizationCheckpointV1> {
    let checkpoint = await this.state.synchronizationCheckpoint(job.vaultId, kind, entityId);
    checkpoint ??= {
      version: 1,
      vaultId: job.vaultId,
      entityId,
      kind,
      state: "Prepared",
      createIdempotencyKey: crypto.randomUUID(),
      completeIdempotencyKey: crypto.randomUUID(),
      ...(kind === "Event" ? { commitIdempotencyKey: crypto.randomUUID() } : {}),
      receivedParts: [],
    };
    if (checkpoint.state === "Durable" || checkpoint.state === "Committed") return checkpoint;
    await this.state.saveSynchronizationCheckpoint(checkpoint);
    const response = record(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${job.vaultId}/uploads`,
          {
            objectId: entityId,
            objectType,
            keyEpochId,
            byteLength,
            sha256,
            targetGenerationId: job.generationId,
            ...(eventMetadata === undefined ? {} : { eventMetadata }),
          },
          checkpoint.createIdempotencyKey,
        )
      ).body,
    );
    const upload = record(response.upload);
    const ticket = record(response.ticket);
    if (
      typeof upload.uploadId !== "string" ||
      typeof upload.partSizeBytes !== "number" ||
      !Array.isArray(upload.receivedParts) ||
      typeof ticket.url !== "string"
    )
      throw Object.assign(new Error("Upload response is invalid"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    checkpoint = {
      ...checkpoint,
      state: "Uploading",
      uploadId: upload.uploadId,
      receivedParts: upload.receivedParts.map(Number),
    };
    await this.state.saveSynchronizationCheckpoint(checkpoint);
    if (upload.state !== "Completed" && upload.state !== "AlreadyDurable") {
      const iterator = bytes[Symbol.asyncIterator]();
      let pending = new Uint8Array();
      for (let part = 0; ; part += 1) {
        const next = await readPart(iterator, pending, upload.partSizeBytes);
        pending = Uint8Array.from(next.pending);
        if (next.done) break;
        if (!checkpoint.receivedParts.includes(part)) {
          await this.transport.putTransfer(ticket.url, part, next.bytes);
          await this.afterUploadPart?.();
        }
      }
      await this.transport.request(
        "POST",
        `/api/vaults/${job.vaultId}/uploads/${upload.uploadId}/complete`,
        undefined,
        checkpoint.completeIdempotencyKey,
      );
    }
    checkpoint = { ...checkpoint, state: "Durable" };
    await this.state.saveSynchronizationCheckpoint(checkpoint);
    return checkpoint;
  }
}

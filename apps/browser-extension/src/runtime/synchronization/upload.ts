import { decodeEncryptedEnvelopeBytes } from "../../crypto/envelope";
import type {
  StoredEvent,
  StoredObjectV1,
  SynchronizationCheckpointV1,
  SynchronizationJobV1,
} from "../../drivers/indexeddb/schema";
import { bytesToBase64Url } from "../account/wire";
import type { ArtifactStore } from "../artifact";
import { UploadTransfer } from "./upload-transfer";

interface UploadStateRepository {
  latestSynchronizationJob(): Promise<SynchronizationJobV1 | undefined>;
  saveSynchronizationJob(job: SynchronizationJobV1): Promise<void>;
  synchronizationCheckpoint(
    vaultId: string,
    kind: "Object" | "Event",
    entityId: string,
  ): Promise<SynchronizationCheckpointV1 | undefined>;
  saveSynchronizationCheckpoint(checkpoint: SynchronizationCheckpointV1): Promise<void>;
}

interface UploadSource {
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

interface UploadTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
}

interface UploadArtifactAvailability {
  isArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<boolean>;
}

export interface UploadFaults {
  readonly beforeArtifactRead?: () => Promise<void>;
  readonly afterUploadPart?: () => Promise<void>;
}

async function checksum(bytes: Uint8Array): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))),
  );
}

async function* bytesStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export class UploadRunner {
  private readonly transfer: UploadTransfer;

  constructor(
    private readonly state: UploadStateRepository,
    private readonly source: UploadSource,
    private readonly artifacts: Pick<ArtifactStore, "openEncrypted">,
    private readonly transport: UploadTransport,
    private readonly beforeEventCommits?: () => Promise<void>,
    private readonly commitEvents = true,
    private readonly afterEventCommit?: (body: unknown) => Promise<void>,
    private readonly availability?: UploadArtifactAvailability,
    private readonly faults?: UploadFaults,
  ) {
    this.transfer = new UploadTransfer(state, transport, faults?.afterUploadPart);
  }

  async run(
    now = new Date().toISOString(),
    publishedEntityIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const loaded = await this.state.latestSynchronizationJob();
    if (
      loaded?.vaultId === undefined ||
      loaded.generationId === undefined ||
      loaded.generationNumber === undefined
    )
      return;
    let job: SynchronizationJobV1 & {
      vaultId: string;
      generationId: string;
      generationNumber: number;
    } = {
      ...loaded,
      vaultId: loaded.vaultId,
      generationId: loaded.generationId,
      generationNumber: loaded.generationNumber,
    };
    if (job.stage === "UploadObjects") {
      const head = await this.source.getVaultHead();
      if (head === undefined)
        throw Object.assign(new Error("Local Vault head is unavailable."), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      const retained = new Set(head.appendedObjectIds);
      const objects = (await this.source.listStoredObjects())
        .filter(
          (object) => retained.has(object.objectId) && !publishedEntityIds.has(object.objectId),
        )
        .toSorted((left, right) => left.objectId.localeCompare(right.objectId));
      for (const object of objects) {
        await this.uploadObject(job, object);
        job = { ...job, state: "Running", completedItems: job.completedItems + 1, updatedAt: now };
        await this.state.saveSynchronizationJob(job);
      }
      job = { ...job, stage: "CommitEvents", updatedAt: now };
      await this.state.saveSynchronizationJob(job);
    }
    if (job.stage === "CommitEvents") {
      const head = await this.source.getVaultHead();
      if (head === undefined)
        throw Object.assign(new Error("Local Vault head is unavailable."), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      const retained = new Set(head.appendedEventIds);
      const events = (await this.source.listStoredEvents())
        .filter((event) => retained.has(event.eventId) && !publishedEntityIds.has(event.eventId))
        .toSorted((left, right) =>
          left.orderingTimestamp === right.orderingTimestamp
            ? left.eventId.localeCompare(right.eventId)
            : left.orderingTimestamp.localeCompare(right.orderingTimestamp),
        );
      for (const event of events) {
        await this.uploadEventDurable(job, event);
        job = { ...job, state: "Running", completedItems: job.completedItems + 1, updatedAt: now };
        await this.state.saveSynchronizationJob(job);
      }
      await this.beforeEventCommits?.();
      if (this.commitEvents) for (const event of events) await this.commitEvent(job, event);
      await this.state.saveSynchronizationJob({
        ...job,
        state: "Running",
        stage: "FetchChanges",
        updatedAt: now,
      });
    }
  }

  async assertPendingUploadsUseEpoch(
    activeKeyEpochId: string,
    publishedEntityIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const job = await this.state.latestSynchronizationJob();
    if (job?.vaultId === undefined) return;
    const [head, objects, events] = await Promise.all([
      this.source.getVaultHead(),
      this.source.listStoredObjects(),
      this.source.listStoredEvents(),
    ]);
    if (head === undefined)
      throw Object.assign(new Error("Local Vault head is unavailable."), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    const retainedObjectIds = new Set(head.appendedObjectIds);
    const retainedEventIds = new Set(head.appendedEventIds);
    const pending = [
      ...objects
        .filter((object) => retainedObjectIds.has(object.objectId))
        .map((object) => ({
          kind: "Object" as const,
          entityId: object.objectId,
          keyEpochId:
            object.objectType === "Artifact"
              ? object.keyEpochId
              : decodeEncryptedEnvelopeBytes(object.envelopeBytes).keyEpochId,
        })),
      ...events
        .filter((event) => retainedEventIds.has(event.eventId))
        .map((event) => ({
          kind: "Event" as const,
          entityId: event.eventId,
          keyEpochId: decodeEncryptedEnvelopeBytes(event.envelopeBytes).keyEpochId,
        })),
    ];
    for (const record of pending) {
      const checkpoint = await this.state.synchronizationCheckpoint(
        job.vaultId,
        record.kind,
        record.entityId,
      );
      if (
        !publishedEntityIds.has(record.entityId) &&
        checkpoint?.state !== "Durable" &&
        checkpoint?.state !== "Committed" &&
        record.keyEpochId !== activeKeyEpochId
      )
        throw Object.assign(new Error("Unpublished local work uses a retired Vault key epoch."), {
          id: "KEY_EPOCH_CHANGED",
        });
    }
  }

  private async uploadObject(
    job: SynchronizationJobV1 & { vaultId: string; generationId: string; generationNumber: number },
    object: StoredObjectV1,
  ): Promise<void> {
    const stream =
      object.objectType === "BundleDescriptor"
        ? bytesStream(object.envelopeBytes)
        : this.artifactStream(job.vaultId, object.objectId);
    const byteLength =
      object.objectType === "BundleDescriptor"
        ? object.envelopeBytes.byteLength
        : object.envelopeByteLength;
    const sha256 =
      object.objectType === "BundleDescriptor"
        ? await checksum(object.envelopeBytes)
        : bytesToBase64Url(object.envelopeChecksum);
    const keyEpochId =
      object.objectType === "Artifact"
        ? object.keyEpochId
        : decodeEncryptedEnvelopeBytes(object.envelopeBytes).keyEpochId;
    await this.transfer.upload(
      job,
      "Object",
      object.objectId,
      object.objectType,
      keyEpochId,
      byteLength,
      sha256,
      stream,
    );
  }

  private async uploadEventDurable(
    job: SynchronizationJobV1 & { vaultId: string; generationId: string; generationNumber: number },
    event: StoredEvent,
  ): Promise<void> {
    await this.transfer.upload(
      job,
      "Event",
      event.eventId,
      "Event",
      decodeEncryptedEnvelopeBytes(event.envelopeBytes).keyEpochId,
      event.envelopeBytes.byteLength,
      await checksum(event.envelopeBytes),
      bytesStream(event.envelopeBytes),
      {
        orderingTimestamp: event.orderingTimestamp,
        dependencyObjectIds: [...event.referencedObjectIds].toSorted(),
      },
    );
  }

  private async commitEvent(
    job: SynchronizationJobV1 & { vaultId: string; generationId: string; generationNumber: number },
    event: StoredEvent,
  ): Promise<void> {
    const checkpoint = await this.state.synchronizationCheckpoint(
      job.vaultId,
      "Event",
      event.eventId,
    );
    if (checkpoint === undefined || checkpoint.commitIdempotencyKey === undefined)
      throw Object.assign(new Error("Event upload checkpoint is unavailable"), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    if (checkpoint.state !== "Committed") {
      const response = await this.transport.request(
        "POST",
        `/api/vaults/${job.vaultId}/commits`,
        {
          generationId: job.generationId,
          generationNumber: job.generationNumber,
          eventObjectId: event.eventId,
          dependencyObjectIds: [...event.referencedObjectIds].toSorted(),
        },
        checkpoint.commitIdempotencyKey,
      );
      await this.afterEventCommit?.(response.body);
      await this.state.saveSynchronizationCheckpoint({ ...checkpoint, state: "Committed" });
    }
  }

  private async *artifactStream(
    vaultId: string,
    artifactObjectId: string,
  ): AsyncIterable<Uint8Array> {
    await this.faults?.beforeArtifactRead?.();
    if (await this.availability?.isArtifactRemoteOnly(vaultId, artifactObjectId))
      throw Object.assign(new Error("The server requested bytes for a remote-only Artifact."), {
        id: "SYNCHRONIZATION_INTEGRITY_FAILED",
      });
    const reader = (await this.artifacts.openEncrypted(vaultId, artifactObjectId)).getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

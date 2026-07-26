import { decodeEncryptedEnvelopeBytes } from "../../crypto/envelope";
import type { StoredEvent, StoredObjectV1 } from "../../drivers/indexeddb/schema";
import { bytesToBase64Url } from "../account/wire";
import { noRuntimeFaultCheckpoint, type RuntimeFaultCheckpoint } from "../fault-checkpoint";
import type { VacuumCandidate } from "../library/vacuum";

interface VacuumTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
}

interface VacuumSource {
  listStoredObjects(): Promise<readonly StoredObjectV1[]>;
  listStoredEvents(): Promise<readonly StoredEvent[]>;
}

interface VacuumActivationJournal {
  persistCandidate(candidate: VacuumCandidate): Promise<void>;
  markRemoteActivated(jobId: string, headCursor: number): Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw integrity("Vacuum response is invalid");
  return value as Record<string, unknown>;
}

async function checksum(bytes: Uint8Array): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))),
  );
}

export class SynchronizedVacuumActivator {
  constructor(
    private readonly vaultId: string,
    private readonly predecessorGenerationNumber: number,
    private readonly headCursor: number,
    private readonly source: VacuumSource,
    private readonly transport: VacuumTransport,
    private readonly commitLocal: (
      candidate: VacuumCandidate,
      activatedHeadCursor: number,
    ) => Promise<void>,
    private readonly journal?: VacuumActivationJournal,
    private readonly faultCheckpoint: RuntimeFaultCheckpoint = noRuntimeFaultCheckpoint,
  ) {}

  async activate(candidate: VacuumCandidate): Promise<void> {
    if (candidate.expectedGenerationId === undefined)
      throw integrity("Vacuum predecessor is unavailable");
    await this.faultCheckpoint.reach("vacuum:before-candidate");
    await this.journal?.persistCandidate(candidate);
    const generationBytes = candidate.generation.envelopeBytes;
    const generationEnvelope = decodeEncryptedEnvelopeBytes(generationBytes);
    const created = object(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${this.vaultId}/generation-candidates`,
          {
            generationId: candidate.generation.generationId,
            generationNumber: candidate.generation.generationNumber,
            predecessorGenerationId: candidate.expectedGenerationId,
            headCursor: this.headCursor,
            generationObject: {
              objectId: candidate.generation.generationId,
              objectType: "VaultGeneration",
              keyEpochId: generationEnvelope.keyEpochId,
              byteLength: generationBytes.byteLength,
              sha256: await checksum(generationBytes),
            },
          },
          crypto.randomUUID(),
        )
      ).body,
    );
    await this.uploadReturned(created, generationBytes);

    for (const event of candidate.eventsToAdd)
      await this.uploadEvent(candidate.generation.generationId, event);

    const [objects, events] = await Promise.all([
      this.source.listStoredObjects(),
      this.source.listStoredEvents(),
    ]);
    const removedObjects = new Set(candidate.objectIds);
    const removedEvents = new Set(candidate.eventIds);
    const retainedIds = [
      ...objects
        .filter((entry) => !removedObjects.has(entry.objectId))
        .map((entry) => entry.objectId),
      ...events.filter((entry) => !removedEvents.has(entry.eventId)).map((entry) => entry.eventId),
      ...candidate.eventsToAdd.map((entry) => entry.eventId),
    ].toSorted();
    if (new Set(retainedIds).size !== retainedIds.length)
      throw integrity("Vacuum reachability contains duplicates");
    const pageSize = 1_000;
    const pageCount = Math.ceil(retainedIds.length / pageSize);
    for (let page = 0; page < pageCount; page += 1) {
      await this.transport.request(
        "PUT",
        `/api/vaults/${this.vaultId}/generation-candidates/${candidate.generation.generationId}/retained-pages/${page}`,
        { recordIds: retainedIds.slice(page * pageSize, (page + 1) * pageSize) },
        crypto.randomUUID(),
      );
    }
    await this.faultCheckpoint.reach("vacuum:before-seal");
    await this.transport.request(
      "POST",
      `/api/vaults/${this.vaultId}/generation-candidates/${candidate.generation.generationId}/seal`,
      {
        pageCount,
        recordCount: retainedIds.length,
        sha256: await checksum(
          new TextEncoder().encode(retainedIds.map((id) => `${id}\n`).join("")),
        ),
      },
      crypto.randomUUID(),
    );
    await this.faultCheckpoint.reach("vacuum:before-activate");
    const activated = object(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${this.vaultId}/generation-candidates/${candidate.generation.generationId}/activate`,
          {
            predecessorGenerationId: candidate.expectedGenerationId,
            predecessorGenerationNumber: this.predecessorGenerationNumber,
            headCursor: this.headCursor,
          },
          crypto.randomUUID(),
        )
      ).body,
    );
    if (
      activated.generationId !== candidate.generation.generationId ||
      activated.generationNumber !== candidate.generation.generationNumber ||
      typeof activated.headCursor !== "number" ||
      !Number.isSafeInteger(activated.headCursor) ||
      activated.headCursor !== this.headCursor + 1
    )
      throw integrity("Activated Vacuum head is invalid");
    await this.journal?.markRemoteActivated(candidate.jobId, activated.headCursor);
    await this.commitLocal(candidate, activated.headCursor);
  }

  private async uploadEvent(generationId: string, event: StoredEvent): Promise<void> {
    const envelope = decodeEncryptedEnvelopeBytes(event.envelopeBytes);
    const response = object(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${this.vaultId}/uploads`,
          {
            objectId: event.eventId,
            objectType: "Event",
            keyEpochId: envelope.keyEpochId,
            byteLength: event.envelopeBytes.byteLength,
            sha256: await checksum(event.envelopeBytes),
            targetGenerationId: generationId,
            eventMetadata: {
              orderingTimestamp: event.orderingTimestamp,
              dependencyObjectIds: [...event.referencedObjectIds].toSorted(),
            },
          },
          crypto.randomUUID(),
        )
      ).body,
    );
    await this.uploadReturned(response, event.envelopeBytes);
  }

  private async uploadReturned(
    response: Record<string, unknown>,
    bytes: Uint8Array,
  ): Promise<void> {
    const upload = object(response.upload);
    const ticket = object(response.ticket);
    if (
      typeof upload.uploadId !== "string" ||
      typeof upload.partSizeBytes !== "number" ||
      !Number.isSafeInteger(upload.partSizeBytes) ||
      upload.partSizeBytes <= 0 ||
      typeof ticket.url !== "string"
    )
      throw integrity("Vacuum upload is invalid");
    const received = Array.isArray(upload.receivedParts) ? upload.receivedParts.map(Number) : [];
    for (let part = 0; part * upload.partSizeBytes < bytes.byteLength; part += 1) {
      if (received.includes(part)) continue;
      const first = part * upload.partSizeBytes;
      await this.transport.putTransfer(
        ticket.url,
        part,
        bytes.subarray(first, Math.min(first + upload.partSizeBytes, bytes.byteLength)),
      );
    }
    await this.transport.request(
      "POST",
      `/api/vaults/${this.vaultId}/uploads/${upload.uploadId}/complete`,
      undefined,
      crypto.randomUUID(),
    );
  }
}

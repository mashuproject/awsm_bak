import { encodeCanonicalCbor } from "../../domain/cbor";
import { sha256 } from "../../domain/hash";
import type {
  StoredArtifactObjectV1,
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
  SynchronizationJobV1,
} from "../../drivers/indexeddb/schema";
import { base64UrlToBytes } from "../account/wire";
import type { ArtifactStore } from "../artifact";
import type { ExportEntryDescriptorV1, ExportManifestV1 } from "../export/contracts";
import { verifyAuthoritativeVaultPackage } from "../export/verify";
import { verifyVaultGeneration } from "../vault/generation";
import type { VaultKeyring } from "../vault/keyring";

const MAXIMUM_INLINE_BYTES = 16 * 1024 * 1024;

interface DownloadTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  getTransfer(url: string, expectedByteLength: number): Promise<ReadableStream<Uint8Array>>;
}

interface RemoteRecord {
  readonly objectId: string;
  readonly objectType: "VaultGeneration" | "Event" | "BundleDescriptor" | "Artifact";
  readonly keyEpochId: string;
  readonly byteLength: number;
  readonly sha256: Uint8Array;
  readonly orderingTimestamp?: string;
  readonly dependencyObjectIds: readonly string[];
}

export interface PreparedRemoteReplica {
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly preparedArtifactObjectIds: readonly string[];
}

export interface VerifiedRemoteReplica extends PreparedRemoteReplica {
  readonly currentVaultName: string;
  readonly vaultCreatedAt: string;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw integrity(`${field} is invalid`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw integrity(`${field} is invalid`);
  return value;
}

function counter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw integrity(`${field} is invalid`);
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw integrity(`${field} is invalid`);
  const result = value.map((entry, index) => string(entry, `${field}.${index}`));
  if (new Set(result).size !== result.length || result.join("\n") !== result.toSorted().join("\n"))
    throw integrity(`${field} is not canonical`);
  return result;
}

function metadata(value: unknown): RemoteRecord {
  const input = object(value, "record metadata");
  if (input.state !== "Committed") throw integrity("Record is not committed");
  const objectType = input.objectType;
  if (
    objectType !== "VaultGeneration" &&
    objectType !== "Event" &&
    objectType !== "BundleDescriptor" &&
    objectType !== "Artifact"
  )
    throw integrity("Record type is unsupported");
  const event = objectType === "Event";
  return {
    objectId: string(input.objectId, "record ID"),
    objectType,
    keyEpochId: string(input.keyEpochId, "record key epoch ID"),
    byteLength: counter(input.byteLength, "record byte length"),
    sha256: base64UrlToBytes(string(input.sha256, "record checksum"), 32),
    ...(event
      ? {
          orderingTimestamp: string(input.orderingTimestamp, "Event ordering timestamp"),
          dependencyObjectIds: strings(input.dependencyObjectIds, "Event dependencies"),
        }
      : { dependencyObjectIds: [] }),
  };
}

function sameMetadata(left: RemoteRecord, right: RemoteRecord): boolean {
  return (
    left.objectId === right.objectId &&
    left.objectType === right.objectType &&
    left.keyEpochId === right.keyEpochId &&
    left.byteLength === right.byteLength &&
    left.orderingTimestamp === right.orderingTimestamp &&
    left.dependencyObjectIds.join("\n") === right.dependencyObjectIds.join("\n") &&
    left.sha256.every((byte, index) => byte === right.sha256[index])
  );
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  expected: number,
): Promise<Uint8Array> {
  if (expected > MAXIMUM_INLINE_BYTES)
    throw integrity("Inline record exceeds its validation bound");
  const result = new Uint8Array(expected);
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > expected)
        throw integrity("Record exceeds advertised length");
      result.set(next.value, offset);
      offset += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expected) throw integrity("Record is shorter than advertised");
  return result;
}

async function checksum(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export class RemoteReplicaDownloader {
  constructor(
    private readonly transport: DownloadTransport,
    private readonly artifacts: Pick<ArtifactStore, "prepareEncrypted">,
  ) {}

  async prepare(
    job: SynchronizationJobV1,
    keyring: VaultKeyring,
    existing?: {
      readonly generation: StoredVaultGenerationV1;
      readonly events: readonly StoredEvent[];
      readonly objects: readonly StoredObjectV1[];
    },
    scope?: { readonly recoveryGenerationId: string },
    beforeArtifactPrepare?: (objectId: string) => Promise<void>,
  ): Promise<PreparedRemoteReplica> {
    if (
      job.vaultId === undefined ||
      job.generationId === undefined ||
      job.generationNumber === undefined ||
      job.stage !== "DownloadRecords"
    )
      throw integrity("Download Job context is incomplete");
    if (scope !== undefined && scope.recoveryGenerationId !== job.generationId)
      throw integrity("Recovery download scope differs from the requested Generation");
    const scopedJob: SynchronizationJobV1 & { vaultId: string; generationId: string } = {
      ...job,
      vaultId: job.vaultId,
      generationId: job.generationId,
    };
    const records = await this.list(scopedJob, scope);
    const generationMetadata = records.filter((record) => record.objectType === "VaultGeneration");
    if (generationMetadata.length !== 1 || generationMetadata[0]?.objectId !== job.generationId)
      throw integrity("Active Generation record is missing");

    const events: StoredEvent[] = [];
    const objects: StoredObjectV1[] = [];
    const artifactIds: string[] = [];
    let generationBytes: Uint8Array | undefined;
    const local = new Map<string, StoredVaultGenerationV1 | StoredEvent | StoredObjectV1>([
      ...(existing === undefined
        ? []
        : [[existing.generation.generationId, existing.generation] as const]),
      ...(existing?.events.map((event) => [event.eventId, event] as const) ?? []),
      ...(existing?.objects.map((object) => [object.objectId, object] as const) ?? []),
    ]);
    try {
      for (const advertised of records) {
        const available = local.get(advertised.objectId);
        if (available !== undefined) {
          await this.acceptExisting(advertised, available, events, objects);
          if (advertised.objectType === "VaultGeneration")
            generationBytes = (available as StoredVaultGenerationV1).envelopeBytes;
          continue;
        }
        const response = object(
          (
            await this.transport.request(
              "POST",
              scope === undefined
                ? `/api/vaults/${job.vaultId}/records/${advertised.objectId}/downloads`
                : `/api/vaults/${job.vaultId}/recoveries/${scope.recoveryGenerationId}/records/${advertised.objectId}/downloads`,
              undefined,
              crypto.randomUUID(),
            )
          ).body,
          "download ticket",
        );
        const confirmed = metadata(response.record);
        if (!sameMetadata(advertised, confirmed))
          throw integrity("Record metadata changed during download");
        const ticket = object(response.ticket, "download ticket");
        const url = string(ticket.url, "download URL");
        const stream = await this.transport.getTransfer(url, advertised.byteLength);
        if (advertised.objectType === "Artifact") {
          const stored: StoredArtifactObjectV1 = {
            version: 1,
            objectId: advertised.objectId,
            objectType: "Artifact",
            keyEpochId: advertised.keyEpochId,
            envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
            envelopeByteLength: advertised.byteLength,
            envelopeChecksumAlgorithm: "hash:sha256:v1",
            envelopeChecksum: advertised.sha256,
          };
          await beforeArtifactPrepare?.(stored.objectId);
          await this.artifacts.prepareEncrypted({
            vaultId: job.vaultId,
            object: stored,
            encrypted: stream,
          });
          objects.push(stored);
          artifactIds.push(stored.objectId);
          continue;
        }
        const bytes = await readBounded(stream, advertised.byteLength);
        if (!equal(await checksum(bytes), advertised.sha256))
          throw integrity("Record checksum differs");
        if (advertised.objectType === "VaultGeneration") generationBytes = bytes;
        else if (advertised.objectType === "Event") {
          events.push({
            version: 1,
            vaultId: job.vaultId,
            eventId: advertised.objectId,
            referencedObjectIds: advertised.dependencyObjectIds,
            orderingTimestamp: advertised.orderingTimestamp as string,
            envelopeBytes: bytes,
          });
        } else {
          objects.push({
            version: 1,
            objectId: advertised.objectId,
            objectType: "BundleDescriptor",
            envelopeBytes: bytes,
          });
        }
      }
      if (generationBytes === undefined) throw integrity("Generation bytes are unavailable");
      const predecessorGenerationId =
        job.predecessorGenerationId ??
        (existing?.generation.generationId === job.generationId
          ? existing.generation.predecessorGenerationId
          : undefined);
      const generation: StoredVaultGenerationV1 = {
        version: 1,
        generationId: job.generationId,
        generationNumber: job.generationNumber,
        ...(predecessorGenerationId === undefined ? {} : { predecessorGenerationId }),
        envelopeBytes: generationBytes,
      };
      const retained = await verifyVaultGeneration(keyring, job.vaultId, generation);
      const retainedObjects = new Set(retained.retainedObjectIds);
      const retainedEvents = new Set(retained.retainedEventIds);
      const downloadedObjectIds = objects.map((entry) => entry.objectId).toSorted();
      const downloadedEventIds = events.map((entry) => entry.eventId).toSorted();
      for (const id of retainedObjects)
        if (!downloadedObjectIds.includes(id)) throw integrity("Retained Object is missing");
      for (const id of retainedEvents)
        if (!downloadedEventIds.includes(id)) throw integrity("Retained Event is missing");
      return {
        generation,
        head: {
          version: 1,
          vaultId: job.vaultId,
          generationId: job.generationId,
          generationNumber: job.generationNumber,
          appendedObjectIds: downloadedObjectIds.filter((id) => !retainedObjects.has(id)),
          appendedEventIds: downloadedEventIds.filter((id) => !retainedEvents.has(id)),
        },
        events: events.toSorted((left, right) =>
          left.orderingTimestamp === right.orderingTimestamp
            ? left.eventId.localeCompare(right.eventId)
            : left.orderingTimestamp.localeCompare(right.orderingTimestamp),
        ),
        objects: objects.toSorted((left, right) => left.objectId.localeCompare(right.objectId)),
        preparedArtifactObjectIds: artifactIds.toSorted(),
      };
    } catch (error) {
      throw error instanceof Error && "id" in error
        ? error
        : integrity(
            `Remote Replica validation failed (${
              error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"
            })`,
          );
    }
  }

  private async acceptExisting(
    advertised: RemoteRecord,
    available: StoredVaultGenerationV1 | StoredEvent | StoredObjectV1,
    events: StoredEvent[],
    objects: StoredObjectV1[],
  ): Promise<void> {
    let bytes: Uint8Array;
    if (advertised.objectType === "VaultGeneration" && "generationId" in available) {
      bytes = available.envelopeBytes;
    } else if (advertised.objectType === "Event" && "eventId" in available) {
      bytes = available.envelopeBytes;
      if (
        available.orderingTimestamp !== advertised.orderingTimestamp ||
        available.referencedObjectIds.join("\n") !== advertised.dependencyObjectIds.join("\n")
      )
        throw integrity("Local Event metadata differs from the server");
      events.push(available);
    } else if (
      advertised.objectType === "BundleDescriptor" &&
      "objectType" in available &&
      available.objectType === "BundleDescriptor"
    ) {
      bytes = available.envelopeBytes;
      objects.push(available);
    } else if (
      advertised.objectType === "Artifact" &&
      "objectType" in available &&
      available.objectType === "Artifact"
    ) {
      if (
        available.envelopeByteLength !== advertised.byteLength ||
        !equal(available.envelopeChecksum, advertised.sha256)
      )
        throw integrity("Local Artifact metadata differs from the server");
      objects.push(available);
      return;
    } else throw integrity("Local record type differs from the server");
    if (
      bytes.byteLength !== advertised.byteLength ||
      !equal(await checksum(bytes), advertised.sha256)
    )
      throw integrity("Local record metadata differs from the server");
  }

  private async list(
    job: SynchronizationJobV1 & { vaultId: string; generationId: string },
    scope?: { readonly recoveryGenerationId: string },
  ): Promise<readonly RemoteRecord[]> {
    const result: RemoteRecord[] = [];
    let after: string | undefined;
    for (;;) {
      const base =
        scope === undefined
          ? `/api/vaults/${job.vaultId}/records`
          : `/api/vaults/${job.vaultId}/recoveries/${scope.recoveryGenerationId}/records`;
      const path = `${base}?limit=100${after === undefined ? "" : `&afterObjectId=${encodeURIComponent(after)}`}`;
      const page = object((await this.transport.request("GET", path)).body, "record page");
      if (page.generationId !== job.generationId || !Array.isArray(page.records))
        throw integrity("Record page Generation differs");
      const decoded = page.records.map(metadata);
      for (const entry of decoded) {
        if (
          result.at(-1)?.objectId !== undefined &&
          entry.objectId <= (result.at(-1)?.objectId ?? "")
        )
          throw integrity("Record pages are not strictly lexical");
        result.push(entry);
      }
      if (page.hasMore === false) return result;
      if (
        page.hasMore !== true ||
        decoded.length === 0 ||
        page.nextObjectId !== result.at(-1)?.objectId
      )
        throw integrity("Record page cursor is invalid");
      after = string(page.nextObjectId, "record page cursor");
    }
  }
}

export async function verifyPreparedRemoteReplica(input: {
  readonly vaultId: string;
  readonly prepared: PreparedRemoteReplica;
  readonly keyring: VaultKeyring;
  readonly artifacts: Pick<ArtifactStore, "openEncrypted">;
  readonly openArtifact?: (object: StoredArtifactObjectV1) => Promise<ReadableStream<Uint8Array>>;
}): Promise<VerifiedRemoteReplica> {
  const files = new Map<string, Uint8Array>();
  files.set("generation.cbor", encodeCanonicalCbor(input.prepared.generation));
  files.set("head.cbor", encodeCanonicalCbor(input.prepared.head));
  for (const event of input.prepared.events)
    files.set(`events/${event.eventId}.cbor`, encodeCanonicalCbor(event));
  for (const object of input.prepared.objects)
    files.set(`objects/${object.objectId}.cbor`, encodeCanonicalCbor(object));

  const descriptors: ExportEntryDescriptorV1[] = [];
  const add = async (
    path: string,
    recordType: ExportEntryDescriptorV1["recordType"],
    recordId: string,
  ): Promise<void> => {
    const bytes = files.get(path);
    if (bytes === undefined) throw integrity("Prepared record is unavailable");
    descriptors.push({
      path,
      recordType,
      recordId,
      byteLength: bytes.byteLength,
      checksumAlgorithm: "hash:sha256:v1",
      checksum: await sha256(bytes),
    });
  };
  await add("generation.cbor", "VaultGeneration", input.prepared.generation.generationId);
  await add("head.cbor", "VaultHead", input.vaultId);
  for (const event of input.prepared.events)
    await add(`events/${event.eventId}.cbor`, "Event", event.eventId);
  for (const object of input.prepared.objects) {
    await add(`objects/${object.objectId}.cbor`, "Object", object.objectId);
    if (object.objectType === "Artifact") {
      descriptors.push({
        path: `artifacts/${object.objectId}.bin`,
        recordType: "ArtifactPayload",
        recordId: object.objectId,
        byteLength: object.envelopeByteLength,
        checksumAlgorithm: "hash:sha256:v1",
        checksum: object.envelopeChecksum,
      });
    }
  }
  const manifest: ExportManifestV1 = {
    exportFormatVersion: 1,
    packageId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    originatingVaultId: input.vaultId,
    generationId: input.prepared.generation.generationId,
    generationNumber: input.prepared.generation.generationNumber,
    coverage: "Complete",
    eventCount: input.prepared.events.length,
    objectCount: input.prepared.objects.length,
    artifactPayloadCount: input.prepared.objects.filter(
      (object) => object.objectType === "Artifact",
    ).length,
    supportedFeatures: ["artifact-graph", "selective-coverage", "vault-generation"],
    entries: descriptors.toSorted((left, right) => left.path.localeCompare(right.path)),
    omissions: [],
    contentIntegrity: { algorithm: "hash:sha256:v1", checksum: new Uint8Array(32) },
  };
  try {
    const verified = await verifyAuthoritativeVaultPackage({
      manifest,
      keyring: input.keyring,
      read: async (path, maximum) => {
        const bytes = files.get(path);
        if (bytes === undefined || bytes.byteLength > maximum)
          throw integrity("Prepared record is unavailable");
        return bytes;
      },
      openArtifact: (objectId) => {
        const object = input.prepared.objects.find(
          (candidate): candidate is StoredArtifactObjectV1 =>
            candidate.objectType === "Artifact" && candidate.objectId === objectId,
        );
        if (object === undefined) throw integrity("Prepared Artifact Object is unavailable");
        return input.openArtifact === undefined
          ? input.artifacts.openEncrypted(input.vaultId, objectId)
          : input.openArtifact(object);
      },
    });
    return {
      generation: verified.generation,
      head: verified.head,
      events: verified.events,
      objects: verified.objects,
      preparedArtifactObjectIds: input.prepared.preparedArtifactObjectIds,
      currentVaultName: verified.currentVaultName,
      vaultCreatedAt: verified.vaultCreatedAt,
    };
  } catch (error) {
    throw error instanceof Error && "id" in error
      ? error
      : integrity("Remote Replica semantics are invalid");
  }
}

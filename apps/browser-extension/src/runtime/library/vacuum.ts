import {
  decodeEncryptedEnvelopeBytes,
  decryptEnvelope,
  encodeEncryptedEnvelope,
  encryptEnvelope,
} from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { record, string } from "../../domain/validation";
import type {
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
  StoredVaultNameProjectionV1,
} from "../../drivers/indexeddb";
import type { ArtifactStore } from "../artifact";
import { decodeBundleRegisteredPayload } from "../capture/contracts";
import { prepareVaultGeneration, verifyVaultGeneration } from "../vault/generation";
import type { VaultKeyring } from "../vault/keyring";
import { decodeVaultNameEvent, decryptVaultNameProjection } from "../vault/name-crypto";
import { reduceVaultNameProjection, type VaultNameEventV1 } from "../vault/name-projection";
import type { LibraryService } from "./service";

export interface VacuumRepository {
  listStoredObjects(): Promise<readonly StoredObjectV1[]>;
  listStoredEvents(): Promise<readonly StoredEvent[]>;
  getVaultNameProjection(): Promise<StoredVaultNameProjectionV1 | undefined>;
  acquireVacuum(jobId: string, createdAt: string): Promise<StoredVaultHeadV1>;
  updateVacuumStage(
    jobId: string,
    stage: "Preflight" | "Analyze" | "Rewrite" | "Verify",
  ): Promise<void>;
  getVaultGeneration(generationId: string): Promise<StoredVaultGenerationV1 | undefined>;
  releaseVacuum(jobId: string): Promise<void>;
  commitVacuum(input: VacuumCommitInput): Promise<void>;
}

export interface VacuumCommitInput {
  readonly jobId: string;
  readonly objectIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly eventsToAdd: readonly StoredEvent[];
  readonly bundleIds: readonly string[];
  readonly expectedGenerationId?: string;
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
}

export interface VacuumCandidate extends VacuumCommitInput {
  readonly deletedArtifactObjectIds: readonly string[];
}

export interface VacuumResult {
  readonly deletedCaptureCount: number;
  readonly reclaimedBytes: number;
}

const COMMON_EVENT_FIELDS = [
  "version",
  "eventType",
  "eventVersion",
  "payloadVersion",
  "vaultId",
  "deviceId",
  "timestamp",
] as const;

const EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  BundleRegistered: [
    ...COMMON_EVENT_FIELDS,
    "protocolVersion",
    "correlationId",
    "bundleId",
    "descriptorObjectId",
    "artifactObjectIds",
    "collectionId",
    "captureProfileId",
    "warnings",
  ],
  CapturesDeleted: [...COMMON_EVENT_FIELDS, "bundleIds", "rewrite"],
  CapturesRestored: [...COMMON_EVENT_FIELDS, "bundleIds", "rewrite"],
  CapturesMoved: [...COMMON_EVENT_FIELDS, "moves", "revertsEventId", "rewrite"],
  CollectionsMerged: [
    ...COMMON_EVENT_FIELDS,
    "destinationCollectionId",
    "sourceCollectionIds",
    "rewrite",
  ],
  CollectionMergeReverted: [...COMMON_EVENT_FIELDS, "mergeEventId", "rewrite"],
  VaultCreated: [...COMMON_EVENT_FIELDS, "protocolVersion", "name"],
  VaultRenamed: [...COMMON_EVENT_FIELDS, "protocolVersion", "name"],
};

export function assertCanonicalEventFields(
  payload: Record<string, unknown>,
  eventType: string,
): void {
  const allowed = EVENT_FIELDS[eventType];
  if (allowed === undefined)
    throw new Error(`Unsupported Event type during Vault Vacuum: ${eventType}`);
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(payload).find((key) => !allowedSet.has(key));
  if (unsupported !== undefined) {
    throw new Error(`Field ${unsupported} is outside the canonical Event schema.`);
  }
}

async function eventPayload(
  event: StoredEvent,
  keyring: VaultKeyring,
  vaultId: string,
): Promise<Record<string, unknown>> {
  const envelope = decodeEncryptedEnvelopeBytes(event.envelopeBytes);
  const epoch = keyring.require(envelope.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:event:v1",
    contextId: event.eventId,
    keyVersion: 1,
  });
  try {
    if (envelope.objectId !== event.eventId || envelope.objectType !== "Event") {
      throw new Error("Event envelope mismatch");
    }
    return record(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "event",
    );
  } finally {
    await wipe(key);
  }
}

export async function objectIdsForBundles(
  events: readonly StoredEvent[],
  bundleIds: ReadonlySet<string>,
  keyring: VaultKeyring,
  vaultId: string,
): Promise<ReadonlySet<string>> {
  const objectIds = new Set<string>();
  for (const event of events) {
    const payload = await eventPayload(event, keyring, vaultId);
    if (payload.eventType !== "BundleRegistered") continue;
    const registration = decodeBundleRegisteredPayload(payload, event.referencedObjectIds);
    if (bundleIds.has(registration.bundleId))
      for (const objectId of event.referencedObjectIds) objectIds.add(objectId);
  }
  return objectIds;
}

export function storedObjectByteLength(object: StoredObjectV1): number {
  return object.objectType === "BundleDescriptor"
    ? object.envelopeBytes.byteLength
    : object.envelopeByteLength;
}

async function rewrittenEvent(
  source: StoredEvent,
  payload: Record<string, unknown>,
  bundleIds: readonly string[],
  objectId: string,
  keyring: VaultKeyring,
  vaultId: string,
): Promise<StoredEvent> {
  const eventId = crypto.randomUUID();
  const epoch = keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:event:v1",
    contextId: eventId,
    keyVersion: 1,
  });
  try {
    return {
      version: 1,
      vaultId,
      eventId,
      referencedObjectIds: [objectId],
      orderingTimestamp: source.orderingTimestamp,
      envelopeBytes: encodeEncryptedEnvelope(
        await encryptEnvelope({
          objectType: "Event",
          objectId: eventId,
          keyEpochId: epoch.keyEpochId,
          plaintext: encodeCanonicalCbor({
            ...payload,
            bundleIds: [...bundleIds].toSorted(),
            rewrite: { version: 1, sourceEventId: source.eventId },
          }),
          key,
        }),
      ),
    };
  } finally {
    await wipe(key);
  }
}

async function rewrittenMoveEvent(
  source: StoredEvent,
  payload: Record<string, unknown>,
  moves: readonly Record<string, string>[],
  objectId: string,
  keyring: VaultKeyring,
  vaultId: string,
): Promise<StoredEvent> {
  const eventId = crypto.randomUUID();
  const epoch = keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:event:v1",
    contextId: eventId,
    keyVersion: 1,
  });
  try {
    return {
      version: 1,
      vaultId,
      eventId,
      referencedObjectIds: [objectId],
      orderingTimestamp: source.orderingTimestamp,
      envelopeBytes: encodeEncryptedEnvelope(
        await encryptEnvelope({
          objectType: "Event",
          objectId: eventId,
          keyEpochId: epoch.keyEpochId,
          plaintext: encodeCanonicalCbor({
            ...payload,
            moves,
            rewrite: { version: 1, sourceEventId: source.eventId },
          }),
          key,
        }),
      ),
    };
  } finally {
    await wipe(key);
  }
}

async function rewrittenManagementEvent(
  source: StoredEvent,
  payload: Record<string, unknown>,
  objectId: string,
  keyring: VaultKeyring,
  vaultId: string,
): Promise<StoredEvent> {
  const eventId = crypto.randomUUID();
  const epoch = keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:event:v1",
    contextId: eventId,
    keyVersion: 1,
  });
  try {
    return {
      version: 1,
      vaultId,
      eventId,
      referencedObjectIds: [objectId],
      orderingTimestamp: source.orderingTimestamp,
      envelopeBytes: encodeEncryptedEnvelope(
        await encryptEnvelope({
          objectType: "Event",
          objectId: eventId,
          keyEpochId: epoch.keyEpochId,
          plaintext: encodeCanonicalCbor({
            ...payload,
            rewrite: { version: 1, sourceEventId: source.eventId },
          }),
          key,
        }),
      ),
    };
  } finally {
    await wipe(key);
  }
}

export class VaultVacuumService {
  constructor(
    readonly repository: VacuumRepository,
    readonly library: LibraryService,
    readonly keyring: VaultKeyring,
    readonly vaultId: string,
    readonly deviceId: string,
    readonly artifactStore: ArtifactStore,
    readonly activateCandidate?: (candidate: VacuumCandidate) => Promise<void>,
  ) {}

  async execute(): Promise<VacuumResult> {
    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const currentHead = await this.repository.acquireVacuum(jobId, createdAt);
    let committed = false;
    try {
      return await this.executeWithLease(jobId, createdAt, currentHead, () => {
        committed = true;
      });
    } finally {
      if (!committed) await this.repository.releaseVacuum(jobId);
    }
  }

  private async executeWithLease(
    jobId: string,
    createdAt: string,
    currentHead: StoredVaultHeadV1,
    didCommit: () => void,
  ): Promise<VacuumResult> {
    const sourceGeneration = await this.repository.getVaultGeneration(currentHead.generationId);
    if (sourceGeneration === undefined) throw new Error("The active Vault Generation is missing.");
    const sourceManifest = await verifyVaultGeneration(
      this.keyring,
      this.vaultId,
      sourceGeneration,
    );
    await this.repository.updateVacuumStage(jobId, "Analyze");
    const [items, objects, events] = await Promise.all([
      this.library.list(),
      this.repository.listStoredObjects(),
      this.repository.listStoredEvents(),
    ]);
    const rootedObjectIds = [
      ...sourceManifest.retainedObjectIds,
      ...currentHead.appendedObjectIds,
    ].toSorted();
    const rootedEventIds = [
      ...sourceManifest.retainedEventIds,
      ...currentHead.appendedEventIds,
    ].toSorted();
    if (
      rootedObjectIds.join("\n") !==
      objects
        .map((object) => object.objectId)
        .toSorted()
        .join("\n")
    ) {
      throw new Error("The active Vault Generation does not reach every stored Object.");
    }
    if (
      rootedEventIds.join("\n") !==
      events
        .map((event) => event.eventId)
        .toSorted()
        .join("\n")
    ) {
      throw new Error("The active Vault Generation does not reach every stored Event.");
    }
    const deleted = items.filter((item) => item.status === "Deleted");
    if (deleted.length === 0) throw new Error("Deleted is empty.");

    // Authentication of every retained Bundle is the pre-activation verification boundary.
    await Promise.all(
      items
        .filter((item) => item.status === "Active")
        .map((item) => this.library.detail(item.bundleId)),
    );

    const deletedBundleIds = new Set(deleted.map((item) => item.bundleId));
    const deletedObjectIds = new Set<string>();
    const activeBundleIds = new Set(
      items.filter((item) => item.status === "Active").map((item) => item.bundleId),
    );
    const replayState = new Map<string, "Active" | "Deleted">();
    const eventIds: string[] = [];
    const eventsToAdd: StoredEvent[] = [];
    const rewrittenManagementEventIds = new Map<string, string>();
    const vaultNameEvents: VaultNameEventV1[] = [];
    let eventBytes = 0;
    let rewrittenEventBytes = 0;
    const orderedEvents = [...events].toSorted(
      (left, right) =>
        left.orderingTimestamp.localeCompare(right.orderingTimestamp) ||
        left.eventId.localeCompare(right.eventId),
    );
    for (const event of orderedEvents) {
      const payload = await eventPayload(event, this.keyring, this.vaultId);
      const eventType = string(payload.eventType, "event.eventType");
      assertCanonicalEventFields(payload, eventType);
      if (eventType === "VaultCreated" || eventType === "VaultRenamed") {
        vaultNameEvents.push(await decodeVaultNameEvent(this.keyring, event));
        continue;
      }
      if (eventType === "BundleRegistered") {
        const registration = decodeBundleRegisteredPayload(payload, event.referencedObjectIds);
        const bundleId = registration.bundleId;
        if (deletedBundleIds.has(bundleId)) {
          for (const objectId of event.referencedObjectIds) deletedObjectIds.add(objectId);
          eventIds.push(event.eventId);
          eventBytes += event.envelopeBytes.byteLength;
          continue;
        }
        if (replayState.has(bundleId)) {
          throw new Error("Retained Event history registers a Bundle more than once.");
        }
        replayState.set(bundleId, "Active");
        continue;
      }
      if (eventType === "CapturesDeleted" || eventType === "CapturesRestored") {
        eventIds.push(event.eventId);
        eventBytes += event.envelopeBytes.byteLength;
        if (!Array.isArray(payload.bundleIds))
          throw new Error("Lifecycle Event Bundle IDs are invalid.");
        const retainedIds = payload.bundleIds
          .map((value, index) => string(value, `event.bundleIds.${String(index)}`))
          .filter((bundleId) => activeBundleIds.has(bundleId))
          .toSorted();
        if (retainedIds.length > 0) {
          const first = items.find((item) => item.bundleId === retainedIds[0]);
          if (first === undefined) throw new Error("Rewritten Event references a missing Bundle.");
          const rewritten = await rewrittenEvent(
            event,
            payload,
            retainedIds,
            first.descriptorObjectId,
            this.keyring,
            this.vaultId,
          );
          eventsToAdd.push(rewritten);
          rewrittenEventBytes += rewritten.envelopeBytes.byteLength;
          const status = eventType === "CapturesDeleted" ? "Deleted" : "Active";
          for (const bundleId of retainedIds) replayState.set(bundleId, status);
        }
        continue;
      }
      if (eventType === "CapturesMoved") {
        eventIds.push(event.eventId);
        eventBytes += event.envelopeBytes.byteLength;
        if (!Array.isArray(payload.moves)) throw new Error("Capture move entries are invalid.");
        const retainedMoves = payload.moves.flatMap((value, index) => {
          const move = record(value, `event.moves.${String(index)}`);
          const bundleId = string(move.bundleId, `event.moves.${String(index)}.bundleId`);
          const fromCollectionId = string(
            move.fromCollectionId,
            `event.moves.${String(index)}.fromCollectionId`,
          );
          const toCollectionId = string(
            move.toCollectionId,
            `event.moves.${String(index)}.toCollectionId`,
          );
          return activeBundleIds.has(bundleId)
            ? [{ bundleId, fromCollectionId, toCollectionId }]
            : [];
        });
        if (retainedMoves.length > 0) {
          const first = items.find((item) => item.bundleId === retainedMoves[0]?.bundleId);
          if (first === undefined) throw new Error("Rewritten move references a missing Bundle.");
          const rewritten = await rewrittenMoveEvent(
            event,
            payload,
            retainedMoves,
            first.descriptorObjectId,
            this.keyring,
            this.vaultId,
          );
          eventsToAdd.push(rewritten);
          rewrittenEventBytes += rewritten.envelopeBytes.byteLength;
        }
        continue;
      }
      if (eventType === "CollectionsMerged") {
        string(payload.destinationCollectionId, "event.destinationCollectionId");
        if (!Array.isArray(payload.sourceCollectionIds)) {
          throw new Error("Collection merge source identifiers are invalid.");
        }
        payload.sourceCollectionIds.forEach((value, index) => {
          string(value, `event.sourceCollectionIds.${String(index)}`);
        });
        if (event.referencedObjectIds.some((objectId) => deletedObjectIds.has(objectId))) {
          const anchor = items
            .filter((item) => item.status === "Active")
            .toSorted((left, right) => left.bundleId.localeCompare(right.bundleId))[0];
          if (anchor === undefined)
            throw new Error("A retained Collection merge has no retained Capture anchor.");
          eventIds.push(event.eventId);
          eventBytes += event.envelopeBytes.byteLength;
          const rewritten = await rewrittenManagementEvent(
            event,
            payload,
            anchor.descriptorObjectId,
            this.keyring,
            this.vaultId,
          );
          eventsToAdd.push(rewritten);
          rewrittenEventBytes += rewritten.envelopeBytes.byteLength;
          rewrittenManagementEventIds.set(event.eventId, rewritten.eventId);
        }
        continue;
      }
      if (eventType === "CollectionMergeReverted") {
        const mergeEventId = string(payload.mergeEventId, "event.mergeEventId");
        const rewrittenMergeEventId = rewrittenManagementEventIds.get(mergeEventId);
        if (
          rewrittenMergeEventId !== undefined ||
          event.referencedObjectIds.some((objectId) => deletedObjectIds.has(objectId))
        ) {
          const anchor = items
            .filter((item) => item.status === "Active")
            .toSorted((left, right) => left.bundleId.localeCompare(right.bundleId))[0];
          if (anchor === undefined)
            throw new Error("A retained Collection merge reversal has no retained Capture anchor.");
          eventIds.push(event.eventId);
          eventBytes += event.envelopeBytes.byteLength;
          const rewritten = await rewrittenManagementEvent(
            event,
            {
              ...payload,
              mergeEventId: rewrittenMergeEventId ?? mergeEventId,
            },
            anchor.descriptorObjectId,
            this.keyring,
            this.vaultId,
          );
          eventsToAdd.push(rewritten);
          rewrittenEventBytes += rewritten.envelopeBytes.byteLength;
          rewrittenManagementEventIds.set(event.eventId, rewritten.eventId);
        }
        continue;
      }
      throw new Error(`Unsupported Event type during Vault Vacuum: ${eventType}`);
    }
    if (
      [...activeBundleIds].toSorted().join("\n") !==
        [...replayState.keys()].toSorted().join("\n") ||
      [...replayState.values()].some((status) => status !== "Active")
    ) {
      throw new Error("Retained Event replay does not match the active Library state.");
    }
    const rebuiltVaultName = reduceVaultNameProjection(vaultNameEvents);
    const storedVaultName = await this.repository.getVaultNameProjection();
    if (storedVaultName === undefined) throw new Error("The Vault Name Projection is missing.");
    const materializedVaultName = await decryptVaultNameProjection(this.keyring, storedVaultName);
    if (
      materializedVaultName.vaultId !== rebuiltVaultName.vaultId ||
      materializedVaultName.name !== rebuiltVaultName.name ||
      materializedVaultName.sourceEventId !== rebuiltVaultName.sourceEventId ||
      materializedVaultName.updatedAt !== rebuiltVaultName.updatedAt
    ) {
      throw new Error("The Vault Name Projection does not match authoritative Event replay.");
    }
    const objectBytes = objects
      .filter((object) => deletedObjectIds.has(object.objectId))
      .reduce((total, object) => total + storedObjectByteLength(object), 0);
    const generationId = crypto.randomUUID();
    const generationNumber = currentHead.generationNumber + 1;
    const retainedObjectIds = objects
      .filter((object) => !deletedObjectIds.has(object.objectId))
      .map((object) => object.objectId)
      .toSorted();
    const deletedEventIds = new Set(eventIds);
    const retainedEventIds = events
      .filter((event) => !deletedEventIds.has(event.eventId))
      .map((event) => event.eventId)
      .concat(eventsToAdd.map((event) => event.eventId))
      .toSorted();
    await this.repository.updateVacuumStage(jobId, "Rewrite");
    const activeEpoch = this.keyring.active();
    const { generation, head } = await prepareVaultGeneration({
      rootKey: activeEpoch.rootKey,
      vaultId: this.vaultId,
      keyEpochId: activeEpoch.keyEpochId,
      deviceId: this.deviceId,
      generationId,
      generationNumber,
      predecessorGenerationId: currentHead.generationId,
      createdAt,
      reason: "Vacuum",
      retainedObjectIds,
      retainedEventIds,
    });
    await this.repository.updateVacuumStage(jobId, "Verify");
    await verifyVaultGeneration(this.keyring, this.vaultId, generation);
    const deletedArtifacts = objects.filter(
      (object) => object.objectType === "Artifact" && deletedObjectIds.has(object.objectId),
    );
    const candidate: VacuumCandidate = {
      jobId,
      objectIds: [...deletedObjectIds].toSorted(),
      eventIds: eventIds.toSorted(),
      eventsToAdd,
      bundleIds: [...deletedBundleIds].toSorted(),
      expectedGenerationId: currentHead.generationId,
      generation,
      head,
      deletedArtifactObjectIds: deletedArtifacts.map((object) => object.objectId),
    };
    if (this.activateCandidate === undefined) {
      await this.repository.commitVacuum(candidate);
      await Promise.all(
        deletedArtifacts.map((object) => this.artifactStore.remove(this.vaultId, object.objectId)),
      );
    } else await this.activateCandidate(candidate);
    didCommit();
    return {
      deletedCaptureCount: deleted.length,
      reclaimedBytes: Math.max(0, objectBytes + eventBytes - rewrittenEventBytes),
    };
  }
}

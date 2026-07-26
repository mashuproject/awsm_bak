import {
  decodeEncryptedEnvelopeBytes,
  decryptEnvelope,
  encodeEncryptedEnvelope,
  encryptEnvelope,
} from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import type { LibraryItemV1 } from "../../domain/contracts";
import { DomainValidationError } from "../../domain/errors";
import { record, string, uuid } from "../../domain/validation";
import type {
  StoredCollectionProjectionV1,
  StoredEvent,
  StoredProjectionV1,
} from "../../drivers/indexeddb";
import type { VaultKeyring } from "../vault/keyring";
import {
  type CollectionsMergedTopologyEventV1,
  type CollectionTopologyEventV1,
  resolveCollectionId,
} from "./collections";
import { assertCanonicalEventFields } from "./vacuum";

export interface CaptureCollectionMoveV1 {
  readonly bundleId: string;
  readonly fromCollectionId: string;
  readonly toCollectionId: string;
}

export interface CapturesMovedFactV1 {
  readonly eventType: "CapturesMoved";
  readonly moves: readonly CaptureCollectionMoveV1[];
  readonly revertsEventId?: string;
}

export type CollectionOperationFactV1 = CollectionTopologyEventV1 | CapturesMovedFactV1;

export interface PreparedCollectionOperationV1 {
  readonly event: StoredEvent;
  readonly projections: readonly StoredProjectionV1[];
  readonly collectionProjection?: StoredCollectionProjectionV1;
}

export class LibraryStateChangedError extends Error {
  readonly id = "LIBRARY_STATE_CHANGED" as const;

  constructor(message: string) {
    super(message);
    this.name = "LibraryStateChangedError";
  }
}

function activeCollectionIds(
  items: readonly LibraryItemV1[],
  topology: readonly CollectionTopologyEventV1[],
): ReadonlySet<string> {
  return new Set(
    items
      .filter((item) => item.status === "Active")
      .map((item) => resolveCollectionId(item.assignedCollectionId, topology)),
  );
}

export function planCollectionMerge(
  items: readonly LibraryItemV1[],
  topology: readonly CollectionTopologyEventV1[],
  destinationCollectionId: string,
  sourceCollectionIds: readonly string[],
  eventId: string,
): CollectionsMergedTopologyEventV1 {
  if (sourceCollectionIds.length === 0) {
    throw new LibraryStateChangedError("A merge must name a source Collection.");
  }
  if (new Set(sourceCollectionIds).size !== sourceCollectionIds.length) {
    throw new LibraryStateChangedError("Merge source Collection IDs must be unique.");
  }
  if (sourceCollectionIds.includes(destinationCollectionId)) {
    throw new LibraryStateChangedError("A Collection cannot be merged into itself.");
  }
  const active = activeCollectionIds(items, topology);
  const destination = resolveCollectionId(destinationCollectionId, topology);
  const sources = sourceCollectionIds
    .map((collectionId) => resolveCollectionId(collectionId, topology))
    .toSorted();
  if (!active.has(destination) || sources.some((source) => !active.has(source))) {
    throw new LibraryStateChangedError("A selected Collection is no longer Active.");
  }
  if (new Set(sources).size !== sources.length || sources.includes(destination)) {
    throw new LibraryStateChangedError("Selected Collections already resolve together.");
  }
  return {
    eventId,
    eventType: "CollectionsMerged",
    destinationCollectionId: destination,
    sourceCollectionIds: sources,
  };
}

export function planCaptureMove(
  items: readonly LibraryItemV1[],
  topology: readonly CollectionTopologyEventV1[],
  bundleIds: readonly string[],
  destinationCollectionId: string,
  options: { readonly allowNewDestination?: boolean } = {},
): readonly CaptureCollectionMoveV1[] {
  if (bundleIds.length === 0) {
    throw new LibraryStateChangedError("A move must name a capture.");
  }
  if (new Set(bundleIds).size !== bundleIds.length) {
    throw new LibraryStateChangedError("Move Bundle IDs must be unique.");
  }
  const destination = resolveCollectionId(destinationCollectionId, topology);
  if (!options.allowNewDestination && !activeCollectionIds(items, topology).has(destination)) {
    throw new LibraryStateChangedError("The destination Collection is no longer Active.");
  }
  const byId = new Map(items.map((item) => [item.bundleId, item]));
  const selected = bundleIds
    .map((bundleId) => {
      const item = byId.get(bundleId);
      if (item?.status !== "Active") {
        throw new LibraryStateChangedError("Every moved capture must still be Active.");
      }
      return item;
    })
    .toSorted((left, right) => left.bundleId.localeCompare(right.bundleId));
  const sourceIds = new Set(
    selected.map((item) => resolveCollectionId(item.assignedCollectionId, topology)),
  );
  if (sourceIds.size !== 1) {
    throw new LibraryStateChangedError("Moved captures must share one source Collection.");
  }
  if (sourceIds.has(destination)) {
    throw new LibraryStateChangedError("The destination must differ from the source Collection.");
  }
  return selected.map((item) => ({
    bundleId: item.bundleId,
    fromCollectionId: item.assignedCollectionId,
    toCollectionId: destination,
  }));
}

export function invertCaptureMoves(
  items: readonly LibraryItemV1[],
  _topology: readonly CollectionTopologyEventV1[],
  moves: readonly CaptureCollectionMoveV1[],
): readonly CaptureCollectionMoveV1[] {
  const byId = new Map(items.map((item) => [item.bundleId, item]));
  return moves.map((move) => {
    const item = byId.get(move.bundleId);
    if (item?.assignedCollectionId !== move.toCollectionId) {
      throw new LibraryStateChangedError("Capture membership changed after the operation.");
    }
    return {
      bundleId: move.bundleId,
      fromCollectionId: move.toCollectionId,
      toCollectionId: move.fromCollectionId,
    };
  });
}

async function encryptedBytes(
  input: PrepareCollectionOperationInput,
  domain: "vault:event:v1" | "vault:projection:v1",
  contextId: string,
  objectType: "Event" | "Projection",
  objectId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const epoch = input.keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId: input.vaultId,
    keyEpochId: epoch.keyEpochId,
    domain,
    contextId,
    keyVersion: 1,
  });
  try {
    return encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType,
        objectId,
        keyEpochId: epoch.keyEpochId,
        plaintext,
        key,
      }),
    );
  } finally {
    await wipe(key);
  }
}

export interface PrepareCollectionOperationInput {
  readonly keyring: VaultKeyring;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly items: readonly LibraryItemV1[];
  readonly topology: readonly CollectionTopologyEventV1[];
  readonly fact: CollectionOperationFactV1;
}

export async function prepareCollectionOperation(
  input: PrepareCollectionOperationInput,
): Promise<PreparedCollectionOperationV1> {
  const affectedBundleIds =
    input.fact.eventType === "CapturesMoved" ? input.fact.moves.map((move) => move.bundleId) : [];
  const itemById = new Map(input.items.map((item) => [item.bundleId, item]));
  const anchor =
    affectedBundleIds.length > 0
      ? itemById.get(affectedBundleIds[0] ?? "")
      : input.items.toSorted((left, right) => left.bundleId.localeCompare(right.bundleId))[0];
  if (anchor === undefined) {
    throw new LibraryStateChangedError("A Collection operation requires a retained capture.");
  }
  const eventPayload = {
    version: 1,
    eventType: input.fact.eventType,
    eventVersion: 1,
    payloadVersion: 1,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    ...(input.fact.eventType === "CollectionsMerged"
      ? {
          destinationCollectionId: input.fact.destinationCollectionId,
          sourceCollectionIds: input.fact.sourceCollectionIds,
        }
      : input.fact.eventType === "CollectionMergeReverted"
        ? { mergeEventId: input.fact.mergeEventId }
        : {
            moves: input.fact.moves,
            ...(input.fact.revertsEventId === undefined
              ? {}
              : { revertsEventId: input.fact.revertsEventId }),
          }),
  };
  const event: StoredEvent = {
    version: 1,
    vaultId: input.vaultId,
    eventId: input.eventId,
    referencedObjectIds: [anchor.descriptorObjectId],
    orderingTimestamp: input.timestamp,
    envelopeBytes: await encryptedBytes(
      input,
      "vault:event:v1",
      input.eventId,
      "Event",
      input.eventId,
      encodeCanonicalCbor(eventPayload),
    ),
  };

  const projections: StoredProjectionV1[] = [];
  if (input.fact.eventType === "CapturesMoved") {
    for (const move of input.fact.moves) {
      const current = itemById.get(move.bundleId);
      if (current?.assignedCollectionId !== move.fromCollectionId) {
        throw new LibraryStateChangedError("Capture membership changed before commit preparation.");
      }
      const updated: LibraryItemV1 = {
        ...current,
        assignedCollectionId: move.toCollectionId,
      };
      projections.push({
        version: 1,
        bundleId: updated.bundleId,
        envelopeBytes: await encryptedBytes(
          input,
          "vault:projection:v1",
          `LibraryItem-v1:${updated.bundleId}`,
          "Projection",
          updated.bundleId,
          encodeCanonicalCbor(updated),
        ),
      });
    }
  }

  if (input.fact.eventType === "CapturesMoved") return { event, projections };
  const topologyEvent: CollectionTopologyEventV1 =
    input.fact.eventType === "CollectionsMerged"
      ? {
          eventId: input.eventId,
          eventType: "CollectionsMerged",
          destinationCollectionId: input.fact.destinationCollectionId,
          sourceCollectionIds: input.fact.sourceCollectionIds,
        }
      : {
          eventId: input.eventId,
          eventType: "CollectionMergeReverted",
          mergeEventId: input.fact.mergeEventId,
        };
  const collectionProjection: StoredCollectionProjectionV1 = {
    version: 1,
    projectionId: input.vaultId,
    envelopeBytes: await encryptedBytes(
      input,
      "vault:projection:v1",
      `LibraryCollections-v1:${input.vaultId}`,
      "Projection",
      input.vaultId,
      encodeCanonicalCbor({
        version: 1,
        topologyEvents: [...input.topology, topologyEvent],
      }),
    ),
  };
  return { event, projections, collectionProjection };
}

export async function decodeCollectionOperationEvent(
  event: StoredEvent,
  keyring: VaultKeyring,
  vaultId: string,
): Promise<
  | {
      readonly eventType: "CollectionsMerged";
      readonly destinationCollectionId: string;
      readonly sourceCollectionIds: readonly string[];
    }
  | { readonly eventType: "CapturesMoved"; readonly moves: readonly CaptureCollectionMoveV1[] }
> {
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
      throw new DomainValidationError("collectionEvent", "has a mismatched envelope");
    }
    const payload = record(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "collectionEvent",
    );
    const eventType = string(payload.eventType, "collectionEvent.eventType");
    assertCanonicalEventFields(payload, eventType);
    if (eventType === "CollectionsMerged") {
      if (!Array.isArray(payload.sourceCollectionIds)) {
        throw new DomainValidationError("collectionEvent.sourceCollectionIds", "must be an array");
      }
      return {
        eventType,
        destinationCollectionId: uuid(
          payload.destinationCollectionId,
          "collectionEvent.destinationCollectionId",
        ),
        sourceCollectionIds: payload.sourceCollectionIds.map((value, index) =>
          uuid(value, `collectionEvent.sourceCollectionIds.${String(index)}`),
        ),
      };
    }
    if (eventType === "CapturesMoved") {
      if (!Array.isArray(payload.moves)) {
        throw new DomainValidationError("collectionEvent.moves", "must be an array");
      }
      return {
        eventType,
        moves: payload.moves.map((value, index) => {
          const move = record(value, `collectionEvent.moves.${String(index)}`);
          return {
            bundleId: uuid(move.bundleId, `collectionEvent.moves.${String(index)}.bundleId`),
            fromCollectionId: uuid(
              move.fromCollectionId,
              `collectionEvent.moves.${String(index)}.fromCollectionId`,
            ),
            toCollectionId: uuid(
              move.toCollectionId,
              `collectionEvent.moves.${String(index)}.toCollectionId`,
            ),
          };
        }),
      };
    }
    throw new LibraryStateChangedError("The referenced operation cannot be undone.");
  } finally {
    await wipe(key);
  }
}

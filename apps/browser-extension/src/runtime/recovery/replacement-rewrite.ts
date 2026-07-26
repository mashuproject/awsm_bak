import {
  decodeEncryptedEnvelopeBytes,
  decryptEnvelope,
  encodeEncryptedEnvelope,
  encryptEnvelope,
} from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { bytesEqual } from "../../domain/hash";
import { record, string } from "../../domain/validation";
import type {
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
} from "../../drivers/indexeddb/schema";
import type { ArtifactStore } from "../artifact";
import { LibraryProjectionRebuilder, type PreparedLibraryProjections } from "../library/rebuild";
import { assertCanonicalEventFields } from "../library/vacuum";
import {
  type PreparedStaleCaptureReplay,
  prepareStaleCaptureReplay,
} from "../synchronization/stale-epoch-replay";
import { prepareVaultGeneration } from "../vault/generation";
import type { VaultKeyring } from "../vault/keyring";

export interface ReplacementIdentifierMapping {
  readonly kind:
    | "Artifact"
    | "Bundle"
    | "BundleDescriptor"
    | "Collection"
    | "Command"
    | "Event"
    | "Vault";
  readonly sourceId: string;
  readonly targetId: string;
}

export interface PreparedVaultReplacement {
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
  readonly objects: readonly StoredObjectV1[];
  readonly events: readonly StoredEvent[];
  readonly projections: PreparedLibraryProjections;
  readonly identifierMappings: readonly ReplacementIdentifierMapping[];
  readonly preparedArtifactObjectIds: readonly string[];
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

async function decryptEventPayload(
  event: StoredEvent,
  vaultId: string,
  keyring: VaultKeyring,
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
    if (envelope.objectId !== event.eventId || envelope.objectType !== "Event")
      throw integrity("Source Event envelope identity differs.");
    const payload = record(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "replacementEvent",
    );
    assertCanonicalEventFields(payload, string(payload.eventType, "replacementEvent.eventType"));
    return payload;
  } finally {
    await wipe(key);
  }
}

async function encryptEventPayload(input: {
  readonly eventId: string;
  readonly vaultId: string;
  readonly keyring: VaultKeyring;
  readonly payload: Record<string, unknown>;
}): Promise<Uint8Array> {
  const epoch = input.keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId: input.vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:event:v1",
    contextId: input.eventId,
    keyVersion: 1,
  });
  try {
    return encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType: "Event",
        objectId: input.eventId,
        keyEpochId: epoch.keyEpochId,
        plaintext: encodeCanonicalCbor(input.payload),
        key,
      }),
    );
  } finally {
    await wipe(key);
  }
}

export class VaultReplacementRewriter {
  constructor(
    private readonly artifacts: Pick<ArtifactStore, "openPlaintext" | "prepare" | "remove">,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async prepare(input: {
    readonly sourceVaultId: string;
    readonly sourceDeviceId: string;
    readonly sourceHead: StoredVaultHeadV1;
    readonly sourceRetainedEventIds: readonly string[];
    readonly sourceRetainedObjectIds: readonly string[];
    readonly sourceKeyring: VaultKeyring;
    readonly sourceEvents: readonly StoredEvent[];
    readonly sourceObjects: readonly StoredObjectV1[];
    readonly targetVaultId: string;
    readonly targetDeviceId: string;
    readonly targetKeyring: VaultKeyring;
    readonly signal?: AbortSignal;
  }): Promise<PreparedVaultReplacement> {
    if (
      input.sourceHead.vaultId !== input.sourceVaultId ||
      input.sourceVaultId === input.targetVaultId
    )
      throw integrity("Vault replacement authority is invalid.");
    const sourceObjects = new Map(input.sourceObjects.map((object) => [object.objectId, object]));
    const reachableEventIds = [
      ...input.sourceRetainedEventIds,
      ...input.sourceHead.appendedEventIds,
    ].toSorted();
    const reachableObjectIds = [
      ...input.sourceRetainedObjectIds,
      ...input.sourceHead.appendedObjectIds,
    ].toSorted();
    const retainedEvents = new Set(reachableEventIds);
    const retainedObjects = new Set(reachableObjectIds);
    if (
      new Set(reachableEventIds).size !== reachableEventIds.length ||
      new Set(reachableObjectIds).size !== reachableObjectIds.length ||
      input.sourceEvents.length !== retainedEvents.size ||
      input.sourceObjects.length !== retainedObjects.size ||
      input.sourceEvents.some(
        (event) => event.vaultId !== input.sourceVaultId || !retainedEvents.has(event.eventId),
      ) ||
      input.sourceObjects.some((object) => !retainedObjects.has(object.objectId))
    )
      throw integrity("Vault replacement input exceeds the active source head.");

    const mappings = new Map<string, ReplacementIdentifierMapping>();
    const mapId = (kind: ReplacementIdentifierMapping["kind"], sourceId: string): string => {
      const key = `${kind}\0${sourceId}`;
      const existing = mappings.get(key);
      if (existing !== undefined) return existing.targetId;
      const mapping = { kind, sourceId, targetId: this.randomUuid() };
      mappings.set(key, mapping);
      return mapping.targetId;
    };
    mappings.set(`Vault\0${input.sourceVaultId}`, {
      kind: "Vault",
      sourceId: input.sourceVaultId,
      targetId: input.targetVaultId,
    });
    const orderedSourceEvents = [...input.sourceEvents].toSorted(
      (left, right) =>
        left.orderingTimestamp.localeCompare(right.orderingTimestamp) ||
        left.eventId.localeCompare(right.eventId),
    );
    for (let first = 0; first < orderedSourceEvents.length; ) {
      const firstSourceEvent = orderedSourceEvents[first];
      if (firstSourceEvent === undefined) throw new Error("The source Event group is empty.");
      const timestamp = firstSourceEvent.orderingTimestamp;
      let last = first + 1;
      while (
        last < orderedSourceEvents.length &&
        orderedSourceEvents[last]?.orderingTimestamp === timestamp
      )
        last += 1;
      const targetEventIds = Array.from({ length: last - first }, () =>
        this.randomUuid(),
      ).toSorted();
      for (let index = first; index < last; index += 1) {
        const sourceEvent = orderedSourceEvents[index];
        const targetId = targetEventIds[index - first];
        if (sourceEvent === undefined || targetId === undefined)
          throw new Error("The source Event group is incomplete.");
        mappings.set(`Event\0${sourceEvent.eventId}`, {
          kind: "Event",
          sourceId: sourceEvent.eventId,
          targetId,
        });
      }
      first = last;
    }

    const events: StoredEvent[] = [];
    const objects: StoredObjectV1[] = [];
    const preparedArtifactObjectIds: string[] = [];
    try {
      for (const source of orderedSourceEvents) {
        input.signal?.throwIfAborted();
        const payload = await decryptEventPayload(source, input.sourceVaultId, input.sourceKeyring);
        const eventType = string(payload.eventType, "replacementEvent.eventType");
        if (eventType === "BundleRegistered") {
          const sourceCollectionId = string(payload.collectionId, "replacementEvent.collectionId");
          const replay: PreparedStaleCaptureReplay = await prepareStaleCaptureReplay({
            vaultId: input.sourceVaultId,
            deviceId: input.sourceDeviceId,
            event: source,
            objects: sourceObjects,
            keyring: input.sourceKeyring,
            artifacts: this.artifacts,
            uuid: this.randomUuid,
            target: {
              vaultId: input.targetVaultId,
              deviceId: input.targetDeviceId,
              keyring: input.targetKeyring,
              collectionId: mapId("Collection", sourceCollectionId),
              eventId: mapId("Event", source.eventId),
            },
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          mappings.set(`Bundle\0${replay.oldBundleId}`, {
            kind: "Bundle",
            sourceId: replay.oldBundleId,
            targetId: replay.registration.graph.bundleId,
          });
          if (mapId("Event", replay.oldEventId) !== replay.registration.event.eventId)
            throw integrity("Replacement Event identifier plan changed.");
          mappings.set(
            `Command\0${string(payload.correlationId, "replacementEvent.correlationId")}`,
            {
              kind: "Command",
              sourceId: string(payload.correlationId, "replacementEvent.correlationId"),
              targetId: replay.registration.outcome.commandId,
            },
          );
          for (const mapping of replay.objectIdMappings) {
            const sourceObject = sourceObjects.get(mapping.sourceObjectId);
            const kind = sourceObject?.objectType === "Artifact" ? "Artifact" : "BundleDescriptor";
            mappings.set(`${kind}\0${mapping.sourceObjectId}`, {
              kind,
              sourceId: mapping.sourceObjectId,
              targetId: mapping.targetObjectId,
            });
          }
          objects.push(...replay.registration.objects);
          events.push(replay.registration.event);
          preparedArtifactObjectIds.push(...replay.preparedArtifactObjectIds);
          continue;
        }

        const eventId = mapId("Event", source.eventId);
        const rewritten = this.rewritePayload(payload, {
          sourceVaultId: input.sourceVaultId,
          targetVaultId: input.targetVaultId,
          targetDeviceId: input.targetDeviceId,
          mapId,
        });
        events.push({
          version: 1,
          vaultId: input.targetVaultId,
          eventId,
          referencedObjectIds: source.referencedObjectIds
            .map((objectId) => {
              const sourceObject = sourceObjects.get(objectId);
              if (sourceObject === undefined)
                throw integrity("Replacement Event references a missing Object.");
              return mapId(
                sourceObject.objectType === "Artifact" ? "Artifact" : "BundleDescriptor",
                objectId,
              );
            })
            .toSorted(),
          orderingTimestamp: source.orderingTimestamp,
          envelopeBytes: await encryptEventPayload({
            eventId,
            vaultId: input.targetVaultId,
            keyring: input.targetKeyring,
            payload: rewritten,
          }),
        });
      }

      if (
        input.sourceObjects.some((object) => {
          const kind = object.objectType === "Artifact" ? "Artifact" : "BundleDescriptor";
          return !mappings.has(`${kind}\0${object.objectId}`);
        }) ||
        input.sourceEvents.some((event) => !mappings.has(`Event\0${event.eventId}`)) ||
        objects.length !== input.sourceObjects.length ||
        events.length !== input.sourceEvents.length
      )
        throw integrity("Vault replacement did not rewrite the exact source closure.");

      const prepareProjections = (
        vaultId: string,
        keyring: VaultKeyring,
        projectionEvents: readonly StoredEvent[],
        projectionObjects: readonly StoredObjectV1[],
      ) => {
        const byId = new Map(projectionObjects.map((object) => [object.objectId, object]));
        return new LibraryProjectionRebuilder(
          {
            listStoredEvents: () => Promise.resolve(projectionEvents),
            getStoredObject: (objectId) => Promise.resolve(byId.get(objectId)),
            replaceLibraryProjections: () => Promise.resolve(),
          },
          keyring,
          vaultId,
          this.artifacts,
        ).prepare(input.signal);
      };
      const [sourceProjections, targetProjections] = await Promise.all([
        prepareProjections(
          input.sourceVaultId,
          input.sourceKeyring,
          input.sourceEvents,
          input.sourceObjects,
        ),
        prepareProjections(input.targetVaultId, input.targetKeyring, events, objects),
      ]);
      const mappedSourceModel = {
        items: sourceProjections.model.items
          .map((item) => ({
            ...item,
            bundleId: mapId("Bundle", item.bundleId),
            descriptorObjectId: mapId("BundleDescriptor", item.descriptorObjectId),
            assignedCollectionId: mapId("Collection", item.assignedCollectionId),
          }))
          .toSorted((left, right) => left.bundleId.localeCompare(right.bundleId)),
        topologyEvents: sourceProjections.model.topologyEvents.map((event) =>
          event.eventType === "CollectionsMerged"
            ? {
                ...event,
                eventId: mapId("Event", event.eventId),
                destinationCollectionId: mapId("Collection", event.destinationCollectionId),
                sourceCollectionIds: event.sourceCollectionIds.map((collectionId) =>
                  mapId("Collection", collectionId),
                ),
              }
            : {
                ...event,
                eventId: mapId("Event", event.eventId),
                mergeEventId: mapId("Event", event.mergeEventId),
              },
        ),
        vaultName: {
          ...sourceProjections.model.vaultName,
          vaultId: input.targetVaultId,
          sourceEventId: mapId("Event", sourceProjections.model.vaultName.sourceEventId),
        },
      };
      if (
        !bytesEqual(
          encodeCanonicalCbor(mappedSourceModel),
          encodeCanonicalCbor(targetProjections.model),
        )
      )
        throw integrity("Replacement Vault differs from the source user-visible model.");

      const targetIds = [...mappings.values()].map((mapping) => mapping.targetId);
      if (new Set(targetIds).size !== targetIds.length)
        throw integrity("Vault replacement generated a duplicate identifier.");

      const generationId = this.randomUuid();
      if (new Set([...targetIds, generationId]).size !== targetIds.length + 1)
        throw integrity("Vault replacement Generation identifier collides.");
      const preparedGeneration = await prepareVaultGeneration({
        rootKey: input.targetKeyring.active().rootKey,
        vaultId: input.targetVaultId,
        keyEpochId: input.targetKeyring.active().keyEpochId,
        deviceId: input.targetDeviceId,
        generationId,
        generationNumber: 0,
        createdAt: this.now(),
        reason: "Initial",
        retainedObjectIds: [],
        retainedEventIds: [],
      });
      return {
        generation: preparedGeneration.generation,
        head: {
          ...preparedGeneration.head,
          appendedObjectIds: objects.map((object) => object.objectId).toSorted(),
          appendedEventIds: events.map((event) => event.eventId).toSorted(),
        },
        objects,
        events,
        projections: targetProjections,
        identifierMappings: [...mappings.values()].toSorted((left, right) =>
          `${left.kind}\0${left.sourceId}`.localeCompare(`${right.kind}\0${right.sourceId}`),
        ),
        preparedArtifactObjectIds,
      };
    } catch (error) {
      await Promise.all(
        preparedArtifactObjectIds.map((objectId) =>
          this.artifacts.remove(input.targetVaultId, objectId),
        ),
      );
      throw error;
    }
  }

  private rewritePayload(
    payload: Record<string, unknown>,
    context: {
      readonly sourceVaultId: string;
      readonly targetVaultId: string;
      readonly targetDeviceId: string;
      readonly mapId: (kind: ReplacementIdentifierMapping["kind"], sourceId: string) => string;
    },
  ): Record<string, unknown> {
    const eventType = string(payload.eventType, "replacementEvent.eventType");
    const common = {
      ...payload,
      vaultId: context.targetVaultId,
      deviceId: context.targetDeviceId,
    };
    const rewrite = (value: unknown): unknown => {
      if (value === undefined) return undefined;
      const input = record(value, "replacementEvent.rewrite");
      return {
        ...input,
        sourceEventId: context.mapId(
          "Event",
          string(input.sourceEventId, "replacementEvent.rewrite.sourceEventId"),
        ),
      };
    };
    if (eventType === "VaultCreated" || eventType === "VaultRenamed") return common;
    if (eventType === "CapturesDeleted" || eventType === "CapturesRestored") {
      if (!Array.isArray(payload.bundleIds))
        throw integrity("Replacement lifecycle Event is invalid.");
      return {
        ...common,
        bundleIds: payload.bundleIds.map((value) =>
          context.mapId("Bundle", string(value, "replacementEvent.bundleId")),
        ),
        ...(payload.rewrite === undefined ? {} : { rewrite: rewrite(payload.rewrite) }),
      };
    }
    if (eventType === "CapturesMoved") {
      if (!Array.isArray(payload.moves)) throw integrity("Replacement move Event is invalid.");
      return {
        ...common,
        moves: payload.moves.map((value) => {
          const move = record(value, "replacementEvent.move");
          return {
            bundleId: context.mapId(
              "Bundle",
              string(move.bundleId, "replacementEvent.move.bundleId"),
            ),
            fromCollectionId: context.mapId(
              "Collection",
              string(move.fromCollectionId, "replacementEvent.move.fromCollectionId"),
            ),
            toCollectionId: context.mapId(
              "Collection",
              string(move.toCollectionId, "replacementEvent.move.toCollectionId"),
            ),
          };
        }),
        ...(payload.revertsEventId === undefined
          ? {}
          : {
              revertsEventId: context.mapId(
                "Event",
                string(payload.revertsEventId, "replacementEvent.revertsEventId"),
              ),
            }),
        ...(payload.rewrite === undefined ? {} : { rewrite: rewrite(payload.rewrite) }),
      };
    }
    if (eventType === "CollectionsMerged") {
      if (!Array.isArray(payload.sourceCollectionIds))
        throw integrity("Replacement merge Event is invalid.");
      return {
        ...common,
        destinationCollectionId: context.mapId(
          "Collection",
          string(payload.destinationCollectionId, "replacementEvent.destinationCollectionId"),
        ),
        sourceCollectionIds: payload.sourceCollectionIds.map((value) =>
          context.mapId("Collection", string(value, "replacementEvent.sourceCollectionId")),
        ),
        ...(payload.rewrite === undefined ? {} : { rewrite: rewrite(payload.rewrite) }),
      };
    }
    if (eventType === "CollectionMergeReverted") {
      return {
        ...common,
        mergeEventId: context.mapId(
          "Event",
          string(payload.mergeEventId, "replacementEvent.mergeEventId"),
        ),
        ...(payload.rewrite === undefined ? {} : { rewrite: rewrite(payload.rewrite) }),
      };
    }
    throw integrity(`Unsupported replacement Event type: ${eventType}`);
  }
}

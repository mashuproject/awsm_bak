import {
  decodeEncryptedEnvelopeBytes,
  decryptEnvelope,
  encodeEncryptedEnvelope,
  encryptEnvelope,
} from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { type BundleDescriptorV1, decodeBundleDescriptor } from "../../domain/artifact-graph";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import type { LibraryItemV1 } from "../../domain/contracts";
import { DomainValidationError } from "../../domain/errors";
import { record, string, uuid } from "../../domain/validation";
import type {
  StoredCollectionProjectionV1,
  StoredEvent,
  StoredObjectV1,
  StoredProjectionV1,
  StoredVaultNameProjectionV1,
} from "../../drivers/indexeddb";
import type { ArtifactStore } from "../artifact";
import { decodeBundleRegisteredPayload, validateArtifactWarnings } from "../capture/contracts";
import type { VaultKeyring } from "../vault/keyring";
import { decodeVaultNameEvent, encryptVaultNameProjection } from "../vault/name-crypto";
import { reduceVaultNameProjection, type VaultNameEventV1 } from "../vault/name-projection";
import type { CollectionTopologyEventV1 } from "./collections";
import { type LibraryProjectionEventV1, reduceLibraryProjection } from "./projection";
import { assertCanonicalEventFields } from "./vacuum";

export interface LibraryProjectionRebuildRepository {
  listStoredEvents(): Promise<readonly StoredEvent[]>;
  getStoredObject(objectId: string): Promise<StoredObjectV1 | undefined>;
  replaceLibraryProjections(
    itemProjections: readonly StoredProjectionV1[],
    collectionProjection: StoredCollectionProjectionV1,
    vaultNameProjection: StoredVaultNameProjectionV1,
  ): Promise<void>;
}

export interface PreparedLibraryProjections {
  readonly itemProjections: readonly StoredProjectionV1[];
  readonly collectionProjection: StoredCollectionProjectionV1;
  readonly vaultNameProjection: StoredVaultNameProjectionV1;
  readonly model: {
    readonly items: readonly LibraryItemV1[];
    readonly topologyEvents: readonly CollectionTopologyEventV1[];
    readonly vaultName: ReturnType<typeof reduceVaultNameProjection>;
  };
}

async function decryptEvent(
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
      throw new DomainValidationError("event", "has a mismatched envelope");
    }
    return record(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "event",
    );
  } finally {
    await wipe(key);
  }
}

async function projectionBytes(
  plaintext: unknown,
  objectId: string,
  contextId: string,
  keyring: VaultKeyring,
  vaultId: string,
): Promise<Uint8Array> {
  const epoch = keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:projection:v1",
    contextId,
    keyVersion: 1,
  });
  try {
    return encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType: "Projection",
        objectId,
        keyEpochId: epoch.keyEpochId,
        plaintext: encodeCanonicalCbor(plaintext),
        key,
      }),
    );
  } finally {
    await wipe(key);
  }
}

export class LibraryProjectionRebuilder {
  constructor(
    readonly repository: LibraryProjectionRebuildRepository,
    readonly keyring: VaultKeyring,
    readonly vaultId: string,
    readonly artifactStore: Pick<ArtifactStore, "openPlaintext">,
  ) {}

  async prepare(signal?: AbortSignal): Promise<PreparedLibraryProjections> {
    signal?.throwIfAborted();
    const events = (await this.repository.listStoredEvents()).toSorted(
      (left, right) =>
        left.orderingTimestamp.localeCompare(right.orderingTimestamp) ||
        left.eventId.localeCompare(right.eventId),
    );
    const itemEvents: LibraryProjectionEventV1[] = [];
    const topologyEvents: CollectionTopologyEventV1[] = [];
    const vaultNameEvents: VaultNameEventV1[] = [];
    for (const event of events) {
      signal?.throwIfAborted();
      const payload = await decryptEvent(event, this.keyring, this.vaultId);
      const eventType = string(payload.eventType, "event.eventType");
      assertCanonicalEventFields(payload, eventType);
      if (eventType === "VaultCreated" || eventType === "VaultRenamed") {
        vaultNameEvents.push(await decodeVaultNameEvent(this.keyring, event));
        continue;
      }
      if (eventType === "BundleRegistered") {
        const registration = decodeBundleRegisteredPayload(payload, event.referencedObjectIds);
        const storedDescriptor = await this.repository.getStoredObject(
          registration.descriptorObjectId,
        );
        if (storedDescriptor?.objectType !== "BundleDescriptor")
          throw new DomainValidationError("event.descriptorObjectId", "does not resolve");
        const envelope = decodeEncryptedEnvelopeBytes(storedDescriptor.envelopeBytes);
        const descriptorEpoch = this.keyring.require(envelope.keyEpochId);
        const descriptorKey = await deriveContextKeyFromCryptoKey(descriptorEpoch.rootKey, {
          vaultId: this.vaultId,
          keyEpochId: descriptorEpoch.keyEpochId,
          domain: "vault:bundle-descriptor:v1",
          contextId: registration.bundleId,
          keyVersion: 1,
        });
        let descriptor: BundleDescriptorV1;
        try {
          if (
            envelope.objectId !== storedDescriptor.objectId ||
            envelope.objectType !== "BundleDescriptor"
          )
            throw new DomainValidationError("descriptor", "has a mismatched envelope");
          descriptor = decodeBundleDescriptor(
            await decryptEnvelope(envelope, descriptorKey, descriptorEpoch.keyEpochId),
          );
        } finally {
          await wipe(descriptorKey);
        }
        if (
          descriptor.bundleId !== registration.bundleId ||
          descriptor.artifacts.map((artifact) => artifact.artifactObjectId).join("\n") !==
            registration.artifactObjectIds.join("\n")
        )
          throw new DomainValidationError("descriptor.artifacts", "does not match Event closure");
        validateArtifactWarnings(
          descriptor.artifacts.map((artifact) => artifact.role),
          registration.warnings,
        );
        let thumbnailWebp: Uint8Array | undefined;
        const thumbnail = descriptor.artifacts.find((artifact) => artifact.role === "THUMBNAIL");
        if (thumbnail !== undefined) {
          const object = await this.repository.getStoredObject(thumbnail.artifactObjectId);
          if (object?.objectType !== "Artifact")
            throw new DomainValidationError("descriptor.artifacts", "has a missing thumbnail");
          const stream = await this.artifactStore.openPlaintext({
            vaultId: this.vaultId,
            object,
            reference: thumbnail,
            keyring: this.keyring,
            ...(signal === undefined ? {} : { signal }),
          });
          thumbnailWebp = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        itemEvents.push({
          eventId: event.eventId,
          eventType,
          bundleId: registration.bundleId,
          descriptorObjectId: registration.descriptorObjectId,
          collectionId: registration.collectionId,
          title: descriptor.metadata.title,
          originalUrl: descriptor.metadata.originalUrl,
          capturedAt: registration.timestamp,
          artifactRoles: descriptor.artifacts.map((artifact) => artifact.role).toSorted(),
          ...(thumbnailWebp === undefined ? {} : { thumbnailWebp }),
          warnings: registration.warnings,
        });
        continue;
      }
      if (eventType === "CapturesDeleted" || eventType === "CapturesRestored") {
        if (!Array.isArray(payload.bundleIds)) {
          throw new DomainValidationError("event.bundleIds", "must be an array");
        }
        itemEvents.push({
          eventId: event.eventId,
          eventType,
          bundleIds: payload.bundleIds.map((value, index) =>
            uuid(value, `event.bundleIds.${String(index)}`),
          ),
        });
        continue;
      }
      if (eventType === "CapturesMoved") {
        if (!Array.isArray(payload.moves)) {
          throw new DomainValidationError("event.moves", "must be an array");
        }
        itemEvents.push({
          eventId: event.eventId,
          eventType,
          moves: payload.moves.map((value, index) => {
            const move = record(value, `event.moves.${String(index)}`);
            return {
              bundleId: uuid(move.bundleId, `event.moves.${String(index)}.bundleId`),
              fromCollectionId: uuid(
                move.fromCollectionId,
                `event.moves.${String(index)}.fromCollectionId`,
              ),
              toCollectionId: uuid(
                move.toCollectionId,
                `event.moves.${String(index)}.toCollectionId`,
              ),
            };
          }),
        });
        continue;
      }
      if (eventType === "CollectionsMerged") {
        if (!Array.isArray(payload.sourceCollectionIds)) {
          throw new DomainValidationError("event.sourceCollectionIds", "must be an array");
        }
        topologyEvents.push({
          eventId: event.eventId,
          eventType,
          destinationCollectionId: uuid(
            payload.destinationCollectionId,
            "event.destinationCollectionId",
          ),
          sourceCollectionIds: payload.sourceCollectionIds.map((value, index) =>
            uuid(value, `event.sourceCollectionIds.${String(index)}`),
          ),
        });
        continue;
      }
      if (eventType === "CollectionMergeReverted") {
        topologyEvents.push({
          eventId: event.eventId,
          eventType,
          mergeEventId: uuid(payload.mergeEventId, "event.mergeEventId"),
        });
        continue;
      }
      throw new Error(`Unsupported Event type during Projection rebuild: ${eventType}`);
    }

    const items = reduceLibraryProjection(itemEvents);
    signal?.throwIfAborted();
    const itemProjections = await Promise.all(
      items.map(
        async (item): Promise<StoredProjectionV1> => ({
          version: 1,
          bundleId: item.bundleId,
          envelopeBytes: await projectionBytes(
            item,
            item.bundleId,
            `LibraryItem-v1:${item.bundleId}`,
            this.keyring,
            this.vaultId,
          ),
        }),
      ),
    );
    signal?.throwIfAborted();
    const collectionProjection: StoredCollectionProjectionV1 = {
      version: 1,
      projectionId: this.vaultId,
      envelopeBytes: await projectionBytes(
        { version: 1, topologyEvents },
        this.vaultId,
        `LibraryCollections-v1:${this.vaultId}`,
        this.keyring,
        this.vaultId,
      ),
    };
    const vaultName = reduceVaultNameProjection(vaultNameEvents);
    const vaultNameProjection = await encryptVaultNameProjection(this.keyring, vaultName);
    signal?.throwIfAborted();
    return {
      itemProjections,
      collectionProjection,
      vaultNameProjection,
      model: { items, topologyEvents, vaultName },
    };
  }

  async execute(): Promise<void> {
    const prepared = await this.prepare();
    await this.repository.replaceLibraryProjections(
      prepared.itemProjections,
      prepared.collectionProjection,
      prepared.vaultNameProjection,
    );
  }
}

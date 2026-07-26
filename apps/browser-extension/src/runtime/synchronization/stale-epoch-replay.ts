import { decodeEncryptedEnvelopeBytes, decryptEnvelope } from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { type ArtifactReferenceV1, decodeBundleDescriptor } from "../../domain/artifact-graph";
import { decodeCanonicalCbor } from "../../domain/cbor";
import { bytesEqual } from "../../domain/hash";
import { record } from "../../domain/validation";
import type { StoredEvent, StoredObjectV1 } from "../../drivers/indexeddb/schema";
import type { ArtifactStore, PreparedArtifact } from "../artifact";
import {
  type BundleRegisteredPayloadV1,
  decodeBundleRegisteredPayload,
} from "../capture/contracts";
import { type PreparedCaptureArtifact, prepareCaptureRegistration } from "../capture/registration";
import type { VaultKeyring } from "../vault/keyring";

function conflict(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_CONFLICT" });
}

async function decryptEvent(
  event: StoredEvent,
  vaultId: string,
  keyring: VaultKeyring,
): Promise<BundleRegisteredPayloadV1> {
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
    if (envelope.objectType !== "Event" || envelope.objectId !== event.eventId)
      throw conflict("The stale Event envelope identity differs.");
    const payload = record(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "staleEvent",
    );
    if (payload.eventType !== "BundleRegistered")
      throw conflict(
        "This unpublished operation cannot be replayed automatically. Create a Complete Export before resolving synchronization.",
      );
    return decodeBundleRegisteredPayload(payload, event.referencedObjectIds);
  } finally {
    await wipe(key);
  }
}

async function decryptDescriptor(
  object: Extract<StoredObjectV1, { readonly objectType: "BundleDescriptor" }>,
  bundleId: string,
  vaultId: string,
  keyring: VaultKeyring,
) {
  const envelope = decodeEncryptedEnvelopeBytes(object.envelopeBytes);
  const epoch = keyring.require(envelope.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:bundle-descriptor:v1",
    contextId: bundleId,
    keyVersion: 1,
  });
  try {
    if (envelope.objectType !== "BundleDescriptor" || envelope.objectId !== object.objectId)
      throw conflict("The stale Bundle Descriptor identity differs.");
    return decodeBundleDescriptor(await decryptEnvelope(envelope, key, epoch.keyEpochId));
  } finally {
    await wipe(key);
  }
}

async function* plaintextChunks(
  stream: ReadableStream<Uint8Array>,
  copied?: Uint8Array[],
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      const chunk = Uint8Array.from(next.value);
      copied?.push(chunk);
      yield chunk;
    }
  } finally {
    reader.releaseLock();
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export interface PreparedStaleCaptureReplay {
  readonly oldBundleId: string;
  readonly oldEventId: string;
  readonly oldObjectIds: readonly string[];
  readonly objectIdMappings: readonly {
    readonly sourceObjectId: string;
    readonly targetObjectId: string;
  }[];
  readonly registration: Awaited<ReturnType<typeof prepareCaptureRegistration>>;
  readonly preparedArtifactObjectIds: readonly string[];
}

export async function prepareStaleCaptureReplay(input: {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly event: StoredEvent;
  readonly objects: ReadonlyMap<string, StoredObjectV1>;
  readonly keyring: VaultKeyring;
  readonly artifacts: Pick<ArtifactStore, "openPlaintext" | "prepare" | "remove">;
  readonly uuid?: () => string;
  readonly signal?: AbortSignal;
  readonly target?: {
    readonly vaultId: string;
    readonly deviceId: string;
    readonly keyring: VaultKeyring;
    readonly collectionId: string;
    readonly eventId?: string;
  };
}): Promise<PreparedStaleCaptureReplay> {
  const uuid = input.uuid ?? (() => crypto.randomUUID());
  const payload = await decryptEvent(input.event, input.vaultId, input.keyring);
  if (payload.vaultId !== input.vaultId)
    throw conflict("The stale capture belongs to another Vault.");
  const storedDescriptor = input.objects.get(payload.descriptorObjectId);
  if (storedDescriptor?.objectType !== "BundleDescriptor")
    throw conflict("The stale capture Bundle Descriptor is unavailable.");
  const descriptor = await decryptDescriptor(
    storedDescriptor,
    payload.bundleId,
    input.vaultId,
    input.keyring,
  );
  if (
    descriptor.bundleId !== payload.bundleId ||
    descriptor.artifacts
      .map((artifact) => artifact.artifactObjectId)
      .toSorted()
      .join("\n") !== [...payload.artifactObjectIds].toSorted().join("\n")
  )
    throw conflict("The stale capture graph is inconsistent.");
  const preparedArtifacts: PreparedCaptureArtifact[] = [];
  const preparedArtifactObjectIds: string[] = [];
  const objectIdMappings: {
    sourceObjectId: string;
    targetObjectId: string;
  }[] = [];
  const thumbnailChunks: Uint8Array[] = [];
  try {
    for (const reference of descriptor.artifacts) {
      input.signal?.throwIfAborted();
      const stored = input.objects.get(reference.artifactObjectId);
      if (stored?.objectType !== "Artifact")
        throw conflict("A stale capture Artifact is unavailable.");
      const objectId = uuid();
      objectIdMappings.push({
        sourceObjectId: reference.artifactObjectId,
        targetObjectId: objectId,
      });
      const copied = reference.role === "THUMBNAIL" ? thumbnailChunks : undefined;
      const plaintext = await input.artifacts.openPlaintext({
        vaultId: input.vaultId,
        object: stored,
        reference,
        keyring: input.keyring,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const prepared: PreparedArtifact = await input.artifacts.prepare({
        vaultId: input.target?.vaultId ?? input.vaultId,
        objectId,
        keyring: input.target?.keyring ?? input.keyring,
        plaintext: plaintextChunks(plaintext, copied),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      preparedArtifactObjectIds.push(objectId);
      if (
        prepared.plaintextByteLength !== reference.plaintextByteLength ||
        !bytesEqual(prepared.plaintextChecksum, reference.plaintextChecksum)
      )
        throw conflict("A replayed Artifact differs from the unpublished capture.");
      const replayedReference: ArtifactReferenceV1 = {
        ...reference,
        artifactObjectId: objectId,
      };
      preparedArtifacts.push({
        object: prepared.object,
        reference: replayedReference,
      });
    }
    const registration = await prepareCaptureRegistration({
      keyring: input.target?.keyring ?? input.keyring,
      vaultId: input.target?.vaultId ?? input.vaultId,
      deviceId: input.target?.deviceId ?? input.deviceId,
      commandId: uuid(),
      bundleId: uuid(),
      descriptorObjectId: uuid(),
      eventId: input.target?.eventId ?? uuid(),
      collectionId: input.target?.collectionId ?? payload.collectionId,
      capturedAt: payload.timestamp,
      metadata: descriptor.metadata,
      artifacts: preparedArtifacts,
      ...(thumbnailChunks.length === 0 ? {} : { thumbnailWebp: concatenate(thumbnailChunks) }),
      warnings: payload.warnings,
      clientVersion: descriptor.clientVersion,
    });
    const registeredDescriptor = registration.objects[0];
    if (registeredDescriptor === undefined)
      throw new Error("The replacement Bundle registration has no descriptor.");
    return {
      oldBundleId: payload.bundleId,
      oldEventId: input.event.eventId,
      oldObjectIds: [...input.event.referencedObjectIds],
      objectIdMappings: [
        {
          sourceObjectId: payload.descriptorObjectId,
          targetObjectId: registeredDescriptor.objectId,
        },
        ...objectIdMappings,
      ],
      registration,
      preparedArtifactObjectIds,
    };
  } catch (error) {
    await Promise.all(
      preparedArtifactObjectIds.map((objectId) =>
        input.artifacts.remove(input.target?.vaultId ?? input.vaultId, objectId),
      ),
    );
    throw error;
  }
}

import { encodeEncryptedEnvelope, encryptEnvelope } from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import {
  type ArtifactReferenceV1,
  type BundleDescriptorV1,
  type CaptureMetadataV1,
  decodeBundleDescriptor,
  encodeBundleDescriptor,
} from "../../domain/artifact-graph";
import { encodeCanonicalCbor } from "../../domain/cbor";
import type { CaptureWarningId } from "../../domain/contracts";
import type { AtomicRegistrationV1, StoredArtifactObjectV1 } from "../../drivers/indexeddb";
import { reduceLibraryProjection } from "../library/projection";
import type { VaultKeyring } from "../vault/keyring";
import { decodeBundleRegisteredPayload, validateArtifactWarnings } from "./contracts";

export interface PreparedCaptureArtifact {
  readonly object: StoredArtifactObjectV1;
  readonly reference: ArtifactReferenceV1;
}

export interface PrepareCaptureRegistrationInput {
  readonly keyring: VaultKeyring;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly commandId: string;
  readonly bundleId: string;
  readonly descriptorObjectId: string;
  readonly eventId: string;
  readonly collectionId: string;
  readonly capturedAt: string;
  readonly metadata: CaptureMetadataV1;
  readonly artifacts: readonly PreparedCaptureArtifact[];
  readonly thumbnailWebp?: Uint8Array;
  readonly warnings: readonly CaptureWarningId[];
  readonly clientVersion: string;
}

async function encryptedBytes(
  input: PrepareCaptureRegistrationInput,
  domain: "vault:bundle-descriptor:v1" | "vault:event:v1" | "vault:projection:v1",
  contextId: string,
  objectType: "BundleDescriptor" | "Event" | "Projection",
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

export async function prepareCaptureRegistration(
  input: PrepareCaptureRegistrationInput,
): Promise<AtomicRegistrationV1> {
  const artifacts = [...input.artifacts].toSorted((left, right) =>
    left.object.objectId.localeCompare(right.object.objectId),
  );
  if (
    artifacts.length === 0 ||
    artifacts.some((artifact) => artifact.object.objectId !== artifact.reference.artifactObjectId)
  )
    throw new Error("Every prepared Artifact must match its descriptor reference.");

  const descriptor: BundleDescriptorV1 = {
    descriptorVersion: 1,
    bundleId: input.bundleId,
    createdAt: input.capturedAt,
    clientVersion: input.clientVersion,
    captureProfileId: "WebPageSnapshot-v1",
    captureAdapterVersion: 1,
    metadata: input.metadata,
    artifacts: artifacts.map((artifact) => artifact.reference),
  };
  const descriptorPlaintext = encodeBundleDescriptor(descriptor);
  decodeBundleDescriptor(descriptorPlaintext);

  const artifactObjectIds = artifacts.map((artifact) => artifact.object.objectId);
  validateArtifactWarnings(
    artifacts.map((artifact) => artifact.reference.role),
    input.warnings,
  );
  const referencedObjectIds = [input.descriptorObjectId, ...artifactObjectIds].toSorted();
  const payload = decodeBundleRegisteredPayload(
    {
      version: 1,
      eventType: "BundleRegistered",
      eventVersion: 1,
      payloadVersion: 1,
      vaultId: input.vaultId,
      deviceId: input.deviceId,
      timestamp: input.capturedAt,
      protocolVersion: 1,
      correlationId: input.commandId,
      bundleId: input.bundleId,
      descriptorObjectId: input.descriptorObjectId,
      artifactObjectIds,
      collectionId: input.collectionId,
      captureProfileId: "WebPageSnapshot-v1",
      warnings: [...input.warnings].toSorted(),
    },
    referencedObjectIds,
  );
  const projection = reduceLibraryProjection([
    {
      eventId: input.eventId,
      eventType: "BundleRegistered",
      bundleId: input.bundleId,
      descriptorObjectId: input.descriptorObjectId,
      collectionId: input.collectionId,
      title: input.metadata.title,
      originalUrl: input.metadata.originalUrl,
      capturedAt: input.capturedAt,
      artifactRoles: artifacts.map((artifact) => artifact.reference.role).toSorted(),
      ...(input.thumbnailWebp === undefined ? {} : { thumbnailWebp: input.thumbnailWebp }),
      warnings: payload.warnings,
    },
  ])[0];
  if (projection === undefined) throw new Error("BundleRegistered did not produce a Projection.");

  const [descriptorEnvelopeBytes, eventEnvelopeBytes, projectionEnvelopeBytes] = await Promise.all([
    encryptedBytes(
      input,
      "vault:bundle-descriptor:v1",
      input.bundleId,
      "BundleDescriptor",
      input.descriptorObjectId,
      descriptorPlaintext,
    ),
    encryptedBytes(
      input,
      "vault:event:v1",
      input.eventId,
      "Event",
      input.eventId,
      encodeCanonicalCbor(payload),
    ),
    encryptedBytes(
      input,
      "vault:projection:v1",
      `LibraryItem-v1:${input.bundleId}`,
      "Projection",
      input.bundleId,
      encodeCanonicalCbor(projection),
    ),
  ]);

  return {
    objects: [
      {
        version: 1,
        objectId: input.descriptorObjectId,
        objectType: "BundleDescriptor",
        envelopeBytes: descriptorEnvelopeBytes,
      },
      ...artifacts.map((artifact) => artifact.object),
    ],
    graph: {
      bundleId: input.bundleId,
      descriptorObjectId: input.descriptorObjectId,
      artifactObjectIds,
    },
    event: {
      version: 1,
      vaultId: input.vaultId,
      eventId: input.eventId,
      referencedObjectIds,
      orderingTimestamp: input.capturedAt,
      envelopeBytes: eventEnvelopeBytes,
    },
    projection: {
      version: 1,
      bundleId: input.bundleId,
      envelopeBytes: projectionEnvelopeBytes,
    },
    outcome: {
      version: 1,
      commandId: input.commandId,
      status: "Succeeded",
      bundleId: input.bundleId,
      descriptorObjectId: input.descriptorObjectId,
      eventId: input.eventId,
    },
  };
}

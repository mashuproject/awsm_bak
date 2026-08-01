import { digestArtifactPayload } from "../../crypto/artifact-stream";
import { sealCompactItem } from "../../crypto/compact";
import { DEPENDENCY_TYPES } from "../../domain/canonical/dependencies";
import { advisoryExtensions } from "../../domain/canonical/features";
import { type Identifier, identifier, randomIdentifier } from "../../domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  BUNDLE_DESCRIPTOR_OBJECT,
  encodeVaultObject,
  type VaultObject,
} from "../../domain/canonical/object";
import { type AuthenticatedVaultEvent, signVaultEvent } from "../../domain/canonical/record";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { FRAME_PLAINTEXT_LIMIT, type OpaqueEnvelope } from "../../storage/opaque-envelope";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../artifact/canonical-store";
import { validatePageSnapshot } from "../page-snapshot";
import type { CanonicalReplicaState } from "../vault/canonical-local-state";
import {
  type OpenedCanonicalVault,
  requireCanonicalClientSecret,
} from "../vault/canonical-service";

const FRAME_TAG_LENGTH = 16;

export interface CaptureWarning {
  readonly key: string;
  readonly detail: Uint8Array;
}

export interface CanonicalPrimaryCaptureInput {
  readonly blob: Blob;
}

export interface PreparedCanonicalCapture {
  readonly bundleId: Identifier<"Bundle">;
  readonly assignedCollectionId: Identifier<"Collection">;
  readonly artifactId: Identifier<"Artifact">;
  readonly artifactObject: VaultObject;
  readonly artifactObjectEnvelope: OpaqueEnvelope;
  readonly artifactRepresentation: PreparedArtifactRepresentation;
  readonly descriptorObject: VaultObject;
  readonly descriptorObjectEnvelope: OpaqueEnvelope;
  readonly event: AuthenticatedVaultEvent;
  readonly eventEnvelope: OpaqueEnvelope;
  readonly nextReplicaState: CanonicalReplicaState;
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

function canonicalUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

function formatOnlyBytes(): Uint8Array {
  return encodeCanonicalValue(indexedMap(1));
}

async function* blobSource(blob: Blob): AsyncIterable<Uint8Array> {
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      for (let offset = 0; offset < next.value.byteLength; offset += FRAME_PLAINTEXT_LIMIT) {
        yield next.value.slice(
          offset,
          Math.min(offset + FRAME_PLAINTEXT_LIMIT, next.value.byteLength),
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function prepareCanonicalCapture(input: {
  readonly vault: OpenedCanonicalVault;
  readonly artifactStore: CanonicalArtifactStore;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly capturedAt: number | bigint;
  readonly primary: CanonicalPrimaryCaptureInput;
  readonly warnings?: readonly CaptureWarning[];
  readonly bundleId?: Identifier<"Bundle">;
  readonly assignedCollectionId?: Identifier<"Collection">;
  readonly artifactProtectionParameters?: Uint8Array;
  readonly artifactObjectProtectionParameters?: Uint8Array;
  readonly descriptorProtectionParameters?: Uint8Array;
  readonly eventProtectionParameters?: Uint8Array;
}): Promise<PreparedCanonicalCapture> {
  const { vault } = input;
  const clientSecret = requireCanonicalClientSecret(vault);
  if (vault.replicaState.lifecycle !== 1) throw new TypeError("Closed Vaults cannot Capture");
  const bundleId = input.bundleId ?? randomIdentifier("Bundle");
  const assignedCollectionId = input.assignedCollectionId ?? randomIdentifier("Collection");
  let snapshot: Awaited<ReturnType<typeof validatePageSnapshot>>;
  try {
    snapshot = await validatePageSnapshot(input.primary.blob);
  } catch (error) {
    throw new TypeError("Primary Artifact is not a valid canonical page snapshot", {
      cause: error,
    });
  }
  if (
    BigInt(snapshot.manifest.capturedAt) !== BigInt(input.capturedAt) ||
    snapshot.manifest.originalUrl !== canonicalUrl(input.originalUrl) ||
    snapshot.manifest.finalUrl !== canonicalUrl(input.finalUrl)
  ) {
    throw new TypeError("Page snapshot provenance does not match the Capture Descriptor");
  }
  const plaintextLength = input.primary.blob.size;
  const plaintextDigest = await digestArtifactPayload({
    plaintextLength,
    source: blobSource(input.primary.blob),
  });
  const protectedDigest = identifier("Artifact", plaintextDigest);
  const artifactObject = encodeVaultObject({
    vaultId: vault.replicaState.vaultId,
    objectType: ARTIFACT_OBJECT,
    requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
    extensions: advisoryExtensions([]),
    body: indexedMap(
      1,
      "awsm.artifact.capture",
      "application/vnd.awsm.web-page+zip",
      "awsm.representation.web-page-zip",
      plaintextLength,
      protectedDigest,
      indexedMap(1, FRAME_PLAINTEXT_LIMIT, FRAME_TAG_LENGTH, plaintextLength, protectedDigest),
      formatOnlyBytes(),
    ),
  });
  const logicalArtifactId = artifactId(artifactObject);
  let artifactRepresentation: PreparedArtifactRepresentation | undefined;
  try {
    artifactRepresentation = await input.artifactStore.prepare({
      vaultId: vault.replicaState.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      artifactId: logicalArtifactId,
      contract: { plaintextLength, plaintextDigest },
      source: blobSource(input.primary.blob),
      ...(input.artifactProtectionParameters === undefined
        ? {}
        : { protectionParameters: input.artifactProtectionParameters }),
    });
    const artifactObjectEnvelope = await sealCompactItem({
      vaultId: vault.replicaState.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      payloadType: 2,
      payloadBytes: artifactObject.bytes,
      ...(input.artifactObjectProtectionParameters === undefined
        ? {}
        : { protectionParameters: input.artifactObjectProtectionParameters }),
    });
    const descriptorObject = encodeVaultObject({
      vaultId: vault.replicaState.vaultId,
      objectType: BUNDLE_DESCRIPTOR_OBJECT,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        bundleId,
        input.capturedAt,
        canonicalUrl(input.originalUrl),
        canonicalUrl(input.finalUrl),
        "awsm.capture.web-page-snapshot",
        "awsm.adapter.browser-web-page",
        1,
        input.title,
        canonicalSet([indexedMap(artifactObject.objectId, "awsm.artifact.primary")]),
        canonicalSet((input.warnings ?? []).map(({ key, detail }) => indexedMap(key, detail))),
        indexedMap(1, formatOnlyBytes()),
      ),
    });
    const descriptorObjectEnvelope = await sealCompactItem({
      vaultId: vault.replicaState.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      payloadType: 2,
      payloadBytes: descriptorObject.bytes,
      ...(input.descriptorProtectionParameters === undefined
        ? {}
        : { protectionParameters: input.descriptorProtectionParameters }),
    });
    const event = await signVaultEvent(
      {
        vaultId: vault.replicaState.vaultId,
        generationId: vault.replicaState.generationId,
        parentRecordIds: vault.replicaState.causalFrontier,
        authorityParentRecordIds: vault.replicaState.authorityFrontier,
        dependencies: [
          { type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptorObject.objectId },
        ],
        requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 2,
        type: 3,
        signerCredentialId: clientSecret.clientCredentialId,
        assertedAt: input.capturedAt,
        body: indexedMap(bundleId, descriptorObject.objectId, assignedCollectionId),
      },
      clientSecret.signingSecretKey,
    );
    const eventEnvelope = await sealCompactItem({
      vaultId: vault.replicaState.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      payloadType: 1,
      payloadBytes: event.bytes,
      ...(input.eventProtectionParameters === undefined
        ? {}
        : { protectionParameters: input.eventProtectionParameters }),
    });
    return {
      bundleId,
      assignedCollectionId,
      artifactId: logicalArtifactId,
      artifactObject,
      artifactObjectEnvelope,
      artifactRepresentation,
      descriptorObject,
      descriptorObjectEnvelope,
      event,
      eventEnvelope,
      nextReplicaState: {
        ...vault.replicaState,
        causalFrontier: [event.recordId],
      },
    };
  } catch (error) {
    await artifactRepresentation?.discard().catch(() => undefined);
    throw error;
  }
}

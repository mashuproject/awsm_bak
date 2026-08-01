import { describe, expect, it } from "vitest";

import { digestArtifactPayload, sealArtifactFrames } from "../../src/crypto/artifact-stream";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import { ARTIFACT_OBJECT, artifactId, encodeVaultObject } from "../../src/domain/canonical/object";
import { concatBytes } from "../../src/domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  encodeCanonicalValue,
} from "../../src/domain/canonical/value";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../../src/runtime/artifact/canonical-store";
import { verifyCanonicalArtifactRepresentation } from "../../src/runtime/artifact/canonical-verify";
import {
  prepareForkArtifactRepresentation,
  rebuildForkVaultObject,
} from "../../src/runtime/vault/canonical-fork-content";
import { decodeOpaqueEnvelope, FRAME_PLAINTEXT_LIMIT } from "../../src/storage/opaque-envelope";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

async function* chunks(payload: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < payload.byteLength; offset += size) {
    yield payload.slice(offset, Math.min(offset + size, payload.byteLength));
  }
}

class SourceArtifactStore implements CanonicalArtifactStore {
  constructor(readonly envelope: Uint8Array) {}

  async prepare(): Promise<PreparedArtifactRepresentation> {
    throw new Error("Source store cannot prepare");
  }

  async has(): Promise<boolean> {
    return true;
  }

  async open(): Promise<ReadableStream<Uint8Array>> {
    const envelope = this.envelope;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(envelope.slice(0, 5));
        controller.enqueue(envelope.slice(5, 17));
        controller.enqueue(envelope.slice(17, 131));
        controller.enqueue(envelope.slice(131));
        controller.close();
      },
    });
  }

  async remove(): Promise<void> {}
}

class DestinationArtifactStore implements CanonicalArtifactStore {
  plaintext: Uint8Array | undefined;

  async prepare(
    input: Parameters<CanonicalArtifactStore["prepare"]>[0],
  ): Promise<PreparedArtifactRepresentation> {
    const plaintextChunks: Uint8Array[] = [];
    const encodedFrames: Uint8Array[] = [];
    const source = (async function* () {
      for await (const chunk of input.source) {
        plaintextChunks.push(Uint8Array.from(chunk));
        yield chunk;
      }
    })();
    const stream = await sealArtifactFrames({
      ...input,
      source,
      protectionParameters: new Uint8Array(64).fill(91),
      writeFrame: async (frame) => {
        encodedFrames.push(Uint8Array.from(frame));
      },
    });
    this.plaintext = concatBytes(plaintextChunks);
    const envelope = concatBytes([stream.envelopePrefix.prefixBytes, ...encodedFrames]);
    const decoded = decodeOpaqueEnvelope(envelope);
    return {
      artifactId: input.artifactId,
      storageItemId: decoded.storageItemId,
      envelopeByteLength: envelope.byteLength,
      stream,
      promote: async () => undefined,
      discard: async () => undefined,
    };
  }

  async has(): Promise<boolean> {
    return false;
  }

  async open(): Promise<ReadableStream<Uint8Array>> {
    throw new Error("Destination store cannot open before promotion");
  }

  async remove(): Promise<void> {}
}

describe("canonical Fork Artifact preparation", () => {
  it("authenticates and re-encrypts a multi-frame wrapper with bounded plaintext chunks", async () => {
    const sourceVaultId = filled("Vault", 60);
    const destinationVaultId = filled("Vault", 61);
    const sourceEpochKey = new Uint8Array(32).fill(62);
    const destinationEpochKey = new Uint8Array(32).fill(63);
    const sourceEpochId = keyEpochId(sourceVaultId, sourceEpochKey);
    const destinationEpochId = keyEpochId(destinationVaultId, destinationEpochKey);
    const payload = Uint8Array.from(
      { length: FRAME_PLAINTEXT_LIMIT + 37 },
      (_, index) => index % 251,
    );
    const plaintextDigest = await digestArtifactPayload({
      plaintextLength: payload.byteLength,
      source: chunks(payload, 271_111),
    });
    const sourceObject = encodeVaultObject({
      vaultId: sourceVaultId,
      objectType: ARTIFACT_OBJECT,
      requiredFeatureSetId: filled("RequiredFeatureSet", 64),
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        "awsm.artifact.capture",
        "application/vnd.awsm.web-page+zip",
        "awsm.representation.web-page-zip",
        payload.byteLength,
        plaintextDigest,
        indexedMap(1, FRAME_PLAINTEXT_LIMIT, 16, payload.byteLength, plaintextDigest),
        encodeCanonicalValue(indexedMap(1)),
      ),
    });
    const destinationObject = rebuildForkVaultObject({
      source: sourceObject,
      destinationVaultId,
      requiredFeatureSetId: filled("RequiredFeatureSet", 65),
      mapIdentifier: () => {
        throw new Error("Artifact bodies contain no remapped identities");
      },
    });
    const sourceFrames: Uint8Array[] = [];
    const sourceStream = await sealArtifactFrames({
      vaultId: sourceVaultId,
      keyEpochId: sourceEpochId,
      keyEpochKey: sourceEpochKey,
      artifactId: artifactId(sourceObject),
      contract: { plaintextLength: payload.byteLength, plaintextDigest },
      source: chunks(payload, 333_333),
      protectionParameters: new Uint8Array(64).fill(66),
      writeFrame: async (frame) => {
        sourceFrames.push(Uint8Array.from(frame));
      },
    });
    const sourceEnvelope = concatBytes([sourceStream.envelopePrefix.prefixBytes, ...sourceFrames]);
    const sourceStore = new SourceArtifactStore(sourceEnvelope);
    const destinationStore = new DestinationArtifactStore();

    const verified = await verifyCanonicalArtifactRepresentation({
      store: sourceStore,
      storageItemId: decodeOpaqueEnvelope(sourceEnvelope).storageItemId,
      object: sourceObject,
      keyEpochId: sourceEpochId,
      keyEpochKey: sourceEpochKey,
      writePlaintext: async () => undefined,
    });
    expect(verified.byteLength).toBe(sourceEnvelope.byteLength);
    expect(verified.byteDigest).toHaveLength(32);

    const prepared = await prepareForkArtifactRepresentation({
      sourceStore,
      destinationStore,
      sourceStorageItemId: decodeOpaqueEnvelope(sourceEnvelope).storageItemId,
      sourceObject,
      sourceKeyEpochId: sourceEpochId,
      sourceKeyEpochKey: sourceEpochKey,
      destinationObject,
      destinationKeyEpochId: destinationEpochId,
      destinationKeyEpochKey: destinationEpochKey,
    });

    expect(destinationStore.plaintext).toEqual(payload);
    expect(prepared.artifactId).toEqual(artifactId(destinationObject));
    expect(prepared.storageItemId).not.toEqual(decodeOpaqueEnvelope(sourceEnvelope).storageItemId);
  }, 20_000);
});

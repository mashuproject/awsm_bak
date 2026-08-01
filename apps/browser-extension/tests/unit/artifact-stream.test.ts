import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import {
  digestArtifactPayload,
  type EncryptedArtifactFrame,
  openArtifactFrames,
  sealArtifactFrames,
} from "../../src/crypto/artifact-stream";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import { concatBytes, transcript } from "../../src/domain/canonical/transcript";
import { decodeOpaqueEnvelope, FRAME_PLAINTEXT_LIMIT } from "../../src/storage/opaque-envelope";

function id<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, fill: number) {
  return identifier(kind, new Uint8Array(32).fill(fill));
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function* chunks(payload: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < payload.byteLength; offset += size) {
    yield payload.slice(offset, Math.min(offset + size, payload.byteLength));
  }
}

describe("bounded Artifact frame encryption", () => {
  it("streams multi-frame payloads without changing the logical contract", async () => {
    const vaultId = id("Vault", 1);
    const epochKey = new Uint8Array(32).fill(2);
    const epochId = keyEpochId(vaultId, epochKey);
    const artifactId = id("Artifact", 3);
    const payload = Uint8Array.from(
      { length: FRAME_PLAINTEXT_LIMIT * 2 + 17 },
      (_, index) => index % 251,
    );
    const contract = {
      plaintextLength: payload.byteLength,
      plaintextDigest: sha256(transcript("awsm:artifact-payload:v1", [payload])),
    };
    await expect(
      digestArtifactPayload({
        plaintextLength: payload.byteLength,
        source: chunks(payload, 271_111),
      }),
    ).resolves.toEqual(contract.plaintextDigest);
    const protectionParameters = new Uint8Array(64).fill(4);
    const frames: EncryptedArtifactFrame[] = [];
    const encodedFrames: Uint8Array[] = [];
    const sealed = await sealArtifactFrames({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      artifactId,
      contract,
      source: chunks(payload, 333_333),
      protectionParameters,
      writeFrame: async (encoded, metadata) => {
        encodedFrames.push(Uint8Array.from(encoded));
        frames.push({ ...metadata, ciphertext: Uint8Array.from(metadata.ciphertext) });
      },
    });
    expect(sealed.frameCount).toBe(3);
    expect(frames.map(({ final }) => final)).toEqual([false, false, true]);
    const completeEnvelope = concatBytes([sealed.envelopePrefix.prefixBytes, ...encodedFrames]);
    expect(decodeOpaqueEnvelope(completeEnvelope).payload).toEqual(concatBytes(encodedFrames));

    const openedChunks: Uint8Array[] = [];
    const result = await openArtifactFrames({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      artifactId,
      contract,
      protectionParameters,
      ciphertextLength: sealed.ciphertextLength,
      ciphertextDigest: sealed.ciphertextDigest,
      frames: chunksOfFrames(frames),
      writePlaintext: async (plaintext) => {
        openedChunks.push(Uint8Array.from(plaintext));
      },
    });
    expect(result.frameCount).toBe(3);
    expect(concatBytes(openedChunks)).toEqual(payload);
    expect(hex(sealed.ciphertextDigest)).toBe(
      "ae339c468fadb168b3982039566f8e3ec3b4afaf5da9f9666f80aba1aaea6205",
    );
  }, 20_000);

  it("encodes an empty Artifact as one authenticated final frame", async () => {
    const vaultId = id("Vault", 10);
    const epochKey = new Uint8Array(32).fill(11);
    const epochId = keyEpochId(vaultId, epochKey);
    const frames: EncryptedArtifactFrame[] = [];
    const contract = {
      plaintextLength: 0,
      plaintextDigest: sha256(transcript("awsm:artifact-payload:v1", [new Uint8Array()])),
    };
    const sealed = await sealArtifactFrames({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      artifactId: id("Artifact", 12),
      contract,
      source: chunks(new Uint8Array(), 1),
      protectionParameters: new Uint8Array(64).fill(13),
      writeFrame: async (_encoded, metadata) => {
        frames.push(metadata);
      },
    });
    expect(sealed.frameCount).toBe(1);
    expect(frames[0]?.final).toBe(true);
    expect(frames[0]?.ciphertext.byteLength).toBe(16);
  });

  it("fails the complete stream when a frame or final contract is wrong", async () => {
    const vaultId = id("Vault", 20);
    const epochKey = new Uint8Array(32).fill(21);
    const epochId = keyEpochId(vaultId, epochKey);
    const artifactId = id("Artifact", 22);
    const payload = new Uint8Array(FRAME_PLAINTEXT_LIMIT + 1).fill(23);
    const contract = {
      plaintextLength: payload.byteLength,
      plaintextDigest: sha256(transcript("awsm:artifact-payload:v1", [payload])),
    };
    const frames: EncryptedArtifactFrame[] = [];
    const sealed = await sealArtifactFrames({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      artifactId,
      contract,
      source: chunks(payload, FRAME_PLAINTEXT_LIMIT),
      protectionParameters: new Uint8Array(64).fill(24),
      writeFrame: async (_encoded, metadata) => {
        frames.push({ ...metadata, ciphertext: Uint8Array.from(metadata.ciphertext) });
      },
    });
    const tampered = frames.map((frame) => ({
      ...frame,
      ciphertext: Uint8Array.from(frame.ciphertext),
    }));
    const last = tampered.at(-1);
    if (last === undefined) throw new Error("missing fixture frame");
    last.ciphertext[last.ciphertext.length - 1] =
      (last.ciphertext[last.ciphertext.length - 1] ?? 0) ^ 1;
    await expect(
      openArtifactFrames({
        vaultId,
        keyEpochId: epochId,
        keyEpochKey: epochKey,
        artifactId,
        contract,
        protectionParameters: sealed.protectionParameters,
        ciphertextLength: sealed.ciphertextLength,
        ciphertextDigest: sealed.ciphertextDigest,
        frames: chunksOfFrames(tampered),
        writePlaintext: async () => undefined,
      }),
    ).rejects.toThrow();
  });
});

async function* chunksOfFrames(
  frames: readonly EncryptedArtifactFrame[],
): AsyncIterable<EncryptedArtifactFrame> {
  yield* frames;
}

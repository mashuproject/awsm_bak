import { sha256 } from "@noble/hashes/sha2.js";

import type { Identifier } from "../domain/canonical/identifiers";
import { concatBytes, uint8, uint32be, uint64be } from "../domain/canonical/transcript";
import { bytesEqual } from "../domain/hash";
import {
  encodeOpaqueEnvelopePrefix,
  encodeStreamFrame,
  FRAME_PLAINTEXT_LIMIT,
  FRAME_TAG_LENGTH,
  type OpaqueEnvelopePrefix,
  STREAMABLE_STORAGE_CLASS,
} from "../storage/opaque-envelope";
import { artifactWrapperKey, frameNonce } from "./canonical";
import { xchachaDecrypt, xchachaEncrypt } from "./xchacha";

export interface ArtifactPayloadContract {
  readonly plaintextLength: number;
  readonly plaintextDigest: Uint8Array;
}

export interface EncryptedArtifactFrame {
  readonly index: number;
  readonly final: boolean;
  readonly ciphertext: Uint8Array;
}

export interface SealedArtifactStream {
  readonly protectionParameters: Uint8Array;
  readonly frameCount: number;
  readonly ciphertextLength: number;
  readonly ciphertextDigest: Uint8Array;
  readonly envelopePrefix: OpaqueEnvelopePrefix;
}

const encoder = new TextEncoder();

function artifactDigestHasher(totalLength: number) {
  const hasher = sha256.create();
  hasher.update(
    concatBytes([
      encoder.encode("awsm:artifact-payload:v1"),
      Uint8Array.of(0),
      uint32be(1),
      uint64be(totalLength),
    ]),
  );
  return hasher;
}

function assertContract(contract: ArtifactPayloadContract): void {
  if (!Number.isSafeInteger(contract.plaintextLength) || contract.plaintextLength < 0) {
    throw new TypeError("Artifact plaintext length must be a nonnegative safe integer");
  }
  if (contract.plaintextDigest.byteLength !== 32) {
    throw new TypeError("Artifact plaintext digest must contain exactly 32 bytes");
  }
  const frameCount = Math.max(1, Math.ceil(contract.plaintextLength / FRAME_PLAINTEXT_LIMIT));
  if (frameCount > 0x1_0000_0000) throw new RangeError("Artifact frame count exceeds uint32");
}

export async function digestArtifactPayload(input: {
  readonly plaintextLength: number;
  readonly source: AsyncIterable<Uint8Array>;
}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(input.plaintextLength) || input.plaintextLength < 0) {
    throw new TypeError("Artifact plaintext length must be a nonnegative safe integer");
  }
  const hasher = artifactDigestHasher(input.plaintextLength);
  let observedLength = 0;
  for await (const chunk of input.source) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > FRAME_PLAINTEXT_LIMIT) {
      throw new TypeError(
        "Artifact source chunks must be Uint8Array values no larger than one frame",
      );
    }
    observedLength += chunk.byteLength;
    if (observedLength > input.plaintextLength) {
      throw new TypeError("Artifact source exceeds its declared plaintext length");
    }
    hasher.update(chunk);
  }
  if (observedLength !== input.plaintextLength) {
    throw new TypeError("Artifact source ended before its declared plaintext length");
  }
  return hasher.digest();
}

function frameAad(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly artifactId: Identifier<"Artifact">;
  readonly protectionParameters: Uint8Array;
  readonly totalPlaintextLength: number;
  readonly frameIndex: number;
  readonly final: boolean;
  readonly framePlaintextLength: number;
  readonly frameCiphertextLength: number;
}): Uint8Array {
  return concatBytes([
    encoder.encode("awsm:artifact-frame-aad:v1"),
    Uint8Array.of(0),
    uint32be(9),
    uint64be(input.vaultId.byteLength),
    input.vaultId,
    uint64be(input.keyEpochId.byteLength),
    input.keyEpochId,
    uint64be(input.artifactId.byteLength),
    input.artifactId,
    uint64be(input.protectionParameters.byteLength),
    input.protectionParameters,
    uint64be(8),
    uint64be(input.totalPlaintextLength),
    uint64be(4),
    uint32be(input.frameIndex),
    uint64be(1),
    uint8(input.final ? 1 : 0),
    uint64be(4),
    uint32be(input.framePlaintextLength),
    uint64be(4),
    uint32be(input.frameCiphertextLength),
  ]);
}

export async function sealArtifactFrames(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly artifactId: Identifier<"Artifact">;
  readonly contract: ArtifactPayloadContract;
  readonly source: AsyncIterable<Uint8Array>;
  readonly writeFrame: (frame: Uint8Array, metadata: EncryptedArtifactFrame) => Promise<void>;
  readonly protectionParameters?: Uint8Array;
}): Promise<SealedArtifactStream> {
  assertContract(input.contract);
  const protectionParameters = input.protectionParameters
    ? Uint8Array.from(input.protectionParameters)
    : crypto.getRandomValues(new Uint8Array(64));
  if (protectionParameters.byteLength !== 64) {
    throw new TypeError("Artifact protection parameters must contain exactly 64 bytes");
  }
  const key = artifactWrapperKey({ ...input, protectionParameters });
  const plaintextHasher = artifactDigestHasher(input.contract.plaintextLength);
  const ciphertextHasher = sha256.create();
  let plaintextLength = 0;
  let ciphertextLength = 0;
  let frameIndex = 0;
  let heldFullFrame: Uint8Array | null = null;
  let pending = new Uint8Array(FRAME_PLAINTEXT_LIMIT);
  let pendingLength = 0;

  const emit = async (plaintext: Uint8Array, final: boolean) => {
    if (frameIndex > 0xffff_ffff) throw new RangeError("Artifact frame index exceeds uint32");
    const ciphertext = await xchachaEncrypt({
      plaintext,
      aad: frameAad({
        ...input,
        protectionParameters,
        totalPlaintextLength: input.contract.plaintextLength,
        frameIndex,
        final,
        framePlaintextLength: plaintext.byteLength,
        frameCiphertextLength: plaintext.byteLength + FRAME_TAG_LENGTH,
      }),
      nonce: frameNonce(protectionParameters.slice(0, 24), frameIndex),
      key,
    });
    const metadata = { index: frameIndex, final, ciphertext } as const;
    const encoded = encodeStreamFrame(metadata);
    ciphertextHasher.update(encoded);
    ciphertextLength += encoded.byteLength;
    await input.writeFrame(encoded, metadata);
    frameIndex += 1;
  };

  for await (const chunk of input.source) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > FRAME_PLAINTEXT_LIMIT) {
      throw new TypeError(
        "Artifact source chunks must be Uint8Array values no larger than one frame",
      );
    }
    plaintextLength += chunk.byteLength;
    if (plaintextLength > input.contract.plaintextLength) {
      throw new TypeError("Artifact source exceeds its committed plaintext length");
    }
    plaintextHasher.update(chunk);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(FRAME_PLAINTEXT_LIMIT - pendingLength, chunk.byteLength - offset);
      pending.set(chunk.subarray(offset, offset + take), pendingLength);
      pendingLength += take;
      offset += take;
      if (pendingLength === FRAME_PLAINTEXT_LIMIT) {
        if (heldFullFrame !== null) await emit(heldFullFrame, false);
        heldFullFrame = pending;
        pending = new Uint8Array(FRAME_PLAINTEXT_LIMIT);
        pendingLength = 0;
      }
    }
  }

  if (plaintextLength !== input.contract.plaintextLength) {
    throw new TypeError("Artifact source ended before its committed plaintext length");
  }
  if (!bytesEqual(plaintextHasher.digest(), input.contract.plaintextDigest)) {
    throw new TypeError("Artifact source digest does not match its logical contract");
  }
  if (pendingLength > 0) {
    if (heldFullFrame !== null) await emit(heldFullFrame, false);
    await emit(pending.slice(0, pendingLength), true);
  } else if (heldFullFrame !== null) {
    await emit(heldFullFrame, true);
  } else {
    await emit(new Uint8Array(), true);
  }

  const ciphertextDigest = ciphertextHasher.digest();
  return {
    protectionParameters,
    frameCount: frameIndex,
    ciphertextLength,
    ciphertextDigest,
    envelopePrefix: encodeOpaqueEnvelopePrefix({
      storageClass: STREAMABLE_STORAGE_CLASS,
      protectionParameters,
      ciphertextLength,
      ciphertextDigest,
    }),
  };
}

export async function openArtifactFrames(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly artifactId: Identifier<"Artifact">;
  readonly contract: ArtifactPayloadContract;
  readonly protectionParameters: Uint8Array;
  readonly ciphertextLength: number;
  readonly ciphertextDigest: Uint8Array;
  readonly frames: AsyncIterable<EncryptedArtifactFrame>;
  readonly writePlaintext: (plaintext: Uint8Array, frameIndex: number) => Promise<void>;
}): Promise<{ readonly frameCount: number }> {
  assertContract(input.contract);
  if (input.protectionParameters.byteLength !== 64 || input.ciphertextDigest.byteLength !== 32) {
    throw new TypeError("Artifact outer protection metadata is invalid");
  }
  const key = artifactWrapperKey(input);
  const plaintextHasher = artifactDigestHasher(input.contract.plaintextLength);
  const ciphertextHasher = sha256.create();
  let expectedIndex = 0;
  let plaintextLength = 0;
  let ciphertextLength = 0;
  let sawFinal = false;
  for await (const frame of input.frames) {
    if (sawFinal || frame.index !== expectedIndex) {
      throw new TypeError("Artifact frames must be contiguous with one final frame");
    }
    const expectedMinimum = frame.final
      ? FRAME_TAG_LENGTH
      : FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH;
    if (
      frame.ciphertext.byteLength < expectedMinimum ||
      frame.ciphertext.byteLength > FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH
    ) {
      throw new TypeError("Artifact frame ciphertext length is invalid");
    }
    const encoded = encodeStreamFrame(frame);
    ciphertextHasher.update(encoded);
    ciphertextLength += encoded.byteLength;
    const framePlaintextLength = frame.ciphertext.byteLength - FRAME_TAG_LENGTH;
    const plaintext = await xchachaDecrypt({
      ciphertext: frame.ciphertext,
      aad: frameAad({
        ...input,
        totalPlaintextLength: input.contract.plaintextLength,
        frameIndex: frame.index,
        final: frame.final,
        framePlaintextLength,
        frameCiphertextLength: frame.ciphertext.byteLength,
      }),
      nonce: frameNonce(input.protectionParameters.slice(0, 24), frame.index),
      key,
    });
    plaintextLength += plaintext.byteLength;
    if (plaintextLength > input.contract.plaintextLength) {
      throw new TypeError("Artifact frames exceed the committed plaintext length");
    }
    plaintextHasher.update(plaintext);
    await input.writePlaintext(plaintext, frame.index);
    sawFinal = frame.final;
    expectedIndex += 1;
  }
  if (!sawFinal || expectedIndex === 0)
    throw new TypeError("Artifact stream is missing its final frame");
  if (
    ciphertextLength !== input.ciphertextLength ||
    !bytesEqual(ciphertextHasher.digest(), input.ciphertextDigest)
  ) {
    throw new TypeError("Artifact outer ciphertext contract is invalid");
  }
  if (
    plaintextLength !== input.contract.plaintextLength ||
    !bytesEqual(plaintextHasher.digest(), input.contract.plaintextDigest)
  ) {
    throw new TypeError("Artifact plaintext contract is invalid");
  }
  return { frameCount: expectedIndex };
}

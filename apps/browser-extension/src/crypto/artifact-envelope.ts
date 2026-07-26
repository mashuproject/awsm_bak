import { decodeCanonicalCbor, encodeCanonicalCbor } from "../domain/cbor";
import { bytesEqual } from "../domain/hash";
import { bytes, canonicalRecord, integer, literal, uuid } from "../domain/validation";
import { readySodium } from "./sodium";
import { xchachaDecrypt, xchachaEncrypt } from "./xchacha";

export const ARTIFACT_CHUNK_PLAINTEXT_BYTES = 1_048_576;
const MAGIC = new TextEncoder().encode("AWSMART1");
const FRAME_HEADER_BYTES = 13;
const MAX_HEADER_BYTES = 64 * 1024;
const ALGORITHM = "enc:xchacha20poly1305-chunked:v1" as const;

export interface ArtifactEnvelopeSummary {
  readonly plaintextByteLength: number;
  readonly plaintextChecksum: Uint8Array;
  readonly envelopeByteLength: number;
  readonly envelopeChecksum: Uint8Array;
}

export class ArtifactEnvelopeError extends Error {
  constructor() {
    super("The Artifact envelope is invalid.");
    this.name = "ArtifactEnvelopeError";
  }
}

interface StreamingHash {
  update(bytes: Uint8Array): void;
  final(): Uint8Array;
}

async function streamingHash(): Promise<StreamingHash> {
  const sodium = await readySodium();
  const state = sodium.crypto_hash_sha256_init();
  let finished = false;
  return {
    update(value) {
      if (finished) throw new ArtifactEnvelopeError();
      sodium.crypto_hash_sha256_update(state, value);
    },
    final() {
      if (finished) throw new ArtifactEnvelopeError();
      finished = true;
      return Uint8Array.from(sodium.crypto_hash_sha256_final(state));
    },
  };
}

function uint32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function frameHeader(index: bigint, final: boolean, plaintextLength: number): Uint8Array {
  const output = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(output.buffer);
  view.setBigUint64(0, index, false);
  output[8] = final ? 1 : 0;
  view.setUint32(9, plaintextLength, false);
  return output;
}

function nonce(prefix: Uint8Array, index: bigint): Uint8Array {
  const output = new Uint8Array(24);
  output.set(prefix);
  new DataView(output.buffer).setBigUint64(16, index, false);
  return output;
}

function aad(
  objectId: string,
  keyEpochId: string,
  prefix: Uint8Array,
  index: bigint,
  final: boolean,
  plaintextLength: number,
): Uint8Array {
  if (index > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArtifactEnvelopeError();
  return encodeCanonicalCbor([
    1,
    objectId,
    keyEpochId,
    ALGORITHM,
    ARTIFACT_CHUNK_PLAINTEXT_BYTES,
    prefix,
    Number(index),
    final ? 1 : 0,
    plaintextLength,
  ]);
}

async function* fixedChunks(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let queued: Uint8Array[] = [];
  let queuedBytes = 0;
  for await (const value of source) {
    if (!(value instanceof Uint8Array)) throw new ArtifactEnvelopeError();
    if (value.byteLength === 0) continue;
    queued.push(value);
    queuedBytes += value.byteLength;
    while (queuedBytes >= ARTIFACT_CHUNK_PLAINTEXT_BYTES) {
      const output = new Uint8Array(ARTIFACT_CHUNK_PLAINTEXT_BYTES);
      let offset = 0;
      while (offset < output.byteLength) {
        const first = queued[0];
        if (first === undefined) throw new ArtifactEnvelopeError();
        const length = Math.min(first.byteLength, output.byteLength - offset);
        output.set(first.subarray(0, length), offset);
        offset += length;
        if (length === first.byteLength) queued.shift();
        else queued[0] = first.subarray(length);
      }
      queuedBytes -= output.byteLength;
      yield output;
    }
  }
  if (queuedBytes > 0) {
    const output = new Uint8Array(queuedBytes);
    let offset = 0;
    for (const value of queued) {
      output.set(value, offset);
      offset += value.byteLength;
    }
    yield output;
  }
  queued = [];
}

export async function writeArtifactEnvelope(input: {
  readonly objectId: string;
  readonly keyEpochId: string;
  readonly key: Uint8Array;
  readonly noncePrefix?: Uint8Array;
  readonly plaintext: AsyncIterable<Uint8Array>;
  readonly write: (bytes: Uint8Array) => void | Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<ArtifactEnvelopeSummary> {
  const objectId = uuid(input.objectId, "artifact.objectId");
  const keyEpochId = uuid(input.keyEpochId, "artifact.keyEpochId");
  if (input.key.byteLength !== 32) throw new ArtifactEnvelopeError();
  const noncePrefix =
    input.noncePrefix === undefined
      ? crypto.getRandomValues(new Uint8Array(16))
      : Uint8Array.from(input.noncePrefix);
  if (noncePrefix.byteLength !== 16) throw new ArtifactEnvelopeError();
  const header = encodeCanonicalCbor({
    artifactEnvelopeVersion: 1,
    objectId,
    keyEpochId,
    algorithm: ALGORITHM,
    chunkPlaintextBytes: ARTIFACT_CHUNK_PLAINTEXT_BYTES,
    noncePrefix,
  });
  if (header.byteLength > MAX_HEADER_BYTES) throw new ArtifactEnvelopeError();
  const plaintextHash = await streamingHash();
  const envelopeHash = await streamingHash();
  let plaintextByteLength = 0;
  let envelopeByteLength = 0;
  const emit = async (value: Uint8Array): Promise<void> => {
    input.signal?.throwIfAborted();
    envelopeHash.update(value);
    envelopeByteLength += value.byteLength;
    await input.write(value);
  };
  await emit(MAGIC);
  await emit(uint32(header.byteLength));
  await emit(header);

  const iterator = fixedChunks(input.plaintext)[Symbol.asyncIterator]();
  let current = await iterator.next();
  if (current.done) current = { done: false, value: new Uint8Array() };
  let index = 0n;
  while (!current.done) {
    input.signal?.throwIfAborted();
    const next = await iterator.next();
    const final = next.done === true;
    const plaintext = current.value;
    plaintextHash.update(plaintext);
    plaintextByteLength += plaintext.byteLength;
    if (!Number.isSafeInteger(plaintextByteLength)) throw new ArtifactEnvelopeError();
    const ciphertext = await xchachaEncrypt({
      plaintext,
      aad: aad(objectId, keyEpochId, noncePrefix, index, final, plaintext.byteLength),
      nonce: nonce(noncePrefix, index),
      key: input.key,
    });
    await emit(frameHeader(index, final, plaintext.byteLength));
    await emit(ciphertext);
    if (final) break;
    current = next;
    index += 1n;
  }

  return {
    plaintextByteLength,
    plaintextChecksum: plaintextHash.final(),
    envelopeByteLength,
    envelopeChecksum: envelopeHash.final(),
  };
}

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private ended = false;
  readonly hashPromise = streamingHash();
  byteLength = 0;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(length: number): Promise<void> {
    while (this.queuedBytes < length && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
      } else {
        if (!(next.value instanceof Uint8Array)) throw new ArtifactEnvelopeError();
        if (next.value.byteLength > 0) {
          this.queue.push(next.value);
          this.queuedBytes += next.value.byteLength;
        }
      }
    }
  }

  async exact(length: number): Promise<Uint8Array> {
    await this.fill(length);
    if (this.queuedBytes < length) throw new ArtifactEnvelopeError();
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const first = this.queue[0];
      if (first === undefined) throw new ArtifactEnvelopeError();
      const count = Math.min(first.byteLength, length - offset);
      output.set(first.subarray(0, count), offset);
      offset += count;
      if (count === first.byteLength) this.queue.shift();
      else this.queue[0] = first.subarray(count);
      this.queuedBytes -= count;
    }
    (await this.hashPromise).update(output);
    this.byteLength += output.byteLength;
    return output;
  }

  async atEnd(): Promise<boolean> {
    await this.fill(1);
    return this.ended && this.queuedBytes === 0;
  }
}

export async function readArtifactEnvelope(input: {
  readonly expectedObjectId: string;
  readonly expectedKeyEpochId: string;
  readonly key: Uint8Array;
  readonly encrypted: AsyncIterable<Uint8Array>;
  readonly write: (bytes: Uint8Array) => void | Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<ArtifactEnvelopeSummary> {
  try {
    const expectedObjectId = uuid(input.expectedObjectId, "artifact.objectId");
    const expectedKeyEpochId = uuid(input.expectedKeyEpochId, "artifact.keyEpochId");
    if (input.key.byteLength !== 32) throw new ArtifactEnvelopeError();
    const reader = new AsyncByteReader(input.encrypted);
    if (!bytesEqual(await reader.exact(MAGIC.byteLength), MAGIC)) throw new ArtifactEnvelopeError();
    const headerLength = new DataView((await reader.exact(4)).buffer).getUint32(0, false);
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) throw new ArtifactEnvelopeError();
    const headerBytes = await reader.exact(headerLength);
    const headerValue = decodeCanonicalCbor(headerBytes);
    if (!bytesEqual(headerBytes, encodeCanonicalCbor(headerValue)))
      throw new ArtifactEnvelopeError();
    const header = canonicalRecord(headerValue, "artifact.header", [
      "artifactEnvelopeVersion",
      "objectId",
      "keyEpochId",
      "algorithm",
      "chunkPlaintextBytes",
      "noncePrefix",
    ]);
    literal(header.artifactEnvelopeVersion, 1, "artifact.header.version");
    if (uuid(header.objectId, "artifact.header.objectId") !== expectedObjectId)
      throw new ArtifactEnvelopeError();
    if (uuid(header.keyEpochId, "artifact.header.keyEpochId") !== expectedKeyEpochId)
      throw new ArtifactEnvelopeError();
    literal(header.algorithm, ALGORITHM, "artifact.header.algorithm");
    if (
      integer(header.chunkPlaintextBytes, "artifact.header.chunkPlaintextBytes") !==
      ARTIFACT_CHUNK_PLAINTEXT_BYTES
    )
      throw new ArtifactEnvelopeError();
    const noncePrefix = bytes(header.noncePrefix, 16, "artifact.header.noncePrefix");
    const plaintextHash = await streamingHash();
    let plaintextByteLength = 0;
    let expectedIndex = 0n;
    let final = false;
    while (!final) {
      input.signal?.throwIfAborted();
      const frame = await reader.exact(FRAME_HEADER_BYTES);
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const index = view.getBigUint64(0, false);
      const flag = frame[8];
      const length = view.getUint32(9, false);
      if (
        index !== expectedIndex ||
        (flag !== 0 && flag !== 1) ||
        length > ARTIFACT_CHUNK_PLAINTEXT_BYTES ||
        (flag === 0 && length !== ARTIFACT_CHUNK_PLAINTEXT_BYTES)
      )
        throw new ArtifactEnvelopeError();
      final = flag === 1;
      const ciphertext = await reader.exact(length + 16);
      const plaintext = await xchachaDecrypt({
        ciphertext,
        aad: aad(expectedObjectId, expectedKeyEpochId, noncePrefix, index, final, length),
        nonce: nonce(noncePrefix, index),
        key: input.key,
      });
      if (plaintext.byteLength !== length) throw new ArtifactEnvelopeError();
      plaintextHash.update(plaintext);
      plaintextByteLength += plaintext.byteLength;
      if (!Number.isSafeInteger(plaintextByteLength)) throw new ArtifactEnvelopeError();
      await input.write(plaintext);
      expectedIndex += 1n;
    }
    if (!(await reader.atEnd())) throw new ArtifactEnvelopeError();
    return {
      plaintextByteLength,
      plaintextChecksum: plaintextHash.final(),
      envelopeByteLength: reader.byteLength,
      envelopeChecksum: (await reader.hashPromise).final(),
    };
  } catch (error) {
    if (error instanceof ArtifactEnvelopeError) throw error;
    throw new ArtifactEnvelopeError();
  }
}

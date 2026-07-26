import { describe, expect, it } from "vitest";
import {
  ARTIFACT_CHUNK_PLAINTEXT_BYTES,
  readArtifactEnvelope,
  writeArtifactEnvelope,
} from "../../src/crypto/artifact-envelope";
import { bytesEqual, sha256 } from "../../src/domain/hash";

const objectId = "00000000-0000-4000-8000-000000000001";
const keyEpochId = "00000000-0000-4000-8000-000000000009";
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const noncePrefix = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);

async function* chunks(values: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value;
}

async function envelope(plaintext: readonly Uint8Array[]): Promise<{
  readonly bytes: Uint8Array;
  readonly plaintext: Uint8Array;
}> {
  const output: Uint8Array[] = [];
  await writeArtifactEnvelope({
    objectId,
    keyEpochId,
    key,
    noncePrefix,
    plaintext: chunks(plaintext),
    write: (value) => {
      output.push(Uint8Array.from(value));
    },
  });
  const bytes = Uint8Array.from(output.flatMap((value) => [...value]));
  const recovered: Uint8Array[] = [];
  await readArtifactEnvelope({
    expectedObjectId: objectId,
    expectedKeyEpochId: keyEpochId,
    key,
    encrypted: chunks([bytes.subarray(0, 13), bytes.subarray(13)]),
    write: (value) => {
      recovered.push(Uint8Array.from(value));
    },
  });
  return {
    bytes,
    plaintext: Uint8Array.from(recovered.flatMap((value) => [...value])),
  };
}

describe("chunked Artifact envelope", () => {
  it("round-trips an authenticated empty Artifact deterministically", async () => {
    const first = await envelope([]);
    const second = await envelope([new Uint8Array()]);
    expect(first.bytes).toEqual(second.bytes);
    expect(first.plaintext).toEqual(new Uint8Array());
  });

  it("rechunks arbitrary input and authenticates exact-multiple and final frames", async () => {
    const plaintext = Uint8Array.from(
      { length: ARTIFACT_CHUNK_PLAINTEXT_BYTES + 17 },
      (_, index) => index % 251,
    );
    const result = await envelope([
      plaintext.subarray(0, 7),
      plaintext.subarray(7, ARTIFACT_CHUNK_PLAINTEXT_BYTES - 3),
      plaintext.subarray(ARTIFACT_CHUNK_PLAINTEXT_BYTES - 3),
    ]);
    expect(result.plaintext).toEqual(plaintext);
  }, 15_000);

  it("returns streaming wrapper and plaintext integrity summaries", async () => {
    const plaintext = new TextEncoder().encode("artifact contents");
    const output: Uint8Array[] = [];
    const written = await writeArtifactEnvelope({
      objectId,
      keyEpochId,
      key,
      noncePrefix,
      plaintext: chunks([plaintext]),
      write: (value) => {
        output.push(Uint8Array.from(value));
      },
    });
    const bytes = Uint8Array.from(output.flatMap((value) => [...value]));
    expect(written.plaintextByteLength).toBe(plaintext.byteLength);
    expect(bytesEqual(written.plaintextChecksum, await sha256(plaintext))).toBe(true);
    expect(written.envelopeByteLength).toBe(bytes.byteLength);
    expect(bytesEqual(written.envelopeChecksum, await sha256(bytes))).toBe(true);

    const recovered: Uint8Array[] = [];
    const read = await readArtifactEnvelope({
      expectedObjectId: objectId,
      expectedKeyEpochId: keyEpochId,
      key,
      encrypted: chunks([bytes]),
      write: (value) => {
        recovered.push(Uint8Array.from(value));
      },
    });
    expect(read).toEqual(written);
  });

  it("rejects wrong keys, cross-Object substitution, truncation, and trailing bytes", async () => {
    const { bytes } = await envelope([new TextEncoder().encode("secret")]);
    const read = (value: Uint8Array, expectedObjectId = objectId, candidateKey = key) =>
      readArtifactEnvelope({
        expectedObjectId,
        expectedKeyEpochId: keyEpochId,
        key: candidateKey,
        encrypted: chunks([value]),
        write: () => undefined,
      });
    await expect(read(bytes, objectId, new Uint8Array(32).fill(9))).rejects.toThrow();
    await expect(read(bytes, "00000000-0000-4000-8000-000000000002")).rejects.toThrow();
    await expect(read(bytes.subarray(0, bytes.byteLength - 1))).rejects.toThrow();
    await expect(read(Uint8Array.from([...bytes, 0]))).rejects.toThrow();
  });

  it("rejects frame index, final flag, and length tampering before plaintext succeeds", async () => {
    const { bytes } = await envelope([new TextEncoder().encode("secret")]);
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, false);
    const frameOffset = 12 + headerLength;
    for (const offset of [frameOffset + 7, frameOffset + 8, frameOffset + 12]) {
      const corrupt = Uint8Array.from(bytes);
      corrupt[offset] = (corrupt[offset] ?? 0) ^ 1;
      await expect(
        readArtifactEnvelope({
          expectedObjectId: objectId,
          expectedKeyEpochId: keyEpochId,
          key,
          encrypted: chunks([corrupt]),
          write: () => undefined,
        }),
      ).rejects.toThrow();
    }
  });
});

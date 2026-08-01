import { describe, expect, it } from "vitest";

import { openCompactItem, sealCompactItem } from "../../src/crypto/compact";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import {
  COMPACT_STORAGE_CLASS,
  decodeOpaqueEnvelope,
  encodeOpaqueEnvelope,
  encodeStreamFrame,
  FRAME_PLAINTEXT_LIMIT,
  STREAMABLE_STORAGE_CLASS,
} from "../../src/storage/opaque-envelope";

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

describe("opaque storage envelope", () => {
  it("round-trips a Compact envelope and matches its outer ID vector", () => {
    const envelope = encodeOpaqueEnvelope({
      storageClass: COMPACT_STORAGE_CLASS,
      protectionParameters: new Uint8Array(64).map((_, index) => index),
      payload: new Uint8Array(16).fill(7),
    });
    const decoded = decodeOpaqueEnvelope(envelope.bytes);

    expect(decoded).toEqual(envelope);
    expect(hex(decoded.storageItemId)).toBe(
      "871846c4ad5f8d1dc06960790a533580e242b6a91c298769dd722864c6a6f73b",
    );
  });

  it("rejects malformed framing, lengths, digests, and Compact limits", () => {
    const envelope = encodeOpaqueEnvelope({
      storageClass: COMPACT_STORAGE_CLASS,
      protectionParameters: new Uint8Array(64).fill(1),
      payload: new Uint8Array(16).fill(2),
    });
    const badMagic = Uint8Array.from(envelope.bytes);
    badMagic[0] = (badMagic[0] ?? 0) ^ 1;
    const badPayload = Uint8Array.from(envelope.bytes);
    badPayload[badPayload.length - 1] = (badPayload[badPayload.length - 1] ?? 0) ^ 1;

    expect(() => decodeOpaqueEnvelope(badMagic)).toThrow(/magic/u);
    expect(() => decodeOpaqueEnvelope(badPayload)).toThrow(/digest/u);
    expect(() => decodeOpaqueEnvelope(envelope.bytes.slice(0, -1))).toThrow(/length/u);
    expect(() =>
      encodeOpaqueEnvelope({
        storageClass: COMPACT_STORAGE_CLASS,
        protectionParameters: new Uint8Array(64),
        payload: new Uint8Array(15),
      }),
    ).toThrow(/bounds/u);
  });

  it("validates exact Streamable frame grammar without semantic metadata", () => {
    const first = encodeStreamFrame({
      index: 0,
      final: false,
      ciphertext: new Uint8Array(FRAME_PLAINTEXT_LIMIT + 16),
    });
    const final = encodeStreamFrame({ index: 1, final: true, ciphertext: new Uint8Array(16) });
    const envelope = encodeOpaqueEnvelope({
      storageClass: STREAMABLE_STORAGE_CLASS,
      protectionParameters: new Uint8Array(64).fill(3),
      payload: new Uint8Array([...first, ...final]),
    });

    expect(decodeOpaqueEnvelope(envelope.bytes).framePlaintextLimit).toBe(FRAME_PLAINTEXT_LIMIT);
    expect(() =>
      encodeOpaqueEnvelope({
        storageClass: STREAMABLE_STORAGE_CLASS,
        protectionParameters: new Uint8Array(64),
        payload: encodeStreamFrame({ index: 1, final: true, ciphertext: new Uint8Array(16) }),
      }),
    ).toThrow(/contiguous/u);
    expect(() =>
      encodeOpaqueEnvelope({
        storageClass: STREAMABLE_STORAGE_CLASS,
        protectionParameters: new Uint8Array(64),
        payload: first,
      }),
    ).toThrow(/final/u);
  });
});

describe("canonical Compact item encryption", () => {
  const vaultId = identifier("Vault", new Uint8Array(32).fill(1));
  const epochKey = new Uint8Array(32).fill(2);
  const epochId = keyEpochId(vaultId, epochKey);
  const plaintext = new TextEncoder().encode("private canonical Record bytes");

  it("authenticates the inner Epoch and hides protected payload bytes", async () => {
    const protectionParameters = new Uint8Array(64).map((_, index) => index);
    const sealed = await sealCompactItem({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      payloadType: 1,
      payloadBytes: plaintext,
      protectionParameters,
    });
    const opened = await openCompactItem({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      envelopeBytes: sealed.bytes,
    });

    expect(opened.payloadType).toBe(1);
    expect(opened.payloadBytes).toEqual(plaintext);
    expect(includesBytes(sealed.bytes, plaintext)).toBe(false);
    expect(hex(sealed.storageItemId)).toBe(
      "7564ba87bdabd64dbd6dc8ddd315be79e790db3b130ecd8303f3dd454c0a00c6",
    );
  });

  it("uses fresh destination representation parameters and fails closed on wrong context", async () => {
    const first = await sealCompactItem({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      payloadType: 1,
      payloadBytes: plaintext,
      protectionParameters: new Uint8Array(64).fill(4),
    });
    const second = await sealCompactItem({
      vaultId,
      keyEpochId: epochId,
      keyEpochKey: epochKey,
      payloadType: 1,
      payloadBytes: plaintext,
      protectionParameters: new Uint8Array(64).fill(5),
    });
    const otherVault = identifier("Vault", new Uint8Array(32).fill(9));

    expect(second.storageItemId).not.toEqual(first.storageItemId);
    await expect(
      openCompactItem({
        vaultId: otherVault,
        keyEpochId: epochId,
        keyEpochKey: epochKey,
        envelopeBytes: first.bytes,
      }),
    ).rejects.toThrow();
  });
});

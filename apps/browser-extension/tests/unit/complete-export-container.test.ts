import { describe, expect, it } from "vitest";

import {
  COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT,
  COMPLETE_EXPORT_MAGIC,
  COMPLETE_EXPORT_METADATA_LIMIT,
  decodeCompleteExportEntryHeader,
  decodeCompleteExportPrefix,
  deriveCompleteExportKey,
  encodeCompleteExportEntryHeader,
  encodeCompleteExportPrefix,
  openCompleteExportEntries,
  openCompleteExportFrame,
  openCompleteExportStream,
  prepareCompleteExportEntry,
  sealCompleteExportFrame,
  sealCompleteExportStream,
  sequenceCompleteExportEntries,
} from "../../src/runtime/complete-export/container";

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("canonical Complete Export container", () => {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
  const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0x20 + index);

  it("encodes and decodes the one canonical package prefix", () => {
    const encoded = encodeCompleteExportPrefix({ salt, nonce });
    const decoded = decodeCompleteExportPrefix(encoded);

    expect(hex(encoded.slice(0, COMPLETE_EXPORT_MAGIC.byteLength))).toBe("4157534d45580100");
    expect(new DataView(encoded.buffer, encoded.byteOffset + 8, 4).getUint32(0, false)).toBe(64);
    expect(decoded).toEqual({
      format: 1,
      salt,
      memoryKiB: 65_536,
      iterations: 3,
      parallelism: 1,
      nonce,
      framePlaintextLimit: COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT,
      bytes: encoded.slice(12),
      prefixBytes: encoded,
    });
  });

  it("rejects noncanonical or unsupported package headers", () => {
    const encoded = encodeCompleteExportPrefix({ salt, nonce });
    const wrongMagic = Uint8Array.from(encoded);
    wrongMagic[0] = (wrongMagic[0] ?? 0) ^ 1;
    expect(() => decodeCompleteExportPrefix(wrongMagic)).toThrow(/magic/u);

    const trailing = new Uint8Array(encoded.byteLength + 1);
    trailing.set(encoded);
    expect(() => decodeCompleteExportPrefix(trailing)).toThrow(/exact prefix/u);

    const unsupportedLimit = Uint8Array.from(encoded);
    unsupportedLimit[unsupportedLimit.byteLength - 1] =
      (unsupportedLimit[unsupportedLimit.byteLength - 1] ?? 0) ^ 1;
    expect(() => decodeCompleteExportPrefix(unsupportedLimit)).toThrow();
  });

  it("authenticates the exact header, frame index, final flag, and plaintext", async () => {
    const prefix = decodeCompleteExportPrefix(encodeCompleteExportPrefix({ salt, nonce }));
    const key = new Uint8Array(32).fill(0x5a);
    const plaintext = new TextEncoder().encode("portable vault bytes");
    const sealed = await sealCompleteExportFrame({
      key,
      headerBytes: prefix.bytes,
      baseNonce: prefix.nonce,
      index: 7,
      final: true,
      plaintext,
    });

    await expect(
      openCompleteExportFrame({
        key,
        headerBytes: prefix.bytes,
        baseNonce: prefix.nonce,
        frameBytes: sealed,
        expectedIndex: 7,
      }),
    ).resolves.toEqual({ index: 7, final: true, plaintext });

    const tampered = Uint8Array.from(sealed);
    tampered[tampered.byteLength - 1] = (tampered[tampered.byteLength - 1] ?? 0) ^ 1;
    await expect(
      openCompleteExportFrame({
        key,
        headerBytes: prefix.bytes,
        baseNonce: prefix.nonce,
        frameBytes: tampered,
        expectedIndex: 7,
      }),
    ).rejects.toThrow();
    await expect(
      openCompleteExportFrame({
        key,
        headerBytes: prefix.bytes,
        baseNonce: prefix.nonce,
        frameBytes: sealed,
        expectedIndex: 6,
      }),
    ).rejects.toThrow(/index/u);
    await expect(
      openCompleteExportFrame({
        key,
        headerBytes: Uint8Array.from(prefix.bytes, (byte, index) =>
          index === 0 ? byte ^ 1 : byte,
        ),
        baseNonce: prefix.nonce,
        frameBytes: sealed,
        expectedIndex: 7,
      }),
    ).rejects.toThrow();
  });

  it("enforces frame bounds and one exact encoded frame", async () => {
    const prefix = decodeCompleteExportPrefix(encodeCompleteExportPrefix({ salt, nonce }));
    const key = new Uint8Array(32).fill(0x33);

    await expect(
      sealCompleteExportFrame({
        key,
        headerBytes: prefix.bytes,
        baseNonce: prefix.nonce,
        index: 0,
        final: false,
        plaintext: new Uint8Array(1),
      }),
    ).rejects.toThrow(/non-final/u);
    await expect(
      sealCompleteExportFrame({
        key,
        headerBytes: prefix.bytes,
        baseNonce: prefix.nonce,
        index: 0,
        final: true,
        plaintext: new Uint8Array(COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT + 1),
      }),
    ).rejects.toThrow(/limit/u);

    const sealed = await sealCompleteExportFrame({
      key,
      headerBytes: prefix.bytes,
      baseNonce: prefix.nonce,
      index: 0,
      final: true,
      plaintext: new Uint8Array(),
    });
    const trailing = new Uint8Array(sealed.byteLength + 1);
    trailing.set(sealed);
    await expect(
      openCompleteExportFrame({
        key,
        headerBytes: prefix.bytes,
        baseNonce: prefix.nonce,
        frameBytes: trailing,
        expectedIndex: 0,
      }),
    ).rejects.toThrow(/length/u);
  });

  it("encodes only exact canonical entry headers", () => {
    const encoded = encodeCompleteExportEntryHeader({
      kind: 2,
      entryId: new Uint8Array(32).fill(1),
      byteLength: 1_048_577,
      byteDigest: new Uint8Array(32).fill(2),
    });

    expect(decodeCompleteExportEntryHeader(encoded)).toEqual({
      kind: 2,
      entryId: new Uint8Array(32).fill(1),
      byteLength: 1_048_577,
      byteDigest: new Uint8Array(32).fill(2),
    });
    expect(() =>
      encodeCompleteExportEntryHeader({
        kind: 4 as 1,
        entryId: new Uint8Array(32),
        byteLength: 0,
        byteDigest: new Uint8Array(32),
      }),
    ).toThrow(/kind/u);
    expect(() =>
      encodeCompleteExportEntryHeader({
        kind: 1,
        entryId: new Uint8Array(31),
        byteLength: 0,
        byteDigest: new Uint8Array(32),
      }),
    ).toThrow(/Entry ID/u);
    expect(() => decodeCompleteExportEntryHeader(Uint8Array.of(0xa0))).toThrow(/fields/u);
    expect(() =>
      prepareCompleteExportEntry(1, new Uint8Array(COMPLETE_EXPORT_METADATA_LIMIT + 1)),
    ).toThrow(/metadata/u);
  });

  it("normalizes the passphrase to NFC before exact Argon2id derivation", async () => {
    const prefix = decodeCompleteExportPrefix(encodeCompleteExportPrefix({ salt, nonce }));
    const composed = await deriveCompleteExportKey("caf\u00e9 vault", prefix);
    const decomposed = await deriveCompleteExportKey("cafe\u0301 vault", prefix);

    expect(composed).toHaveLength(32);
    expect(decomposed).toEqual(composed);
    composed.fill(0);
    decomposed.fill(0);
  });

  it("round-trips a bounded independently authenticated encrypted stream", async () => {
    const plaintext = Uint8Array.from(
      { length: COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT * 2 + 17 },
      (_, index) => index % 251,
    );
    const encrypted: Uint8Array[] = [];
    await sealCompleteExportStream({
      passphrase: "correct horse battery staple",
      salt,
      nonce,
      plaintext: (async function* () {
        yield plaintext.slice(0, 17);
        yield plaintext.slice(17, COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT + 9);
        yield plaintext.slice(COMPLETE_EXPORT_FRAME_PLAINTEXT_LIMIT + 9);
      })(),
      write: async (bytes) => {
        encrypted.push(Uint8Array.from(bytes));
      },
    });

    expect(encrypted).toHaveLength(4);
    expect(encrypted[0]?.slice(0, 8)).toEqual(COMPLETE_EXPORT_MAGIC);
    expect(encrypted.slice(1).every((frame) => frame.byteLength <= 1_048_601)).toBe(true);

    const opened: Uint8Array[] = [];
    const result = await openCompleteExportStream({
      passphrase: "correct horse battery staple",
      encrypted: (async function* () {
        const joined = new Uint8Array(
          encrypted.reduce((total, part) => total + part.byteLength, 0),
        );
        let offset = 0;
        for (const part of encrypted) {
          joined.set(part, offset);
          offset += part.byteLength;
        }
        for (let cursor = 0; cursor < joined.byteLength; cursor += 777_777) {
          yield joined.slice(cursor, cursor + 777_777);
        }
      })(),
      writePlaintext: async (bytes) => {
        opened.push(Uint8Array.from(bytes));
      },
    });

    expect(result.frameCount).toBe(3);
    const restored = new Uint8Array(opened.reduce((total, part) => total + part.byteLength, 0));
    let restoredOffset = 0;
    for (const part of opened) {
      restored.set(part, restoredOffset);
      restoredOffset += part.byteLength;
    }
    expect(restored).toEqual(plaintext);
  }, 15_000);

  it("rejects truncated streams and bytes after the final frame", async () => {
    const encrypted: Uint8Array[] = [];
    await sealCompleteExportStream({
      passphrase: "correct horse battery staple",
      salt,
      nonce,
      plaintext: (async function* () {
        yield Uint8Array.of(1, 2, 3);
      })(),
      write: async (bytes) => {
        encrypted.push(Uint8Array.from(bytes));
      },
    });
    const joined = new Uint8Array(encrypted.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of encrypted) {
      joined.set(part, offset);
      offset += part.byteLength;
    }

    await expect(
      openCompleteExportStream({
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          yield joined.slice(0, -1);
        })(),
        writePlaintext: async () => undefined,
      }),
    ).rejects.toThrow(/truncated/u);
    await expect(
      openCompleteExportStream({
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          yield joined;
          yield Uint8Array.of(0);
        })(),
        writePlaintext: async () => undefined,
      }),
    ).rejects.toThrow(/trailing/u);
  });

  it("sequences Manifest, sorted opaque items, and key inventory exactly", async () => {
    const manifest = prepareCompleteExportEntry(1, Uint8Array.of(1));
    const firstOpaque = prepareCompleteExportEntry(2, Uint8Array.of(2));
    const secondOpaque = prepareCompleteExportEntry(2, Uint8Array.of(3));
    const orderedOpaque = [firstOpaque, secondOpaque].toSorted((left, right) =>
      hex(left.header.entryId).localeCompare(hex(right.header.entryId)),
    );
    const inventory = prepareCompleteExportEntry(3, Uint8Array.of(4));
    const plaintext: Uint8Array[] = [];

    for await (const bytes of sequenceCompleteExportEntries([
      manifest,
      ...orderedOpaque,
      inventory,
    ])) {
      plaintext.push(bytes);
    }

    expect(plaintext).toHaveLength(12);
    expect(new DataView(plaintext[0]?.buffer ?? new ArrayBuffer(0)).getUint32(0, false)).toBe(
      plaintext[1]?.byteLength,
    );
    expect(decodeCompleteExportEntryHeader(plaintext[1] ?? new Uint8Array()).kind).toBe(1);
    expect(decodeCompleteExportEntryHeader(plaintext[10] ?? new Uint8Array()).kind).toBe(3);
  });

  it("rejects entry order, duplicate opaque IDs, and body integrity mismatches", async () => {
    const manifest = prepareCompleteExportEntry(1, Uint8Array.of(1));
    const opaque = prepareCompleteExportEntry(2, Uint8Array.of(2));
    const inventory = prepareCompleteExportEntry(3, Uint8Array.of(3));
    const consume = async (entries: Parameters<typeof sequenceCompleteExportEntries>[0]) => {
      for await (const _bytes of sequenceCompleteExportEntries(entries)) {
        // Exhaust validation.
      }
    };

    await expect(consume([opaque, manifest, inventory])).rejects.toThrow(/Manifest first/u);
    await expect(consume([manifest, opaque, opaque, inventory])).rejects.toThrow(/sorted unique/u);
    await expect(
      consume([
        {
          ...manifest,
          bytes: (async function* () {
            yield Uint8Array.of(9);
          })(),
        },
        inventory,
      ]),
    ).rejects.toThrow(/digest/u);
    await expect(consume([manifest, inventory, opaque])).rejects.toThrow(/last/u);
  });

  it("decrypts and authenticates entries through bounded Prepared Data callbacks", async () => {
    const manifest = prepareCompleteExportEntry(1, Uint8Array.of(1, 2));
    const opaque = prepareCompleteExportEntry(2, Uint8Array.of(3, 4, 5));
    const inventory = prepareCompleteExportEntry(3, Uint8Array.of(6));
    const encrypted: Uint8Array[] = [];
    await sealCompleteExportStream({
      passphrase: "correct horse battery staple",
      salt,
      nonce,
      plaintext: sequenceCompleteExportEntries([manifest, opaque, inventory]),
      write: async (bytes) => {
        encrypted.push(Uint8Array.from(bytes));
      },
    });
    const observed: { kind: number; chunks: Uint8Array[] }[] = [];

    const result = await openCompleteExportEntries({
      passphrase: "correct horse battery staple",
      encrypted: (async function* () {
        for (const bytes of encrypted) yield bytes;
      })(),
      onEntryStart: async (header) => {
        observed.push({ kind: header.kind, chunks: [] });
      },
      onEntryChunk: async (_header, bytes) => {
        observed.at(-1)?.chunks.push(Uint8Array.from(bytes));
      },
      onEntryEnd: async () => undefined,
    });

    expect(result).toMatchObject({ entryCount: 3 });
    expect(
      observed.map(({ kind, chunks }) => [
        kind,
        hex(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))),
      ]),
    ).toEqual([
      [1, "0102"],
      [2, "030405"],
      [3, "06"],
    ]);
  }, 15_000);
});

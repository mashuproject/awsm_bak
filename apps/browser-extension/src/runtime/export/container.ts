import {
  BlobReader,
  type FileEntry,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  type WritableWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { wipe } from "../../crypto/sodium";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { bytesEqual, sha256 } from "../../domain/hash";
import { importVaultKeyring, type VaultKeyring } from "../vault/keyring";
import { decodeExportKeyEnvelope, decodeExportManifest, type ExportManifestV1 } from "./contracts";
import type { ExportedVaultKeyring } from "./key-envelope";
import { ExportAuthenticationError, openExportKeyEnvelope } from "./key-envelope";
import type { VerifiedAuthoritativeVaultPackage } from "./verify";
import { verifyAuthoritativeVaultPackage } from "./verify";

export const VAULT_PACKAGE_MIME = "application/vnd.awsm.vault+zip";
const FIXED_DATE = new Date("1980-01-01T00:00:00.000Z");
const FIXED_PATHS = new Set(["generation.cbor", "head.cbor", "key.cbor", "manifest.cbor"]);
const DYNAMIC_PATH =
  /^(?:(?:events|objects)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cbor|artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin)$/iu;

export interface VaultPackageEntry {
  readonly path: string;
  readonly bytes: Uint8Array | ReadableStream<Uint8Array>;
}

export interface ValidatedVaultPackage extends VerifiedAuthoritativeVaultPackage {
  readonly manifest: ExportManifestV1;
  readonly keyring: VaultKeyring;
}

export class ExportPackageInvalidError extends Error {
  readonly id = "EXPORT_PACKAGE_INVALID";

  constructor() {
    super("The Export package is invalid.");
    this.name = "ExportPackageInvalidError";
  }
}

class VaultPackageConsumerError {
  constructor(readonly cause: unknown) {}
}

function assertCanonicalPaths(paths: readonly string[]): void {
  if (paths.join("\n") !== [...paths].toSorted().join("\n")) throw new ExportPackageInvalidError();
  if (new Set(paths).size !== paths.length) throw new ExportPackageInvalidError();
  for (const path of paths) {
    if (!FIXED_PATHS.has(path) && !DYNAMIC_PATH.test(path)) throw new ExportPackageInvalidError();
  }
  for (const fixed of FIXED_PATHS)
    if (!paths.includes(fixed)) throw new ExportPackageInvalidError();
}

async function assertZip64Tail(source: Blob, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const tail = new Uint8Array(await source.slice(Math.max(0, source.size - 4096)).arrayBuffer());
  signal?.throwIfAborted();
  const contains = (signature: readonly number[]): boolean =>
    tail.some((_, index) => signature.every((byte, offset) => tail[index + offset] === byte));
  if (!contains([0x50, 0x4b, 0x06, 0x06]) || !contains([0x50, 0x4b, 0x06, 0x07])) {
    throw new ExportPackageInvalidError();
  }
}

export async function writeVaultPackage(
  output: WritableWriter | WritableStream,
  entries: Iterable<VaultPackageEntry> | AsyncIterable<VaultPackageEntry>,
  signal?: AbortSignal,
): Promise<void> {
  const writer = new ZipWriter(output, {
    zip64: true,
    level: 0,
    compressionMethod: 0,
    extendedTimestamp: false,
    keepOrder: true,
    msDosCompatible: true,
    useWebWorkers: false,
  });
  try {
    let previousPath: string | undefined;
    const seenFixed = new Set<string>();
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (
        (previousPath !== undefined && previousPath >= entry.path) ||
        (!FIXED_PATHS.has(entry.path) && !DYNAMIC_PATH.test(entry.path))
      ) {
        throw new ExportPackageInvalidError();
      }
      previousPath = entry.path;
      if (FIXED_PATHS.has(entry.path)) seenFixed.add(entry.path);
      await writer.add(
        entry.path,
        entry.bytes instanceof Uint8Array ? new Uint8ArrayReader(entry.bytes) : entry.bytes,
        {
          zip64: true,
          level: 0,
          compressionMethod: 0,
          extendedTimestamp: false,
          externalFileAttributes: 0,
          internalFileAttributes: 0,
          lastModDate: FIXED_DATE,
          msDosCompatible: true,
          ...(signal === undefined ? {} : { signal }),
          useWebWorkers: false,
        },
      );
    }
    if (seenFixed.size !== FIXED_PATHS.size) throw new ExportPackageInvalidError();
    await writer.close(new Uint8Array(), { zip64: true });
  } catch (error) {
    await writer.close().catch(() => undefined);
    throw error;
  }
}

async function entryBytes(
  entry: FileEntry,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (entry.uncompressedSize > maximum || entry.compressedSize !== entry.uncompressedSize) {
    throw new ExportPackageInvalidError();
  }
  signal?.throwIfAborted();
  const result = await entry.getData(
    new Uint8ArrayWriter(),
    signal === undefined ? undefined : { signal },
  );
  signal?.throwIfAborted();
  const localExtraTypes = [...(entry.localDirectory?.extraField?.keys() ?? [])];
  if (
    entry.localDirectory?.encrypted === true ||
    entry.localDirectory?.compressionMethod !== 0 ||
    localExtraTypes.some((type) => type !== 0x0001)
  ) {
    throw new ExportPackageInvalidError();
  }
  return result;
}

export async function withAuthenticatedVaultPackage<Result>(
  source: Blob,
  passphrase: string,
  use: (
    validated: ValidatedVaultPackage,
    rawKeyring: ExportedVaultKeyring,
  ) => Result | Promise<Result>,
  onRootKeyAuthenticated?: (vaultId: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<Result> {
  const reader = new ZipReader(new BlobReader(source), {
    useWebWorkers: false,
    checkSignature: true,
    checkOverlappingEntry: true,
  });
  let rawKeyring: ExportedVaultKeyring | undefined;
  try {
    signal?.throwIfAborted();
    await assertZip64Tail(source, signal);
    const entries = await reader.getEntries();
    if (reader.comment.byteLength !== 0) throw new ExportPackageInvalidError();
    if (
      (reader.prependedData?.byteLength ?? 0) !== 0 ||
      (reader.appendedData?.byteLength ?? 0) !== 0
    )
      throw new ExportPackageInvalidError();
    const paths = entries.map((entry) => entry.filename);
    assertCanonicalPaths(paths);
    if (
      entries.some(
        (entry) =>
          entry.directory ||
          entry.encrypted ||
          entry.compressionMethod !== 0 ||
          entry.comment.length !== 0 ||
          entry.externalFileAttributes !== 0 ||
          entry.internalFileAttributes !== 0 ||
          entry.extraFieldZip64 === undefined ||
          entry.extraFieldExtendedTimestamp !== undefined ||
          [...(entry.extraField?.keys() ?? [])].some((type) => type !== 0x0001) ||
          entry.lastModDate.getUTCFullYear() !== 1980 ||
          entry.lastModDate.getUTCMonth() !== 0 ||
          entry.lastModDate.getUTCDate() !== 1,
      )
    ) {
      throw new ExportPackageInvalidError();
    }
    const files = new Map(entries.map((entry) => [entry.filename, entry as FileEntry]));
    const manifestEntry = files.get("manifest.cbor");
    const keyEntry = files.get("key.cbor");
    if (manifestEntry === undefined || keyEntry === undefined)
      throw new ExportPackageInvalidError();
    const manifestBytes = await entryBytes(manifestEntry, 16 * 1024 * 1024, signal);
    const keyBytes = await entryBytes(keyEntry, 64 * 1024, signal);
    const manifest = decodeExportManifest(manifestBytes);
    const keyEnvelope = decodeExportKeyEnvelope(keyBytes);
    if (
      keyEnvelope.packageId !== manifest.packageId ||
      keyEnvelope.originatingVaultId !== manifest.originatingVaultId
    ) {
      throw new ExportAuthenticationError();
    }
    rawKeyring = await openExportKeyEnvelope(keyEnvelope, manifestBytes, passphrase);
    if (rawKeyring.vaultId !== manifest.originatingVaultId) throw new ExportAuthenticationError();
    passphrase = "";
    signal?.throwIfAborted();
    const descriptorChecksum = await sha256(
      encodeCanonicalCbor({
        entries: manifest.entries,
        omissions: manifest.omissions,
        coverage: manifest.coverage,
      }),
    );
    if (!bytesEqual(descriptorChecksum, manifest.contentIntegrity.checksum)) {
      throw new ExportPackageInvalidError();
    }
    const expectedPaths = [
      "key.cbor",
      "manifest.cbor",
      ...manifest.entries.map((entry) => entry.path),
    ].toSorted();
    if (expectedPaths.join("\n") !== paths.join("\n")) throw new ExportPackageInvalidError();
    for (const descriptor of manifest.entries) {
      const entry = files.get(descriptor.path);
      if (entry === undefined || entry.uncompressedSize !== descriptor.byteLength) {
        throw new ExportPackageInvalidError();
      }
      if (descriptor.recordType === "ArtifactPayload") continue;
      const bytes = await entryBytes(entry, descriptor.byteLength, signal);
      if (!bytesEqual(await sha256(bytes), descriptor.checksum)) {
        throw new ExportPackageInvalidError();
      }
      const decoded = decodeCanonicalCbor(bytes);
      if (!bytesEqual(bytes, encodeCanonicalCbor(decoded))) throw new ExportPackageInvalidError();
    }
    const keyring = await importVaultKeyring(
      rawKeyring.activeKeyEpochId,
      rawKeyring.keyEpochs.map((epoch) => ({
        ...epoch,
        rootKey: Uint8Array.from(epoch.rootKey),
      })),
    );
    try {
      await onRootKeyAuthenticated?.(manifest.originatingVaultId);
    } catch (error) {
      throw new VaultPackageConsumerError(error);
    }
    const verified = await verifyAuthoritativeVaultPackage({
      manifest,
      keyring,
      read: async (path, maximum) => {
        const entry = files.get(path);
        if (entry === undefined) throw new ExportPackageInvalidError();
        return entryBytes(entry, maximum);
      },
      openArtifact: async (objectId) => {
        signal?.throwIfAborted();
        const entry = files.get(`artifacts/${objectId}.bin`);
        if (entry === undefined) throw new ExportPackageInvalidError();
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        void entry
          .getData(stream.writable, signal === undefined ? undefined : { signal })
          .catch((error: unknown) => stream.writable.abort(error).catch(() => undefined));
        return stream.readable;
      },
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      return await use({ manifest, keyring, ...verified }, rawKeyring);
    } catch (error) {
      throw new VaultPackageConsumerError(error);
    }
  } catch (error) {
    if (error instanceof VaultPackageConsumerError) throw error.cause;
    if (error instanceof ExportAuthenticationError || error instanceof ExportPackageInvalidError) {
      throw error;
    }
    throw new ExportPackageInvalidError();
  } finally {
    passphrase = "";
    if (rawKeyring !== undefined)
      await Promise.all(rawKeyring.keyEpochs.map(async (epoch) => wipe(epoch.rootKey)));
    await reader.close().catch(() => undefined);
  }
}

export async function validateVaultPackage(
  source: Blob,
  passphrase: string,
  signal?: AbortSignal,
): Promise<ValidatedVaultPackage> {
  return withAuthenticatedVaultPackage(
    source,
    passphrase,
    (validated) => validated,
    undefined,
    signal,
  );
}

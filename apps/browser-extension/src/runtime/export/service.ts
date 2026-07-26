import { encodeCanonicalCbor } from "../../domain/cbor";
import { sha256 } from "../../domain/hash";
import type {
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
} from "../../drivers/indexeddb/schema";
import { verifyVaultGeneration } from "../vault/generation";
import type { VaultService } from "../vault/service";
import type { VaultPackageEntry } from "./container";
import type { ExportEntryDescriptorV1, ExportManifestV1 } from "./contracts";
import { verifyAuthoritativeVaultPackage } from "./verify";

export interface VaultExportSource {
  getVaultHead(): Promise<StoredVaultHeadV1 | undefined>;
  getVaultGeneration(generationId: string): Promise<StoredVaultGenerationV1 | undefined>;
  getStoredEvent(eventId: string): Promise<StoredEvent | undefined>;
  getStoredObject(objectId: string): Promise<StoredObjectV1 | undefined>;
  listAuthoritativeIds(): Promise<{
    readonly eventIds: readonly string[];
    readonly objectIds: readonly string[];
  }>;
}

export interface PreparedVaultExport {
  readonly manifest: ExportManifestV1;
  readonly entries: AsyncIterable<VaultPackageEntry>;
  assertSnapshotCurrent(): Promise<void>;
}

export interface ExportArtifactReader {
  openEncrypted(
    vaultId: string,
    objectId: string,
    object: Extract<StoredObjectV1, { readonly objectType: "Artifact" }>,
  ): Promise<ReadableStream<Uint8Array>>;
}

function exactUnion(left: readonly string[], right: readonly string[]): readonly string[] {
  const combined = [...left, ...right].toSorted();
  if (new Set(combined).size !== combined.length)
    throw new Error("Duplicate reachability identifier");
  return combined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameHead(left: StoredVaultHeadV1, right: StoredVaultHeadV1): boolean {
  return (
    left.version === right.version &&
    left.vaultId === right.vaultId &&
    left.generationId === right.generationId &&
    left.generationNumber === right.generationNumber &&
    sameStrings(left.appendedEventIds, right.appendedEventIds) &&
    sameStrings(left.appendedObjectIds, right.appendedObjectIds)
  );
}

async function descriptor(
  path: string,
  recordType: ExportEntryDescriptorV1["recordType"],
  recordId: string,
  bytes: Uint8Array,
): Promise<ExportEntryDescriptorV1> {
  return {
    path,
    recordType,
    recordId,
    byteLength: bytes.byteLength,
    checksumAlgorithm: "hash:sha256:v1",
    checksum: await sha256(bytes),
  };
}

export class VaultExportService {
  constructor(
    private readonly source: VaultExportSource,
    private readonly vault: VaultService,
    private readonly vaultId: string,
    private readonly artifactStore: ExportArtifactReader,
  ) {}

  async prepare(input: {
    readonly packageId: string;
    readonly createdAt: string;
    readonly passphrase: string;
    readonly salt: Uint8Array;
    readonly nonce: Uint8Array;
    readonly omitArtifactObjectIds?: ReadonlySet<string>;
  }): Promise<PreparedVaultExport> {
    const head = await this.source.getVaultHead();
    if (head === undefined || head.vaultId !== this.vaultId) throw new Error("Active head missing");
    const generation = await this.source.getVaultGeneration(head.generationId);
    if (generation === undefined || generation.generationNumber !== head.generationNumber)
      throw new Error("Active Generation missing");
    const retained = await verifyVaultGeneration(
      this.vault.requireKeyring(),
      this.vaultId,
      generation,
    );
    const eventIds = exactUnion(retained.retainedEventIds, head.appendedEventIds);
    const objectIds = exactUnion(retained.retainedObjectIds, head.appendedObjectIds);
    const storedIds = await this.source.listAuthoritativeIds();
    if (
      !sameStrings(eventIds, [...storedIds.eventIds].toSorted()) ||
      !sameStrings(objectIds, [...storedIds.objectIds].toSorted())
    )
      throw new Error("Authoritative reachability mismatch");
    const generationBytes = encodeCanonicalCbor(generation);
    const headBytes = encodeCanonicalCbor(head);
    const descriptors: ExportEntryDescriptorV1[] = [];
    for (const eventId of eventIds) {
      const event = await this.source.getStoredEvent(eventId);
      if (event === undefined || event.eventId !== eventId || event.vaultId !== this.vaultId) {
        throw new Error("Event missing or cross-Vault");
      }
      descriptors.push(
        await descriptor(`events/${eventId}.cbor`, "Event", eventId, encodeCanonicalCbor(event)),
      );
    }
    descriptors.push(
      await descriptor(
        "generation.cbor",
        "VaultGeneration",
        generation.generationId,
        generationBytes,
      ),
      await descriptor("head.cbor", "VaultHead", this.vaultId, headBytes),
    );
    const artifactObjects: Extract<StoredObjectV1, { readonly objectType: "Artifact" }>[] = [];
    const omissions = [];
    for (const objectId of objectIds) {
      const object = await this.source.getStoredObject(objectId);
      if (object === undefined || object.objectId !== objectId) {
        throw new Error("Object missing or unsupported");
      }
      if (object.objectType === "Artifact") {
        artifactObjects.push(object);
        if (input.omitArtifactObjectIds?.has(objectId)) {
          omissions.push({
            artifactObjectId: objectId,
            expectedPath: `artifacts/${objectId}.bin`,
            envelopeByteLength: object.envelopeByteLength,
            envelopeChecksumAlgorithm: object.envelopeChecksumAlgorithm,
            envelopeChecksum: object.envelopeChecksum,
            reason: "NotLocallyAvailable" as const,
          });
        } else {
          descriptors.push({
            path: `artifacts/${objectId}.bin`,
            recordType: "ArtifactPayload",
            recordId: objectId,
            byteLength: object.envelopeByteLength,
            checksumAlgorithm: object.envelopeChecksumAlgorithm,
            checksum: object.envelopeChecksum,
          });
        }
      }
      descriptors.push(
        await descriptor(
          `objects/${objectId}.cbor`,
          "Object",
          objectId,
          encodeCanonicalCbor(object),
        ),
      );
    }
    descriptors.sort((left, right) => left.path.localeCompare(right.path));
    const manifest: ExportManifestV1 = {
      exportFormatVersion: 1,
      packageId: input.packageId,
      createdAt: input.createdAt,
      originatingVaultId: this.vaultId,
      generationId: generation.generationId,
      generationNumber: generation.generationNumber,
      coverage: omissions.length === 0 ? "Complete" : "Selective",
      objectCount: objectIds.length,
      eventCount: eventIds.length,
      artifactPayloadCount: artifactObjects.length - omissions.length,
      supportedFeatures: ["artifact-graph", "selective-coverage", "vault-generation"],
      entries: descriptors,
      omissions: omissions.toSorted((left, right) =>
        left.artifactObjectId.localeCompare(right.artifactObjectId),
      ),
      contentIntegrity: {
        algorithm: "hash:sha256:v1",
        checksum: await sha256(
          encodeCanonicalCbor({
            entries: descriptors,
            omissions: omissions.toSorted((left, right) =>
              left.artifactObjectId.localeCompare(right.artifactObjectId),
            ),
            coverage: omissions.length === 0 ? "Complete" : "Selective",
          }),
        ),
      },
    };
    const manifestBytes = encodeCanonicalCbor(manifest);
    await verifyAuthoritativeVaultPackage({
      manifest,
      keyring: this.vault.requireKeyring(),
      read: async (path) => {
        if (path === "generation.cbor") return generationBytes;
        if (path === "head.cbor") return headBytes;
        const eventMatch = /^events\/(.+)\.cbor$/u.exec(path);
        if (eventMatch?.[1] !== undefined) {
          const event = await this.source.getStoredEvent(eventMatch[1]);
          if (event !== undefined) return encodeCanonicalCbor(event);
        }
        const objectMatch = /^objects\/(.+)\.cbor$/u.exec(path);
        if (objectMatch?.[1] !== undefined) {
          const object = await this.source.getStoredObject(objectMatch[1]);
          if (object !== undefined) return encodeCanonicalCbor(object);
        }
        throw new Error("Authoritative Export record is missing");
      },
      openArtifact: async (objectId) => {
        const object = artifactObjects.find((candidate) => candidate.objectId === objectId);
        if (object === undefined) throw new Error("Artifact Object missing");
        return this.artifactStore.openEncrypted(this.vaultId, objectId, object);
      },
    });
    const keyEnvelope = await this.vault.createExportKeyEnvelope({
      packageId: input.packageId,
      manifestBytes,
      passphrase: input.passphrase,
      salt: input.salt,
      nonce: input.nonce,
    });
    const source = this.source;
    const vaultId = this.vaultId;
    const artifactStore = this.artifactStore;
    return {
      manifest,
      assertSnapshotCurrent: async () => {
        const current = await source.getVaultHead();
        if (current === undefined || !sameHead(head, current))
          throw new Error("Vault head changed");
      },
      entries: {
        async *[Symbol.asyncIterator](): AsyncGenerator<VaultPackageEntry> {
          const fixed = new Map<string, Uint8Array>([
            ["generation.cbor", generationBytes],
            ["head.cbor", headBytes],
            ["key.cbor", encodeCanonicalCbor(keyEnvelope)],
            ["manifest.cbor", manifestBytes],
          ]);
          const paths = [
            ...descriptors.map((entry) => entry.path),
            "key.cbor",
            "manifest.cbor",
          ].toSorted();
          for (const path of paths) {
            const fixedBytes = fixed.get(path);
            if (fixedBytes !== undefined) {
              yield { path, bytes: fixedBytes };
              continue;
            }
            const artifactMatch = /^artifacts\/(.+)\.bin$/u.exec(path);
            if (artifactMatch?.[1] !== undefined) {
              yield {
                path,
                bytes: await artifactStore.openEncrypted(
                  vaultId,
                  artifactMatch[1],
                  artifactObjects.find((candidate) => candidate.objectId === artifactMatch[1]) ??
                    (() => {
                      throw new Error("Artifact Object changed");
                    })(),
                ),
              };
              continue;
            }
            const eventMatch = /^events\/(.+)\.cbor$/u.exec(path);
            if (eventMatch?.[1] !== undefined) {
              const event = await source.getStoredEvent(eventMatch[1]);
              if (event === undefined || event.vaultId !== vaultId)
                throw new Error("Event changed");
              yield { path, bytes: encodeCanonicalCbor(event) };
              continue;
            }
            const objectMatch = /^objects\/(.+)\.cbor$/u.exec(path);
            const object =
              objectMatch?.[1] === undefined
                ? undefined
                : await source.getStoredObject(objectMatch[1]);
            if (object === undefined) throw new Error("Object changed");
            yield { path, bytes: encodeCanonicalCbor(object) };
          }
        },
      },
    };
  }
}

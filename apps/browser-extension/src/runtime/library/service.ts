import { decodeEncryptedEnvelopeBytes, decryptEnvelope } from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import {
  type ArtifactKind,
  type ArtifactReferenceV1,
  type ArtifactRole,
  type BundleDescriptorV1,
  type CaptureMetadataV1,
  decodeBundleDescriptor,
} from "../../domain/artifact-graph";
import { decodeCanonicalCbor } from "../../domain/cbor";
import type { CaptureWarningId, LibraryItemV1, RuntimeErrorId } from "../../domain/contracts";
import type {
  StoredCollectionProjectionV1,
  StoredObjectV1,
  StoredProjectionV1,
} from "../../drivers/indexeddb";
import type { OpenPlaintextArtifactInput } from "../artifact";
import {
  decodeLibraryCollectionState,
  groupCollectionItems,
  type LibraryCollectionGroupV1,
} from "./collections";
import { decodeLibraryItem } from "./decode";

export interface LibraryRepository {
  listEncryptedProjections(): Promise<readonly StoredProjectionV1[]>;
  getCollectionProjection(): Promise<StoredCollectionProjectionV1 | undefined>;
  getStoredObject(objectId: string): Promise<StoredObjectV1 | undefined>;
}

export interface LibraryDetailV1 {
  readonly item: LibraryItemV1;
  readonly metadata: CaptureMetadataV1;
  readonly artifacts: readonly ArtifactDetailItem[];
}

export interface ArtifactDetailItem {
  readonly role: ArtifactRole;
  readonly state: "Present" | "NotProduced" | "Failed";
  readonly kind: ArtifactKind;
  readonly mimeType: string;
  readonly byteLength?: number;
  readonly acquiredAt?: string;
  readonly warning?: CaptureWarningId;
  readonly availability?: "Local" | "RemoteOnly";
  readonly canPreview: boolean;
  readonly canInspect: boolean;
  readonly canDownload: boolean;
}

export interface LibraryArtifactAvailability {
  isArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<boolean>;
}

export interface LibraryArtifactReader {
  openPlaintext(
    input: Pick<
      OpenPlaintextArtifactInput,
      "vaultId" | "object" | "reference" | "rootKey" | "signal"
    >,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface OpenArtifactResult {
  readonly item: LibraryItemV1;
  readonly reference: ArtifactReferenceV1;
  readonly stream: ReadableStream<Uint8Array>;
}

const ROLE_DEFINITION: Readonly<
  Record<ArtifactRole, { readonly kind: ArtifactKind; readonly mimeType: string }>
> = {
  PRIMARY: { kind: "CAPTURE", mimeType: "application/vnd.awsm.web-page+zip" },
  SCREENSHOT_FULL: { kind: "IMAGE", mimeType: "image/webp" },
  THUMBNAIL: { kind: "IMAGE", mimeType: "image/webp" },
  TEXT_EXTRACTED: { kind: "TEXT", mimeType: "text/plain;charset=utf-8" },
  CONTENT_STRUCTURED: {
    kind: "STRUCTURED_CONTENT",
    mimeType: "application/cbor-seq",
  },
};

const ROLES = Object.keys(ROLE_DEFINITION) as readonly ArtifactRole[];

function roleWarning(
  role: ArtifactRole,
  warnings: readonly CaptureWarningId[],
): CaptureWarningId | undefined {
  if (role === "SCREENSHOT_FULL")
    return warnings.find(
      (warning) => warning === "SCREENSHOT_CAPTURE_FAILED" || warning === "SCREENSHOT_UNAVAILABLE",
    );
  if (role === "THUMBNAIL")
    return warnings.find((warning) => warning === "THUMBNAIL_CAPTURE_FAILED");
  if (role === "TEXT_EXTRACTED")
    return warnings.find((warning) => warning === "TEXT_EXTRACTION_FAILED");
  if (role === "CONTENT_STRUCTURED")
    return warnings.find((warning) => warning === "STRUCTURED_CONTENT_EXTRACTION_FAILED");
  return undefined;
}

export type LibraryPageGroupV1 = LibraryCollectionGroupV1;

export class LibraryError extends Error {
  readonly id: RuntimeErrorId;

  constructor(id: RuntimeErrorId, message: string) {
    super(message);
    this.name = "LibraryError";
    this.id = id;
  }
}

export class LibraryService {
  readonly repository: LibraryRepository;
  readonly rootKey: CryptoKey;
  readonly vaultId: string;
  readonly artifactStore: LibraryArtifactReader;
  readonly availability: LibraryArtifactAvailability;

  constructor(
    repository: LibraryRepository,
    rootKey: CryptoKey,
    vaultId: string,
    artifactStore: LibraryArtifactReader,
    availability: LibraryArtifactAvailability,
  ) {
    this.repository = repository;
    this.rootKey = rootKey;
    this.vaultId = vaultId;
    this.artifactStore = artifactStore;
    this.availability = availability;
  }

  async list(): Promise<readonly LibraryItemV1[]> {
    try {
      const records = await this.repository.listEncryptedProjections();
      const items = await Promise.all(records.map((record) => this.decryptProjection(record)));
      return items.toSorted((left, right) => right.capturedAt.localeCompare(left.capturedAt));
    } catch {
      throw new LibraryError("BUNDLE_INVALID", "A library record could not be authenticated.");
    }
  }

  async listActive(): Promise<readonly LibraryItemV1[]> {
    return (await this.list()).filter((item) => item.status === "Active");
  }

  async listDeleted(): Promise<readonly LibraryItemV1[]> {
    return (await this.list()).filter((item) => item.status === "Deleted");
  }

  async groups(): Promise<readonly LibraryPageGroupV1[]> {
    const [items, topology] = await Promise.all([this.list(), this.topology()]);
    return groupCollectionItems(items, topology, "Active");
  }

  async deletedGroups(): Promise<readonly LibraryPageGroupV1[]> {
    const [items, topology] = await Promise.all([this.list(), this.topology()]);
    return groupCollectionItems(items, topology, "Deleted");
  }

  async topology() {
    const record = await this.repository.getCollectionProjection();
    if (record === undefined) return [];
    const key = await deriveContextKeyFromCryptoKey(this.rootKey, {
      vaultId: this.vaultId,
      domain: "vault:projection:v1",
      contextId: `LibraryCollections-v1:${this.vaultId}`,
      keyVersion: 1,
    });
    try {
      const envelope = decodeEncryptedEnvelopeBytes(record.envelopeBytes);
      if (envelope.objectId !== record.projectionId || envelope.objectType !== "Projection") {
        throw new Error("Collection Projection envelope mismatch");
      }
      return decodeLibraryCollectionState(decodeCanonicalCbor(await decryptEnvelope(envelope, key)))
        .topologyEvents;
    } finally {
      await wipe(key);
    }
  }

  async detail(bundleId: string): Promise<LibraryDetailV1> {
    try {
      const { item, descriptor } = await this.loadDescriptor(bundleId);
      const references = new Map(
        descriptor.artifacts.map((reference) => [reference.role, reference]),
      );
      for (const reference of descriptor.artifacts) {
        const object = await this.repository.getStoredObject(reference.artifactObjectId);
        if (object?.objectType !== "Artifact") throw new Error("Missing Artifact");
      }
      return {
        item,
        metadata: descriptor.metadata,
        artifacts: await Promise.all(
          ROLES.map(async (role) => {
            const definition = ROLE_DEFINITION[role];
            const reference = references.get(role);
            const warning = roleWarning(role, item.warnings);
            const state =
              reference !== undefined
                ? "Present"
                : warning === undefined
                  ? "NotProduced"
                  : "Failed";
            return {
              role,
              state,
              kind: definition.kind,
              mimeType: definition.mimeType,
              ...(reference === undefined
                ? {}
                : {
                    byteLength: reference.plaintextByteLength,
                    acquiredAt: reference.acquiredAt,
                    availability: (await this.availability.isArtifactRemoteOnly(
                      this.vaultId,
                      reference.artifactObjectId,
                    ))
                      ? ("RemoteOnly" as const)
                      : ("Local" as const),
                  }),
              ...(warning === undefined ? {} : { warning }),
              canPreview:
                reference !== undefined && (role === "SCREENSHOT_FULL" || role === "THUMBNAIL"),
              canInspect:
                reference !== undefined &&
                (role === "TEXT_EXTRACTED" || role === "CONTENT_STRUCTURED"),
              canDownload: reference !== undefined && role === "PRIMARY",
            };
          }),
        ),
      };
    } catch {
      throw new LibraryError("BUNDLE_INVALID", "The archived capture is missing or corrupt.");
    }
  }

  async openArtifact(bundleId: string, role: ArtifactRole): Promise<OpenArtifactResult> {
    try {
      const { item, descriptor } = await this.loadDescriptor(bundleId);
      const reference = descriptor.artifacts.find((artifact) => artifact.role === role);
      if (reference === undefined) throw new Error("Artifact was not produced");
      const object = await this.repository.getStoredObject(reference.artifactObjectId);
      if (object?.objectType !== "Artifact") throw new Error("Missing Artifact");
      return {
        item,
        reference,
        stream: await this.artifactStore.openPlaintext({
          vaultId: this.vaultId,
          object,
          reference,
          rootKey: this.rootKey,
        }),
      };
    } catch (error) {
      if (error instanceof Error && "id" in error) throw error;
      throw new LibraryError("BUNDLE_INVALID", "The Artifact is missing or corrupt.");
    }
  }

  private async loadDescriptor(
    bundleId: string,
  ): Promise<{ readonly item: LibraryItemV1; readonly descriptor: BundleDescriptorV1 }> {
    const item = (await this.list()).find((candidate) => candidate.bundleId === bundleId);
    if (item === undefined) throw new Error("Missing Projection");
    const record = await this.repository.getStoredObject(item.descriptorObjectId);
    if (record?.objectType !== "BundleDescriptor") throw new Error("Missing descriptor");
    const key = await deriveContextKeyFromCryptoKey(this.rootKey, {
      vaultId: this.vaultId,
      domain: "vault:bundle-descriptor:v1",
      contextId: item.bundleId,
      keyVersion: 1,
    });
    try {
      const envelope = decodeEncryptedEnvelopeBytes(record.envelopeBytes);
      if (envelope.objectId !== record.objectId || envelope.objectType !== "BundleDescriptor")
        throw new Error("Descriptor envelope mismatch");
      const descriptor = decodeBundleDescriptor(await decryptEnvelope(envelope, key));
      if (descriptor.bundleId !== bundleId) throw new Error("Descriptor Bundle mismatch");
      return { item, descriptor };
    } finally {
      await wipe(key);
    }
  }

  private async decryptProjection(record: StoredProjectionV1): Promise<LibraryItemV1> {
    const key = await deriveContextKeyFromCryptoKey(this.rootKey, {
      vaultId: this.vaultId,
      domain: "vault:projection:v1",
      contextId: `LibraryItem-v1:${record.bundleId}`,
      keyVersion: 1,
    });
    try {
      const envelope = decodeEncryptedEnvelopeBytes(record.envelopeBytes);
      if (envelope.objectId !== record.bundleId || envelope.objectType !== "Projection") {
        throw new Error("Projection envelope mismatch");
      }
      return decodeLibraryItem(decodeCanonicalCbor(await decryptEnvelope(envelope, key)));
    } finally {
      await wipe(key);
    }
  }
}

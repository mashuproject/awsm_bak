import type { ArtifactPayloadContract, SealedArtifactStream } from "../../crypto/artifact-stream";
import type { Identifier } from "../../domain/canonical/identifiers";

export interface PreparedArtifactRepresentation {
  readonly artifactId: Identifier<"Artifact">;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly envelopeByteLength: number;
  readonly stream: SealedArtifactStream;
  promote(): Promise<void>;
  /** Cleans only state owned by this preparation, never an identical pre-existing representation. */
  discard(): Promise<void>;
}

export interface PreparedOpaqueArtifactRepresentation {
  readonly artifactId: Identifier<"Artifact">;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly envelopeByteLength: number;
  promote(): Promise<void>;
  /** Cleans only state owned by this preparation, never an identical pre-existing representation. */
  discard(): Promise<void>;
}

export interface CanonicalArtifactStore {
  prepare(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly keyEpochId: Identifier<"KeyEpoch">;
    readonly keyEpochKey: Uint8Array;
    readonly artifactId: Identifier<"Artifact">;
    readonly contract: ArtifactPayloadContract;
    readonly source: AsyncIterable<Uint8Array>;
    readonly protectionParameters?: Uint8Array;
  }): Promise<PreparedArtifactRepresentation>;

  has(storageItemId: Identifier<"StorageItem">): Promise<boolean>;
  open(storageItemId: Identifier<"StorageItem">): Promise<ReadableStream<Uint8Array>>;
  remove(storageItemId: Identifier<"StorageItem">): Promise<void>;
  reconcile?(retainedStorageItemKeys: ReadonlySet<string>): Promise<void>;
}

export interface CanonicalArtifactImportStore extends CanonicalArtifactStore {
  prepareOpaque(input: {
    readonly artifactId: Identifier<"Artifact">;
    readonly storageItemId: Identifier<"StorageItem">;
    readonly envelopeByteLength: number;
    readonly source: ReadableStream<Uint8Array>;
  }): Promise<PreparedOpaqueArtifactRepresentation>;
}

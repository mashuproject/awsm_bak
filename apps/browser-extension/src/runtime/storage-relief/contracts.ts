import { bytesEqual } from "../../domain/hash";
import type { StoredArtifactObjectV1, StoredVaultHeadV1 } from "../../drivers/indexeddb/schema";
import type {
  StorageReliefCheckpointV1,
  StorageReliefJobV1,
  StorageReliefSkipReason,
  StoredRemoteOnlyArtifactV1,
} from "../../drivers/indexeddb/storage-relief-schema";

export interface StorageReliefRepository {
  latestStorageReliefJob(vaultId: string): Promise<StorageReliefJobV1 | undefined>;
  listStorageReliefCheckpoints(
    vaultId: string,
    jobId: string,
  ): Promise<readonly StorageReliefCheckpointV1[]>;
  saveStorageReliefJob(job: StorageReliefJobV1): Promise<void>;
  saveStorageReliefCheckpoint(
    checkpoint: StorageReliefCheckpointV1,
    updatedAt: string,
  ): Promise<void>;
  markArtifactRemoteOnly(input: {
    readonly checkpoint: StorageReliefCheckpointV1;
    readonly availability: StoredRemoteOnlyArtifactV1;
    readonly updatedAt: string;
  }): Promise<void>;
}

export interface StorageReliefArtifactStore {
  has(vaultId: string, objectId: string): Promise<boolean>;
  verifyEncrypted(vaultId: string, object: StoredArtifactObjectV1): Promise<boolean>;
  remove(vaultId: string, objectId: string): Promise<void>;
}

export interface StorageReliefRemoteRecord {
  readonly objectType: "VaultGeneration" | "Artifact" | "BundleDescriptor" | "Event";
  readonly keyEpochId: string;
  readonly byteLength: number;
  readonly sha256: Uint8Array;
  readonly dependencyObjectIds?: readonly string[];
}

export interface StorageReliefProof {
  readonly generationId: string;
  readonly generationNumber: number;
  readonly records: ReadonlyMap<string, StorageReliefRemoteRecord>;
  readonly closures: ReadonlyMap<
    string,
    {
      readonly descriptorObjectId: string;
      readonly registrationEventId: string;
      readonly dependencyObjectIds: readonly string[];
    }
  >;
}

export interface StorageReliefContext {
  readonly vaultId: string;
  readonly accountId: string;
  readonly serverOrigin: string;
  readonly unlocked: boolean;
  readonly authenticated: boolean;
  readonly head: StoredVaultHeadV1;
}

export interface StorageReliefRuntime {
  current(): Promise<StorageReliefContext>;
  synchronize(signal?: AbortSignal): Promise<void>;
  prove(signal?: AbortSignal): Promise<StorageReliefProof>;
  recheckRemoteFence(signal?: AbortSignal): Promise<{
    readonly generationId: string;
    readonly generationNumber: number;
  }>;
}

export interface StorageReliefFaults {
  afterSynchronization?(signal?: AbortSignal): Promise<void>;
  afterVerifiedCheckpoint?(signal?: AbortSignal): Promise<void>;
  afterEvictingCheckpoint?(signal?: AbortSignal): Promise<void>;
  afterWrapperRemoved?(signal?: AbortSignal): Promise<void>;
  afterRemoteOnlyCommit?(signal?: AbortSignal): Promise<void>;
}

export function artifactObject(checkpoint: StorageReliefCheckpointV1): StoredArtifactObjectV1 {
  return {
    version: 1,
    objectId: checkpoint.artifactObjectId,
    objectType: "Artifact",
    keyEpochId: checkpoint.keyEpochId,
    envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
    envelopeByteLength: checkpoint.envelopeByteLength,
    envelopeChecksumAlgorithm: "hash:sha256:v1",
    envelopeChecksum: checkpoint.envelopeChecksum,
  };
}

export function sameHead(left: StoredVaultHeadV1, right: StoredVaultHeadV1): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.generationId === right.generationId &&
    left.generationNumber === right.generationNumber &&
    left.appendedObjectIds.join("\n") === right.appendedObjectIds.join("\n") &&
    left.appendedEventIds.join("\n") === right.appendedEventIds.join("\n")
  );
}

export function storageReliefError(id: string, message: string): Error {
  return Object.assign(new Error(message), { id });
}

export function storageReliefSkipReason(
  checkpoint: StorageReliefCheckpointV1,
  proof: StorageReliefProof,
): StorageReliefSkipReason | undefined {
  const remote = proof.records.get(checkpoint.artifactObjectId);
  if (remote === undefined) return "NotRemoteMember";
  if (
    remote.objectType !== "Artifact" ||
    remote.keyEpochId !== checkpoint.keyEpochId ||
    remote.byteLength !== checkpoint.envelopeByteLength ||
    !bytesEqual(remote.sha256, checkpoint.envelopeChecksum)
  )
    return "RemoteMetadataMismatch";
  const closure = proof.closures.get(checkpoint.artifactObjectId);
  if (closure === undefined) return "DependencyClosureUnavailable";
  const descriptor = proof.records.get(closure.descriptorObjectId);
  const event = proof.records.get(closure.registrationEventId);
  if (
    descriptor?.objectType !== "BundleDescriptor" ||
    event?.objectType !== "Event" ||
    event.dependencyObjectIds?.join("\n") !== closure.dependencyObjectIds.join("\n")
  )
    return "DependencyClosureUnavailable";
  return undefined;
}

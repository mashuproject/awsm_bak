import type { RuntimeErrorId } from "../../domain/contracts";
import type { StoredVaultHeadV1 } from "./schema";

export type StoredRemoteOnlyArtifactV1 = {
  readonly version: 1;
  readonly vaultId: string;
  readonly artifactObjectId: string;
  readonly markedAt: string;
};

export type StorageReliefJobState =
  | "Created"
  | "Running"
  | "WaitingForUnlock"
  | "AuthenticationRequired"
  | "Succeeded"
  | "Failed"
  | "Cancelled";

export type StorageReliefJobStage = "Synchronize" | "Preflight" | "Evict" | "Checkpoint";

export type StorageReliefJobV1 = {
  readonly version: 1;
  readonly vaultId: string;
  readonly jobId: string;
  readonly state: StorageReliefJobState;
  readonly stage: StorageReliefJobStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expectedServerOrigin: string;
  readonly expectedAccountId: string;
  readonly expectedLocalHead?: StoredVaultHeadV1;
  readonly expectedGenerationId?: string;
  readonly expectedGenerationNumber?: number;
  readonly candidateArtifacts: number;
  readonly candidateBytes: number;
  readonly verifiedArtifacts: number;
  readonly verifiedBytes: number;
  readonly evictedArtifacts: number;
  readonly freedBytes: number;
  readonly skippedArtifacts: number;
  readonly skippedBytes: number;
  readonly cancellationRequested: boolean;
  readonly errorId?: RuntimeErrorId;
};

export type StorageReliefCheckpointState =
  | "Candidate"
  | "Verified"
  | "Evicting"
  | "Evicted"
  | "Skipped";

export type StorageReliefSkipReason =
  | "NotRemoteMember"
  | "RemoteMetadataMismatch"
  | "DependencyClosureUnavailable";

export type StorageReliefCheckpointV1 = {
  readonly version: 1;
  readonly vaultId: string;
  readonly jobId: string;
  readonly artifactObjectId: string;
  readonly keyEpochId: string;
  readonly envelopeByteLength: number;
  readonly envelopeChecksum: Uint8Array;
  readonly state: StorageReliefCheckpointState;
  readonly remoteGenerationId?: string;
  readonly remoteGenerationNumber?: number;
  readonly skipReason?: StorageReliefSkipReason;
};

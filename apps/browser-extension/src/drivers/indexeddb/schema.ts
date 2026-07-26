export const DATABASE_VERSION = 1;
export const DATABASE_NAME = "awsm-client";

export const STORES = {
  workspaceMetadata: "workspace_metadata",
  workspaceKeys: "workspace_keys",
  accountConfiguration: "account_configuration",
  apiSessions: "api_sessions",
  sessionKeys: "session_keys",
  protectedCredentials: "protected_credentials",
  vaultSyncState: "vault_sync_state",
  recoveryKits: "recovery_kits",
  deviceSessions: "device_sessions",
  deviceIdentities: "device_identities",
  deviceLocalKeys: "device_local_keys",
  epochKeys: "epoch_keys",
  deviceEnrollmentJobs: "device_enrollment_jobs",
  futureProtectionJobs: "future_protection_jobs",
  vaultReplacementJobs: "vault_replacement_jobs",
  vaultReplacementCheckpoints: "vault_replacement_checkpoints",
  synchronizationJobs: "synchronization_jobs",
  synchronizationCheckpoints: "synchronization_checkpoints",
  serverSwitchJobs: "server_switch_jobs",
  serverSwitchCheckpoints: "server_switch_checkpoints",
  artifactAvailability: "artifact_availability",
  storageReliefJobs: "storage_relief_jobs",
  storageReliefCheckpoints: "storage_relief_checkpoints",
  vaultDirectory: "vault_directory",
  vaultNameCache: "vault_name_cache",
  vaultNameProjection: "vault_name_projection",
  vaultMetadata: "vault_metadata",
  keySlots: "key_slots",
  deviceKeys: "device_keys",
  objects: "objects",
  events: "events",
  libraryProjection: "library_projection",
  collectionProjection: "collection_projection",
  captureJobs: "capture_jobs",
  commandOutcomes: "command_outcomes",
  vaultGenerations: "vault_generations",
  vaultHead: "vault_head",
  vacuumJobs: "vacuum_jobs",
  exportJobs: "export_jobs",
  importJobs: "import_jobs",
  uiPreferences: "ui_preferences",
} as const;

export interface StoredLibraryPreferencesV1 {
  readonly version: 1;
  readonly sort: "CapturedNewest" | "CapturedOldest" | "TitleAscending";
  readonly view: "Grid" | "List";
}

export type AccountConfigurationV1 =
  | { readonly version: 1; readonly mode: "Unconfigured" }
  | { readonly version: 1; readonly mode: "LocalOnly" }
  | {
      readonly version: 1;
      readonly mode: "Configured";
      readonly serverOrigin: string;
      readonly registration:
        | { readonly enabled: false }
        | { readonly enabled: true; readonly signUpUrl: string };
    };

export interface StoredAccountMetadataV1 {
  readonly version: 1;
  readonly accountId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly scope: "Account" | "VaultDevice";
}

export interface StoredAccountSecretsV1 {
  readonly version: 1;
  readonly accountId: string;
  readonly sessionId: string;
  readonly refreshNonce: Uint8Array;
  readonly refreshCiphertext: Uint8Array;
}

export interface StoredAccountVaultV1 {
  readonly version: 1;
  readonly accountId: string;
  readonly vaultId: string;
  readonly activeRecoveryGenerationId: string;
  readonly activeKeyEpochId?: string;
  readonly remoteGenerationId?: string;
  readonly remoteGenerationNumber?: number;
  readonly deliveryCursor: number;
}

export interface StoredRecoveryKitV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly metadata: import("../../runtime/recovery/kit").RecoveryKitMetadataV1;
  readonly ciphertext: Uint8Array;
}

export type SynchronizationStage =
  | "DiscoverAccountVault"
  | "RecoverVault"
  | "EnrollDevice"
  | "EnrollVault"
  | "Subscribe"
  | "FetchHead"
  | "UploadObjects"
  | "CommitEvents"
  | "FetchChanges"
  | "DownloadRecords"
  | "Validate"
  | "ActivateLocal"
  | "Checkpoint"
  | "PrepareServerReplacement"
  | "ActivateServerReplacement";

export interface SynchronizationJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly accountId: string;
  readonly vaultId?: string;
  readonly generationId?: string;
  readonly generationNumber?: number;
  readonly predecessorGenerationId?: string;
  readonly state:
    | "Created"
    | "Running"
    | "Waiting"
    | "AuthenticationRequired"
    | "Conflict"
    | "Failed"
    | "Succeeded";
  readonly stage: SynchronizationStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snapshotCursor: number;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly retryCount: number;
  readonly retryAt?: string;
  readonly errorId?: string;
  readonly attachIdempotencyKey: string;
  readonly preparedArtifactObjectIds?: readonly string[];
}

export interface SynchronizationCheckpointV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly entityId: string;
  readonly kind: "Object" | "Event";
  readonly state: "Prepared" | "Uploading" | "Durable" | "Committed";
  readonly createIdempotencyKey: string;
  readonly completeIdempotencyKey: string;
  readonly commitIdempotencyKey?: string;
  readonly uploadId?: string;
  readonly receivedParts: readonly number[];
}

export type ServerSwitchDirection =
  | "PublishLocal"
  | "FastForwardCandidate"
  | "FastForwardLocal"
  | "Union";

export type ServerSwitchJobState =
  | "AuthenticationRequired"
  | "WaitingForUnlock"
  | "Running"
  | "Conflict"
  | "Failed"
  | "Succeeded";

export type ServerSwitchStage =
  | "AuthenticateCandidate"
  | "Compare"
  | "PrepareRemote"
  | "ActivateRemote"
  | "PrepareLocal"
  | "ActivateLocal"
  | "PromoteContext"
  | "RevokePriorSession"
  | "Terminal";

export interface ServerSwitchJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly sourceOrigin: string;
  readonly candidateOrigin: string;
  readonly candidateRegistration:
    | { readonly enabled: false }
    | { readonly enabled: true; readonly signUpUrl: string };
  readonly vaultId: string;
  readonly state: ServerSwitchJobState;
  readonly stage: ServerSwitchStage;
  readonly direction?: ServerSwitchDirection;
  readonly expectedLocalHead: StoredVaultHeadV1;
  readonly candidateGenerationId?: string;
  readonly candidateGenerationNumber?: number;
  readonly candidatePredecessorGenerationId?: string;
  readonly candidateHeadCursor?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly retryCount: number;
  readonly retryAt?: string;
  readonly candidateAuthorityChanged: boolean;
  readonly errorId?: string;
  readonly conflictReason?: "AncestryUnavailable" | "DivergedGeneration";
  readonly attachIdempotencyKey: string;
  readonly candidateIdempotencyKey: string;
}

export interface ServerSwitchCheckpointV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly kind: "Object" | "Event" | "Generation" | "Recovery";
  readonly entityId: string;
  readonly state: "Prepared" | "Uploading" | "Durable" | "Committed";
  readonly createIdempotencyKey: string;
  readonly completeIdempotencyKey: string;
  readonly commitIdempotencyKey?: string;
  readonly uploadId?: string;
  readonly receivedParts: readonly number[];
}

export type VaultReplacementJobState =
  | "Created"
  | "Running"
  | "WaitingForPhraseConfirmation"
  | "WaitingForExportConfirmation"
  | "WaitingForNetwork"
  | "Conflict"
  | "Failed"
  | "Succeeded"
  | "Aborted";

export type VaultReplacementJobStage =
  | "ExportGate"
  | "PrepareAuthority"
  | "Rewrite"
  | "Validate"
  | "StageRemote"
  | "Upload"
  | "CompleteRemote"
  | "ActivateRemote"
  | "PromoteLocal"
  | "PurgeSource"
  | "Terminal";

export interface VaultReplacementJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly accountId: string;
  readonly sourceVaultId: string;
  readonly sourceHead: StoredVaultHeadV1;
  readonly sourceHeadCursor: number;
  readonly verifiedExportJobId: string;
  readonly safelyStoredConfirmed: true;
  readonly candidateIdempotencyKey: string;
  readonly generationUploadCompleteIdempotencyKey: string;
  readonly candidateCompleteIdempotencyKey: string;
  readonly activationIdempotencyKey: string;
  readonly state: VaultReplacementJobState;
  readonly stage: VaultReplacementJobStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetVaultId?: string;
  readonly targetDeviceId?: string;
  readonly targetRecoveryGenerationId?: string;
  readonly targetKeyEpochId?: string;
  readonly targetGenerationId?: string;
  readonly targetGenerationNumber?: number;
  readonly targetHeadCursor?: number;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly retryCount: number;
  readonly errorId?: string;
  readonly purgeId?: string;
}

export interface VaultReplacementCheckpointV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly sourceVaultId: string;
  readonly targetVaultId: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly updatedAt: string;
}

export interface WorkspaceMetadataV1 {
  readonly version: 1;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly activeVaultId?: string;
}

export interface WorkspaceRecordsV1 {
  readonly metadata: WorkspaceMetadataV1;
  readonly nameCacheKey: CryptoKey;
}

export interface VaultDirectoryEntryV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly createdAt: string;
}

export type StoredObjectType = "BundleDescriptor" | "Artifact";

export interface StoredBundleDescriptorObjectV1 {
  readonly version: 1;
  readonly objectId: string;
  readonly objectType: "BundleDescriptor";
  readonly envelopeBytes: Uint8Array;
}

export interface StoredArtifactObjectV1 {
  readonly version: 1;
  readonly objectId: string;
  readonly objectType: "Artifact";
  readonly keyEpochId: string;
  readonly envelopeFormat: "artifact:xchacha20poly1305-chunked:v1";
  readonly envelopeByteLength: number;
  readonly envelopeChecksumAlgorithm: "hash:sha256:v1";
  readonly envelopeChecksum: Uint8Array;
}

export type StoredObjectV1 = StoredBundleDescriptorObjectV1 | StoredArtifactObjectV1;

export interface StoredEvent {
  readonly version: 1;
  readonly vaultId: string;
  readonly eventId: string;
  readonly referencedObjectIds: readonly string[];
  readonly orderingTimestamp: string;
  readonly envelopeBytes: Uint8Array;
}

export interface StoredProjectionV1 {
  readonly version: 1;
  readonly bundleId: string;
  readonly envelopeBytes: Uint8Array;
}

export interface StoredCollectionProjectionV1 {
  readonly version: 1;
  readonly projectionId: string;
  readonly envelopeBytes: Uint8Array;
}

export interface StoredVaultNameProjectionV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly sourceEventId: string;
  readonly envelopeBytes: Uint8Array;
}

export interface CommandOutcomeV1 {
  readonly version: 1;
  readonly commandId: string;
  readonly status: "Succeeded";
  readonly bundleId: string;
  readonly descriptorObjectId: string;
  readonly eventId: string;
}

export interface AtomicRegistrationV1 {
  readonly objects: readonly StoredObjectV1[];
  readonly graph: {
    readonly bundleId: string;
    readonly descriptorObjectId: string;
    readonly artifactObjectIds: readonly string[];
  };
  readonly event: StoredEvent;
  readonly projection: StoredProjectionV1;
  readonly outcome: CommandOutcomeV1;
}

export interface StoreCounts {
  readonly objects: number;
  readonly events: number;
  readonly projections: number;
  readonly outcomes: number;
}

export interface StoredVaultGenerationV1 {
  readonly version: 1;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly predecessorGenerationId?: string;
  readonly envelopeBytes: Uint8Array;
}

export interface StoredVaultHeadV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly appendedObjectIds: readonly string[];
  readonly appendedEventIds: readonly string[];
}

export interface StoredVacuumJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly sourceGenerationId: string;
  readonly stage:
    | "Preflight"
    | "Analyze"
    | "Rewrite"
    | "Verify"
    | "ActivateRemote"
    | "ActivateLocal";
  readonly createdAt: string;
  readonly candidate?: StoredVacuumCandidateV1;
  readonly activatedHeadCursor?: number;
}

export interface StoredVacuumCandidateV1 {
  readonly jobId: string;
  readonly objectIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly eventsToAdd: readonly StoredEvent[];
  readonly bundleIds: readonly string[];
  readonly expectedGenerationId: string;
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
  readonly deletedArtifactObjectIds: readonly string[];
}

export type ExportJobState = "Created" | "Running" | "Succeeded" | "Failed" | "Cancelled";
export type ExportJobStage = "Preflight" | "Snapshot" | "Verify" | "Package" | "Download";

export interface ExportJobV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly jobId: string;
  readonly packageId: string;
  readonly state: ExportJobState;
  readonly stage: ExportJobStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedEntries: number;
  readonly totalEntries: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly cancellationRequested: boolean;
  readonly verifiedSnapshot?: {
    readonly vaultId: string;
    readonly generationId: string;
    readonly generationNumber: number;
    readonly appendedObjectIds: readonly string[];
    readonly appendedEventIds: readonly string[];
    readonly coverage: "Complete";
    readonly verifiedAt: string;
    readonly downloadedAt: string;
  };
  readonly errorId?: import("../../domain/contracts").RuntimeErrorId;
}

export type ImportJobState = "Created" | "Running" | "Succeeded" | "Failed" | "Cancelled";
export type ImportJobStage =
  | "Acquire"
  | "Authenticate"
  | "Validate"
  | "Prepare"
  | "Rebuild"
  | "Commit";

export interface ImportJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly state: ImportJobState;
  readonly stage: ImportJobStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceByteLength: number;
  readonly acquiredBytes: number;
  readonly completedEntries: number;
  readonly totalEntries: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly cancellationRequested: boolean;
  readonly destinationVaultId?: string;
  readonly errorId?: import("../../domain/contracts").RuntimeErrorId;
}

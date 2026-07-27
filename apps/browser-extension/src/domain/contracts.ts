export const CAPTURE_WARNINGS = [
  "SCREENSHOT_UNAVAILABLE",
  "SCREENSHOT_TRUNCATED",
  "SCREENSHOT_CAPTURE_FAILED",
  "OPTIONAL_METADATA_UNAVAILABLE",
  "THUMBNAIL_CAPTURE_FAILED",
  "TEXT_EXTRACTION_FAILED",
  "STRUCTURED_CONTENT_EXTRACTION_FAILED",
  "PAGE_SNAPSHOT_INCOMPLETE",
] as const;

export type CaptureWarningId = (typeof CAPTURE_WARNINGS)[number];

export const RUNTIME_ERROR_IDS = [
  "VAULT_LOCKED",
  "UNSUPPORTED_URL",
  "PERMISSION_DENIED",
  "PAGE_SNAPSHOT_FAILED",
  "PAGE_SNAPSHOT_TOO_LARGE",
  "PAGE_PACKAGE_FAILED",
  "MHTML_DOWNLOAD_FAILED",
  "CAPTURE_INTERRUPTED",
  "BUNDLE_INVALID",
  "CRYPTO_AUTHENTICATION_FAILED",
  "UNSUPPORTED_FORMAT_VERSION",
  "STORAGE_TRANSACTION_FAILED",
  "LIBRARY_STATE_CHANGED",
  "INVALID_VAULT_NAME",
  "VAULT_NOT_FOUND",
  "VAULT_CONTEXT_CHANGED",
  "VAULT_BUSY",
  "VAULT_LOCAL_COPY_INCOMPLETE",
  "INVALID_EXPORT_PASSPHRASE",
  "EXPORT_AUTHENTICATION_FAILED",
  "EXPORT_PACKAGE_INVALID",
  "EXPORT_INTERRUPTED",
  "EXPORT_DOWNLOAD_FAILED",
  "IMPORT_AUTHENTICATION_FAILED",
  "IMPORT_PACKAGE_INVALID",
  "SELECTIVE_IMPORT_UNSUPPORTED",
  "VAULT_ALREADY_EXISTS",
  "IMPORT_INTERRUPTED",
  "STORAGE_QUOTA_EXCEEDED",
  "ACCOUNT_INPUT_INVALID",
  "ACCOUNT_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_FAILED",
  "REGISTRATION_DISABLED",
  "SESSION_EXPIRED",
  "RECOVERY_PHRASE_INVALID",
  "RECOVERY_GENERATION_CHANGED",
  "KEY_EPOCH_CHANGED",
  "DEVICE_REVOKED",
  "DEVICE_ENROLLMENT_INVALID",
  "VAULT_REPLACEMENT_CONFLICT",
  "VAULT_REPLACEMENT_EXPORT_REQUIRED",
  "SERVER_INCOMPATIBLE",
  "SERVER_PERMISSION_DENIED",
  "SERVER_SWITCH_CONFLICT",
  "SERVER_SWITCH_VAULT_MISMATCH",
  "SYNCHRONIZATION_INTEGRITY_FAILED",
  "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
  "SYNCHRONIZATION_INTERRUPTED",
  "SYNCHRONIZATION_CONFLICT",
  "STORAGE_RELIEF_AUTHENTICATION_REQUIRED",
  "STORAGE_RELIEF_ESTIMATE_CHANGED",
  "REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED",
  "REMOTE_ARTIFACT_OFFLINE",
  "REMOTE_ARTIFACT_UNAVAILABLE",
  "REMOTE_ARTIFACT_NOT_FOUND",
  "REMOTE_ARTIFACT_INTEGRITY_FAILED",
  "STALE_REPLICA_DISCARD_FAILED",
  "SEARCH_QUERY_INVALID",
  "SEARCH_FILTER_INVALID",
  "SEARCH_CURSOR_EXPIRED",
  "SEARCH_INDEX_UNAVAILABLE",
  "SEARCH_INDEX_CORRUPT",
  "SEARCH_PROVIDER_NOT_CONFIGURED",
  "SEARCH_PROVIDER_PERMISSION_REQUIRED",
  "SEARCH_PROVIDER_UNAVAILABLE",
  "SEARCH_PROVIDER_RESPONSE_INVALID",
  "SEARCH_PROVIDER_DIMENSION_CHANGED",
  "SEARCH_MODEL_PERMISSION_REQUIRED",
  "SEARCH_MODEL_DOWNLOAD_FAILED",
  "SEARCH_MODEL_INTEGRITY_FAILED",
  "SEARCH_MODEL_IN_USE",
  "SEARCH_PROBE_EXPIRED",
] as const;

export type RuntimeErrorId = (typeof RUNTIME_ERROR_IDS)[number];

export interface RuntimeErrorV1 {
  readonly id: RuntimeErrorId;
  readonly message: string;
}

export interface CapturePageCommandV1 {
  readonly commandId: string;
  readonly commandType: "CapturePage";
  readonly commandVersion: 1;
  readonly issuingDeviceId: string;
  readonly createdAt: string;
  readonly tabId: number;
  readonly observedUrl: string;
  readonly captureProfileId: "WebPageSnapshot-v1";
  readonly idempotencyKey: string;
}

export interface EncryptedEnvelopeV1 {
  readonly formatVersion: 1;
  readonly objectType:
    | "BundleDescriptor"
    | "Event"
    | "Projection"
    | "WrappedKey"
    | "VaultGeneration";
  readonly algorithm: "enc:xchacha20poly1305:v1";
  readonly keyEpochId: string;
  readonly objectId: string;
  readonly payloadLength: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface LibraryItemV1 {
  readonly version: 1;
  readonly bundleId: string;
  readonly descriptorObjectId: string;
  readonly assignedCollectionId: string;
  readonly title: string;
  readonly originalUrl: string;
  readonly capturedAt: string;
  readonly artifactRoles: readonly import("./artifact-graph").ArtifactRole[];
  readonly status: "Active" | "Deleted";
  readonly thumbnailWebp?: Uint8Array;
  readonly warnings: readonly CaptureWarningId[];
}

export type CaptureJobState = "Created" | "Running" | "Succeeded" | "Failed";
export type CaptureJobStage =
  | "Preflight"
  | "Snapshot"
  | "Screenshot"
  | "Resources"
  | "Package"
  | "Commit";

export interface CaptureJob {
  readonly version: 1;
  readonly vaultId: string;
  readonly jobId: string;
  readonly commandId: string;
  readonly tabId: number;
  readonly state: CaptureJobState;
  readonly stage: CaptureJobStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorId?: RuntimeErrorId;
  readonly noticeDismissed?: boolean;
}

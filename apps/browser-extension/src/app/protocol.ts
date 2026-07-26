import type { ArtifactRole, CaptureMetadataV1 } from "../domain/artifact-graph";
import type {
  CaptureJob,
  CaptureWarningId,
  LibraryItemV1,
  RuntimeErrorId,
} from "../domain/contracts";
import type {
  ExportJobV1,
  ImportJobV1,
  VaultReplacementJobState,
} from "../drivers/indexeddb/schema";
import type { ArtifactDetailItem } from "../runtime/library/service";
import type { WorkspaceState } from "../runtime/vault/workspace-service";
import {
  isStorageReliefRequest,
  type StorageReliefJobView,
  type StorageReliefRequest,
} from "./storage-relief-protocol";

type ExpectedVault = { readonly expectedVaultId: string };

export type AppRequest =
  | StorageReliefRequest
  | { readonly type: "GetState" }
  | { readonly type: "WakeSynchronization" }
  | { readonly type: "ChooseLocalOnly" }
  | { readonly type: "ConfigureSyncServer"; readonly serverOrigin: string }
  | ({
      readonly type: "BeginServerSwitch";
      readonly candidateOrigin: string;
    } & ExpectedVault)
  | {
      readonly type: "LoginServerSwitchCandidate";
      readonly email: string;
      readonly password: string;
    }
  | { readonly type: "CancelServerSwitch"; readonly jobId: string }
  | { readonly type: "RetryServerSwitch"; readonly jobId: string }
  | { readonly type: "RetrySynchronization" }
  | ({
      readonly type: "DiscardStaleReplica";
      readonly exportDecision: "Exported" | "SkipConfirmed";
    } & ExpectedVault)
  | {
      readonly type: "LoginAccount";
      readonly email: string;
      readonly password: string;
    }
  | { readonly type: "LogoutAccount" }
  | { readonly type: "ResetLocalDevice" }
  | {
      readonly type: "PrepareAccountVault";
      readonly existingVaultId?: string;
      readonly newVaultName?: string;
    }
  | {
      readonly type: "ConfirmInitialVault";
      readonly setupId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelInitialVault"; readonly setupId: string }
  | {
      readonly type: "RecoverAccountVault";
      readonly recoveryPhrase: string;
      readonly confirmationPhrase: string;
    }
  | ({ readonly type: "ListVaultDevices" } & ExpectedVault)
  | ({
      readonly type: "RemoveVaultDevice";
      readonly deviceId: string;
    } & ExpectedVault)
  | ({ readonly type: "RemoveCurrentDevice" } & ExpectedVault)
  | ({
      readonly type: "PrepareFutureProtection";
      readonly targetDeviceId: string;
    } & ExpectedVault)
  | {
      readonly type: "ConfirmFutureProtection";
      readonly protectionId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelFutureProtection"; readonly protectionId: string }
  | ({
      readonly type: "PrepareVaultReplacement";
      readonly safelyStoredConfirmed: boolean;
    } & ExpectedVault)
  | {
      readonly type: "ConfirmVaultReplacement";
      readonly replacementId: string;
      readonly recoveryPhrase: string;
    }
  | {
      readonly type: "CancelVaultReplacement";
      readonly replacementId: string;
    }
  | ({ readonly type: "RetryVaultReplacement" } & ExpectedVault)
  | { readonly type: "SuggestVaultName" }
  | {
      readonly type: "CreateVault";
      readonly expectedActiveVaultId?: string;
      readonly name: string;
    }
  | {
      readonly type: "SelectActiveVault";
      readonly expectedActiveVaultId: string;
      readonly vaultId: string;
    }
  | {
      readonly type: "RenameVault";
      readonly expectedActiveVaultId: string;
      readonly vaultId: string;
      readonly name: string;
    }
  | ({ readonly type: "UnlockDevice" } & ExpectedVault)
  | ({
      readonly type: "DismissRecentCapture";
      readonly jobId: string;
    } & ExpectedVault)
  | ({
      readonly type: "CaptureActivePage";
      readonly tabId?: number;
    } & ExpectedVault)
  | ({ readonly type: "ListLibrary" } & ExpectedVault)
  | ({ readonly type: "ListDeleted" } & ExpectedVault)
  | ({
      readonly type: "DeleteCaptures";
      readonly bundleIds: readonly string[];
    } & ExpectedVault)
  | ({
      readonly type: "RestoreCaptures";
      readonly bundleIds: readonly string[];
    } & ExpectedVault)
  | ({
      readonly type: "MergeCollections";
      readonly destinationCollectionId: string;
      readonly sourceCollectionIds: readonly string[];
    } & ExpectedVault)
  | ({
      readonly type: "MoveCaptures";
      readonly bundleIds: readonly string[];
      readonly destinationCollectionId: string;
    } & ExpectedVault)
  | ({
      readonly type: "ExtractCaptures";
      readonly bundleIds: readonly string[];
    } & ExpectedVault)
  | ({
      readonly type: "UndoLibraryOperation";
      readonly operationEventId: string;
    } & ExpectedVault)
  | ({ readonly type: "VacuumVault" } & ExpectedVault)
  | ({ readonly type: "GetVacuumEstimate" } & ExpectedVault)
  | ({
      readonly type: "ExportVault";
      readonly passphrase: string;
    } & ExpectedVault)
  | ({
      readonly type: "CancelVaultExport";
      readonly jobId: string;
    } & ExpectedVault)
  | { readonly type: "BeginVaultImport"; readonly sourceByteLength: number }
  | {
      readonly type: "ReportVaultImportProgress";
      readonly jobId: string;
      readonly acquiredBytes: number;
    }
  | { readonly type: "CompleteVaultImportStaging"; readonly jobId: string }
  | {
      readonly type: "ImportVault";
      readonly jobId: string;
      readonly passphrase: string;
    }
  | { readonly type: "CancelVaultImport"; readonly jobId: string }
  | ({
      readonly type: "GetLibraryDetail";
      readonly bundleId: string;
    } & ExpectedVault)
  | ({
      readonly type: "OpenArtifact";
      readonly bundleId: string;
      readonly role: ArtifactRole;
    } & ExpectedVault)
  | ({
      readonly type: "DownloadMhtml";
      readonly bundleId: string;
    } & ExpectedVault)
  | ({
      readonly type: "ReadArtifactChunk";
      readonly sessionId: string;
    } & ExpectedVault)
  | ({
      readonly type: "CancelArtifactSession";
      readonly sessionId: string;
    } & ExpectedVault);

const APP_REQUEST_TYPES: ReadonlySet<AppRequest["type"]> = new Set([
  "GetState",
  "WakeSynchronization",
  "ChooseLocalOnly",
  "ConfigureSyncServer",
  "BeginServerSwitch",
  "LoginServerSwitchCandidate",
  "CancelServerSwitch",
  "RetryServerSwitch",
  "RetrySynchronization",
  "DiscardStaleReplica",
  "LoginAccount",
  "LogoutAccount",
  "ResetLocalDevice",
  "PrepareAccountVault",
  "ConfirmInitialVault",
  "CancelInitialVault",
  "RecoverAccountVault",
  "ListVaultDevices",
  "RemoveVaultDevice",
  "RemoveCurrentDevice",
  "PrepareFutureProtection",
  "ConfirmFutureProtection",
  "CancelFutureProtection",
  "PrepareVaultReplacement",
  "ConfirmVaultReplacement",
  "CancelVaultReplacement",
  "RetryVaultReplacement",
  "SuggestVaultName",
  "CreateVault",
  "SelectActiveVault",
  "RenameVault",
  "UnlockDevice",
  "DismissRecentCapture",
  "CaptureActivePage",
  "ListLibrary",
  "ListDeleted",
  "DeleteCaptures",
  "RestoreCaptures",
  "MergeCollections",
  "MoveCaptures",
  "ExtractCaptures",
  "UndoLibraryOperation",
  "VacuumVault",
  "GetVacuumEstimate",
  "ExportVault",
  "CancelVaultExport",
  "BeginVaultImport",
  "ReportVaultImportProgress",
  "CompleteVaultImportStaging",
  "ImportVault",
  "CancelVaultImport",
  "GetLibraryDetail",
  "OpenArtifact",
  "DownloadMhtml",
  "ReadArtifactChunk",
  "CancelArtifactSession",
  "GetStorageReliefEstimate",
  "StartStorageRelief",
  "CancelStorageRelief",
]);

export function isAppRequest(value: unknown): value is AppRequest {
  const recognized =
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    APP_REQUEST_TYPES.has(value.type as AppRequest["type"]);
  if (!recognized) return false;
  if (
    value.type === "GetStorageReliefEstimate" ||
    value.type === "StartStorageRelief" ||
    value.type === "CancelStorageRelief"
  )
    return isStorageReliefRequest(value);
  if (
    value.type === "LoginAccount" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "email" && key !== "password") ||
      !("email" in value) ||
      typeof value.email !== "string" ||
      !("password" in value) ||
      typeof value.password !== "string")
  )
    return false;
  if (value.type === "LogoutAccount" && Object.keys(value).some((key) => key !== "type"))
    return false;
  if (value.type === "ResetLocalDevice" && Object.keys(value).some((key) => key !== "type"))
    return false;
  if (
    value.type === "ConfigureSyncServer" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "serverOrigin") ||
      !("serverOrigin" in value) ||
      typeof value.serverOrigin !== "string")
  )
    return false;
  if (
    value.type === "BeginServerSwitch" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "candidateOrigin" && key !== "expectedVaultId",
    ) ||
      !("candidateOrigin" in value) ||
      typeof value.candidateOrigin !== "string" ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string")
  )
    return false;
  if (
    value.type === "LoginServerSwitchCandidate" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "email" && key !== "password") ||
      !("email" in value) ||
      typeof value.email !== "string" ||
      !("password" in value) ||
      typeof value.password !== "string")
  )
    return false;
  if (
    (value.type === "CancelServerSwitch" || value.type === "RetryServerSwitch") &&
    (Object.keys(value).some((key) => key !== "type" && key !== "jobId") ||
      !("jobId" in value) ||
      typeof value.jobId !== "string")
  )
    return false;
  if (value.type === "ChooseLocalOnly" && Object.keys(value).some((key) => key !== "type"))
    return false;
  if (value.type === "WakeSynchronization" && Object.keys(value).some((key) => key !== "type"))
    return false;
  if (value.type === "RetrySynchronization" && Object.keys(value).some((key) => key !== "type"))
    return false;
  if (
    value.type === "DiscardStaleReplica" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "expectedVaultId" && key !== "exportDecision",
    ) ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string" ||
      !("exportDecision" in value) ||
      (value.exportDecision !== "Exported" && value.exportDecision !== "SkipConfirmed"))
  )
    return false;
  if (value.type === "PrepareAccountVault") {
    const validChoice =
      ("existingVaultId" in value &&
        typeof value.existingVaultId === "string" &&
        !("newVaultName" in value)) ||
      ("newVaultName" in value &&
        typeof value.newVaultName === "string" &&
        !("existingVaultId" in value));
    if (
      !validChoice ||
      Object.keys(value).some(
        (key) => key !== "type" && key !== "existingVaultId" && key !== "newVaultName",
      )
    )
      return false;
  }
  if (
    value.type === "ConfirmInitialVault" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "setupId" && key !== "recoveryPhrase",
    ) ||
      !("setupId" in value) ||
      typeof value.setupId !== "string" ||
      !("recoveryPhrase" in value) ||
      typeof value.recoveryPhrase !== "string")
  )
    return false;
  if (
    value.type === "CancelInitialVault" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "setupId") ||
      !("setupId" in value) ||
      typeof value.setupId !== "string")
  )
    return false;
  if (
    value.type === "RecoverAccountVault" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "recoveryPhrase" && key !== "confirmationPhrase",
    ) ||
      !("recoveryPhrase" in value) ||
      typeof value.recoveryPhrase !== "string" ||
      !("confirmationPhrase" in value) ||
      typeof value.confirmationPhrase !== "string")
  )
    return false;
  if (
    value.type === "ListVaultDevices" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "expectedVaultId") ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string")
  )
    return false;
  if (
    value.type === "RemoveVaultDevice" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "expectedVaultId" && key !== "deviceId",
    ) ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string" ||
      !("deviceId" in value) ||
      typeof value.deviceId !== "string")
  )
    return false;
  if (
    value.type === "RemoveCurrentDevice" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "expectedVaultId") ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string")
  )
    return false;
  if (
    value.type === "PrepareFutureProtection" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "expectedVaultId" && key !== "targetDeviceId",
    ) ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string" ||
      !("targetDeviceId" in value) ||
      typeof value.targetDeviceId !== "string")
  )
    return false;
  if (
    value.type === "ConfirmFutureProtection" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "protectionId" && key !== "recoveryPhrase",
    ) ||
      !("protectionId" in value) ||
      typeof value.protectionId !== "string" ||
      !("recoveryPhrase" in value) ||
      typeof value.recoveryPhrase !== "string")
  )
    return false;
  if (
    value.type === "CancelFutureProtection" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "protectionId") ||
      !("protectionId" in value) ||
      typeof value.protectionId !== "string")
  )
    return false;
  if (
    value.type === "PrepareVaultReplacement" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "expectedVaultId" && key !== "safelyStoredConfirmed",
    ) ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string" ||
      !("safelyStoredConfirmed" in value) ||
      typeof value.safelyStoredConfirmed !== "boolean")
  )
    return false;
  if (
    value.type === "ConfirmVaultReplacement" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "replacementId" && key !== "recoveryPhrase",
    ) ||
      !("replacementId" in value) ||
      typeof value.replacementId !== "string" ||
      !("recoveryPhrase" in value) ||
      typeof value.recoveryPhrase !== "string")
  )
    return false;
  if (
    value.type === "CancelVaultReplacement" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "replacementId") ||
      !("replacementId" in value) ||
      typeof value.replacementId !== "string")
  )
    return false;
  if (
    value.type === "RetryVaultReplacement" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "expectedVaultId") ||
      !("expectedVaultId" in value) ||
      typeof value.expectedVaultId !== "string")
  )
    return false;
  if (
    value.type === "BeginVaultImport" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "sourceByteLength") ||
      !("sourceByteLength" in value) ||
      typeof value.sourceByteLength !== "number" ||
      !Number.isSafeInteger(value.sourceByteLength) ||
      value.sourceByteLength < 0)
  )
    return false;
  if (
    value.type === "ReportVaultImportProgress" &&
    (Object.keys(value).some(
      (key) => key !== "type" && key !== "jobId" && key !== "acquiredBytes",
    ) ||
      !("jobId" in value) ||
      typeof value.jobId !== "string" ||
      !("acquiredBytes" in value) ||
      typeof value.acquiredBytes !== "number" ||
      !Number.isSafeInteger(value.acquiredBytes) ||
      value.acquiredBytes < 0)
  )
    return false;
  if (
    (value.type === "CompleteVaultImportStaging" || value.type === "CancelVaultImport") &&
    (Object.keys(value).some((key) => key !== "type" && key !== "jobId") ||
      !("jobId" in value) ||
      typeof value.jobId !== "string")
  )
    return false;
  if (
    value.type === "ImportVault" &&
    (Object.keys(value).some((key) => key !== "type" && key !== "jobId" && key !== "passphrase") ||
      !("jobId" in value) ||
      typeof value.jobId !== "string" ||
      !("passphrase" in value) ||
      typeof value.passphrase !== "string")
  )
    return false;
  if ("expectedVaultId" in value && typeof value.expectedVaultId !== "string") return false;
  if (value.type === "CreateVault" && "passphrase" in value) return false;
  if (
    value.type === "ExportVault" &&
    (!("passphrase" in value) || typeof value.passphrase !== "string")
  )
    return false;
  if (
    value.type === "OpenArtifact" &&
    (!("bundleId" in value) ||
      typeof value.bundleId !== "string" ||
      !("role" in value) ||
      !["PRIMARY", "SCREENSHOT_FULL", "THUMBNAIL", "TEXT_EXTRACTED", "CONTENT_STRUCTURED"].includes(
        String(value.role),
      ))
  )
    return false;
  if (
    value.type === "DownloadMhtml" &&
    (!("bundleId" in value) || typeof value.bundleId !== "string")
  )
    return false;
  if (
    (value.type === "ReadArtifactChunk" || value.type === "CancelArtifactSession") &&
    (!("sessionId" in value) || typeof value.sessionId !== "string")
  )
    return false;
  if (
    value.type === "CancelVaultExport" &&
    (!("jobId" in value) || typeof value.jobId !== "string")
  )
    return false;
  return true;
}

export interface AppState {
  readonly account: AccountView;
  readonly workspace: WorkspaceState;
  readonly serverSwitch?: ServerSwitchView;
  readonly vaultReplacement?: VaultReplacementView;
  readonly latestJob?: CaptureJob;
  readonly latestWarnings?: readonly CaptureWarningId[];
  readonly recentCapture?: RecentCapture;
  readonly latestExportJob?: ExportJobV1;
  readonly latestImportJob?: ImportJobV1;
  readonly latestStorageReliefJob?: StorageReliefJobView;
  readonly remoteOnlyArtifactCount?: number;
}

export interface VaultReplacementView {
  readonly jobId: string;
  readonly sourceVaultId: string;
  readonly targetVaultId?: string;
  readonly state: VaultReplacementJobState;
  readonly stage: string;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly errorId?: string;
}

export interface ServerSwitchView {
  readonly jobId: string;
  readonly candidateOrigin: string;
  readonly state:
    | "AuthenticationRequired"
    | "VaultLocked"
    | "Comparing"
    | "Applying"
    | "Conflict"
    | "Failed";
  readonly direction?: "PublishLocal" | "FastForwardCandidate" | "FastForwardLocal" | "Union";
  readonly completedItems: number;
  readonly totalItems: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly errorId?: string;
  readonly reason?: "AncestryUnavailable" | "DivergedGeneration";
  readonly candidateAuthorityChanged?: boolean;
}

export interface AccountView {
  readonly configuration:
    | { readonly mode: "Unconfigured" }
    | { readonly mode: "LocalOnly" }
    | {
        readonly mode: "Configured";
        readonly serverOrigin: string;
        readonly registration:
          | { readonly enabled: false }
          | { readonly enabled: true; readonly signUpUrl: string };
      };
  readonly email?: string;
  readonly accountState: "SignedOut" | "Authenticating" | "Authenticated" | "Expired";
  readonly vaultSyncState:
    | "LocalOnly"
    | "Enrolling"
    | "Uploading"
    | "Downloading"
    | "UpToDate"
    | "Offline"
    | "PermissionRequired"
    | "AuthenticationRequired"
    | "DeviceRevoked"
    | "Conflict"
    | "Failed"
    | "SetupRequired"
    | "RecoveryRequired";
  readonly errorId?: string;
  readonly staleResolutionRequired?: boolean;
}

export interface RecentCapture {
  readonly vaultId: string;
  readonly jobId: string;
  readonly bundleId: string;
  readonly title: string;
  readonly screenshotBase64?: string;
  readonly warnings: readonly CaptureWarningId[];
}

export interface AppStateChanged {
  readonly type: "AppStateChanged";
}

export interface LibraryDetailMessage {
  readonly item: LibraryItemV1;
  readonly metadata: CaptureMetadataV1;
  readonly artifacts: readonly ArtifactDetailItem[];
}

export interface OpenArtifactMessage {
  readonly sessionId: string;
  readonly role: ArtifactRole;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly filename: string;
}

export interface ArtifactChunkMessage {
  readonly done: boolean;
  readonly chunkBase64?: string;
}

export interface LibraryPageGroupMessage {
  readonly collectionId: string;
  readonly title: string;
  readonly originalUrl: string;
  readonly knownUrls: readonly string[];
  readonly latest: LibraryItemV1;
  readonly captures: readonly LibraryItemV1[];
  readonly captureThumbnails: readonly LibraryCaptureThumbnail[];
}

export interface LibraryCaptureThumbnail {
  readonly bundleId: string;
  readonly thumbnailBase64?: string;
}

export interface LibraryOperationReceipt {
  readonly operationEventId: string;
  readonly destinationCollectionId: string;
}

export type AppValue =
  | AppState
  | readonly LibraryPageGroupMessage[]
  | LibraryDetailMessage
  | LibraryOperationReceipt
  | OpenArtifactMessage
  | ArtifactChunkMessage
  | { readonly name: string }
  | { readonly bundleId: string }
  | { readonly filename: string }
  | { readonly jobId: string; readonly filename: string }
  | { readonly jobId: string }
  | { readonly jobId: string; readonly vaultId: string }
  | {
      readonly setupId: string;
      readonly recoveryPhrase: string;
      readonly recoveryFileBase64: string;
      readonly recoveryFilename: string;
    }
  | {
      readonly protectionId: string;
      readonly recoveryPhrase: string;
      readonly recoveryFileBase64: string;
      readonly recoveryFilename: string;
    }
  | {
      readonly replacementId: string;
      readonly recoveryPhrase: string;
      readonly recoveryFileBase64: string;
      readonly recoveryFilename: string;
    }
  | readonly {
      readonly deviceId: string;
      readonly displayName: string;
      readonly clientKind: string;
      readonly current: boolean;
      readonly revoked: boolean;
    }[]
  | { readonly forkVaultId: string }
  | { readonly deletedCaptureCount: number; readonly reclaimedBytes: number }
  | { readonly deletedCaptureCount: number; readonly reclaimableBytes: number }
  | { readonly candidateArtifacts: number; readonly candidateBytes: number }
  | null;

export type AppResponse =
  | { readonly ok: true; readonly value: AppValue }
  | {
      readonly ok: false;
      readonly error: { readonly id: RuntimeErrorId; readonly message: string };
    };

export const PAGE_SNAPSHOT_PROFILE_KEY = "awsm.capture.web-page-snapshot" as const;
export const PAGE_SNAPSHOT_MIME_TYPE = "application/vnd.awsm.web-page+zip" as const;
export const PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE = "text/html;charset=utf-8" as const;

export type SnapshotAcquisition = "Embedded" | "Cache" | "Network";
export type SnapshotCompression = "Store" | "Deflate";
export type SnapshotOmissionSubject = "Frame" | "Resource" | "Media" | "FileInput";
export type SnapshotOmissionReason =
  | "InaccessibleFrame"
  | "CrossOrigin"
  | "UnsupportedScheme"
  | "FetchFailed"
  | "ResourceTooLarge"
  | "CaptureBudgetExceeded"
  | "MediaBodyExcluded"
  | "FileBodyExcluded"
  | "InvalidContent";

export interface SnapshotDocumentV1 {
  readonly id: string;
  readonly parentId?: string;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly member: string;
  readonly mediaType: typeof PAGE_SNAPSHOT_DOCUMENT_MEDIA_TYPE;
  readonly byteLength: number;
  readonly sha256: Uint8Array;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface SnapshotResourceV1 {
  readonly id: string;
  readonly ownerDocumentId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly member: string;
  readonly mediaType: string;
  readonly contentLanguage?: string;
  readonly status: number;
  readonly byteLength: number;
  readonly sha256: Uint8Array;
  readonly acquisition: SnapshotAcquisition;
  readonly compression: SnapshotCompression;
}

export interface SnapshotOmissionV1 {
  readonly ownerDocumentId: string;
  readonly url: string;
  readonly subject: SnapshotOmissionSubject;
  readonly reason: SnapshotOmissionReason;
}

export interface PageSnapshotManifestV1 {
  readonly version: 1;
  readonly captureProfileKey: typeof PAGE_SNAPSHOT_PROFILE_KEY;
  readonly capturedAt: number;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly topDocumentId: "d000000";
  readonly documents: readonly SnapshotDocumentV1[];
  readonly resources: readonly SnapshotResourceV1[];
  readonly omissions: readonly SnapshotOmissionV1[];
}

export interface SnapshotDocumentSource {
  readonly parentId?: string;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly bytes: Uint8Array | Blob;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface SnapshotResourceSource {
  readonly ownerDocumentId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly bytes: Uint8Array | Blob;
  readonly mediaType: string;
  readonly contentLanguage?: string;
  readonly status: number;
  readonly acquisition: SnapshotAcquisition;
  readonly compression: SnapshotCompression;
}

export interface CreatePageSnapshotInput {
  readonly capturedAt: number;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly documents: readonly SnapshotDocumentSource[];
  readonly resources: readonly SnapshotResourceSource[];
  readonly omissions: readonly SnapshotOmissionV1[];
}

export interface ValidatedPageSnapshot {
  readonly manifest: PageSnapshotManifestV1;
  readonly members: ReadonlyMap<string, Blob>;
}

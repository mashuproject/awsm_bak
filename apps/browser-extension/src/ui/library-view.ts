import type { ArtifactRole } from "../domain/artifact-graph";

interface CaptureIdentity {
  readonly bundleId: string;
}

interface CaptureGroup {
  readonly captures: readonly CaptureIdentity[];
}

interface PointerPosition {
  readonly clientX: number;
  readonly clientY: number;
}

interface ElementBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function dragImageHotspot(
  pointer: PointerPosition,
  bounds: ElementBounds,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.min(bounds.width, Math.max(0, pointer.clientX - bounds.left)),
    y: Math.min(bounds.height, Math.max(0, pointer.clientY - bounds.top)),
  };
}

export type LibraryGroupDestination =
  | { readonly screen: "detail"; readonly bundleId: string }
  | { readonly screen: "history" };

export function libraryGroupDestination(group: CaptureGroup): LibraryGroupDestination {
  const onlyCapture = group.captures.length === 1 ? group.captures[0] : undefined;
  return onlyCapture === undefined
    ? { screen: "history" }
    : { screen: "detail", bundleId: onlyCapture.bundleId };
}

export function collectionLayerBundleIds(group: CaptureGroup): readonly string[] {
  return group.captures.slice(0, 3).map((capture) => capture.bundleId);
}

export function mergeDropRequest(sourceCollectionId: string, destinationCollectionId: string) {
  if (sourceCollectionId === destinationCollectionId) return undefined;
  return {
    type: "MergeCollections" as const,
    destinationCollectionId,
    sourceCollectionIds: [sourceCollectionId],
  };
}

export function captureDropRequest(
  bundleIds: readonly string[],
  destinationCollectionId: string | "new",
) {
  const canonicalIds = [...new Set(bundleIds)].toSorted();
  if (canonicalIds.length === 0) return undefined;
  return destinationCollectionId === "new"
    ? { type: "ExtractCaptures" as const, bundleIds: canonicalIds }
    : {
        type: "MoveCaptures" as const,
        bundleIds: canonicalIds,
        destinationCollectionId,
      };
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Byte size must be non-negative.");
  const units = ["B", "KiB", "MiB", "GiB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    unitIndex === 0
      ? String(Math.round(value))
      : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  return `${formatted} ${units[unitIndex]}`;
}

export function storageReliefConfirmation(
  candidateArtifacts: number,
  candidateBytes: number,
): string {
  return [
    `Remove up to ${formatByteSize(candidateBytes)} from this device?`,
    "AWSM will verify each encrypted server copy before removing its local copy.",
    `These ${String(candidateArtifacts)} page snapshots and screenshots will require your Account and a connection until retrieved again.`,
  ].join("\n\n");
}

export type ArtifactPresentationAction = "Download" | "Preview" | "Inspect" | "None";

export function artifactPresentation(role: ArtifactRole): {
  readonly label: string;
  readonly action: ArtifactPresentationAction;
} {
  switch (role) {
    case "PRIMARY":
      return { label: "MHTML", action: "Download" };
    case "SCREENSHOT_FULL":
      return { label: "Screenshot", action: "Preview" };
    case "THUMBNAIL":
      return { label: "Thumbnail", action: "None" };
    case "TEXT_EXTRACTED":
      return { label: "Extracted text", action: "Inspect" };
    case "CONTENT_STRUCTURED":
      return { label: "Structured content", action: "Inspect" };
  }
}

export function signOutConfirmation(remoteOnlyArtifacts: number): string {
  return [
    "Sign out and lock this Vault?",
    "Decrypted content will disappear immediately. The Account password cannot decrypt the Vault.",
    ...(remoteOnlyArtifacts === 0
      ? []
      : [
          `${String(remoteOnlyArtifacts)} remote-only ${remoteOnlyArtifacts === 1 ? "Artifact remains" : "Artifacts remain"} on the synchronization server. This Device can retrieve ${remoteOnlyArtifacts === 1 ? "it" : "them"} after you unlock the Vault unless the Device is removed.`,
        ]),
  ].join("\n\n");
}

export function remoteArtifactFailureMessage(
  errorId: string | undefined,
  surface: "Inspect" | "Download" | "Screenshot",
): string {
  if (errorId === "REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED")
    return surface === "Screenshot"
      ? "Sign in to retrieve this screenshot."
      : "Sign in to retrieve this Artifact.";
  if (errorId === "REMOTE_ARTIFACT_OFFLINE")
    return surface === "Download"
      ? "Reconnect and try the download again."
      : surface === "Screenshot"
        ? "This screenshot is stored on the server. Reconnect and try again."
        : "This Artifact is stored on the server. Reconnect and try again.";
  if (errorId === "REMOTE_ARTIFACT_INTEGRITY_FAILED")
    return surface === "Screenshot"
      ? "Screenshot failed integrity verification."
      : "The Artifact failed integrity verification.";
  if (errorId === "REMOTE_ARTIFACT_NOT_FOUND")
    return surface === "Screenshot"
      ? "The server no longer has this screenshot."
      : "The server no longer has this Artifact.";
  if (errorId === "REMOTE_ARTIFACT_UNAVAILABLE")
    return surface === "Download"
      ? "The server copy is temporarily unavailable. Try the download again."
      : "The server copy is temporarily unavailable. Try again.";
  return surface === "Inspect"
    ? "The Artifact could not be inspected. Try again."
    : surface === "Download"
      ? "The Artifact could not be saved. Try again."
      : "Screenshot preview unavailable. Try again.";
}

export function libraryStateConfirmation(
  title: string,
  captureCount: number,
  operation: "Delete" | "Restore",
): string {
  if (operation === "Restore") {
    return `Restore “${title}” (${String(captureCount)} ${captureCount === 1 ? "capture" : "captures"}) to the Library?`;
  }
  return [
    `Delete “${title}” (${String(captureCount)} ${captureCount === 1 ? "capture" : "captures"})?`,
    "Deleted captures remain accessible and restorable in Deleted.",
    "They continue using storage until you run Vault Vacuum.",
  ].join("\n\n");
}

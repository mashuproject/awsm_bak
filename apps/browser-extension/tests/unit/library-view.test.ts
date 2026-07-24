import { describe, expect, it } from "vitest";
import {
  artifactPresentation,
  captureDropRequest,
  collectionLayerBundleIds,
  dragImageHotspot,
  formatByteSize,
  libraryGroupDestination,
  libraryStateConfirmation,
  mergeDropRequest,
  remoteArtifactFailureMessage,
  signOutConfirmation,
  storageReliefConfirmation,
} from "../../src/ui/library-view";

const capture = (suffix: string) => ({ bundleId: `00000000-0000-4000-8000-${suffix}` });

describe("Library collection navigation", () => {
  it("keeps the grabbed point under the pointer in the drag ghost", () => {
    expect(
      dragImageHotspot(
        { clientX: 260, clientY: 340 },
        { left: 100, top: 200, width: 320, height: 280 },
      ),
    ).toEqual({ x: 160, y: 140 });
    expect(
      dragImageHotspot(
        { clientX: 500, clientY: 100 },
        { left: 100, top: 200, width: 320, height: 280 },
      ),
    ).toEqual({ x: 320, y: 0 });
  });

  it("formats retained and reclaimable storage in readable binary units", () => {
    expect(formatByteSize(824)).toBe("824 B");
    expect(formatByteSize(12_697)).toBe("12.4 KiB");
    expect(formatByteSize(3_250_586)).toBe("3.1 MiB");
  });

  it("explains the complete proof-before-delete storage-relief boundary", () => {
    expect(storageReliefConfirmation(2, 3_250_586)).toBe(
      "Remove up to 3.1 MiB from this device?\n\n" +
        "AWSM will verify each encrypted server copy before removing its local copy.\n\n" +
        "These 2 page snapshots and screenshots will require your Account and a connection until retrieved again.",
    );
  });

  it("maps internal Artifact roles to user-facing labels and actions", () => {
    expect(artifactPresentation("PRIMARY")).toEqual({ label: "MHTML", action: "Download" });
    expect(artifactPresentation("SCREENSHOT_FULL")).toEqual({
      label: "Screenshot",
      action: "Preview",
    });
    expect(artifactPresentation("THUMBNAIL")).toEqual({ label: "Thumbnail", action: "None" });
    expect(artifactPresentation("TEXT_EXTRACTED")).toEqual({
      label: "Extracted text",
      action: "Inspect",
    });
    expect(artifactPresentation("CONTENT_STRUCTURED")).toEqual({
      label: "Structured content",
      action: "Inspect",
    });
  });

  it("warns before signing out when remote-only payloads depend on Account access", () => {
    expect(signOutConfirmation(3)).toBe(
      "Sign out while 3 remote-only Artifacts depend on this Account?\n\n" +
        "Those payloads will be unavailable until you sign in to the same Account on this synchronization server again.",
    );
    expect(signOutConfirmation(0)).toBeUndefined();
  });
  it("distinguishes remote integrity, availability, authentication, and offline failures", () => {
    expect(remoteArtifactFailureMessage("REMOTE_ARTIFACT_INTEGRITY_FAILED", "Screenshot")).toBe(
      "Screenshot failed integrity verification.",
    );
    expect(remoteArtifactFailureMessage("REMOTE_ARTIFACT_UNAVAILABLE", "Inspect")).toBe(
      "The server copy is temporarily unavailable. Try again.",
    );
    expect(
      remoteArtifactFailureMessage("REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED", "Download"),
    ).toBe("Sign in to retrieve this Artifact.");
    expect(remoteArtifactFailureMessage("REMOTE_ARTIFACT_OFFLINE", "Screenshot")).toBe(
      "This screenshot is stored on the server. Reconnect and try again.",
    );
  });
  it("opens a single capture directly without an intermediate history view", () => {
    expect(libraryGroupDestination({ captures: [capture("000000000001")] })).toEqual({
      screen: "detail",
      bundleId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("opens history and layers actual newest capture thumbnails for a collection", () => {
    const captures = [
      capture("000000000003"),
      capture("000000000002"),
      capture("000000000001"),
      capture("000000000000"),
    ];
    expect(libraryGroupDestination({ captures })).toEqual({ screen: "history" });
    expect(collectionLayerBundleIds({ captures })).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("describes deletion as restorable until explicit Vault Vacuum", () => {
    expect(libraryStateConfirmation("A useful page", 2, "Delete")).toBe(
      "Delete “A useful page” (2 captures)?\n\n" +
        "Deleted captures remain accessible and restorable in Deleted.\n\n" +
        "They continue using storage until you run Vault Vacuum.",
    );
  });

  it("uses the collection drop target as the merge destination", () => {
    expect(mergeDropRequest("source-id", "destination-id")).toEqual({
      type: "MergeCollections",
      destinationCollectionId: "destination-id",
      sourceCollectionIds: ["source-id"],
    });
    expect(mergeDropRequest("same-id", "same-id")).toBeUndefined();
  });

  it("maps selected capture drops to Move or Extract requests", () => {
    expect(captureDropRequest(["b", "a"], "destination-id")).toEqual({
      type: "MoveCaptures",
      bundleIds: ["a", "b"],
      destinationCollectionId: "destination-id",
    });
    expect(captureDropRequest(["b", "a"], "new")).toEqual({
      type: "ExtractCaptures",
      bundleIds: ["a", "b"],
    });
    expect(captureDropRequest([], "new")).toBeUndefined();
  });
});

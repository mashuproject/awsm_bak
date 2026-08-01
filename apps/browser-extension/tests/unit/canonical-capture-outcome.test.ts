import { describe, expect, it } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import {
  decodeCanonicalCaptureOutcome,
  encodeCanonicalCaptureOutcome,
} from "../../src/runtime/capture/canonical-outcome";

describe("canonical Capture outcome", () => {
  it("round-trips the complete local idempotency result canonically", () => {
    const value = {
      commandId: "capture:workflow-1",
      vaultId: randomIdentifier("Vault"),
      generationId: randomIdentifier("Generation"),
      bundleId: randomIdentifier("Bundle"),
      assignedCollectionId: randomIdentifier("Collection"),
      eventRecordId: randomIdentifier("VaultRecord"),
      descriptorObjectId: randomIdentifier("VaultObject"),
      artifactObjectId: randomIdentifier("VaultObject"),
      artifactStorageItemId: randomIdentifier("StorageItem"),
    } as const;
    expect(decodeCanonicalCaptureOutcome(encodeCanonicalCaptureOutcome(value))).toEqual(value);
  });

  it("rejects control characters and unknown fields", () => {
    const value = {
      commandId: "capture\nworkflow",
      vaultId: randomIdentifier("Vault"),
      generationId: randomIdentifier("Generation"),
      bundleId: randomIdentifier("Bundle"),
      assignedCollectionId: randomIdentifier("Collection"),
      eventRecordId: randomIdentifier("VaultRecord"),
      descriptorObjectId: randomIdentifier("VaultObject"),
      artifactObjectId: randomIdentifier("VaultObject"),
      artifactStorageItemId: randomIdentifier("StorageItem"),
    } as const;
    expect(() => encodeCanonicalCaptureOutcome(value)).toThrow(/Command ID/u);
  });
});

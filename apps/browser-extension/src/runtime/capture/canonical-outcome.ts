import type { Identifier } from "../../domain/canonical/identifiers";
import {
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  textValue,
} from "../../domain/canonical/schema";
import {
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";

export const CAPTURE_OUTCOME_FORMAT = 1 as const;

export interface CanonicalCaptureOutcome {
  readonly commandId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly bundleId: Identifier<"Bundle">;
  readonly assignedCollectionId: Identifier<"Collection">;
  readonly eventRecordId: Identifier<"VaultRecord">;
  readonly descriptorObjectId: Identifier<"VaultObject">;
  readonly artifactObjectId: Identifier<"VaultObject">;
  readonly artifactStorageItemId: Identifier<"StorageItem">;
}

export function assertCanonicalCommandId(value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > 256 ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    throw new TypeError("Command ID is outside the accepted local bounds");
  }
}

export function encodeCanonicalCaptureOutcome(value: CanonicalCaptureOutcome): Uint8Array {
  assertCanonicalCommandId(value.commandId);
  return encodeCanonicalValue(
    canonicalMap([
      [0, CAPTURE_OUTCOME_FORMAT],
      [1, value.commandId],
      [2, value.vaultId],
      [3, value.generationId],
      [4, value.bundleId],
      [5, value.assignedCollectionId],
      [6, value.eventRecordId],
      [7, value.descriptorObjectId],
      [8, value.artifactObjectId],
      [9, value.artifactStorageItemId],
    ]),
  );
}

export function decodeCanonicalCaptureOutcome(bytes: Uint8Array): CanonicalCaptureOutcome {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [...Array(10).keys()],
    "Canonical Capture outcome",
  );
  exactCode(mapValue(map, 0), CAPTURE_OUTCOME_FORMAT, "Capture outcome format");
  const value: CanonicalCaptureOutcome = {
    commandId: textValue(mapValue(map, 1), "Capture Command ID", { maxUtf8Bytes: 256 }),
    vaultId: identifierValue(mapValue(map, 2), "Vault", "Capture outcome Vault ID"),
    generationId: identifierValue(mapValue(map, 3), "Generation", "Capture outcome Generation ID"),
    bundleId: identifierValue(mapValue(map, 4), "Bundle", "Capture outcome Bundle ID"),
    assignedCollectionId: identifierValue(
      mapValue(map, 5),
      "Collection",
      "Capture outcome Collection ID",
    ),
    eventRecordId: identifierValue(mapValue(map, 6), "VaultRecord", "Capture outcome Event ID"),
    descriptorObjectId: identifierValue(
      mapValue(map, 7),
      "VaultObject",
      "Capture outcome Descriptor ID",
    ),
    artifactObjectId: identifierValue(
      mapValue(map, 8),
      "VaultObject",
      "Capture outcome Artifact Object ID",
    ),
    artifactStorageItemId: identifierValue(
      mapValue(map, 9),
      "StorageItem",
      "Capture outcome Artifact Storage Item ID",
    ),
  };
  assertCanonicalCommandId(value.commandId);
  if (!bytesEqual(encodeCanonicalCaptureOutcome(value), bytes)) {
    throw new TypeError("Canonical Capture outcome bytes are not canonical");
  }
  return value;
}

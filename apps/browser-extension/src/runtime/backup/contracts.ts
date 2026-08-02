import { sha256 } from "@noble/hashes/sha2.js";

import {
  byteString,
  exactCode,
  exactMap,
  mapValue,
  nonnegativeInteger,
} from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";

export const BACKUP_SNAPSHOT_FORMAT = 1 as const;
export const BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE = 1 as const;

export interface BackupSnapshotManifestInput {
  readonly format: typeof BACKUP_SNAPSHOT_FORMAT;
  readonly backupSetId: Uint8Array;
  readonly protectionProfile: typeof BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE;
  readonly packageByteLength: number;
  readonly packageByteDigest: Uint8Array;
}

export interface BackupSnapshotManifest extends BackupSnapshotManifestInput {
  readonly snapshotId: Uint8Array;
}

function snapshotStateValue(
  input: BackupSnapshotManifestInput,
): ReadonlyMap<number, CanonicalValue> {
  const backupSetId = byteString(input.backupSetId, 32, "Backup Set ID");
  if (backupSetId.every((byte) => byte === 0)) {
    throw new TypeError("Backup Set ID must not be all zero");
  }
  const packageByteLength = nonnegativeInteger(
    input.packageByteLength,
    "Backup package byte length",
  );
  if (packageByteLength < 1) throw new TypeError("Backup package byte length must be positive");
  return canonicalMap([
    [0, exactCode(input.format, BACKUP_SNAPSHOT_FORMAT, "Backup Snapshot format")],
    [1, backupSetId],
    [
      3,
      exactCode(
        input.protectionProfile,
        BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE,
        "Backup protection profile",
      ),
    ],
    [4, packageByteLength],
    [5, byteString(input.packageByteDigest, 32, "Backup package byte digest")],
  ]);
}

export function backupSnapshotId(input: BackupSnapshotManifestInput): Uint8Array {
  return sha256(
    transcript("awsm:backup-snapshot-id:v1", [encodeCanonicalValue(snapshotStateValue(input))]),
  );
}

export function encodeBackupSnapshotManifest(input: BackupSnapshotManifest): Uint8Array {
  const state = snapshotStateValue(input);
  const snapshotId = byteString(input.snapshotId, 32, "Backup Snapshot ID");
  if (!bytesEqual(snapshotId, backupSnapshotId(input))) {
    throw new TypeError("Backup Snapshot ID does not match its Manifest");
  }
  return encodeCanonicalValue(canonicalMap([...state.entries(), [2, snapshotId] as const]));
}

export function decodeBackupSnapshotManifest(bytes: Uint8Array): BackupSnapshotManifest {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4, 5], "Backup Snapshot Manifest");
  const packageByteLength = nonnegativeInteger(mapValue(map, 4), "Backup package byte length");
  if (packageByteLength < 1) throw new TypeError("Backup package byte length must be positive");
  const value: BackupSnapshotManifest = {
    format: exactCode(mapValue(map, 0), BACKUP_SNAPSHOT_FORMAT, "Backup Snapshot format"),
    backupSetId: byteString(mapValue(map, 1), 32, "Backup Set ID"),
    snapshotId: byteString(mapValue(map, 2), 32, "Backup Snapshot ID"),
    protectionProfile: exactCode(
      mapValue(map, 3),
      BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE,
      "Backup protection profile",
    ),
    packageByteLength,
    packageByteDigest: byteString(mapValue(map, 5), 32, "Backup package byte digest"),
  };
  if (value.backupSetId.every((byte) => byte === 0)) {
    throw new TypeError("Backup Set ID must not be all zero");
  }
  if (!bytesEqual(value.snapshotId, backupSnapshotId(value))) {
    throw new TypeError("Backup Snapshot ID does not match its Manifest");
  }
  if (!bytesEqual(bytes, encodeBackupSnapshotManifest(value))) {
    throw new TypeError("Backup Snapshot Manifest is not canonical");
  }
  return value;
}

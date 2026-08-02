import { byteString, nonnegativeInteger } from "../../domain/canonical/schema";
import { bytesEqual } from "../../domain/hash";
import { decodeBackupSnapshotManifest } from "./contracts";

export interface BackupSetSnapshotEntry {
  readonly snapshotId: Uint8Array;
  readonly manifestBytes: Uint8Array;
}

export interface BackupSetPackageEntry {
  readonly packageByteLength: number;
  readonly packageByteDigest: Uint8Array;
}

export interface BackupSetDestinationInventory {
  readonly backupSetId: Uint8Array;
  readonly snapshots: readonly BackupSetSnapshotEntry[];
  readonly packageEntries: readonly BackupSetPackageEntry[];
}

export interface BackupSetRetentionPlan {
  readonly expectedInventory: BackupSetDestinationInventory;
  readonly deleteSnapshotIds: readonly Uint8Array[];
  readonly deletePackageEntries: readonly BackupSetPackageEntry[];
  readonly retainedSnapshotCount: number;
  readonly retainedPackageEntryCount: number;
}

export interface BackupSetRetentionInput {
  readonly inventory: BackupSetDestinationInventory;
  readonly deleteSnapshotIds: readonly Uint8Array[];
}

export interface CanonicalBackupSetRetentionDestination {
  readonly readInventory: (backupSetId: Uint8Array) => Promise<BackupSetDestinationInventory>;
  /** Applies the deletions only when the destination still exactly matches expectedInventory. */
  readonly commitRetention: (input: {
    readonly expectedInventory: BackupSetDestinationInventory;
    readonly deleteSnapshotIds: readonly Uint8Array[];
    readonly deletePackageEntries: readonly BackupSetPackageEntry[];
  }) => Promise<void>;
}

export interface CanonicalBackupSetRetentionOutcome {
  readonly deletedSnapshotCount: number;
  readonly deletedPackageEntryCount: number;
  readonly retainedSnapshotCount: number;
  readonly retainedPackageEntryCount: number;
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function backupSetId(value: Uint8Array): Uint8Array {
  const parsed = byteString(value, 32, "Backup Set ID");
  if (parsed.every((byte) => byte === 0)) throw new TypeError("Backup Set ID must not be all zero");
  return Uint8Array.from(parsed);
}

function normalizeInventory(input: BackupSetDestinationInventory): BackupSetDestinationInventory {
  const setId = backupSetId(input.backupSetId);
  const snapshots = input.snapshots.map((entry) => {
    const snapshotId = byteString(entry.snapshotId, 32, "Backup Snapshot inventory ID");
    const manifestBytes = Uint8Array.from(entry.manifestBytes);
    const manifest = decodeBackupSnapshotManifest(manifestBytes);
    same(manifest.backupSetId, setId, "Backup Snapshot Backup Set ID");
    same(manifest.snapshotId, snapshotId, "Backup Snapshot inventory ID");
    return { snapshotId: Uint8Array.from(snapshotId), manifestBytes };
  });
  const snapshotKeys = snapshots.map(({ snapshotId }) => key(snapshotId));
  if (new Set(snapshotKeys).size !== snapshotKeys.length) {
    throw new TypeError("Backup Set inventory contains a duplicate Snapshot ID");
  }
  snapshots.sort((left, right) => compareBytes(left.snapshotId, right.snapshotId));

  const packageEntries = input.packageEntries.map((entry) => {
    const packageByteLength = nonnegativeInteger(
      entry.packageByteLength,
      "Backup package entry byte length",
    );
    if (packageByteLength < 1) throw new TypeError("Backup package entry must not be empty");
    return {
      packageByteLength,
      packageByteDigest: Uint8Array.from(
        byteString(entry.packageByteDigest, 32, "Backup package entry digest"),
      ),
    };
  });
  const packageDigests = packageEntries.map(({ packageByteDigest }) => key(packageByteDigest));
  if (new Set(packageDigests).size !== packageDigests.length) {
    throw new TypeError("Backup Set inventory contains a duplicate encrypted package digest");
  }
  packageEntries.sort((left, right) =>
    compareBytes(left.packageByteDigest, right.packageByteDigest),
  );

  const packages = new Map(
    packageEntries.map((entry) => [key(entry.packageByteDigest), entry] as const),
  );
  for (const snapshot of snapshots) {
    const manifest = decodeBackupSnapshotManifest(snapshot.manifestBytes);
    const packageEntry = packages.get(key(manifest.packageByteDigest));
    if (
      packageEntry === undefined ||
      packageEntry.packageByteLength !== manifest.packageByteLength
    ) {
      throw new TypeError("Backup Snapshot is missing encrypted package dependency");
    }
  }
  return { backupSetId: setId, snapshots, packageEntries };
}

export function planBackupSetRetention(input: BackupSetRetentionInput): BackupSetRetentionPlan {
  const inventory = normalizeInventory(input.inventory);
  const deleteSnapshotIds = input.deleteSnapshotIds.map((snapshotId) =>
    Uint8Array.from(byteString(snapshotId, 32, "Backup retention Snapshot ID")),
  );
  const deleteKeys = deleteSnapshotIds.map(key);
  if (new Set(deleteKeys).size !== deleteKeys.length) {
    throw new TypeError("Backup retention contains a duplicate Snapshot ID");
  }
  const snapshots = new Map(
    inventory.snapshots.map((entry) => [key(entry.snapshotId), entry] as const),
  );
  for (const snapshotKey of deleteKeys) {
    if (!snapshots.has(snapshotKey)) {
      throw new TypeError("Backup retention selects an unknown Snapshot");
    }
  }
  deleteSnapshotIds.sort(compareBytes);
  const deleteKeySet = new Set(deleteKeys);

  const retainedSnapshots = inventory.snapshots.filter(
    ({ snapshotId }) => !deleteKeySet.has(key(snapshotId)),
  );
  const retainedPackageKeys = new Set(
    retainedSnapshots.map(({ manifestBytes }) =>
      key(decodeBackupSnapshotManifest(manifestBytes).packageByteDigest),
    ),
  );
  const deletePackageEntries = inventory.packageEntries.filter(
    ({ packageByteDigest }) => !retainedPackageKeys.has(key(packageByteDigest)),
  );
  return {
    expectedInventory: inventory,
    deleteSnapshotIds,
    deletePackageEntries,
    retainedSnapshotCount: retainedSnapshots.length,
    retainedPackageEntryCount: inventory.packageEntries.length - deletePackageEntries.length,
  };
}

export class CanonicalBackupSetRetentionService {
  constructor(private readonly destination: CanonicalBackupSetRetentionDestination) {}

  async retain(input: {
    readonly backupSetId: Uint8Array;
    readonly deleteSnapshotIds: readonly Uint8Array[];
  }): Promise<CanonicalBackupSetRetentionOutcome> {
    const setId = backupSetId(input.backupSetId);
    const inventory = await this.destination.readInventory(setId);
    same(inventory.backupSetId, setId, "Backup Set destination identity");
    const plan = planBackupSetRetention({
      inventory,
      deleteSnapshotIds: input.deleteSnapshotIds,
    });
    if (plan.deleteSnapshotIds.length > 0 || plan.deletePackageEntries.length > 0) {
      await this.destination.commitRetention({
        expectedInventory: plan.expectedInventory,
        deleteSnapshotIds: plan.deleteSnapshotIds,
        deletePackageEntries: plan.deletePackageEntries,
      });
    }
    return {
      deletedSnapshotCount: plan.deleteSnapshotIds.length,
      deletedPackageEntryCount: plan.deletePackageEntries.length,
      retainedSnapshotCount: plan.retainedSnapshotCount,
      retainedPackageEntryCount: plan.retainedPackageEntryCount,
    };
  }
}

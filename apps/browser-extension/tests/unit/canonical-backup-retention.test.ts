import { describe, expect, it, vi } from "vitest";

import {
  BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE,
  BACKUP_SNAPSHOT_FORMAT,
  backupSnapshotId,
  encodeBackupSnapshotManifest,
} from "../../src/runtime/backup/contracts";
import {
  type BackupSetDestinationInventory,
  CanonicalBackupSetRetentionService,
  planBackupSetRetention,
} from "../../src/runtime/backup/retention";

function snapshot(backupSetId: Uint8Array, digestByte: number, byteLength: number) {
  const input = {
    format: BACKUP_SNAPSHOT_FORMAT,
    backupSetId,
    protectionProfile: BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE,
    packageByteLength: byteLength,
    packageByteDigest: new Uint8Array(32).fill(digestByte),
  } as const;
  const manifest = { ...input, snapshotId: backupSnapshotId(input) };
  return {
    snapshotId: manifest.snapshotId,
    manifestBytes: encodeBackupSnapshotManifest(manifest),
    packageEntry: {
      packageByteLength: byteLength,
      packageByteDigest: manifest.packageByteDigest,
    },
  };
}

function inventory(): BackupSetDestinationInventory {
  const backupSetId = new Uint8Array(32).fill(1);
  const first = snapshot(backupSetId, 2, 20);
  const second = snapshot(backupSetId, 3, 30);
  return {
    backupSetId,
    snapshots: [second, first],
    packageEntries: [second.packageEntry, first.packageEntry],
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required Backup Set fixture is missing");
  return value;
}

describe("canonical Backup Set retention", () => {
  it("removes only selected Snapshots and encrypted packages unreachable from retained Snapshots", () => {
    const current = inventory();
    const selected = required(current.snapshots[1]);
    const selectedPackage = required(current.packageEntries[1]);

    const plan = planBackupSetRetention({
      inventory: current,
      deleteSnapshotIds: [selected.snapshotId],
    });

    expect(plan.deleteSnapshotIds).toEqual([selected.snapshotId]);
    expect(plan.deletePackageEntries).toEqual([selectedPackage]);
    expect(plan.retainedSnapshotCount).toBe(1);
    expect(plan.retainedPackageEntryCount).toBe(1);
  });

  it("fails closed on missing dependencies, foreign manifests, and unknown deletion targets", () => {
    const current = inventory();
    expect(() =>
      planBackupSetRetention({
        inventory: { ...current, packageEntries: current.packageEntries.slice(1) },
        deleteSnapshotIds: [],
      }),
    ).toThrow(/missing encrypted package/u);

    const foreign = snapshot(new Uint8Array(32).fill(9), 4, 40);
    expect(() =>
      planBackupSetRetention({
        inventory: { ...current, snapshots: [foreign] },
        deleteSnapshotIds: [],
      }),
    ).toThrow(/Backup Set ID/u);

    expect(() =>
      planBackupSetRetention({
        inventory: current,
        deleteSnapshotIds: [new Uint8Array(32).fill(8)],
      }),
    ).toThrow(/unknown Snapshot/u);

    expect(() =>
      planBackupSetRetention({
        inventory: {
          ...current,
          packageEntries: [
            ...current.packageEntries,
            { packageByteLength: 99, packageByteDigest: new Uint8Array(32).fill(2) },
          ],
        },
        deleteSnapshotIds: [],
      }),
    ).toThrow(/duplicate encrypted package digest/u);
  });

  it("reclaims orphan encrypted packages without selecting a retained Snapshot", () => {
    const current = inventory();
    const orphan = { packageByteLength: 40, packageByteDigest: new Uint8Array(32).fill(4) };

    const plan = planBackupSetRetention({
      inventory: { ...current, packageEntries: [...current.packageEntries, orphan] },
      deleteSnapshotIds: [],
    });

    expect(plan.deleteSnapshotIds).toEqual([]);
    expect(plan.deletePackageEntries).toEqual([orphan]);
    expect(plan.retainedSnapshotCount).toBe(2);
    expect(plan.retainedPackageEntryCount).toBe(2);
  });

  it("commits one exact-inventory conditional retention mutation", async () => {
    const current = inventory();
    const selected = required(current.snapshots[0]);
    const selectedPackage = required(current.packageEntries[0]);
    const commitRetention = vi.fn(async () => undefined);
    const service = new CanonicalBackupSetRetentionService({
      readInventory: async () => current,
      commitRetention,
    });

    const outcome = await service.retain({
      backupSetId: current.backupSetId,
      deleteSnapshotIds: [selected.snapshotId],
    });

    expect(outcome).toEqual({
      deletedSnapshotCount: 1,
      deletedPackageEntryCount: 1,
      retainedSnapshotCount: 1,
      retainedPackageEntryCount: 1,
    });
    expect(commitRetention).toHaveBeenCalledOnce();
    expect(commitRetention).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedInventory: expect.objectContaining({ backupSetId: current.backupSetId }),
        deleteSnapshotIds: [selected.snapshotId],
        deletePackageEntries: [selectedPackage],
      }),
    );
  });

  it("does not mutate a complete retained inventory when policy selects nothing", async () => {
    const current = inventory();
    const commitRetention = vi.fn(async () => undefined);
    const service = new CanonicalBackupSetRetentionService({
      readInventory: async () => current,
      commitRetention,
    });

    await expect(
      service.retain({ backupSetId: current.backupSetId, deleteSnapshotIds: [] }),
    ).resolves.toEqual({
      deletedSnapshotCount: 0,
      deletedPackageEntryCount: 0,
      retainedSnapshotCount: 2,
      retainedPackageEntryCount: 2,
    });
    expect(commitRetention).not.toHaveBeenCalled();
  });
});

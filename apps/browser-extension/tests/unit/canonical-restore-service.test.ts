import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { EMPTY_REQUIRED_FEATURE_SET_ID } from "../../src/domain/canonical/features";
import { type Identifier, identifier } from "../../src/domain/canonical/identifiers";
import { CanonicalStorageError } from "../../src/drivers/indexeddb/canonical-database";
import {
  type BackupSnapshotManifest,
  backupSnapshotId,
  encodeBackupSnapshotManifest,
} from "../../src/runtime/backup/contracts";
import type { CanonicalBackupVerificationArea } from "../../src/runtime/backup/service";
import { prepareCompleteExportEntry } from "../../src/runtime/complete-export/container";
import {
  type CompleteExportManifestInput,
  completeExportStateDigest,
  decodeCompleteExportManifest,
  encodeCompleteExportManifest,
} from "../../src/runtime/complete-export/contracts";
import { CanonicalRestoreService } from "../../src/runtime/restore/service";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function exportManifest() {
  const vaultId = filled("Vault", 1);
  const generationId = filled("Generation", 2);
  const baselineId = filled("VaultRecord", 3);
  const frontierId = filled("VaultRecord", 4);
  const storageItemId = prepareCompleteExportEntry(2, Uint8Array.of(9)).header
    .entryId as Identifier<"StorageItem">;
  const input: CompleteExportManifestInput = {
    vaultId,
    generationId,
    frontier: [frontierId],
    requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
    typedLogicalRoots: [
      { type: DEPENDENCY_TYPES.VaultBaseline, id: baselineId },
      { type: DEPENDENCY_TYPES.VaultRecord, id: frontierId },
    ],
    opaqueItemInventory: [
      {
        namespace: 1,
        logicalId: frontierId,
        storageItemId,
        keyEpochId: filled("KeyEpoch", 5),
        byteLength: 1,
        byteDigest: new Uint8Array(32).fill(6),
      },
    ],
    continuityProofRoots: [frontierId],
  };
  return decodeCompleteExportManifest(
    encodeCompleteExportManifest({
      format: 1,
      ...input,
      stateDigest: completeExportStateDigest(input),
    }),
  );
}

function snapshot(manifest = exportManifest(), packageBytes = Uint8Array.of(1, 2, 3)) {
  const input = {
    format: 1 as const,
    backupSetId: new Uint8Array(32).fill(7),
    protectionProfile: 1 as const,
    packageByteLength: packageBytes.byteLength,
    packageByteDigest: sha256(packageBytes),
  };
  const value: BackupSnapshotManifest = { ...input, snapshotId: backupSnapshotId(input) };
  return { value, bytes: encodeBackupSnapshotManifest(value), packageBytes, manifest };
}

function verificationArea(): CanonicalBackupVerificationArea {
  return {
    beginOpaque: async () => ({
      write: async () => undefined,
      finish: async () => undefined,
      abort: async () => undefined,
    }),
    abortAll: async () => undefined,
    openOpaque: async () => new ReadableStream(),
    discard: vi.fn(async () => undefined),
  };
}

function fixture(known: boolean) {
  const stored = snapshot();
  const verification = verificationArea();
  const key = new Uint8Array(32).fill(11);
  const validatePackage = vi.fn(async (input) => {
    for await (const _chunk of input.encrypted) {
      // The validator owns complete stream consumption.
    }
    return {
      manifest: stored.manifest,
      keyInventory: {
        format: 1 as const,
        vaultId: stored.manifest.vaultId,
        generationId: stored.manifest.generationId,
        entries: [{ keyEpochId: filled("KeyEpoch", 12), keyEpochKey: key }],
      },
      opaqueItemCount: 1,
      frameCount: 1,
    };
  });
  const activateUnknown = vi.fn(async () => ({
    vaultId: stored.manifest.vaultId,
    generationId: stored.manifest.generationId,
  }));
  const reconcileKnown = vi.fn(async () => ({ relation: "equal" as const, changed: false }));
  const service = new CanonicalRestoreService({
    vaults: {
      listVaults: async () => (known ? [{ vaultId: stored.manifest.vaultId }] : []),
    },
    completeImports: { activateUnknown, reconcileKnown },
    validatePackage,
  });
  return {
    stored,
    verification,
    key,
    service,
    activateUnknown,
    reconcileKnown,
  };
}

describe("canonical Restore service", () => {
  it.each([false, true])(
    "restores a verified Snapshot through the ordinary %s-Vault Import path",
    async (known) => {
      const subject = fixture(known);
      const outcome = await subject.service.restore({
        snapshotManifestBytes: subject.stored.bytes,
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          yield subject.stored.packageBytes;
        })(),
        verification: subject.verification,
      });

      expect(outcome.kind).toBe(known ? "reconciled" : "activated");
      expect(subject.activateUnknown).toHaveBeenCalledTimes(known ? 0 : 1);
      expect(subject.reconcileKnown).toHaveBeenCalledTimes(known ? 1 : 0);
      expect(subject.key).toEqual(new Uint8Array(32));
      expect(subject.verification.discard).toHaveBeenCalledOnce();
    },
  );

  it("rejects altered Backup bytes before exposing any Replica mutation", async () => {
    const subject = fixture(false);
    const altered = Uint8Array.from(subject.stored.packageBytes);
    altered[0] = (altered[0] ?? 0) ^ 1;

    await expect(
      subject.service.restore({
        snapshotManifestBytes: subject.stored.bytes,
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          yield altered;
        })(),
        verification: subject.verification,
      }),
    ).rejects.toThrow(/Backup package bytes/u);
    expect(subject.activateUnknown).not.toHaveBeenCalled();
    expect(subject.reconcileKnown).not.toHaveBeenCalled();
    expect(subject.verification.discard).toHaveBeenCalledOnce();
  });

  it("reclassifies through known-Vault reconciliation when concurrent activation wins", async () => {
    const subject = fixture(false);
    subject.activateUnknown.mockRejectedValueOnce(
      new CanonicalStorageError("VAULT_ALREADY_EXISTS", "concurrent Restore won"),
    );

    const outcome = await subject.service.restore({
      snapshotManifestBytes: subject.stored.bytes,
      passphrase: "correct horse battery staple",
      encrypted: (async function* () {
        yield subject.stored.packageBytes;
      })(),
      verification: subject.verification,
    });

    expect(outcome).toMatchObject({ kind: "reconciled", relation: "equal", changed: false });
    expect(subject.activateUnknown).toHaveBeenCalledOnce();
    expect(subject.reconcileKnown).toHaveBeenCalledOnce();
  });

  it("discards Restore Prepared Data even when the Snapshot Manifest is malformed", async () => {
    const subject = fixture(false);

    await expect(
      subject.service.restore({
        snapshotManifestBytes: Uint8Array.of(1),
        passphrase: "correct horse battery staple",
        encrypted: (async function* () {
          yield subject.stored.packageBytes;
        })(),
        verification: subject.verification,
      }),
    ).rejects.toThrow();
    expect(subject.verification.discard).toHaveBeenCalledOnce();
  });
});

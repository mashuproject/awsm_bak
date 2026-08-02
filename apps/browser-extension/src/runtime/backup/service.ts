import { sha256 } from "@noble/hashes/sha2.js";

import { wipe } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import { encodeCompleteExportManifest } from "../complete-export/contracts";
import type {
  CanonicalCompleteExportInput,
  CanonicalCompleteExportOutcome,
} from "../complete-export/service";
import type { CompleteImportPreparedSource } from "../complete-import/semantic";
import { validateCompleteExportSemantics } from "../complete-import/semantic";
import type { CompleteImportPreparedSink } from "../complete-import/validate";
import { validateCompleteExportPackage } from "../complete-import/validate";
import {
  BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE,
  BACKUP_SNAPSHOT_FORMAT,
  type BackupSnapshotManifest,
  backupSnapshotId,
  encodeBackupSnapshotManifest,
} from "./contracts";

export interface CanonicalBackupPreparedSnapshot {
  /** Writes preparation-owned unpublished package bytes. */
  readonly write: (bytes: Uint8Array) => Promise<void>;
  /** Durably finishes unpublished package bytes before independent readback. */
  readonly finish: () => Promise<void>;
  /** Reopens the exact destination representation rather than an in-process write buffer. */
  readonly open: () => AsyncIterable<Uint8Array>;
  /** Atomically and idempotently publishes this exact Manifest last. */
  readonly commit: (snapshotManifestBytes: Uint8Array) => Promise<void>;
  /** Removes only preparation-owned unpublished state and never a published Snapshot. */
  readonly abort: () => Promise<void>;
}

export interface CanonicalBackupVerificationArea
  extends CompleteImportPreparedSink,
    CompleteImportPreparedSource {
  readonly discard: () => Promise<void>;
}

interface CanonicalBackupExporter {
  readonly export: (input: CanonicalCompleteExportInput) => Promise<CanonicalCompleteExportOutcome>;
}

interface CanonicalBackupDependencies {
  readonly exporter: CanonicalBackupExporter;
  readonly createVerificationArea: () => Promise<CanonicalBackupVerificationArea>;
  readonly validatePackage?: typeof validateCompleteExportPackage;
  readonly validateSemantics?: typeof validateCompleteExportSemantics;
}

export interface CanonicalBackupSnapshotInput {
  readonly backupSetId: Uint8Array;
  readonly vaultId: Identifier<"Vault">;
  readonly passphrase: string;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly prepared: CanonicalBackupPreparedSnapshot;
}

export interface CanonicalBackupSnapshotOutcome {
  readonly snapshot: BackupSnapshotManifest;
  readonly opaqueItemCount: number;
  readonly frameCount: number;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

export class CanonicalBackupService {
  private readonly validatePackage: typeof validateCompleteExportPackage;
  private readonly validateSemantics: typeof validateCompleteExportSemantics;

  constructor(private readonly dependencies: CanonicalBackupDependencies) {
    this.validatePackage = dependencies.validatePackage ?? validateCompleteExportPackage;
    this.validateSemantics = dependencies.validateSemantics ?? validateCompleteExportSemantics;
  }

  async createSnapshot(
    input: CanonicalBackupSnapshotInput,
  ): Promise<CanonicalBackupSnapshotOutcome> {
    const writtenDigest = sha256.create();
    let writtenLength = 0;
    let verification: CanonicalBackupVerificationArea | undefined;
    let packageValidation: Awaited<ReturnType<typeof validateCompleteExportPackage>> | undefined;
    let semanticValidation: Awaited<ReturnType<typeof validateCompleteExportSemantics>> | undefined;
    let committed = false;
    try {
      const exported = await this.dependencies.exporter.export({
        vaultId: input.vaultId,
        passphrase: input.passphrase,
        salt: input.salt,
        nonce: input.nonce,
        write: async (bytes) => {
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
            throw new TypeError("Backup package chunks must contain bytes");
          }
          writtenLength += bytes.byteLength;
          if (!Number.isSafeInteger(writtenLength)) {
            throw new TypeError("Backup package byte length exceeds the portable bound");
          }
          writtenDigest.update(bytes);
          await input.prepared.write(bytes);
        },
      });
      if (writtenLength < 1) throw new TypeError("Backup package must not be empty");
      await input.prepared.finish();

      verification = await this.dependencies.createVerificationArea();
      const readDigest = sha256.create();
      let readLength = 0;
      const readback = input.prepared.open();
      const verifiedReadback: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          for await (const bytes of readback) {
            if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
              throw new TypeError("Backup destination readback chunks must contain bytes");
            }
            readLength += bytes.byteLength;
            if (!Number.isSafeInteger(readLength)) {
              throw new TypeError("Backup destination readback exceeds the portable bound");
            }
            readDigest.update(bytes);
            yield bytes;
          }
        },
      };
      packageValidation = await this.validatePackage({
        passphrase: input.passphrase,
        encrypted: verifiedReadback,
        sink: verification,
      });
      const packageByteDigest = writtenDigest.digest();
      if (readLength !== writtenLength || !bytesEqual(readDigest.digest(), packageByteDigest)) {
        throw new TypeError("Backup destination readback does not match the written package");
      }
      same(
        encodeCompleteExportManifest(packageValidation.manifest),
        encodeCompleteExportManifest(exported.manifest),
        "Backup verified Complete Export Manifest",
      );
      semanticValidation = await this.validateSemantics({
        manifest: packageValidation.manifest,
        keyInventory: packageValidation.keyInventory,
        source: verification,
      });
      same(
        encodeCompleteExportManifest(semanticValidation.manifest),
        encodeCompleteExportManifest(exported.manifest),
        "Backup semantic Complete Export Manifest",
      );

      const snapshotInput = {
        format: BACKUP_SNAPSHOT_FORMAT,
        backupSetId: input.backupSetId,
        protectionProfile: BACKUP_COMPLETE_EXPORT_PASSPHRASE_PROFILE,
        packageByteLength: writtenLength,
        packageByteDigest,
      } as const;
      const snapshot: BackupSnapshotManifest = {
        ...snapshotInput,
        snapshotId: backupSnapshotId(snapshotInput),
      };
      await input.prepared.commit(encodeBackupSnapshotManifest(snapshot));
      committed = true;
      return {
        snapshot,
        opaqueItemCount: packageValidation.opaqueItemCount,
        frameCount: packageValidation.frameCount,
      };
    } catch (error) {
      if (!committed) await input.prepared.abort().catch(() => undefined);
      throw error;
    } finally {
      for (const entry of packageValidation?.keyInventory.entries ?? []) {
        await wipe(entry.keyEpochKey);
      }
      for (const entry of semanticValidation?.keyInventory.entries ?? []) {
        await wipe(entry.keyEpochKey);
      }
      await verification?.discard().catch(() => undefined);
    }
  }
}

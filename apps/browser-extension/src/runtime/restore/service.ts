import { sha256 } from "@noble/hashes/sha2.js";

import { wipe } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import { decodeBackupSnapshotManifest } from "../backup/contracts";
import type { CanonicalBackupVerificationArea } from "../backup/service";
import type {
  CompleteExportKeyInventory,
  CompleteExportManifest,
} from "../complete-export/contracts";
import type { ActivatedCompleteImport, ReconciledCompleteImport } from "../complete-import/service";
import { validateCompleteExportPackage } from "../complete-import/validate";

interface CanonicalRestoreVaultDirectory {
  readonly vaultId: Identifier<"Vault">;
}

interface CanonicalRestoreVaults {
  readonly listVaults: () => Promise<readonly CanonicalRestoreVaultDirectory[]>;
}

interface CanonicalRestoreCompleteImports {
  readonly activateUnknown: (input: {
    readonly manifest: CompleteExportManifest;
    readonly keyInventory: CompleteExportKeyInventory;
    readonly source: CanonicalBackupVerificationArea;
  }) => Promise<ActivatedCompleteImport>;
  readonly reconcileKnown: (input: {
    readonly manifest: CompleteExportManifest;
    readonly keyInventory: CompleteExportKeyInventory;
    readonly source: CanonicalBackupVerificationArea;
  }) => Promise<ReconciledCompleteImport>;
}

interface CanonicalRestoreDependencies {
  readonly vaults: CanonicalRestoreVaults;
  readonly completeImports: CanonicalRestoreCompleteImports;
  readonly validatePackage?: typeof validateCompleteExportPackage;
}

function isVaultAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "id") === "VAULT_ALREADY_EXISTS"
  );
}

export interface CanonicalRestoreInput {
  readonly snapshotManifestBytes: Uint8Array;
  readonly passphrase: string;
  readonly encrypted: AsyncIterable<Uint8Array>;
  readonly verification: CanonicalBackupVerificationArea;
}

export type CanonicalRestoreOutcome =
  | {
      readonly kind: "activated";
      readonly snapshotId: Uint8Array;
      readonly vaultId: Identifier<"Vault">;
      readonly generationId: Identifier<"Generation">;
    }
  | ({ readonly kind: "reconciled"; readonly snapshotId: Uint8Array } & ReconciledCompleteImport);

export class CanonicalRestoreService {
  private readonly validatePackage: typeof validateCompleteExportPackage;

  constructor(private readonly dependencies: CanonicalRestoreDependencies) {
    this.validatePackage = dependencies.validatePackage ?? validateCompleteExportPackage;
  }

  async restore(input: CanonicalRestoreInput): Promise<CanonicalRestoreOutcome> {
    let validated: Awaited<ReturnType<typeof validateCompleteExportPackage>> | undefined;
    try {
      const snapshot = decodeBackupSnapshotManifest(input.snapshotManifestBytes);
      const digest = sha256.create();
      let byteLength = 0;
      const encrypted: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          for await (const bytes of input.encrypted) {
            if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
              throw new TypeError("Backup package chunks must contain bytes");
            }
            byteLength += bytes.byteLength;
            if (!Number.isSafeInteger(byteLength) || byteLength > snapshot.packageByteLength) {
              throw new TypeError("Backup package bytes exceed the Snapshot Manifest");
            }
            digest.update(bytes);
            yield bytes;
          }
        },
      };
      validated = await this.validatePackage({
        passphrase: input.passphrase,
        encrypted,
        sink: input.verification,
      });
      if (
        byteLength !== snapshot.packageByteLength ||
        !bytesEqual(digest.digest(), snapshot.packageByteDigest)
      ) {
        throw new TypeError("Backup package bytes do not match the Snapshot Manifest");
      }
      const packageValidation = validated;
      const known = (await this.dependencies.vaults.listVaults()).some(({ vaultId }) =>
        bytesEqual(vaultId, packageValidation.manifest.vaultId),
      );
      const prepared = {
        manifest: packageValidation.manifest,
        keyInventory: packageValidation.keyInventory,
        source: input.verification,
      };
      if (known) {
        const reconciled = await this.dependencies.completeImports.reconcileKnown(prepared);
        return { kind: "reconciled", snapshotId: snapshot.snapshotId, ...reconciled };
      }
      let activated: ActivatedCompleteImport;
      try {
        activated = await this.dependencies.completeImports.activateUnknown(prepared);
      } catch (error) {
        if (!isVaultAlreadyExists(error)) throw error;
        const reconciled = await this.dependencies.completeImports.reconcileKnown(prepared);
        return { kind: "reconciled", snapshotId: snapshot.snapshotId, ...reconciled };
      }
      return {
        kind: "activated",
        snapshotId: snapshot.snapshotId,
        vaultId: activated.vaultId,
        generationId: activated.generationId,
      };
    } finally {
      for (const entry of validated?.keyInventory.entries ?? []) await wipe(entry.keyEpochKey);
      await input.verification.discard().catch(() => undefined);
    }
  }
}

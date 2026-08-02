import { describe, expect, it, vi } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { EMPTY_REQUIRED_FEATURE_SET_ID } from "../../src/domain/canonical/features";
import { type Identifier, identifier } from "../../src/domain/canonical/identifiers";
import { decodeBackupSnapshotManifest } from "../../src/runtime/backup/contracts";
import {
  type CanonicalBackupPreparedSnapshot,
  CanonicalBackupService,
  type CanonicalBackupVerificationArea,
} from "../../src/runtime/backup/service";
import { prepareCompleteExportEntry } from "../../src/runtime/complete-export/container";
import {
  type CompleteExportManifestInput,
  completeExportStateDigest,
  decodeCompleteExportManifest,
  encodeCompleteExportManifest,
} from "../../src/runtime/complete-export/contracts";

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

function fixture(
  options: { readonly mutateReadback?: boolean; readonly failSemantics?: boolean } = {},
) {
  const manifest = exportManifest();
  const packageChunks: Uint8Array[] = [];
  const actions: string[] = [];
  let committedManifest: Uint8Array | undefined;
  const prepared: CanonicalBackupPreparedSnapshot = {
    write: async (bytes) => {
      actions.push("write");
      packageChunks.push(Uint8Array.from(bytes));
    },
    finish: async () => {
      actions.push("finish");
    },
    open: async function* () {
      actions.push("open");
      for (const chunk of packageChunks) {
        const bytes = Uint8Array.from(chunk);
        if (options.mutateReadback && bytes.byteLength > 0) bytes[0] = (bytes[0] ?? 0) ^ 1;
        yield bytes;
      }
    },
    commit: async (bytes) => {
      actions.push("commit");
      committedManifest = Uint8Array.from(bytes);
    },
    abort: async () => {
      actions.push("abort");
    },
  };
  const verification: CanonicalBackupVerificationArea = {
    beginOpaque: async () => ({
      write: async () => undefined,
      finish: async () => undefined,
      abort: async () => undefined,
    }),
    abortAll: async () => undefined,
    openOpaque: async () => new ReadableStream(),
    discard: async () => {
      actions.push("discard-verification");
    },
  };
  const packageValidator = vi.fn(async (input) => {
    for await (const _chunk of input.encrypted) actions.push("validate-package");
    return {
      manifest,
      keyInventory: {
        format: 1 as const,
        vaultId: manifest.vaultId,
        generationId: manifest.generationId,
        entries: [],
      },
      opaqueItemCount: manifest.opaqueItemInventory.length,
      frameCount: 1,
    };
  });
  const semanticValidator = vi.fn(async () => {
    actions.push("validate-semantics");
    if (options.failSemantics) throw new TypeError("semantic failure");
    return {
      manifest,
      keyInventory: {
        format: 1 as const,
        vaultId: manifest.vaultId,
        generationId: manifest.generationId,
        entries: [],
      },
    } as never;
  });
  const exporter = {
    export: async (input: { readonly write: (bytes: Uint8Array) => Promise<void> }) => {
      await input.write(Uint8Array.of(1, 2));
      await input.write(Uint8Array.of(3));
      return { manifest, opaqueItemCount: 1, frameCount: 1 };
    },
  };
  const service = new CanonicalBackupService({
    exporter,
    createVerificationArea: async () => verification,
    validatePackage: packageValidator,
    validateSemantics: semanticValidator,
  });
  return {
    service,
    prepared,
    manifest,
    actions,
    packageValidator,
    semanticValidator,
    committed: () => committedManifest,
  };
}

describe("canonical Backup service", () => {
  it("commits the Snapshot manifest only after exact destination readback and semantic proof", async () => {
    const subject = fixture();
    const outcome = await subject.service.createSnapshot({
      backupSetId: new Uint8Array(32).fill(7),
      vaultId: subject.manifest.vaultId,
      passphrase: "correct horse battery staple",
      salt: new Uint8Array(16).fill(8),
      nonce: new Uint8Array(24).fill(9),
      prepared: subject.prepared,
    });
    const committed = subject.committed();

    expect(committed).toBeDefined();
    expect(decodeBackupSnapshotManifest(committed as Uint8Array)).toEqual(outcome.snapshot);
    expect(subject.actions.indexOf("validate-semantics")).toBeLessThan(
      subject.actions.indexOf("commit"),
    );
    expect(subject.actions.at(-1)).toBe("discard-verification");
    expect(subject.packageValidator).toHaveBeenCalledOnce();
    expect(subject.semanticValidator).toHaveBeenCalledOnce();
  });

  it("aborts without a manifest when readback or semantic validation fails", async () => {
    for (const options of [{ mutateReadback: true }, { failSemantics: true }]) {
      const subject = fixture(options);
      await expect(
        subject.service.createSnapshot({
          backupSetId: new Uint8Array(32).fill(7),
          vaultId: subject.manifest.vaultId,
          passphrase: "correct horse battery staple",
          salt: new Uint8Array(16).fill(8),
          nonce: new Uint8Array(24).fill(9),
          prepared: subject.prepared,
        }),
      ).rejects.toThrow(options.mutateReadback ? /readback/u : /semantic failure/u);
      expect(subject.committed()).toBeUndefined();
      expect(subject.actions).toContain("abort");
      expect(subject.actions.at(-1)).toBe("discard-verification");
    }
  });
});

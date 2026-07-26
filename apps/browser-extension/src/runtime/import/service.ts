import type { RuntimeErrorId } from "../../domain/contracts";
import type { StoredObjectV1 } from "../../drivers/indexeddb";
import type { IndexedDbImportRepository } from "../../drivers/indexeddb/import-repository";
import type { IndexedDbWorkspaceRepository } from "../../drivers/indexeddb/workspace-repository";
import type { ArtifactStore } from "../artifact";
import {
  ExportAuthenticationError,
  ExportPackageInvalidError,
  withAuthenticatedVaultPackage,
} from "../export";
import { LibraryProjectionRebuilder } from "../library/rebuild";
import { encryptWorkspaceVaultName } from "../vault";
import { prepareImportedArtifacts } from "./artifacts";
import { prepareImportedVaultCredentials } from "./credentials";

export class VaultImportError extends Error {
  constructor(
    readonly id: RuntimeErrorId,
    message: string,
  ) {
    super(message);
    this.name = "VaultImportError";
  }
}

export function validateImportPassphrase(passphrase: string): string {
  if (new TextEncoder().encode(passphrase).byteLength > 1_024) {
    throw new VaultImportError(
      "IMPORT_AUTHENTICATION_FAILED",
      "The Vault Package could not be authenticated.",
    );
  }
  return passphrase;
}

export class VaultImportService {
  constructor(
    private readonly jobs: IndexedDbImportRepository,
    private readonly workspace: IndexedDbWorkspaceRepository,
    private readonly artifactStore: ArtifactStore,
    private readonly notify: () => Promise<void>,
  ) {}

  async execute(input: {
    readonly jobId: string;
    readonly source: Blob;
    readonly passphrase: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly jobId: string; readonly vaultId: string }> {
    let importPassphrase = input.passphrase;
    Reflect.deleteProperty(input, "passphrase");
    let authenticated = false;
    let destinationVaultId: string | undefined;
    let artifactObjects: readonly StoredObjectV1[] = [];
    let committed = false;
    const update = async (): Promise<void> => this.notify();
    try {
      importPassphrase = validateImportPassphrase(importPassphrase);
      const vaultId = await withAuthenticatedVaultPackage(
        input.source,
        importPassphrase,
        async (validated, rawKeyring) => {
          input.signal.throwIfAborted();
          destinationVaultId = validated.manifest.originatingVaultId;
          if (validated.manifest.coverage !== "Complete") {
            throw new VaultImportError(
              "SELECTIVE_IMPORT_UNSUPPORTED",
              "Selective Vault Import is not supported.",
            );
          }
          if (await this.workspace.hasVaultCollision(destinationVaultId)) {
            throw new VaultImportError("VAULT_ALREADY_EXISTS", "The Vault already exists.");
          }
          artifactObjects = validated.objects.filter((object) => object.objectType === "Artifact");
          const { records, epochStorage } = await prepareImportedVaultCredentials(
            validated,
            rawKeyring,
          );
          let job = await this.jobs.advance(input.jobId, {
            stage: "Prepare",
            completedEntries: 0,
            totalEntries: validated.manifest.artifactPayloadCount,
            processedBytes: 0,
            totalBytes: validated.objects
              .filter((object) => object.objectType === "Artifact")
              .reduce((total, object) => total + object.envelopeByteLength, 0),
            updatedAt: new Date().toISOString(),
          });
          await update();
          const preparedArtifacts = await prepareImportedArtifacts({
            source: input.source,
            vaultId: destinationVaultId,
            objects: validated.objects,
            artifactStore: this.artifactStore,
            signal: input.signal,
            onProgress: async (completedEntries, processedBytes) => {
              job = await this.jobs.advance(input.jobId, {
                stage: "Prepare",
                completedEntries,
                totalEntries: job.totalEntries,
                processedBytes,
                totalBytes: job.totalBytes,
                updatedAt: new Date().toISOString(),
              });
              await update();
            },
          });
          job = await this.jobs.advance(input.jobId, {
            stage: "Rebuild",
            completedEntries: 0,
            totalEntries: validated.events.length,
            processedBytes: 0,
            totalBytes: 0,
            updatedAt: new Date().toISOString(),
          });
          await update();
          const objects = new Map(validated.objects.map((object) => [object.objectId, object]));
          const projections = await new LibraryProjectionRebuilder(
            {
              listStoredEvents: () => Promise.resolve(validated.events),
              getStoredObject: (objectId) => Promise.resolve(objects.get(objectId)),
              replaceLibraryProjections: () => Promise.resolve(),
            },
            validated.keyring,
            destinationVaultId,
            this.artifactStore,
          ).prepare(input.signal);
          const workspace = await this.workspace.load();
          if (workspace === undefined) throw new Error("Workspace is not initialized.");
          const nameCache = await encryptWorkspaceVaultName({
            key: workspace.nameCacheKey,
            workspaceId: workspace.metadata.workspaceId,
            vaultId: destinationVaultId,
            sourceEventId: projections.vaultNameProjection.sourceEventId,
            name: validated.currentVaultName,
          });
          input.signal.throwIfAborted();
          job = await this.jobs.advance(input.jobId, {
            stage: "Commit",
            completedEntries: validated.events.length,
            totalEntries: validated.events.length,
            processedBytes: 0,
            totalBytes: 0,
            updatedAt: new Date().toISOString(),
          });
          await update();
          input.signal.throwIfAborted();
          await this.workspace.commitVaultImport({
            job,
            records,
            epochStorage,
            events: validated.events,
            objects: validated.objects,
            libraryProjections: projections.itemProjections,
            collectionProjection: projections.collectionProjection,
            vaultNameProjection: projections.vaultNameProjection,
            nameCache,
            preparedArtifactObjectIds: preparedArtifacts.map((object) => object.objectId),
          });
          committed = true;
          await update();
          return destinationVaultId;
        },
        async (vaultId) => {
          destinationVaultId = vaultId;
          await this.jobs.authenticationSucceeded(input.jobId, vaultId, new Date().toISOString());
          authenticated = true;
          await update();
        },
        input.signal,
      );
      return { jobId: input.jobId, vaultId };
    } catch (error) {
      if (
        !authenticated &&
        (error instanceof ExportAuthenticationError ||
          (error instanceof VaultImportError && error.id === "IMPORT_AUTHENTICATION_FAILED"))
      ) {
        await this.jobs.authenticationFailed(input.jobId, new Date().toISOString());
        await update();
        throw new VaultImportError(
          "IMPORT_AUTHENTICATION_FAILED",
          "The Vault Package could not be authenticated.",
        );
      }
      const cancelled = input.signal.aborted;
      const errorId: RuntimeErrorId = cancelled
        ? "IMPORT_INTERRUPTED"
        : error instanceof VaultImportError
          ? error.id
          : error instanceof ExportPackageInvalidError
            ? "IMPORT_PACKAGE_INVALID"
            : error instanceof Error && "id" in error && typeof error.id === "string"
              ? (error.id as RuntimeErrorId)
              : "IMPORT_PACKAGE_INVALID";
      if (!cancelled) await this.jobs.fail(input.jobId, errorId, new Date().toISOString());
      await update();
      throw error instanceof VaultImportError
        ? error
        : new VaultImportError(errorId, "Import failed.");
    } finally {
      importPassphrase = "";
      if (!committed && destinationVaultId !== undefined) {
        await Promise.all(
          artifactObjects.map((object) =>
            this.artifactStore
              .remove(destinationVaultId as string, object.objectId)
              .catch(() => undefined),
          ),
        );
      }
    }
  }
}

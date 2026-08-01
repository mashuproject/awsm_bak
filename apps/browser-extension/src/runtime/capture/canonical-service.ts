import { type Identifier, randomIdentifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  CanonicalStorageError,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import {
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  encodeLogicalResolution,
  type LogicalResolution,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import type { CanonicalVaultService } from "../vault/canonical-service";
import {
  assertCanonicalCommandId,
  type CanonicalCaptureOutcome,
  decodeCanonicalCaptureOutcome,
  encodeCanonicalCaptureOutcome,
} from "./canonical-outcome";
import {
  type CanonicalPrimaryCaptureInput,
  type CaptureWarning,
  prepareCanonicalCapture,
} from "./canonical-prepare";

const MAX_FRONTIER_RETRIES = 4;

export interface CanonicalCaptureCommand {
  readonly commandId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly capturedAt: number | bigint;
  readonly primary: CanonicalPrimaryCaptureInput;
  readonly warnings?: readonly CaptureWarning[];
  readonly bundleId?: Identifier<"Bundle">;
  readonly assignedCollectionId?: Identifier<"Collection">;
  readonly artifactProtectionParameters?: Uint8Array;
  readonly artifactObjectProtectionParameters?: Uint8Array;
  readonly descriptorProtectionParameters?: Uint8Array;
  readonly eventProtectionParameters?: Uint8Array;
}

function sameIdentifier(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function resolutionItemKey(resolution: LogicalResolution): string {
  return `${resolution.kind}:${identifierStorageKey(
    resolution.logicalId as Identifier<"VaultRecord">,
  )}`;
}

export class CanonicalCaptureService {
  constructor(
    readonly vaults: CanonicalVaultService,
    readonly artifacts: CanonicalArtifactStore,
  ) {}

  async execute(command: CanonicalCaptureCommand): Promise<CanonicalCaptureOutcome> {
    assertCanonicalCommandId(command.commandId);
    const vaultKey = identifierStorageKey(command.vaultId);
    const previous = await this.readOutcome(vaultKey, command.commandId);
    if (previous !== undefined) {
      sameIdentifier(previous.vaultId, command.vaultId, "Capture outcome Vault ID");
      return previous;
    }

    const bundleId = command.bundleId ?? randomIdentifier("Bundle");
    const assignedCollectionId = command.assignedCollectionId ?? randomIdentifier("Collection");
    for (let attempt = 0; attempt < MAX_FRONTIER_RETRIES; attempt += 1) {
      const racedOutcome = await this.readOutcome(vaultKey, command.commandId);
      if (racedOutcome !== undefined) {
        sameIdentifier(racedOutcome.vaultId, command.vaultId, "Capture outcome Vault ID");
        return racedOutcome;
      }
      const vault = await this.vaults.openVault(command.vaultId);
      const prepared = await prepareCanonicalCapture({
        vault,
        artifactStore: this.artifacts,
        originalUrl: command.originalUrl,
        finalUrl: command.finalUrl,
        title: command.title,
        capturedAt: command.capturedAt,
        primary: command.primary,
        bundleId,
        assignedCollectionId,
        ...(command.warnings === undefined ? {} : { warnings: command.warnings }),
        ...(command.artifactProtectionParameters === undefined
          ? {}
          : { artifactProtectionParameters: command.artifactProtectionParameters }),
        ...(command.artifactObjectProtectionParameters === undefined
          ? {}
          : { artifactObjectProtectionParameters: command.artifactObjectProtectionParameters }),
        ...(command.descriptorProtectionParameters === undefined
          ? {}
          : { descriptorProtectionParameters: command.descriptorProtectionParameters }),
        ...(command.eventProtectionParameters === undefined
          ? {}
          : { eventProtectionParameters: command.eventProtectionParameters }),
      });
      const outcome: CanonicalCaptureOutcome = {
        commandId: command.commandId,
        vaultId: command.vaultId,
        generationId: vault.replicaState.generationId,
        bundleId,
        assignedCollectionId,
        eventRecordId: prepared.event.recordId,
        descriptorObjectId: prepared.descriptorObject.objectId,
        artifactObjectId: prepared.artifactObject.objectId,
        artifactStorageItemId: prepared.artifactRepresentation.storageItemId,
      };
      const resolutions: readonly LogicalResolution[] = [
        {
          vaultId: command.vaultId,
          kind: 1,
          logicalId: prepared.event.recordId,
          storageItemId: prepared.eventEnvelope.storageItemId,
          keyEpochId: vault.epochSecret.keyEpochId,
          availability: 1,
        },
        {
          vaultId: command.vaultId,
          kind: 3,
          logicalId: prepared.descriptorObject.objectId,
          storageItemId: prepared.descriptorObjectEnvelope.storageItemId,
          keyEpochId: vault.epochSecret.keyEpochId,
          availability: 1,
        },
        {
          vaultId: command.vaultId,
          kind: 3,
          logicalId: prepared.artifactObject.objectId,
          storageItemId: prepared.artifactObjectEnvelope.storageItemId,
          keyEpochId: vault.epochSecret.keyEpochId,
          availability: 1,
        },
        {
          vaultId: command.vaultId,
          kind: 5,
          logicalId: prepared.artifactId,
          storageItemId: prepared.artifactRepresentation.storageItemId,
          keyEpochId: vault.epochSecret.keyEpochId,
          availability: 1,
        },
      ];
      const [nextReplicaState, ...resolutionItems] = await Promise.all([
        prepareWrappedLocalStateItem({
          namespace: NAMESPACES.replicaState.key,
          scopeKey: vaultKey,
          itemKey: "current",
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.replica-state",
          context: canonicalLocalStorageContext(command.vaultId, vault.replicaState.generationId),
          bytes: encodeCanonicalReplicaState(prepared.nextReplicaState),
        }),
        ...resolutions.map((resolution) =>
          prepareWrappedLocalStateItem({
            namespace: NAMESPACES.logicalResolution.key,
            scopeKey: vaultKey,
            itemKey: resolutionItemKey(resolution),
            wrappingKey: vault.installationWrappingKey,
            domain: "awsm.local.logical-resolution",
            context: canonicalLocalStorageContext(command.vaultId, resolution.logicalId),
            bytes: encodeLogicalResolution(resolution),
          }),
        ),
      ]);
      const immutableItems: readonly NamespaceBytes[] = [
        {
          namespace: NAMESPACES.vaultRecord.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(prepared.event.recordId),
          bytes: prepared.eventEnvelope.bytes,
        },
        {
          namespace: NAMESPACES.vaultObject.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(prepared.descriptorObject.objectId),
          bytes: prepared.descriptorObjectEnvelope.bytes,
        },
        {
          namespace: NAMESPACES.vaultObject.key,
          scopeKey: vaultKey,
          itemKey: identifierStorageKey(prepared.artifactObject.objectId),
          bytes: prepared.artifactObjectEnvelope.bytes,
        },
        {
          namespace: NAMESPACES.commandOutcome.key,
          scopeKey: vaultKey,
          itemKey: command.commandId,
          bytes: encodeCanonicalCaptureOutcome(outcome),
        },
      ];
      try {
        await prepared.artifactRepresentation.promote();
        await this.vaults.storage.commitReplicaMutation({
          realm: this.vaults.realm,
          expectedReplicaState: vault.replicaStateStorageBytes,
          nextReplicaState,
          immutableItems,
          mutableItems: resolutionItems,
        });
        return outcome;
      } catch (error) {
        await prepared.artifactRepresentation.discard().catch(() => undefined);
        if (error instanceof CanonicalStorageError && error.id === "VAULT_CONTEXT_CHANGED") {
          continue;
        }
        throw error;
      }
    }
    throw new CanonicalStorageError(
      "VAULT_CONTEXT_CHANGED",
      "The Capture could not commit because the accepted Frontier kept changing.",
    );
  }

  private async readOutcome(
    vaultKey: string,
    commandId: string,
  ): Promise<CanonicalCaptureOutcome | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.commandOutcome.key,
      scopeKey: vaultKey,
      itemKey: commandId,
    });
    if (bytes === undefined) return undefined;
    const outcome = decodeCanonicalCaptureOutcome(bytes);
    if (outcome.commandId !== commandId) {
      throw new TypeError("Stored Capture outcome belongs to another Command");
    }
    return outcome;
  }
}

import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import {
  canonicalLocalStorageContext,
  encodeCanonicalReplicaState,
  encodeLogicalResolution,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../vault/canonical-service";
import type { CanonicalPullContentValidation } from "./canonical-pull-content-validation";
import type { CanonicalPullSynchronizationJobService } from "./canonical-pull-synchronization-job-service";
import type { CanonicalPullSynchronizationJob } from "./canonical-state";

type PullPromotionPort = Pick<CanonicalPullSynchronizationJobService, "promoteValidated">;

type QuarantineReader = {
  readonly readQuarantine: (input: {
    readonly remoteId: string;
    readonly storageItemId: Uint8Array;
  }) => Promise<Uint8Array | undefined>;
};

function key(value: Identifier<"StorageItem">): string {
  return identifierStorageKey(value);
}

/**
 * Turns an already validated same-Generation Content Record branch into one atomic local
 * promotion. Authority, Key-Epoch, Feature, and Object candidates never enter this boundary.
 */
export class CanonicalPullContentPromotionService {
  constructor(private readonly jobs: PullPromotionPort) {}

  async promote(input: {
    readonly vault: Pick<
      PersistedOpenedCanonicalVault,
      "replicaState" | "replicaStateStorageBytes" | "installationWrappingKey"
    >;
    readonly previous: CanonicalPullSynchronizationJob;
    readonly validation: CanonicalPullContentValidation;
    readonly readQuarantine: QuarantineReader["readQuarantine"];
  }): Promise<CanonicalPullSynchronizationJob> {
    if (!bytesEqual(input.previous.vaultId, input.vault.replicaState.vaultId)) {
      throw new TypeError("Synchronization Job Vault does not match the opened Replica");
    }
    if (input.validation.acceptedCandidates.length === 0) {
      throw new TypeError("Content promotion requires one or more newly validated Records");
    }

    const references = new Map(
      input.previous.quarantineReferences.map((reference) => [
        key(reference.storageItemId),
        reference,
      ]),
    );
    const promotedReferences = input.validation.acceptedCandidates.map((candidate) => {
      if (!bytesEqual(candidate.logicalId, candidate.record.recordId)) {
        throw new TypeError("Validated Content Record identity does not match its signed Record");
      }
      const reference = references.get(key(candidate.storageItemId));
      if (reference === undefined) {
        throw new TypeError("Validated Content Record is absent from Synchronization Quarantine");
      }
      return reference;
    });
    if (
      new Set(promotedReferences.map((reference) => key(reference.storageItemId))).size !==
      promotedReferences.length
    ) {
      throw new TypeError("Validated Content Records repeat a Quarantine representation");
    }

    const opaqueBytes = await Promise.all(
      input.validation.acceptedCandidates.map(async (candidate) => {
        const bytes = await input.readQuarantine({
          remoteId: input.previous.remoteId,
          storageItemId: candidate.storageItemId,
        });
        if (bytes === undefined) {
          throw new TypeError("Validated Content Record Quarantine bytes are unavailable");
        }
        const envelope = decodeOpaqueEnvelope(bytes);
        if (!bytesEqual(envelope.storageItemId, candidate.storageItemId)) {
          throw new TypeError(
            "Validated Content Record Quarantine bytes do not match their identity",
          );
        }
        return { candidate, bytes: Uint8Array.from(bytes) };
      }),
    );

    const promotedStorageItems = new Set(
      promotedReferences.map((reference) => key(reference.storageItemId)),
    );
    const quarantineReferences = input.previous.quarantineReferences.filter(
      (reference) => !promotedStorageItems.has(key(reference.storageItemId)),
    );
    const completes = quarantineReferences.length === 0;
    const next: CanonicalPullSynchronizationJob = {
      ...input.previous,
      stage: completes ? 3 : 2,
      state: completes ? 3 : 1,
      quarantineReferences,
      progress: {
        ...input.previous.progress,
        promotedItemCount:
          input.previous.progress.promotedItemCount + input.validation.acceptedCandidates.length,
      },
    };
    const vaultKey = identifierStorageKey(input.vault.replicaState.vaultId);
    const [nextReplicaState, ...resolutionItems] = await Promise.all([
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.replicaState.key,
        scopeKey: vaultKey,
        itemKey: "current",
        wrappingKey: input.vault.installationWrappingKey,
        domain: "awsm.local.replica-state",
        context: canonicalLocalStorageContext(
          input.validation.nextReplicaState.vaultId,
          input.validation.nextReplicaState.generationId,
        ),
        bytes: encodeCanonicalReplicaState(input.validation.nextReplicaState),
      }),
      ...opaqueBytes.map(({ candidate }) =>
        prepareWrappedLocalStateItem({
          namespace: NAMESPACES.logicalResolution.key,
          scopeKey: vaultKey,
          itemKey: `1:${identifierStorageKey(candidate.logicalId)}`,
          wrappingKey: input.vault.installationWrappingKey,
          domain: "awsm.local.logical-resolution",
          context: canonicalLocalStorageContext(
            input.vault.replicaState.vaultId,
            candidate.logicalId,
          ),
          bytes: encodeLogicalResolution({
            vaultId: input.vault.replicaState.vaultId,
            kind: 1,
            logicalId: candidate.logicalId,
            storageItemId: candidate.storageItemId,
            keyEpochId: candidate.keyEpochId,
            availability: 1,
          }),
        }),
      ),
    ]);
    const immutableItems: NamespaceBytes[] = opaqueBytes.map(({ candidate, bytes }) => ({
      namespace: NAMESPACES.vaultRecord.key,
      scopeKey: vaultKey,
      itemKey: identifierStorageKey(candidate.logicalId),
      bytes,
    }));

    await this.jobs.promoteValidated({
      previous: input.previous,
      next,
      promotedReferences,
      expectedReplicaState: input.vault.replicaStateStorageBytes,
      nextReplicaState,
      immutableItems,
      resolutionItems,
    });
    return next;
  }
}

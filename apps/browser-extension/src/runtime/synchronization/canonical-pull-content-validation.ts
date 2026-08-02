import type { OpenedCompactItem } from "../../crypto/compact";
import type { Identifier } from "../../domain/canonical/identifiers";
import { decodeVaultObject, type VaultObject } from "../../domain/canonical/object";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { causalMaxima } from "../../domain/canonical/reducers";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import { collectCompleteExportReachability } from "../complete-export/reachability";
import { CanonicalReplayService } from "../projection/canonical-replay";
import type { CanonicalReplicaState } from "../vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../vault/canonical-service";
import type { CanonicalPulledCompactCandidate } from "./canonical-pull-candidate";

type PulledContentRecord = Extract<
  CanonicalPulledCompactCandidate,
  { readonly kind: "VaultRecord" }
>;
type QuarantineReader = {
  readonly readQuarantine: (input: {
    readonly remoteId: string;
    readonly storageItemId: Identifier<"StorageItem">;
  }) => Promise<Uint8Array | undefined>;
};

function key(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compare(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.byteLength; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function decodeRecord(bytes: Uint8Array): AuthenticatedVaultEvent | VaultBaseline {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Pulled Compact Record is not a map");
  if (value.get(6) === 1) return decodeVaultEvent(bytes);
  if (value.get(6) === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Pulled Compact Record kind is unsupported");
}

function candidateMaps(candidates: readonly CanonicalPulledCompactCandidate[]): {
  readonly records: ReadonlyMap<string, PulledContentRecord>;
} {
  const records = new Map<string, PulledContentRecord>();
  const storageItems = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind !== "VaultRecord") continue;
    const storageItemKey = key(candidate.storageItemId);
    if (storageItems.has(storageItemKey)) {
      throw new TypeError("Pulled candidates repeat an opaque Storage Item");
    }
    storageItems.add(storageItemKey);
    const candidateKey = key(candidate.logicalId);
    if (records.has(candidateKey)) {
      throw new TypeError("Pulled candidates repeat a protected logical identity");
    }
    records.set(candidateKey, candidate);
  }
  return { records };
}

function assertCurrentContentContext(
  event: AuthenticatedVaultEvent,
  state: CanonicalReplicaState,
): void {
  if (
    event.family !== 2 ||
    !bytesEqual(event.vaultId, state.vaultId) ||
    !bytesEqual(event.generationId, state.generationId) ||
    !bytesEqual(event.requiredFeatureSetId, state.requiredFeatureSetId)
  ) {
    throw new TypeError("Pulled Record is not a current Content Event");
  }
}

function candidateOpened(candidate: PulledContentRecord, bytes: Uint8Array): OpenedCompactItem {
  const envelope = decodeOpaqueEnvelope(bytes);
  same(envelope.storageItemId, candidate.storageItemId, "Pulled Quarantine Storage Item ID");
  return {
    keyEpochId: candidate.keyEpochId,
    payloadType: 1,
    payloadBytes: candidate.record.bytes,
    envelope,
  };
}

/**
 * Validates one explicit same-Generation Content Record branch against an accepted Replica. Every
 * non-Record compact dependency must already be locally verified; Authority, Key-Epoch,
 * Required-Feature, Vacuum, and new Object candidates stay in Quarantine for their own validator.
 */
export class CanonicalPullContentValidationService {
  constructor(
    private readonly replays: CanonicalReplayService,
    private readonly quarantine: QuarantineReader,
  ) {}

  async validate(input: {
    readonly remoteId: string;
    readonly vault: PersistedOpenedCanonicalVault;
    readonly candidates: readonly CanonicalPulledCompactCandidate[];
    readonly rootRecordIds: readonly Identifier<"VaultRecord">[];
  }): Promise<{
    readonly nextReplicaState: CanonicalReplicaState;
    readonly acceptedCandidates: readonly CanonicalPulledCompactCandidate[];
  }> {
    if (input.vault.replicaState.adoption !== null) {
      throw new TypeError("Pulled Content validation requires a non-adopted Generation");
    }
    if (input.rootRecordIds.length === 0) {
      throw new TypeError("Pulled Content validation requires one or more Record roots");
    }
    if (new Set(input.rootRecordIds.map(key)).size !== input.rootRecordIds.length) {
      throw new TypeError("Pulled Content validation repeats a Record root");
    }
    const current = await this.replays.replayOpened(input.vault);
    const candidates = candidateMaps(input.candidates);
    const graph = current.graph;
    const selectedRecords: PulledContentRecord[] = [];
    const visiting = new Set<string>();
    const selectRecord = (recordId: Identifier<"VaultRecord">): void => {
      const recordKey = key(recordId);
      if (graph.has(recordId)) return;
      if (visiting.has(recordKey)) throw new TypeError("Pulled Content branch contains a cycle");
      const candidate = candidates.records.get(recordKey);
      if (candidate === undefined)
        throw new TypeError("Pulled Content branch has an unavailable parent");
      if (!("family" in candidate.record)) {
        throw new TypeError("Pulled Content branch cannot introduce a Baseline");
      }
      assertCurrentContentContext(candidate.record, input.vault.replicaState);
      visiting.add(recordKey);
      for (const parentId of candidate.record.parentRecordIds) selectRecord(parentId);
      for (const authorityParentId of candidate.record.authorityParentRecordIds) {
        if (!graph.has(authorityParentId)) {
          throw new TypeError("Pulled Content branch has an unavailable Authority Parent");
        }
      }
      graph.add(candidate.record.recordId, candidate.record.parentRecordIds);
      selectedRecords.push(candidate);
      visiting.delete(recordKey);
    };
    for (const rootRecordId of input.rootRecordIds) selectRecord(rootRecordId);

    const nextReplicaState: CanonicalReplicaState = {
      ...input.vault.replicaState,
      causalFrontier: causalMaxima(
        [
          ...input.vault.replicaState.causalFrontier.map((causeId) => ({ causeId })),
          ...selectedRecords.map(({ record }) => ({ causeId: record.recordId })),
        ],
        graph,
      )
        .map(({ causeId }) => causeId)
        .toSorted(compare),
    };
    const prospectiveVault: PersistedOpenedCanonicalVault = {
      ...input.vault,
      replicaState: nextReplicaState,
    };
    const bytesByStorageItem = new Map<string, Uint8Array>();
    const readCandidate = async (candidate: PulledContentRecord): Promise<Uint8Array> => {
      const candidateKey = key(candidate.storageItemId);
      const cached = bytesByStorageItem.get(candidateKey);
      if (cached !== undefined) return cached;
      const bytes = await this.quarantine.readQuarantine({
        remoteId: input.remoteId,
        storageItemId: candidate.storageItemId,
      });
      if (bytes === undefined)
        throw new TypeError("Pulled candidate Quarantine bytes are unavailable");
      const opened = candidateOpened(candidate, bytes);
      bytesByStorageItem.set(candidateKey, Uint8Array.from(opened.envelope.bytes));
      return opened.envelope.bytes;
    };
    const candidateForCompact = (kind: 1 | 3 | 4, logicalId: Uint8Array) =>
      kind === 1 ? candidates.records.get(key(logicalId)) : undefined;
    const virtualVaults = {
      openResolvedCompactItem: async (request: {
        readonly kind: 1 | 3 | 4;
        readonly logicalId: Uint8Array;
        readonly payloadType: 1 | 2 | 3;
      }): Promise<OpenedCompactItem> => {
        const candidate = candidateForCompact(request.kind, request.logicalId);
        if (candidate === undefined) {
          return this.replays.vaults.openResolvedCompactItem(request as never);
        }
        const opened = candidateOpened(candidate, await readCandidate(candidate));
        if (opened.payloadType !== request.payloadType) {
          throw new TypeError("Pulled candidate Compact type does not match its logical namespace");
        }
        return opened;
      },
      readResolvedOpaqueItem: (
        request: Parameters<CanonicalReplayService["vaults"]["readResolvedOpaqueItem"]>[0],
      ) => this.replays.vaults.readResolvedOpaqueItem(request),
    };
    const prospective = await new CanonicalReplayService(virtualVaults as never).replayOpened(
      prospectiveVault,
    );
    const reachability = await collectCompleteExportReachability({
      vaultId: prospective.vault.replicaState.vaultId,
      generationId: prospective.vault.replicaState.generationId,
      requiredFeatureSetId: prospective.vault.replicaState.requiredFeatureSetId,
      baselineId: prospective.vault.replicaState.baselineId,
      causalFrontier: prospective.vault.replicaState.causalFrontier,
      authorityFrontier: prospective.vault.replicaState.authorityFrontier,
      loadRecord: async (recordId) => {
        const opened = await virtualVaults.openResolvedCompactItem({
          vault: prospectiveVault,
          kind: 1,
          logicalId: recordId,
          namespace: NAMESPACES.vaultRecord.key,
          payloadType: 1,
        } as never);
        return decodeRecord(opened.payloadBytes);
      },
      loadObject: async (objectId): Promise<VaultObject> => {
        const opened = await virtualVaults.openResolvedCompactItem({
          vault: prospectiveVault,
          kind: 3,
          logicalId: objectId,
          namespace: NAMESPACES.vaultObject.key,
          payloadType: 2,
        } as never);
        return decodeVaultObject(opened.payloadBytes);
      },
      loadFeatureManifest: async (featureManifestId) =>
        (
          await virtualVaults.openResolvedCompactItem({
            vault: prospectiveVault,
            kind: 4,
            logicalId: featureManifestId,
            namespace: NAMESPACES.featureManifest.key,
            payloadType: 3,
          } as never)
        ).payloadBytes,
    });
    const acceptedRecordIds = new Set(reachability.recordIds.map(key));
    const selectedRecordIds = new Set(selectedRecords.map(({ logicalId }) => key(logicalId)));
    const acceptedCandidates = input.candidates.filter(
      (candidate): candidate is PulledContentRecord =>
        candidate.kind === "VaultRecord" && selectedRecordIds.has(key(candidate.logicalId)),
    );
    if (!selectedRecords.every(({ logicalId }) => acceptedRecordIds.has(key(logicalId)))) {
      throw new TypeError("Pulled Content branch is not reachable from its proposed Frontier");
    }
    await Promise.all(acceptedCandidates.map(readCandidate));
    return { nextReplicaState, acceptedCandidates };
  }
}

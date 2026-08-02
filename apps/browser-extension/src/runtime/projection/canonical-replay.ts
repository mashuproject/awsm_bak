import { contentCheckpointCauseIds } from "../../domain/canonical/baseline-body";
import { DEPENDENCY_TYPES } from "../../domain/canonical/dependencies";
import { featureManifestId } from "../../domain/canonical/features";
import type { Identifier } from "../../domain/canonical/identifiers";
import {
  type AuthenticatedVaultEvent,
  decodeVaultEvent,
  verifyVaultEventSignature,
} from "../../domain/canonical/record";
import { CausalGraph } from "../../domain/canonical/reducers";
import { exactMap, mapValue } from "../../domain/canonical/schema";
import { bytesEqual } from "../../domain/hash";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { initialVaultClientAuthority } from "../vault/canonical-open";
import type {
  CanonicalVaultService,
  PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";
import {
  CanonicalAuthorityReplay,
  type CanonicalAuthorityState,
  canonicalAuthorityFeatureManifestRequirements,
  canonicalAuthorityKeyEnvelopeRequirements,
} from "./canonical-authority-replay";

const MAX_REPLAY_RECORDS = 1_000_000;

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map(key));
  return right.every((value) => expected.has(key(value)));
}

function containsAll(values: readonly Uint8Array[], required: readonly Uint8Array[]): boolean {
  return required.every((candidate) => values.some((value) => bytesEqual(value, candidate)));
}

export interface ReplayedCanonicalVault {
  readonly vault: PersistedOpenedCanonicalVault;
  readonly graph: CausalGraph;
  readonly events: readonly AuthenticatedVaultEvent[];
  readonly authority: CanonicalAuthorityState;
}

export interface CanonicalReplayOptions {
  readonly supportedFeatureManifestIds?: readonly Identifier<"FeatureManifest">[];
}

export function replayEventMemberId(
  replay: ReplayedCanonicalVault,
  event: AuthenticatedVaultEvent,
): Identifier<"Member"> {
  const credential = replay.authority.clientCredentials.get(key(event.signerCredentialId));
  if (credential === undefined) throw new TypeError("Vault Event signer has no accepted Member");
  return credential.memberId;
}

export class CanonicalReplayService {
  constructor(
    readonly vaults: CanonicalVaultService,
    readonly options: CanonicalReplayOptions = {},
  ) {}

  async replay(vaultId: Identifier<"Vault">): Promise<ReplayedCanonicalVault> {
    return this.replayOpened(await this.vaults.openVault(vaultId));
  }

  async replayOpened(vault: PersistedOpenedCanonicalVault): Promise<ReplayedCanonicalVault> {
    const graph = new CausalGraph();
    const events = new Map<string, AuthenticatedVaultEvent>();
    const visiting = new Set<string>();
    const ordered: AuthenticatedVaultEvent[] = [];
    const genesisKey = key(vault.genesis.recordId);
    const baselineKey = key(vault.baseline.recordId);
    const adoption = vault.replicaState.adoption;
    const initialClient = initialVaultClientAuthority(vault.genesis);
    const body = exactMap(vault.baseline.body, [0, 1, 2, 3, 4, 5], "Accepted Baseline body");
    const authorityCheckpoint = exactMap(
      mapValue(body, 3),
      [...Array(10).keys()],
      "Accepted Baseline authority checkpoint",
    );
    const anchorFeatureManifestBytes: Uint8Array[] = [];
    for (const dependency of vault.baseline.dependencies) {
      if (dependency.type !== DEPENDENCY_TYPES.FeatureManifest) continue;
      const opened = await this.vaults.openResolvedCompactItem({
        vault,
        kind: 4,
        logicalId: dependency.id,
        namespace: NAMESPACES.featureManifest.key,
        payloadType: 3,
      });
      if (!bytesEqual(featureManifestId(opened.payloadBytes), dependency.id)) {
        throw new TypeError("Accepted Baseline Feature Manifest does not match its dependency ID");
      }
      anchorFeatureManifestBytes.push(opened.payloadBytes);
    }
    const authorityReplay = new CanonicalAuthorityReplay(
      vault.genesis,
      adoption === null ? vault.genesis.recordId : adoption.vacuumEventRecordId,
      mapValue(authorityCheckpoint, 7),
      vault.baseline.requiredFeatureSetId,
      anchorFeatureManifestBytes,
      this.options.supportedFeatureManifestIds ?? [],
    );
    graph.addBaseline(vault.baseline.recordId, contentCheckpointCauseIds(mapValue(body, 2)));

    const visit = async (recordId: Identifier<"VaultRecord">): Promise<void> => {
      const recordKey = key(recordId);
      if (adoption !== null && recordKey === baselineKey) return;
      if (events.has(recordKey)) return;
      if (visiting.has(recordKey)) throw new TypeError("The Vault Record graph contains a cycle");
      if (events.size >= MAX_REPLAY_RECORDS) throw new RangeError("Vault replay exceeds its bound");
      visiting.add(recordKey);
      const event =
        recordKey === genesisKey
          ? vault.genesis
          : decodeVaultEvent(
              (
                await this.vaults.openResolvedCompactItem({
                  vault,
                  kind: 1,
                  logicalId: recordId,
                  namespace: NAMESPACES.vaultRecord.key,
                  payloadType: 1,
                })
              ).payloadBytes,
            );
      if (!bytesEqual(event.recordId, recordId)) {
        throw new TypeError("Resolved Vault Event does not match its Record ID");
      }
      if (
        !bytesEqual(event.vaultId, vault.replicaState.vaultId) ||
        !bytesEqual(event.generationId, vault.replicaState.generationId)
      ) {
        throw new TypeError("Vault Event belongs to another accepted context");
      }
      const parents = [...event.parentRecordIds].sort((left, right) =>
        key(left).localeCompare(key(right)),
      );
      for (const parent of parents) await visit(parent);
      if (event.family === 1 && event.type === 1) {
        if (recordKey !== genesisKey) throw new TypeError("Vault replay contains another Genesis");
        if (!(await verifyVaultEventSignature(event, initialClient.signingPublicKey))) {
          throw new TypeError("Vault Event signature is invalid");
        }
      } else {
        const keyEnvelopeRequirements = canonicalAuthorityKeyEnvelopeRequirements(event);
        const featureManifestRequirements = canonicalAuthorityFeatureManifestRequirements(event);
        await authorityReplay.validateAndAccept(event);
        for (const requirement of keyEnvelopeRequirements) {
          await this.vaults.readResolvedOpaqueItem({
            vault,
            kind: 2,
            logicalId: requirement.keyEnvelopeId,
            expectedKeyEpochId: requirement.keyEpochId,
            namespace: NAMESPACES.keyEnvelope.key,
          });
        }
        for (const requirement of featureManifestRequirements) {
          const opened = await this.vaults.openResolvedCompactItem({
            vault,
            kind: 4,
            logicalId: requirement.id,
            namespace: NAMESPACES.featureManifest.key,
            payloadType: 3,
          });
          if (!bytesEqual(opened.payloadBytes, requirement.bytes)) {
            throw new TypeError(
              "Feature Activation Manifest dependency bytes differ from its body",
            );
          }
        }
      }
      graph.add(
        event.recordId,
        recordKey === genesisKey ? [vault.baseline.recordId] : event.parentRecordIds,
      );
      events.set(recordKey, event);
      ordered.push(event);
      visiting.delete(recordKey);
    };

    const frontiers = [...vault.replicaState.causalFrontier].sort((left, right) =>
      key(left).localeCompare(key(right)),
    );
    for (const frontier of frontiers) await visit(frontier);
    if (adoption === null && !events.has(genesisKey)) {
      throw new TypeError("The causal DAG does not reach Genesis");
    }
    const authority = authorityReplay.stateAt(vault.replicaState.authorityFrontier);
    if (!bytesEqual(authority.requiredFeatureSetId, vault.replicaState.requiredFeatureSetId)) {
      throw new TypeError("Replica Required Feature Set does not match accepted Authority State");
    }
    if (authority.lifecycle !== vault.replicaState.lifecycle) {
      throw new TypeError("Replica lifecycle does not match accepted Authority State");
    }
    if (adoption !== null) {
      if (vault.replicaState.lifecycle === 1) {
        if (
          !sameSet(vault.replicaState.authorityFrontier, [adoption.vacuumEventRecordId]) ||
          !containsAll(vault.replicaState.continuityRecordIds, [
            vault.genesis.recordId,
            adoption.vacuumEventRecordId,
          ])
        ) {
          throw new TypeError("Open successor authority state is inconsistent");
        }
      } else {
        const closure = ordered.find((event) => event.family === 3 && event.type === 2);
        if (
          closure === undefined ||
          !sameSet(vault.replicaState.causalFrontier, [closure.recordId]) ||
          !sameSet(vault.replicaState.authorityFrontier, [closure.recordId]) ||
          !containsAll(vault.replicaState.continuityRecordIds, [
            vault.genesis.recordId,
            adoption.vacuumEventRecordId,
            closure.recordId,
          ])
        ) {
          throw new TypeError("Closed successor authority state is inconsistent");
        }
      }
    } else {
      const proofRecordIds = authorityReplay.reachableRecordIds(
        vault.replicaState.authorityFrontier,
      );
      if (!sameSet(vault.replicaState.continuityRecordIds, proofRecordIds)) {
        throw new TypeError("Initial Continuity Proof does not match accepted Authority State");
      }
    }
    return { vault, graph, events: ordered, authority };
  }
}

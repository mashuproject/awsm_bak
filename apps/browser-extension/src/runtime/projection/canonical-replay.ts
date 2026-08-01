import type { Identifier } from "../../domain/canonical/identifiers";
import {
  type AuthenticatedVaultEvent,
  decodeVaultEvent,
  verifyVaultEventSignature,
} from "../../domain/canonical/record";
import { CausalGraph } from "../../domain/canonical/reducers";
import { bytesEqual } from "../../domain/hash";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import type {
  CanonicalVaultService,
  PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";

const MAX_REPLAY_RECORDS = 1_000_000;

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map(key));
  return right.every((value) => expected.has(key(value)));
}

export interface ReplayedCanonicalVault {
  readonly vault: PersistedOpenedCanonicalVault;
  readonly graph: CausalGraph;
  readonly events: readonly AuthenticatedVaultEvent[];
}

export class CanonicalReplayService {
  constructor(readonly vaults: CanonicalVaultService) {}

  async replay(vaultId: Identifier<"Vault">): Promise<ReplayedCanonicalVault> {
    return this.replayOpened(await this.vaults.openVault(vaultId));
  }

  async replayOpened(vault: PersistedOpenedCanonicalVault): Promise<ReplayedCanonicalVault> {
    const graph = new CausalGraph();
    const events = new Map<string, AuthenticatedVaultEvent>();
    const visiting = new Set<string>();
    const ordered: AuthenticatedVaultEvent[] = [];
    const genesisKey = key(vault.genesis.recordId);

    const visit = async (recordId: Identifier<"VaultRecord">): Promise<void> => {
      const recordKey = key(recordId);
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
        !bytesEqual(event.generationId, vault.replicaState.generationId) ||
        !bytesEqual(event.requiredFeatureSetId, vault.replicaState.requiredFeatureSetId)
      ) {
        throw new TypeError("Vault Event belongs to another accepted context");
      }
      const parents = [...event.parentRecordIds].sort((left, right) =>
        key(left).localeCompare(key(right)),
      );
      for (const parent of parents) await visit(parent);
      if (event.family === 1 && event.type === 1) {
        if (recordKey !== genesisKey) throw new TypeError("Vault replay contains another Genesis");
      } else {
        if (event.family !== 2) {
          throw new TypeError(
            "This replay slice cannot yet reduce post-Genesis authority or lifecycle Events",
          );
        }
        if (!sameSet(event.authorityParentRecordIds, vault.replicaState.authorityFrontier)) {
          throw new TypeError("Content Event does not name the accepted Authority Frontier");
        }
        if (!bytesEqual(event.signerCredentialId, vault.clientSecret.clientCredentialId)) {
          throw new TypeError("Content Event is not signed by the active local Credential");
        }
      }
      if (!(await verifyVaultEventSignature(event, vault.clientSecret.signingPublicKey))) {
        throw new TypeError("Vault Event signature is invalid");
      }
      graph.add(event.recordId, event.parentRecordIds);
      events.set(recordKey, event);
      ordered.push(event);
      visiting.delete(recordKey);
    };

    const frontiers = [...vault.replicaState.causalFrontier].sort((left, right) =>
      key(left).localeCompare(key(right)),
    );
    for (const frontier of frontiers) await visit(frontier);
    if (!events.has(genesisKey)) throw new TypeError("The causal DAG does not reach Genesis");
    return { vault, graph, events: ordered };
  }
}

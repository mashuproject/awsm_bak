import type { Identifier } from "../../domain/canonical/identifiers";
import type { AuthenticatedVaultEvent } from "../../domain/canonical/record";
import { CausalGraph } from "../../domain/canonical/reducers";
import { bytesEqual } from "../../domain/hash";
import type { CanonicalReplicaState } from "../vault/canonical-local-state";

export interface CompleteImportHistoryView {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly baselineId: Identifier<"VaultRecord">;
  readonly genesisId: Identifier<"VaultRecord">;
  readonly causalFrontier: readonly Identifier<"VaultRecord">[];
  readonly authorityFrontier: readonly Identifier<"VaultRecord">[];
  readonly causalGraph: CausalGraph;
  readonly authorityGraph: CausalGraph;
}

export type SameGenerationCompleteImportCollision =
  | "equal"
  | "incoming-ancestor"
  | "incoming-fast-forward"
  | "divergent";

export function buildCompleteImportHistoryView(input: {
  readonly state: CanonicalReplicaState;
  readonly genesisId: Identifier<"VaultRecord">;
  readonly events: readonly AuthenticatedVaultEvent[];
}): CompleteImportHistoryView {
  const causalGraph = new CausalGraph();
  const authorityGraph = new CausalGraph();
  causalGraph.add(input.state.baselineId, []);
  const authorityAnchor = input.state.adoption?.vacuumEventRecordId ?? input.genesisId;
  authorityGraph.add(authorityAnchor, []);

  for (const event of input.events) {
    if (!bytesEqual(event.vaultId, input.state.vaultId)) {
      throw new TypeError("Complete Import history Event belongs to another Vault");
    }
    if (!bytesEqual(event.generationId, input.state.generationId)) continue;
    if (bytesEqual(event.recordId, input.genesisId)) {
      causalGraph.add(event.recordId, [input.state.baselineId]);
    } else {
      causalGraph.add(event.recordId, event.parentRecordIds);
    }
    if (!bytesEqual(event.recordId, authorityAnchor)) {
      authorityGraph.add(event.recordId, event.authorityParentRecordIds);
    }
  }

  return {
    vaultId: input.state.vaultId,
    generationId: input.state.generationId,
    baselineId: input.state.baselineId,
    genesisId: input.genesisId,
    causalFrontier: input.state.causalFrontier,
    authorityFrontier: input.state.authorityFrontier,
    causalGraph,
    authorityGraph,
  };
}

function requireFrontier(
  graph: CausalGraph,
  frontier: readonly Identifier<"VaultRecord">[],
  field: string,
): void {
  if (frontier.length === 0 || frontier.some((recordId) => !graph.has(recordId))) {
    throw new TypeError(`${field} is not fully represented by its authenticated graph`);
  }
}

function descendsFrom(
  descendantGraph: CausalGraph,
  ancestorFrontier: readonly Identifier<"VaultRecord">[],
  descendantFrontier: readonly Identifier<"VaultRecord">[],
): boolean {
  return ancestorFrontier.every((ancestor) =>
    descendantFrontier.some(
      (descendant) =>
        bytesEqual(ancestor, descendant) || descendantGraph.isAncestor(ancestor, descendant),
    ),
  );
}

export function classifyCompleteImportCollision(input: {
  readonly local: CompleteImportHistoryView;
  readonly incoming: CompleteImportHistoryView;
}): SameGenerationCompleteImportCollision {
  if (!bytesEqual(input.local.vaultId, input.incoming.vaultId)) {
    throw new TypeError("Complete Import collision does not name the same Vault ID");
  }
  if (!bytesEqual(input.local.genesisId, input.incoming.genesisId)) {
    throw new TypeError("Complete Import Vault identity has an incompatible Genesis");
  }
  if (!bytesEqual(input.local.generationId, input.incoming.generationId)) {
    throw new TypeError("Complete Import collision requires a Generation relationship proof");
  }
  if (!bytesEqual(input.local.baselineId, input.incoming.baselineId)) {
    throw new TypeError("Complete Import Generation has an incompatible Baseline");
  }

  requireFrontier(input.local.causalGraph, input.local.causalFrontier, "Local causal Frontier");
  requireFrontier(
    input.local.authorityGraph,
    input.local.authorityFrontier,
    "Local Authority Frontier",
  );
  requireFrontier(
    input.incoming.causalGraph,
    input.incoming.causalFrontier,
    "Incoming causal Frontier",
  );
  requireFrontier(
    input.incoming.authorityGraph,
    input.incoming.authorityFrontier,
    "Incoming Authority Frontier",
  );

  const incomingContainsLocal =
    descendsFrom(
      input.incoming.causalGraph,
      input.local.causalFrontier,
      input.incoming.causalFrontier,
    ) &&
    descendsFrom(
      input.incoming.authorityGraph,
      input.local.authorityFrontier,
      input.incoming.authorityFrontier,
    );
  const localContainsIncoming =
    descendsFrom(
      input.local.causalGraph,
      input.incoming.causalFrontier,
      input.local.causalFrontier,
    ) &&
    descendsFrom(
      input.local.authorityGraph,
      input.incoming.authorityFrontier,
      input.local.authorityFrontier,
    );

  if (incomingContainsLocal && localContainsIncoming) return "equal";
  if (incomingContainsLocal) return "incoming-fast-forward";
  if (localContainsIncoming) return "incoming-ancestor";
  return "divergent";
}

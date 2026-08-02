import type { Identifier } from "../../domain/canonical/identifiers";
import type { AuthenticatedVaultEvent } from "../../domain/canonical/record";
import { CausalGraph } from "../../domain/canonical/reducers";
import { exactMap, identifierValue, idSetValue, mapValue } from "../../domain/canonical/schema";
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
  readonly continuityEvents: readonly AuthenticatedVaultEvent[];
}

export type CompleteImportCollisionRelation =
  | "equal"
  | "incoming-ancestor"
  | "incoming-fast-forward"
  | "incoming-vacuum-successor"
  | "incoming-generation-ancestor"
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
    continuityEvents: input.events,
  };
}

interface VacuumBoundary {
  readonly event: AuthenticatedVaultEvent;
  readonly predecessorGenerationId: Identifier<"Generation">;
  readonly predecessorFrontier: readonly Identifier<"VaultRecord">[];
  readonly successorGenerationId: Identifier<"Generation">;
  readonly successorBaselineId: Identifier<"VaultRecord">;
}

function sameSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((candidate) => right.some((value) => bytesEqual(value, candidate)));
}

function vacuumBoundaries(view: CompleteImportHistoryView): readonly VacuumBoundary[] {
  return view.continuityEvents
    .filter((event) => event.family === 3 && event.type === 1)
    .map((event) => {
      const body = exactMap(event.body, [...Array(7).keys()], "Complete Import Vacuum body");
      const predecessorGenerationId = identifierValue(
        mapValue(body, 0),
        "Generation",
        "Vacuum predecessor Generation ID",
      );
      const predecessorFrontier = idSetValue(
        mapValue(body, 1),
        "VaultRecord",
        "Vacuum predecessor Frontier",
        { nonempty: true },
      );
      if (
        !bytesEqual(predecessorGenerationId, event.generationId) ||
        !sameSet(predecessorFrontier, event.parentRecordIds)
      ) {
        throw new TypeError("Complete Import Vacuum predecessor context is inconsistent");
      }
      return {
        event,
        predecessorGenerationId,
        predecessorFrontier,
        successorGenerationId: identifierValue(
          mapValue(body, 2),
          "Generation",
          "Vacuum successor Generation ID",
        ),
        successorBaselineId: identifierValue(
          mapValue(body, 3),
          "VaultRecord",
          "Vacuum successor Baseline ID",
        ),
      };
    });
}

function generationPath(
  view: CompleteImportHistoryView,
  predecessorGenerationId: Identifier<"Generation">,
  successorGenerationId: Identifier<"Generation">,
): readonly VacuumBoundary[] | null {
  const boundaries = vacuumBoundaries(view);
  const path: VacuumBoundary[] = [];
  let current = predecessorGenerationId;
  const visited = new Set<string>();
  while (!bytesEqual(current, successorGenerationId)) {
    const currentKey = Array.from(current).join(",");
    if (visited.has(currentKey))
      throw new TypeError("Complete Import Vacuum chain contains a cycle");
    visited.add(currentKey);
    const candidates = boundaries.filter((boundary) =>
      bytesEqual(boundary.predecessorGenerationId, current),
    );
    if (candidates.length === 0) return null;
    if (candidates.length !== 1 || candidates[0] === undefined) {
      throw new TypeError("Complete Import Vacuum chain is ambiguous");
    }
    path.push(candidates[0]);
    current = candidates[0].successorGenerationId;
  }
  const last = path.at(-1);
  if (last === undefined || !bytesEqual(last.successorBaselineId, view.baselineId)) {
    throw new TypeError("Complete Import Vacuum chain does not authenticate the active Baseline");
  }
  return path;
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
}): CompleteImportCollisionRelation {
  if (!bytesEqual(input.local.vaultId, input.incoming.vaultId)) {
    throw new TypeError("Complete Import collision does not name the same Vault ID");
  }
  if (!bytesEqual(input.local.genesisId, input.incoming.genesisId)) {
    throw new TypeError("Complete Import Vault identity has an incompatible Genesis");
  }
  if (!bytesEqual(input.local.generationId, input.incoming.generationId)) {
    const incomingPath = generationPath(
      input.incoming,
      input.local.generationId,
      input.incoming.generationId,
    );
    if (incomingPath !== null) {
      const first = incomingPath[0];
      if (
        first !== undefined &&
        descendsFrom(
          input.local.causalGraph,
          input.local.causalFrontier,
          first.predecessorFrontier,
        ) &&
        descendsFrom(
          input.local.authorityGraph,
          input.local.authorityFrontier,
          first.event.authorityParentRecordIds,
        )
      ) {
        return "incoming-vacuum-successor";
      }
      return "divergent";
    }
    const localPath = generationPath(
      input.local,
      input.incoming.generationId,
      input.local.generationId,
    );
    if (localPath !== null) {
      const first = localPath[0];
      if (
        first !== undefined &&
        descendsFrom(
          input.incoming.causalGraph,
          input.incoming.causalFrontier,
          first.predecessorFrontier,
        ) &&
        descendsFrom(
          input.incoming.authorityGraph,
          input.incoming.authorityFrontier,
          first.event.authorityParentRecordIds,
        )
      ) {
        return "incoming-generation-ancestor";
      }
    }
    return "divergent";
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

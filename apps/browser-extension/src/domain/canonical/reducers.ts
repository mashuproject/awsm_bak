import { bytesEqual } from "../hash";
import type { Identifier } from "./identifiers";
import { type CanonicalValue, encodeCanonicalValue } from "./value";

export type ReductionStrategy =
  | "additive-union"
  | "causal-scalar"
  | "observed-remove"
  | "graph-validation"
  | "n-way-content"
  | "genesis"
  | "membership"
  | "administrator-role"
  | "invitation"
  | "client-credential"
  | "recovery-credential"
  | "key-epoch"
  | "key-delivery"
  | "feature-activation"
  | "generation-choice"
  | "closure";

const AUTHORITY_STRATEGIES: readonly ReductionStrategy[] = [
  "genesis",
  "membership",
  "administrator-role",
  "administrator-role",
  "invitation",
  "invitation",
  "invitation",
  "invitation",
  "client-credential",
  "client-credential",
  "recovery-credential",
  "key-epoch",
  "key-delivery",
  "feature-activation",
];

const CONTENT_STRATEGIES: readonly ReductionStrategy[] = [
  "causal-scalar",
  "causal-scalar",
  "additive-union",
  "causal-scalar",
  "causal-scalar",
  "causal-scalar",
  "causal-scalar",
  "graph-validation",
  "graph-validation",
  "graph-validation",
  "causal-scalar",
  "additive-union",
  "causal-scalar",
  "graph-validation",
  "causal-scalar",
  "causal-scalar",
  "graph-validation",
  "additive-union",
  "causal-scalar",
  "additive-union",
  "observed-remove",
  "causal-scalar",
  "causal-scalar",
  "graph-validation",
  "graph-validation",
  "graph-validation",
  "additive-union",
  "n-way-content",
  "n-way-content",
  "n-way-content",
  "n-way-content",
];

const LIFECYCLE_STRATEGIES: readonly ReductionStrategy[] = ["generation-choice", "closure"];

export function reductionStrategy(family: 1 | 2 | 3, type: number): ReductionStrategy {
  const strategy =
    family === 1
      ? AUTHORITY_STRATEGIES[type - 1]
      : family === 2
        ? CONTENT_STRATEGIES[type - 1]
        : LIFECYCLE_STRATEGIES[type - 1];
  if (strategy === undefined) throw new TypeError("Unknown base Event family or type");
  return strategy;
}

function key(id: Uint8Array): string {
  return Array.from(id, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareIds(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < 32; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class CausalGraph {
  readonly #parents = new Map<string, readonly Identifier<"VaultRecord">[]>();
  readonly #baselineRootByCause = new Map<string, string>();

  public addBaseline(
    baselineId: Identifier<"VaultRecord">,
    causeIds: readonly Identifier<"VaultRecord">[],
  ): void {
    const baselineKey = key(baselineId);
    if (causeIds.length !== new Set(causeIds.map(key)).size) {
      throw new TypeError("A Baseline cannot repeat a Baseline Cause ID");
    }
    for (const causeId of causeIds) {
      const causeKey = key(causeId);
      if (
        causeKey === baselineKey ||
        this.#parents.has(causeKey) ||
        (this.#baselineRootByCause.has(causeKey) &&
          this.#baselineRootByCause.get(causeKey) !== baselineKey)
      ) {
        throw new TypeError("A Baseline Cause ID collides with another causal identity");
      }
    }
    this.add(baselineId, []);
    for (const causeId of causeIds) this.#baselineRootByCause.set(key(causeId), baselineKey);
  }

  public add(
    recordId: Identifier<"VaultRecord">,
    parentRecordIds: readonly Identifier<"VaultRecord">[],
  ): void {
    const recordKey = key(recordId);
    if (this.#baselineRootByCause.has(recordKey)) {
      throw new TypeError("A Record ID collides with a Baseline Cause ID");
    }
    const existing = this.#parents.get(recordKey);
    if (existing !== undefined) {
      if (!sameIdSet(existing, parentRecordIds)) {
        throw new TypeError("One Record ID cannot claim two causal parent sets");
      }
      return;
    }
    if (
      parentRecordIds.some(
        (parentId) => bytesEqual(parentId, recordId) || this.isAncestor(recordId, parentId),
      )
    ) {
      throw new TypeError("A Record cannot create a causal cycle");
    }
    this.#parents.set(recordKey, [...parentRecordIds]);
  }

  public has(recordId: Uint8Array): boolean {
    const recordKey = key(recordId);
    return this.#parents.has(recordKey) || this.#baselineRootByCause.has(recordKey);
  }

  public isAncestor(ancestorId: Uint8Array, descendantId: Uint8Array): boolean {
    if (bytesEqual(ancestorId, descendantId)) return false;
    const target = this.#baselineRootByCause.get(key(ancestorId)) ?? key(ancestorId);
    if (target === key(descendantId) && this.#baselineRootByCause.has(key(ancestorId))) return true;
    const pending = [...(this.#parents.get(key(descendantId)) ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop() as Identifier<"VaultRecord">;
      const currentKey = key(current);
      if (currentKey === target) return true;
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);
      pending.push(...(this.#parents.get(currentKey) ?? []));
    }
    return false;
  }
}

function sameIdSet(
  left: readonly Identifier<"VaultRecord">[],
  right: readonly Identifier<"VaultRecord">[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map(key));
  return right.every((id) => leftKeys.has(key(id)));
}

export interface CausalFact {
  readonly causeId: Identifier<"VaultRecord">;
}

export interface CausalCandidate<Value> extends CausalFact {
  readonly value: Value;
}

export function causalMaxima<Fact extends CausalFact>(
  candidates: readonly Fact[],
  graph: CausalGraph,
): readonly Fact[] {
  const byId = new Map<string, Fact>();
  for (const candidate of candidates) {
    const candidateKey = key(candidate.causeId);
    if (byId.has(candidateKey)) throw new TypeError("Reducer input repeats a Cause ID");
    if (!graph.has(candidate.causeId))
      throw new TypeError("Reducer input references an unknown Record");
    byId.set(candidateKey, candidate);
  }
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          !bytesEqual(candidate.causeId, other.causeId) &&
          graph.isAncestor(candidate.causeId, other.causeId),
      ),
  );
}

export function reduceCausalScalar<Value>(
  candidates: readonly CausalCandidate<Value>[],
  graph: CausalGraph,
): CausalCandidate<Value> | null {
  if (candidates.length === 0) return null;
  const maxima = causalMaxima(candidates, graph);
  return [...maxima].sort((left, right) => compareIds(left.causeId, right.causeId))[0] ?? null;
}

export interface AdditiveFact {
  readonly entityId: Uint8Array;
  readonly causeId: Identifier<"VaultRecord">;
  readonly authenticatedValue: CanonicalValue;
}

export interface AdditiveUnionResult {
  readonly facts: readonly AdditiveFact[];
  readonly collisions: readonly {
    readonly entityId: Uint8Array;
    readonly candidates: readonly AdditiveFact[];
  }[];
}

export function reduceAdditiveUnion(facts: readonly AdditiveFact[]): AdditiveUnionResult {
  const grouped = new Map<string, AdditiveFact[]>();
  for (const fact of facts) {
    const entries = grouped.get(key(fact.entityId)) ?? [];
    entries.push(fact);
    grouped.set(key(fact.entityId), entries);
  }
  const accepted: AdditiveFact[] = [];
  const collisions: AdditiveUnionResult["collisions"][number][] = [];
  for (const entries of grouped.values()) {
    const first = entries[0] as AdditiveFact;
    const firstBytes = encodeCanonicalValue(first.authenticatedValue);
    if (
      entries.every((entry) =>
        bytesEqual(firstBytes, encodeCanonicalValue(entry.authenticatedValue)),
      )
    ) {
      accepted.push(first);
    } else {
      collisions.push({ entityId: first.entityId, candidates: entries });
    }
  }
  accepted.sort((left, right) => compareIds(left.entityId, right.entityId));
  collisions.sort((left, right) => compareIds(left.entityId, right.entityId));
  return { facts: accepted, collisions };
}

export interface ObservedAssignment<Value> extends CausalCandidate<Value> {
  readonly relationKey: string;
}

export interface ObservedRemoval {
  readonly causeId: Identifier<"VaultRecord">;
  readonly relationKey: string;
  readonly observedAssignmentCauseIds: readonly Identifier<"VaultRecord">[];
}

export function reduceObservedRemove<Value>(
  assignments: readonly ObservedAssignment<Value>[],
  removals: readonly ObservedRemoval[],
  graph: CausalGraph,
): readonly ObservedAssignment<Value>[] {
  const assignmentsById = new Map(
    assignments.map((assignment) => [key(assignment.causeId), assignment]),
  );
  const removed = new Set<string>();
  for (const removal of removals) {
    if (!graph.has(removal.causeId))
      throw new TypeError("Observed removal references an unknown Record");
    if (removal.observedAssignmentCauseIds.length === 0) {
      throw new TypeError("Observed removal must name at least one assignment fact");
    }
    const seen = new Set<string>();
    for (const assignmentId of removal.observedAssignmentCauseIds) {
      const assignmentKey = key(assignmentId);
      if (seen.has(assignmentKey))
        throw new TypeError("Observed removal repeats an assignment fact");
      seen.add(assignmentKey);
      const assignment = assignmentsById.get(assignmentKey);
      if (assignment === undefined || assignment.relationKey !== removal.relationKey) {
        throw new TypeError("Observed removal names a fact outside its exact relation");
      }
      if (!graph.isAncestor(assignment.causeId, removal.causeId)) {
        throw new TypeError("Observed removal names an assignment it did not causally observe");
      }
      if (
        removals.some(
          (prior) =>
            prior !== removal &&
            graph.isAncestor(prior.causeId, removal.causeId) &&
            prior.observedAssignmentCauseIds.some((id) => bytesEqual(id, assignment.causeId)),
        )
      ) {
        throw new TypeError("Observed removal names an already inactive assignment fact");
      }
      removed.add(assignmentKey);
    }
  }
  return assignments.filter((assignment) => !removed.has(key(assignment.causeId)));
}

export interface DirectedEdge {
  readonly sourceId: Uint8Array;
  readonly destinationId: Uint8Array;
  readonly causeId: Identifier<"VaultRecord">;
}

export interface GraphConflict {
  readonly subjectIds: readonly Uint8Array[];
  readonly candidates: readonly DirectedEdge[];
  readonly kind: "cycle" | "multiple-destinations";
}

export interface DirectedGraphReduction {
  readonly edges: readonly DirectedEdge[];
  readonly conflicts: readonly GraphConflict[];
}

export function reduceDirectedGraph(
  candidates: readonly DirectedEdge[],
  graph: CausalGraph,
): DirectedGraphReduction {
  const bySource = new Map<string, DirectedEdge[]>();
  for (const candidate of candidates) {
    if (!graph.has(candidate.causeId))
      throw new TypeError("Graph edge references an unknown Record");
    const entries = bySource.get(key(candidate.sourceId)) ?? [];
    entries.push(candidate);
    bySource.set(key(candidate.sourceId), entries);
  }
  const effective: DirectedEdge[] = [];
  const conflicts: GraphConflict[] = [];
  for (const entries of bySource.values()) {
    const maxima = causalMaxima(entries, graph);
    const byDestination = new Map<string, DirectedEdge[]>();
    for (const entry of maxima) {
      const sameDestination = byDestination.get(key(entry.destinationId)) ?? [];
      sameDestination.push(entry);
      byDestination.set(key(entry.destinationId), sameDestination);
    }
    if (byDestination.size > 1) {
      conflicts.push({
        kind: "multiple-destinations",
        subjectIds: [entries[0]?.sourceId ?? new Uint8Array()],
        candidates: maxima,
      });
      continue;
    }
    const selected = [...maxima].sort((left, right) => compareIds(left.causeId, right.causeId))[0];
    if (selected !== undefined) effective.push(selected);
  }

  const edgeBySource = new Map(effective.map((edge) => [key(edge.sourceId), edge]));
  const cyclic = new Set<string>();
  for (const edge of effective) {
    const path: DirectedEdge[] = [];
    const positions = new Map<string, number>();
    let current: DirectedEdge | undefined = edge;
    while (current !== undefined) {
      const sourceKey = key(current.sourceId);
      const position = positions.get(sourceKey);
      if (position !== undefined) {
        const cycle = path.slice(position);
        const cycleKey = cycle
          .map((entry) => key(entry.sourceId))
          .sort()
          .join(":");
        if (!cyclic.has(cycleKey)) {
          cyclic.add(cycleKey);
          conflicts.push({
            kind: "cycle",
            subjectIds: cycle.map((entry) => entry.sourceId),
            candidates: cycle,
          });
        }
        break;
      }
      positions.set(sourceKey, path.length);
      path.push(current);
      current = edgeBySource.get(key(current.destinationId));
    }
  }
  const conflictedCauses = new Set(
    conflicts.flatMap(({ candidates }) => candidates.map(({ causeId }) => key(causeId))),
  );
  return {
    edges: effective.filter((edge) => !conflictedCauses.has(key(edge.causeId))),
    conflicts,
  };
}

export interface NoteHead extends CausalCandidate<Uint8Array | null> {
  readonly kind: "revision" | "deletion";
}

export type NoteReduction =
  | { readonly state: "absent"; readonly heads: readonly [] }
  | { readonly state: "active"; readonly heads: readonly [NoteHead] }
  | { readonly state: "deleted"; readonly heads: readonly NoteHead[] }
  | { readonly state: "conflict"; readonly heads: readonly NoteHead[] };

export function reduceNoteHeads(
  candidates: readonly NoteHead[],
  graph: CausalGraph,
): NoteReduction {
  if (candidates.length === 0) return { state: "absent", heads: [] };
  const maxima = [...causalMaxima(candidates, graph)].sort((left, right) =>
    compareIds(left.causeId, right.causeId),
  );
  if (maxima.every(({ kind }) => kind === "deletion")) {
    return { state: "deleted", heads: maxima };
  }
  if (maxima.length === 1) {
    return { state: "active", heads: [maxima[0] as NoteHead] };
  }
  return { state: "conflict", heads: maxima };
}

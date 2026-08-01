import { describe, expect, it } from "vitest";

import { type Identifier, identifier } from "../../src/domain/canonical/identifiers";
import {
  CausalGraph,
  reduceAdditiveUnion,
  reduceCausalScalar,
  reduceDirectedGraph,
  reduceNoteHeads,
  reduceObservedRemove,
  reductionStrategy,
} from "../../src/domain/canonical/reducers";
import { canonicalMap } from "../../src/domain/canonical/value";

function record(fill: number): Identifier<"VaultRecord"> {
  return identifier("VaultRecord", new Uint8Array(32).fill(fill));
}

function entity(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function graphWithSiblings(count: number) {
  const graph = new CausalGraph();
  const root = record(1);
  graph.add(root, []);
  const siblings = Array.from({ length: count }, (_, index) => record(index + 2));
  for (const sibling of siblings) graph.add(sibling, [root]);
  return { graph, root, siblings };
}

describe("exhaustive reducer strategy registry", () => {
  it("classifies every one of the 47 base Event types", () => {
    const strategies = [
      ...Array.from({ length: 14 }, (_, index) => reductionStrategy(1, index + 1)),
      ...Array.from({ length: 31 }, (_, index) => reductionStrategy(2, index + 1)),
      ...Array.from({ length: 2 }, (_, index) => reductionStrategy(3, index + 1)),
    ];
    expect(strategies).toHaveLength(47);
    expect(strategies).toContain("observed-remove");
    expect(strategies).toContain("n-way-content");
    expect(strategies).toContain("generation-choice");
    expect(() => reductionStrategy(2, 32)).toThrow(/unknown/iu);
  });
});

describe("deterministic causal primitives", () => {
  it("selects a descendant and uses ascending raw Record ID only for siblings", () => {
    const { graph, root, siblings } = graphWithSiblings(2);
    const descendant = record(9);
    graph.add(descendant, [siblings[1] as Identifier<"VaultRecord">]);

    expect(
      reduceCausalScalar(
        [
          { causeId: root, value: "root" },
          { causeId: siblings[0] as Identifier<"VaultRecord">, value: "first sibling" },
          { causeId: siblings[1] as Identifier<"VaultRecord">, value: "second sibling" },
          { causeId: descendant, value: "descendant" },
        ],
        graph,
      )?.value,
    ).toBe("first sibling");
  });

  it("converges across randomized candidate and DAG insertion order", () => {
    const root = record(1);
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      causeId: record(index + 2),
      value: index,
    }));
    const winners = new Set<number>();
    for (let rotation = 0; rotation < candidates.length; rotation += 1) {
      const graph = new CausalGraph();
      for (const candidate of rotate(candidates, rotation).reverse()) {
        graph.add(candidate.causeId, [root]);
      }
      graph.add(root, []);
      winners.add(reduceCausalScalar(rotate(candidates, rotation), graph)?.value ?? -1);
    }
    expect(winners).toEqual(new Set([0]));
  });

  it("rejects a causal cycle even when records arrive out of order", () => {
    const graph = new CausalGraph();
    const first = record(1);
    const second = record(2);
    graph.add(second, [first]);
    expect(() => graph.add(first, [second])).toThrow(/cycle/u);
  });

  it("lets descendant Events supersede sibling Baseline Causes without Record-parent fiction", () => {
    const graph = new CausalGraph();
    const baselineId = record(10);
    const firstBaselineCause = record(11);
    const secondBaselineCause = record(12);
    const descendant = record(13);

    graph.addBaseline(baselineId, [firstBaselineCause, secondBaselineCause]);
    graph.add(descendant, [baselineId]);

    expect(graph.isAncestor(firstBaselineCause, secondBaselineCause)).toBe(false);
    expect(graph.isAncestor(secondBaselineCause, firstBaselineCause)).toBe(false);
    expect(graph.isAncestor(firstBaselineCause, descendant)).toBe(true);
    expect(
      reduceCausalScalar(
        [
          { causeId: firstBaselineCause, value: "checkpoint" },
          { causeId: descendant, value: "event" },
        ],
        graph,
      )?.value,
    ).toBe("event");
  });
});

describe("additive, observed-remove, graph, and Note reducers", () => {
  it("quarantines incompatible stable-ID creation facts", () => {
    const id = entity(1);
    const result = reduceAdditiveUnion([
      { entityId: id, causeId: record(2), authenticatedValue: canonicalMap([[0, "first"]]) },
      { entityId: id, causeId: record(3), authenticatedValue: canonicalMap([[0, "second"]]) },
      {
        entityId: entity(4),
        causeId: record(5),
        authenticatedValue: canonicalMap([[0, "unrelated"]]),
      },
    ]);
    expect(result.collisions).toHaveLength(1);
    expect(result.facts).toHaveLength(1);
  });

  it("implements observed-remove add-wins for a concurrent assignment", () => {
    const graph = new CausalGraph();
    const root = record(1);
    const observed = record(2);
    const concurrent = record(3);
    const removal = record(4);
    graph.add(root, []);
    graph.add(observed, [root]);
    graph.add(concurrent, [root]);
    graph.add(removal, [observed]);
    const active = reduceObservedRemove(
      [
        { causeId: observed, relationKey: "tag:target", value: "observed" },
        { causeId: concurrent, relationKey: "tag:target", value: "concurrent" },
      ],
      [
        {
          causeId: removal,
          relationKey: "tag:target",
          observedAssignmentCauseIds: [observed],
        },
      ],
      graph,
    );
    expect(active.map(({ value }) => value)).toEqual(["concurrent"]);
  });

  it("surfaces multiple destinations and cycles instead of choosing by time", () => {
    const { graph, siblings } = graphWithSiblings(4);
    const multiple = reduceDirectedGraph(
      [
        {
          sourceId: entity(10),
          destinationId: entity(11),
          causeId: siblings[0] as Identifier<"VaultRecord">,
        },
        {
          sourceId: entity(10),
          destinationId: entity(12),
          causeId: siblings[1] as Identifier<"VaultRecord">,
        },
      ],
      graph,
    );
    expect(multiple.conflicts.map(({ kind }) => kind)).toEqual(["multiple-destinations"]);

    const cyclic = reduceDirectedGraph(
      [
        {
          sourceId: entity(20),
          destinationId: entity(21),
          causeId: siblings[2] as Identifier<"VaultRecord">,
        },
        {
          sourceId: entity(21),
          destinationId: entity(20),
          causeId: siblings[3] as Identifier<"VaultRecord">,
        },
      ],
      graph,
    );
    expect(cyclic.conflicts.map(({ kind }) => kind)).toEqual(["cycle"]);
    expect(cyclic.edges).toEqual([]);
  });

  it("retains an arbitrary ten-way Note conflict and converges concurrent deletions", () => {
    const { graph, siblings } = graphWithSiblings(10);
    const conflict = reduceNoteHeads(
      siblings.map((causeId, index) => ({
        causeId,
        kind: "revision" as const,
        value: entity(index + 50),
      })),
      graph,
    );
    expect(conflict.state).toBe("conflict");
    expect(conflict.heads).toHaveLength(10);

    const deletion = reduceNoteHeads(
      siblings.slice(0, 3).map((causeId) => ({ causeId, kind: "deletion" as const, value: null })),
      graph,
    );
    expect(deletion.state).toBe("deleted");
    expect(deletion.heads).toHaveLength(3);
  });
});

function rotate<Value>(values: readonly Value[], offset: number): Value[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

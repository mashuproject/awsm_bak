import { describe, expect, it } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { reduceCollectionRedirects } from "../../src/runtime/library/canonical-projection";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";

function merge(
  recordId: ReturnType<typeof randomIdentifier<"VaultRecord">>,
  sourceId: ReturnType<typeof randomIdentifier<"Collection">>,
  destinationId: ReturnType<typeof randomIdentifier<"Collection">>,
) {
  return {
    family: 2,
    type: 8,
    recordId,
    body: canonicalMap([
      [0, canonicalSet([sourceId])],
      [1, destinationId],
    ]),
  } as const;
}

describe("canonical Collection redirect reduction", () => {
  it("replaces every exact current conflicting Cause with one controlling redirect fact", () => {
    const genesis = randomIdentifier("VaultRecord");
    const firstCause = randomIdentifier("VaultRecord");
    const secondCause = randomIdentifier("VaultRecord");
    const resolutionCause = randomIdentifier("VaultRecord");
    const sourceId = randomIdentifier("Collection");
    const firstDestinationId = randomIdentifier("Collection");
    const secondDestinationId = randomIdentifier("Collection");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(firstCause, [genesis]);
    graph.add(secondCause, [genesis]);
    graph.add(resolutionCause, [firstCause, secondCause]);
    const replay = {
      graph,
      events: [
        merge(firstCause, sourceId, firstDestinationId),
        merge(secondCause, sourceId, secondDestinationId),
        {
          family: 2,
          type: 10,
          recordId: resolutionCause,
          body: canonicalMap([
            [0, canonicalSet([firstCause, secondCause])],
            [
              1,
              canonicalSet([
                canonicalMap([
                  [0, sourceId],
                  [1, secondDestinationId],
                ]),
              ]),
            ],
          ]),
        },
      ],
    } as unknown as ReplayedCanonicalVault;

    const reduced = reduceCollectionRedirects(replay);

    expect(reduced.conflicts).toEqual([]);
    expect(reduced.edges).toEqual([
      { sourceId, destinationId: secondDestinationId, causeId: resolutionCause },
    ]);
  });

  it("rejects a Resolution that omits a current conflicting Cause", () => {
    const genesis = randomIdentifier("VaultRecord");
    const firstCause = randomIdentifier("VaultRecord");
    const secondCause = randomIdentifier("VaultRecord");
    const resolutionCause = randomIdentifier("VaultRecord");
    const sourceId = randomIdentifier("Collection");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(firstCause, [genesis]);
    graph.add(secondCause, [genesis]);
    graph.add(resolutionCause, [firstCause, secondCause]);
    const replay = {
      graph,
      events: [
        merge(firstCause, sourceId, randomIdentifier("Collection")),
        merge(secondCause, sourceId, randomIdentifier("Collection")),
        {
          family: 2,
          type: 10,
          recordId: resolutionCause,
          body: canonicalMap([
            [0, canonicalSet([firstCause])],
            [1, []],
          ]),
        },
      ],
    } as unknown as ReplayedCanonicalVault;

    expect(() => reduceCollectionRedirects(replay)).toThrow(/exact current conflict/u);
  });

  it("rejects a replacement graph that cycles through an unaffected redirect", () => {
    const genesis = randomIdentifier("VaultRecord");
    const firstCause = randomIdentifier("VaultRecord");
    const secondCause = randomIdentifier("VaultRecord");
    const unaffectedCause = randomIdentifier("VaultRecord");
    const resolutionCause = randomIdentifier("VaultRecord");
    const sourceId = randomIdentifier("Collection");
    const outsideId = randomIdentifier("Collection");
    const graph = new CausalGraph();
    graph.add(genesis, []);
    graph.add(firstCause, [genesis]);
    graph.add(secondCause, [genesis]);
    graph.add(unaffectedCause, [genesis]);
    graph.add(resolutionCause, [firstCause, secondCause, unaffectedCause]);
    const replay = {
      graph,
      events: [
        merge(firstCause, sourceId, randomIdentifier("Collection")),
        merge(secondCause, sourceId, randomIdentifier("Collection")),
        merge(unaffectedCause, outsideId, sourceId),
        {
          family: 2,
          type: 10,
          recordId: resolutionCause,
          body: canonicalMap([
            [0, canonicalSet([firstCause, secondCause])],
            [
              1,
              canonicalSet([
                canonicalMap([
                  [0, sourceId],
                  [1, outsideId],
                ]),
              ]),
            ],
          ]),
        },
      ],
    } as unknown as ReplayedCanonicalVault;

    expect(() => reduceCollectionRedirects(replay)).toThrow(/valid replacement graph/u);
  });
});

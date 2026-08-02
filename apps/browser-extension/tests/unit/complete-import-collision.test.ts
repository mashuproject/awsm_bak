import { describe, expect, it } from "vitest";

import type { Identifier, IdentifierKind } from "../../src/domain/canonical/identifiers";
import type { AuthenticatedVaultEvent } from "../../src/domain/canonical/record";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import {
  buildCompleteImportHistoryView,
  type CompleteImportHistoryView,
  classifyCompleteImportCollision,
} from "../../src/runtime/complete-import/collision";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";

function id<Type extends IdentifierKind>(value: number): Identifier<Type> {
  return new Uint8Array(32).fill(value) as Identifier<Type>;
}

const vaultId = id<"Vault">(1);
const generationId = id<"Generation">(2);
const baselineId = id<"VaultRecord">(3);
const genesisId = id<"VaultRecord">(4);

function graph(
  entries: readonly (readonly [Identifier<"VaultRecord">, readonly Identifier<"VaultRecord">[]])[],
): CausalGraph {
  const result = new CausalGraph();
  for (const [recordId, parents] of entries) result.add(recordId, parents);
  return result;
}

function history(input: {
  readonly causalFrontier: readonly Identifier<"VaultRecord">[];
  readonly authorityFrontier: readonly Identifier<"VaultRecord">[];
  readonly causalEntries: readonly (readonly [
    Identifier<"VaultRecord">,
    readonly Identifier<"VaultRecord">[],
  ])[];
  readonly authorityEntries: readonly (readonly [
    Identifier<"VaultRecord">,
    readonly Identifier<"VaultRecord">[],
  ])[];
  readonly overrides?: Partial<CompleteImportHistoryView>;
  readonly continuityEvents?: readonly AuthenticatedVaultEvent[];
}): CompleteImportHistoryView {
  return {
    vaultId,
    generationId,
    baselineId,
    genesisId,
    causalFrontier: input.causalFrontier,
    authorityFrontier: input.authorityFrontier,
    causalGraph: graph(input.causalEntries),
    authorityGraph: graph(input.authorityEntries),
    continuityEvents: input.continuityEvents ?? [],
    ...input.overrides,
  };
}

function vacuumBoundary(input: {
  readonly recordId: Identifier<"VaultRecord">;
  readonly predecessorGenerationId: Identifier<"Generation">;
  readonly predecessorFrontier: readonly Identifier<"VaultRecord">[];
  readonly predecessorAuthorityFrontier: readonly Identifier<"VaultRecord">[];
  readonly successorGenerationId: Identifier<"Generation">;
  readonly successorBaselineId: Identifier<"VaultRecord">;
}): AuthenticatedVaultEvent {
  return {
    vaultId,
    generationId: input.predecessorGenerationId,
    recordId: input.recordId,
    parentRecordIds: input.predecessorFrontier,
    authorityParentRecordIds: input.predecessorAuthorityFrontier,
    dependencies: [],
    requiredFeatureSetId: id<"RequiredFeatureSet">(120),
    extensions: new Map(),
    family: 3,
    type: 1,
    signerCredentialId: id<"ClientCredential">(121),
    assertedAt: 99n,
    body: canonicalMap([
      [0, input.predecessorGenerationId],
      [1, canonicalSet(input.predecessorFrontier)],
      [2, input.successorGenerationId],
      [3, input.successorBaselineId],
      [4, new Uint8Array(32).fill(122)],
      [5, new Uint8Array(32).fill(123)],
      [6, new Uint8Array(32).fill(124)],
    ]),
    bytes: new Uint8Array(),
    signature: new Uint8Array(64),
  } as AuthenticatedVaultEvent;
}

describe("canonical Complete Import collision classification", () => {
  const captureId = id<"VaultRecord">(5);
  const authorityId = id<"VaultRecord">(6);
  const siblingId = id<"VaultRecord">(7);
  const rootEntries = [[genesisId, []]] as const;

  it("recognizes equal causal and Authority Frontiers", () => {
    const local = history({
      causalFrontier: [genesisId],
      authorityFrontier: [genesisId],
      causalEntries: rootEntries,
      authorityEntries: rootEntries,
    });

    expect(classifyCompleteImportCollision({ local, incoming: local })).toBe("equal");
  });

  it("fast-forwards only when the incoming state descends both local Frontiers", () => {
    const local = history({
      causalFrontier: [genesisId],
      authorityFrontier: [genesisId],
      causalEntries: rootEntries,
      authorityEntries: rootEntries,
    });
    const incoming = history({
      causalFrontier: [captureId],
      authorityFrontier: [authorityId],
      causalEntries: [...rootEntries, [captureId, [genesisId]], [authorityId, [captureId]]],
      authorityEntries: [...rootEntries, [captureId, [genesisId]], [authorityId, [captureId]]],
    });

    expect(classifyCompleteImportCollision({ local, incoming })).toBe("incoming-fast-forward");
    expect(classifyCompleteImportCollision({ local: incoming, incoming: local })).toBe(
      "incoming-ancestor",
    );
  });

  it("classifies sibling work as divergent without a time-based winner", () => {
    const local = history({
      causalFrontier: [captureId],
      authorityFrontier: [genesisId],
      causalEntries: [...rootEntries, [captureId, [genesisId]]],
      authorityEntries: rootEntries,
    });
    const incoming = history({
      causalFrontier: [siblingId],
      authorityFrontier: [genesisId],
      causalEntries: [...rootEntries, [siblingId, [genesisId]]],
      authorityEntries: rootEntries,
    });

    expect(classifyCompleteImportCollision({ local, incoming })).toBe("divergent");
  });

  it("classifies mixed causal and Authority directions as divergent", () => {
    const common = history({
      causalFrontier: [genesisId],
      authorityFrontier: [genesisId],
      causalEntries: rootEntries,
      authorityEntries: rootEntries,
    });
    const causalAhead = history({
      causalFrontier: [captureId],
      authorityFrontier: [genesisId],
      causalEntries: [...rootEntries, [captureId, [genesisId]]],
      authorityEntries: rootEntries,
    });
    const authorityAhead = history({
      causalFrontier: [genesisId],
      authorityFrontier: [authorityId],
      causalEntries: rootEntries,
      authorityEntries: [...rootEntries, [authorityId, [genesisId]]],
    });

    expect(classifyCompleteImportCollision({ local: causalAhead, incoming: authorityAhead })).toBe(
      "divergent",
    );
    expect(classifyCompleteImportCollision({ local: common, incoming: causalAhead })).toBe(
      "incoming-fast-forward",
    );
  });

  it("rejects an incompatible Genesis or Baseline under the same Vault identity", () => {
    const local = history({
      causalFrontier: [genesisId],
      authorityFrontier: [genesisId],
      causalEntries: rootEntries,
      authorityEntries: rootEntries,
    });

    expect(() =>
      classifyCompleteImportCollision({
        local,
        incoming: history({
          causalFrontier: [genesisId],
          authorityFrontier: [genesisId],
          causalEntries: rootEntries,
          authorityEntries: rootEntries,
          overrides: { genesisId: id<"VaultRecord">(99) },
        }),
      }),
    ).toThrow("Genesis");
    expect(() =>
      classifyCompleteImportCollision({
        local,
        incoming: history({
          causalFrontier: [genesisId],
          authorityFrontier: [genesisId],
          causalEntries: rootEntries,
          authorityEntries: rootEntries,
          overrides: { baselineId: id<"VaultRecord">(98) },
        }),
      }),
    ).toThrow("Baseline");
  });

  it("anchors a successor Generation at its Baseline and adopted Vacuum boundary", () => {
    const successorGenerationId = id<"Generation">(40);
    const successorBaselineId = id<"VaultRecord">(41);
    const vacuumEventId = id<"VaultRecord">(42);
    const state: CanonicalReplicaState = {
      vaultId,
      generationId: successorGenerationId,
      causalFrontier: [successorBaselineId],
      authorityFrontier: [vacuumEventId],
      continuityRecordIds: [genesisId, vacuumEventId],
      baselineId: successorBaselineId,
      currentKeyEpochId: id<"KeyEpoch">(43),
      requiredFeatureSetId: id<"RequiredFeatureSet">(44),
      authoringClientCredentialId: null,
      memberId: null,
      lifecycle: 1,
      preservationRoots: [],
      garbageCollectionFences: [],
      adoption: { vacuumEventRecordId: vacuumEventId },
    };

    const built = buildCompleteImportHistoryView({ state, genesisId, events: [] });

    expect(built.causalGraph.has(successorBaselineId)).toBe(true);
    expect(built.authorityGraph.has(vacuumEventId)).toBe(true);
    expect(classifyCompleteImportCollision({ local: built, incoming: built })).toBe("equal");
  });

  it("recognizes a compatible authenticated incoming Vacuum successor", () => {
    const successorGenerationId = id<"Generation">(50);
    const successorBaselineId = id<"VaultRecord">(51);
    const vacuumEventId = id<"VaultRecord">(52);
    const boundary = vacuumBoundary({
      recordId: vacuumEventId,
      predecessorGenerationId: generationId,
      predecessorFrontier: [genesisId],
      predecessorAuthorityFrontier: [genesisId],
      successorGenerationId,
      successorBaselineId,
    });
    const local = history({
      causalFrontier: [genesisId],
      authorityFrontier: [genesisId],
      causalEntries: rootEntries,
      authorityEntries: rootEntries,
    });
    const incoming = history({
      causalFrontier: [successorBaselineId],
      authorityFrontier: [vacuumEventId],
      causalEntries: [[successorBaselineId, []]],
      authorityEntries: [[vacuumEventId, []]],
      continuityEvents: [boundary],
      overrides: {
        generationId: successorGenerationId,
        baselineId: successorBaselineId,
      },
    });

    expect(classifyCompleteImportCollision({ local, incoming })).toBe("incoming-vacuum-successor");
    expect(classifyCompleteImportCollision({ local: incoming, incoming: local })).toBe(
      "incoming-generation-ancestor",
    );
  });

  it.each(["causal", "authority"] as const)(
    "does not adopt a successor whose signed predecessor %s Frontier omits local work",
    (omittedFrontier) => {
      const localHead = id<"VaultRecord">(60);
      const remoteHead = id<"VaultRecord">(61);
      const successorGenerationId = id<"Generation">(62);
      const successorBaselineId = id<"VaultRecord">(63);
      const vacuumEventId = id<"VaultRecord">(64);
      const local = history({
        causalFrontier: omittedFrontier === "causal" ? [localHead] : [genesisId],
        authorityFrontier: omittedFrontier === "authority" ? [localHead] : [genesisId],
        causalEntries:
          omittedFrontier === "causal" ? [...rootEntries, [localHead, [genesisId]]] : rootEntries,
        authorityEntries:
          omittedFrontier === "authority"
            ? [...rootEntries, [localHead, [genesisId]]]
            : rootEntries,
      });
      const incoming = history({
        causalFrontier: [successorBaselineId],
        authorityFrontier: [vacuumEventId],
        causalEntries: [[successorBaselineId, []]],
        authorityEntries: [[vacuumEventId, []]],
        continuityEvents: [
          vacuumBoundary({
            recordId: vacuumEventId,
            predecessorGenerationId: generationId,
            predecessorFrontier: omittedFrontier === "causal" ? [remoteHead] : [genesisId],
            predecessorAuthorityFrontier:
              omittedFrontier === "authority" ? [remoteHead] : [genesisId],
            successorGenerationId,
            successorBaselineId,
          }),
        ],
        overrides: {
          generationId: successorGenerationId,
          baselineId: successorBaselineId,
        },
      });

      expect(classifyCompleteImportCollision({ local, incoming })).toBe("divergent");
    },
  );
});

export type ExactMatchReason = "ExactTitle" | "ExactUrl" | "ExactPhrase";
export type HybridMatch = ExactMatchReason | "Keyword" | "Semantic" | "KeywordAndSemantic";

export interface ExactCandidate {
  readonly bundleId: string;
  readonly reason: ExactMatchReason;
  readonly keywordScore: number;
  readonly capturedAt: string;
  readonly passageId?: string;
}

export interface ProviderCandidate {
  readonly bundleId: string;
  readonly passageId: string;
  readonly score: number;
  readonly capturedAt: string;
}

export interface HybridResult {
  readonly bundleId: string;
  readonly passageId?: string;
  readonly match: HybridMatch;
  readonly score: number;
  readonly capturedAt: string;
}

const EXACT_PRIORITY: Readonly<Record<ExactMatchReason, number>> = {
  ExactTitle: 0,
  ExactUrl: 1,
  ExactPhrase: 2,
};

function providerOrder(left: ProviderCandidate, right: ProviderCandidate): number {
  return (
    right.score - left.score ||
    right.capturedAt.localeCompare(left.capturedAt) ||
    left.bundleId.localeCompare(right.bundleId)
  );
}

export function fuseHybridResults(input: {
  readonly exact: readonly ExactCandidate[];
  readonly keyword: readonly ProviderCandidate[];
  readonly semantic: readonly ProviderCandidate[];
}): readonly HybridResult[] {
  const exactByBundle = new Map<string, ExactCandidate>();
  for (const candidate of input.exact) {
    const current = exactByBundle.get(candidate.bundleId);
    if (
      current === undefined ||
      EXACT_PRIORITY[candidate.reason] < EXACT_PRIORITY[current.reason] ||
      (candidate.reason === current.reason && candidate.keywordScore > current.keywordScore)
    ) {
      exactByBundle.set(candidate.bundleId, candidate);
    }
  }
  const exact = Array.from(exactByBundle.values()).sort(
    (left, right) =>
      EXACT_PRIORITY[left.reason] - EXACT_PRIORITY[right.reason] ||
      right.keywordScore - left.keywordScore ||
      right.capturedAt.localeCompare(left.capturedAt) ||
      left.bundleId.localeCompare(right.bundleId),
  );

  const keyword = [...input.keyword].sort(providerOrder).slice(0, 200);
  const semantic = [...input.semantic].sort(providerOrder).slice(0, 100);
  const keywordRanks = new Map(keyword.map((candidate, index) => [candidate.bundleId, index + 1]));
  const semanticRanks = new Map(
    semantic.map((candidate, index) => [candidate.bundleId, index + 1]),
  );
  const keywordCandidates = new Map(keyword.map((candidate) => [candidate.bundleId, candidate]));
  const semanticCandidates = new Map(semantic.map((candidate) => [candidate.bundleId, candidate]));
  const exactIds = new Set(exact.map(({ bundleId }) => bundleId));
  const fusedIds = new Set([...keywordRanks.keys(), ...semanticRanks.keys()]);

  const fused = Array.from(fusedIds)
    .filter((bundleId) => !exactIds.has(bundleId))
    .map((bundleId): HybridResult & { providerCount: number; bestRank: number } => {
      const keywordRank = keywordRanks.get(bundleId);
      const semanticRank = semanticRanks.get(bundleId);
      const keywordCandidate = keywordCandidates.get(bundleId);
      const semanticCandidate = semanticCandidates.get(bundleId);
      const keywordContribution = keywordRank === undefined ? 0 : 1 / (60 + keywordRank);
      const semanticContribution = semanticRank === undefined ? 0 : 1 / (60 + semanticRank);
      const chooseKeyword =
        keywordCandidate !== undefined &&
        (semanticCandidate === undefined ||
          (keywordRank ?? Infinity) <= (semanticRank ?? Infinity));
      const selected = chooseKeyword ? keywordCandidate : semanticCandidate;
      if (selected === undefined) throw new Error("Hybrid candidate disappeared.");
      return {
        bundleId,
        passageId: selected.passageId,
        match:
          keywordRank !== undefined && semanticRank !== undefined
            ? "KeywordAndSemantic"
            : keywordRank !== undefined
              ? "Keyword"
              : "Semantic",
        score: keywordContribution + semanticContribution,
        capturedAt: selected.capturedAt,
        providerCount: Number(keywordRank !== undefined) + Number(semanticRank !== undefined),
        bestRank: Math.min(keywordRank ?? Infinity, semanticRank ?? Infinity),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.providerCount - left.providerCount ||
        left.bestRank - right.bestRank ||
        right.capturedAt.localeCompare(left.capturedAt) ||
        left.bundleId.localeCompare(right.bundleId),
    );

  return [
    ...exact.map(
      (candidate): HybridResult => ({
        bundleId: candidate.bundleId,
        ...(candidate.passageId === undefined ? {} : { passageId: candidate.passageId }),
        match: candidate.reason,
        score: candidate.keywordScore,
        capturedAt: candidate.capturedAt,
      }),
    ),
    ...fused.map(
      ({ providerCount: _providerCount, bestRank: _bestRank, ...candidate }) => candidate,
    ),
  ];
}

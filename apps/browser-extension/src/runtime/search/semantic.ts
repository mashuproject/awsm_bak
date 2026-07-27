import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { sha256 } from "../../domain/hash";
import type { EmbeddingProviderIdentity } from "./contracts";
import type { SearchDocument } from "./documents";
import { type KeywordFilters, matchesSearchFilters } from "./keyword";

export interface QuantizedVector {
  readonly dimensions: number;
  readonly scale: number;
  readonly values: Uint8Array;
}

export interface PassageEmbedding {
  readonly passageId: string;
  readonly passageOrdinal: number;
  readonly vector: Float32Array;
}

export interface SearchSemanticVector {
  readonly version: 1;
  readonly dimensions: number;
  readonly scale: number;
  readonly values: Uint8Array;
}

export interface SearchSemanticCapture {
  readonly version: 1;
  readonly bundleId: string;
  readonly collectionId: string;
  readonly status: "Active" | "Deleted";
  readonly host: string;
  readonly capturedAt: string;
  readonly sourceRevision: string;
  readonly providerIdentityHash: string;
  readonly centroids: readonly {
    readonly passageId: string;
    readonly passageOrdinal: number;
    readonly vector: SearchSemanticVector;
  }[];
}

export interface SearchSemanticPassages {
  readonly version: 1;
  readonly bundleId: string;
  readonly sourceRevision: string;
  readonly providerIdentityHash: string;
  readonly passages: readonly {
    readonly passageId: string;
    readonly passageOrdinal: number;
    readonly vector: SearchSemanticVector;
  }[];
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function providerIdentityHash(identity: EmbeddingProviderIdentity): Promise<string> {
  return hex(await sha256(encodeCanonicalCbor(identity)));
}

function finiteVector(value: readonly number[] | Float32Array): Float64Array {
  if (value.length === 0 || value.length > 4_096) {
    throw new DomainValidationError("embedding", "must contain 1 through 4,096 dimensions");
  }
  const output = Float64Array.from(value);
  if (output.some((component) => !Number.isFinite(component))) {
    throw new DomainValidationError("embedding", "must contain only finite numbers");
  }
  return output;
}

export function normalizeEmbedding(value: readonly number[] | Float32Array): Float32Array {
  const input = finiteVector(value);
  const squaredNorm = input.reduce((total, component) => total + component * component, 0);
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new DomainValidationError("embedding", "must have a finite non-zero norm");
  }
  return Float32Array.from(input, (component) => component / norm);
}

function roundTiesAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function quantizeEmbedding(value: Float32Array): QuantizedVector {
  const input = finiteVector(value);
  const maximum = input.reduce((current, component) => Math.max(current, Math.abs(component)), 0);
  if (maximum === 0) {
    throw new DomainValidationError("embedding", "must have a non-zero component");
  }
  const scale = maximum / 127;
  const signed = Int8Array.from(input, (component) =>
    Math.max(-127, Math.min(127, roundTiesAwayFromZero(component / scale))),
  );
  return {
    dimensions: signed.length,
    scale,
    values: Uint8Array.from(signed, (component) => component & 0xff),
  };
}

function floatCosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) {
    throw new DomainValidationError("embedding", "dimensions must match");
  }
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftSquared) * Math.sqrt(rightSquared);
  if (!Number.isFinite(denominator) || denominator === 0) {
    throw new DomainValidationError("embedding", "must have a finite non-zero norm");
  }
  return dot / denominator;
}

export function cosineSimilarity(query: Float32Array, stored: QuantizedVector): number {
  if (
    stored.dimensions !== stored.values.byteLength ||
    stored.dimensions !== query.length ||
    !Number.isFinite(stored.scale) ||
    stored.scale <= 0
  ) {
    throw new DomainValidationError("embedding", "contains an invalid quantized vector");
  }
  const signed = new Int8Array(
    stored.values.buffer,
    stored.values.byteOffset,
    stored.values.byteLength,
  );
  let dot = 0;
  let storedSquared = 0;
  for (let index = 0; index < query.length; index += 1) {
    const storedValue = (signed[index] ?? 0) * stored.scale;
    dot += (query[index] ?? 0) * storedValue;
    storedSquared += storedValue * storedValue;
  }
  const norm = Math.sqrt(storedSquared);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new DomainValidationError("embedding", "contains a zero or non-finite stored norm");
  }
  return dot / norm;
}

export function selectCaptureCentroids(
  passages: readonly PassageEmbedding[],
): readonly PassageEmbedding[] {
  if (passages.length === 0) return [];
  const ordered = [...passages].sort(
    (left, right) =>
      left.passageOrdinal - right.passageOrdinal || left.passageId.localeCompare(right.passageId),
  );
  if (ordered[0]?.passageOrdinal !== 0) {
    throw new DomainValidationError("semantic.passages", "must begin at passage ordinal zero");
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const passage = ordered[index];
    if (
      passage === undefined ||
      passage.passageOrdinal !== index ||
      ordered.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index && candidate.passageId === passage.passageId,
      )
    ) {
      throw new DomainValidationError("semantic.passages", "must have unique contiguous passages");
    }
    finiteVector(passage.vector);
  }

  const selected = [ordered[0]];
  const remaining = ordered.slice(1);
  while (selected.length < 4 && remaining.length > 0) {
    let choiceIndex = 0;
    let choiceSimilarity = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate === undefined) continue;
      const maximumSimilarity = Math.max(
        ...selected.map((centroid) => floatCosine(candidate.vector, centroid.vector)),
      );
      if (
        maximumSimilarity < choiceSimilarity ||
        (maximumSimilarity === choiceSimilarity &&
          candidate.passageOrdinal < (remaining[choiceIndex]?.passageOrdinal ?? Infinity))
      ) {
        choiceIndex = index;
        choiceSimilarity = maximumSimilarity;
      }
    }
    const [choice] = remaining.splice(choiceIndex, 1);
    if (choice !== undefined) selected.push(choice);
  }
  return selected;
}

function storedVector(vector: Float32Array): SearchSemanticVector {
  return { version: 1, ...quantizeEmbedding(vector) };
}

export function buildSemanticMaterializations(input: {
  readonly document: SearchDocument;
  readonly providerIdentityHash: string;
  readonly embeddings: readonly PassageEmbedding[];
}): { readonly capture: SearchSemanticCapture; readonly passages: SearchSemanticPassages } {
  if (!/^[0-9a-f]{64}$/u.test(input.providerIdentityHash))
    throw new DomainValidationError(
      "semantic.providerIdentityHash",
      "must be a lowercase SHA-256 digest",
    );
  if (
    input.embeddings.length !== input.document.passages.length ||
    input.embeddings.some(
      (embedding, index) =>
        embedding.passageOrdinal !== index ||
        embedding.passageId !== input.document.passages[index]?.passageId,
    )
  )
    throw new DomainValidationError(
      "semantic.embeddings",
      "must cover every document passage in order",
    );
  const normalized = input.embeddings.map((embedding) => ({
    ...embedding,
    vector: normalizeEmbedding(embedding.vector),
  }));
  const passages = normalized.map(({ passageId, passageOrdinal, vector }) => ({
    passageId,
    passageOrdinal,
    vector: storedVector(vector),
  }));
  const centroids = selectCaptureCentroids(normalized).map(
    ({ passageId, passageOrdinal, vector }) => ({
      passageId,
      passageOrdinal,
      vector: storedVector(vector),
    }),
  );
  return {
    capture: {
      version: 1,
      bundleId: input.document.bundleId,
      collectionId: input.document.collectionId,
      status: input.document.status,
      host: input.document.host,
      capturedAt: input.document.capturedAt,
      sourceRevision: input.document.sourceRevision,
      providerIdentityHash: input.providerIdentityHash,
      centroids,
    },
    passages: {
      version: 1,
      bundleId: input.document.bundleId,
      sourceRevision: input.document.sourceRevision,
      providerIdentityHash: input.providerIdentityHash,
      passages,
    },
  };
}

export interface SemanticRankCandidate {
  readonly bundleId: string;
  readonly passageId: string;
  readonly score: number;
  readonly capturedAt: string;
}

interface CentroidCandidate {
  readonly capture: SearchSemanticCapture;
  readonly score: number;
}

function centroidOrder(left: CentroidCandidate, right: CentroidCandidate): number {
  return (
    right.score - left.score ||
    right.capture.capturedAt.localeCompare(left.capture.capturedAt) ||
    left.capture.bundleId.localeCompare(right.capture.bundleId)
  );
}

export class SemanticCentroidCollector {
  private candidates: CentroidCandidate[] = [];

  constructor(
    private readonly input: {
      readonly query: Float32Array;
      readonly providerIdentityHash: string;
      readonly filters: KeywordFilters;
    },
  ) {}

  add(batch: readonly SearchSemanticCapture[]): void {
    const additions = batch
      .filter(
        (capture) =>
          capture.providerIdentityHash === this.input.providerIdentityHash &&
          matchesSearchFilters(capture, this.input.filters),
      )
      .map((capture) => ({
        capture,
        score: Math.max(
          ...capture.centroids.map(({ vector }) => cosineSimilarity(this.input.query, vector)),
        ),
      }));
    this.candidates = [...this.candidates, ...additions].sort(centroidOrder).slice(0, 100);
  }

  captures(): readonly SearchSemanticCapture[] {
    return this.candidates.map(({ capture }) => capture);
  }
}

export function rankSemanticCandidates(input: {
  readonly query: Float32Array;
  readonly captures: readonly SearchSemanticCapture[];
  readonly passages: ReadonlyMap<string, SearchSemanticPassages>;
  readonly providerIdentityHash?: string;
  readonly filters?: KeywordFilters;
}): readonly SemanticRankCandidate[] {
  const centroidCandidates = input.captures
    .filter(
      (capture) =>
        (input.providerIdentityHash === undefined ||
          capture.providerIdentityHash === input.providerIdentityHash) &&
        (input.filters === undefined || matchesSearchFilters(capture, input.filters)),
    )
    .map((capture) => ({
      capture,
      score: Math.max(
        ...capture.centroids.map(({ vector }) => cosineSimilarity(input.query, vector)),
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.capture.capturedAt.localeCompare(left.capture.capturedAt) ||
        left.capture.bundleId.localeCompare(right.capture.bundleId),
    )
    .slice(0, 100);
  return centroidCandidates
    .map(({ capture }): SemanticRankCandidate => {
      const passageRow = input.passages.get(capture.bundleId);
      if (
        passageRow === undefined ||
        passageRow.sourceRevision !== capture.sourceRevision ||
        passageRow.providerIdentityHash !== capture.providerIdentityHash
      )
        throw new DomainValidationError(
          "semantic.passages",
          "do not match their Capture materialization",
        );
      const ranked = passageRow.passages
        .map((passage) => ({
          passage,
          score: cosineSimilarity(input.query, passage.vector),
        }))
        .sort(
          (left, right) =>
            right.score - left.score || left.passage.passageOrdinal - right.passage.passageOrdinal,
        );
      const best = ranked[0];
      if (best === undefined)
        throw new DomainValidationError("semantic.passages", "must not be empty");
      return {
        bundleId: capture.bundleId,
        passageId: best.passage.passageId,
        score: best.score,
        capturedAt: capture.capturedAt,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.capturedAt.localeCompare(left.capturedAt) ||
        left.bundleId.localeCompare(right.bundleId),
    );
}

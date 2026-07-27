import { DomainValidationError } from "../../../domain/errors";

const CONTENT_TOKENS_PER_WINDOW = 254;
const DOCUMENT_OVERLAP_TOKENS = 32;

export function splitContentTokenIds(
  tokenIds: readonly number[],
  purpose: "Document" | "Query",
): readonly (readonly number[])[] {
  if (tokenIds.some((tokenId) => !Number.isSafeInteger(tokenId) || tokenId < 0))
    throw new DomainValidationError("localModel.tokenIds", "must be nonnegative integers");
  if (tokenIds.length === 0) return [[]];
  const overlap = purpose === "Document" ? DOCUMENT_OVERLAP_TOKENS : 0;
  const stride = CONTENT_TOKENS_PER_WINDOW - overlap;
  const windows: number[][] = [];
  for (let start = 0; start < tokenIds.length; start += stride) {
    windows.push(tokenIds.slice(start, start + CONTENT_TOKENS_PER_WINDOW));
    if (start + CONTENT_TOKENS_PER_WINDOW >= tokenIds.length) break;
  }
  return windows;
}

function normalize(values: Iterable<number>, field: string): Float32Array {
  const components = [...values];
  let squaredNorm = 0;
  for (const value of components) {
    if (!Number.isFinite(value))
      throw new DomainValidationError(field, "must contain only finite values");
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0)
    throw new DomainValidationError(field, "must have a finite non-zero norm");
  return Float32Array.from(components, (value) => value / norm);
}

export function meanPoolLastHiddenState(input: {
  readonly lastHiddenState: Float32Array;
  readonly attentionMask: Uint8Array;
  readonly tokenCount: number;
  readonly dimensions: number;
}): Float32Array {
  if (
    !Number.isSafeInteger(input.tokenCount) ||
    input.tokenCount <= 0 ||
    !Number.isSafeInteger(input.dimensions) ||
    input.dimensions <= 0 ||
    input.attentionMask.length !== input.tokenCount ||
    input.lastHiddenState.length !== input.tokenCount * input.dimensions
  )
    throw new DomainValidationError("localModel.output", "has incompatible tensor dimensions");
  const totals = new Float64Array(input.dimensions);
  let includedTokens = 0;
  for (let token = 0; token < input.tokenCount; token += 1) {
    const mask = input.attentionMask[token];
    if (mask !== 0 && mask !== 1)
      throw new DomainValidationError("localModel.attentionMask", "must be binary");
    if (mask === 0) continue;
    includedTokens += 1;
    for (let dimension = 0; dimension < input.dimensions; dimension += 1) {
      const value = input.lastHiddenState[token * input.dimensions + dimension];
      if (value === undefined || !Number.isFinite(value))
        throw new DomainValidationError("localModel.output", "contains a non-finite value");
      totals[dimension] = (totals[dimension] ?? 0) + value;
    }
  }
  if (includedTokens === 0)
    throw new DomainValidationError("localModel.attentionMask", "selects no tokens");
  return normalize(
    Array.from(totals, (total) => total / includedTokens),
    "localModel.pooledOutput",
  );
}

export function combineWindowEmbeddings(windows: readonly Float32Array[]): Float32Array {
  const dimensions = windows[0]?.length ?? 0;
  if (windows.length === 0 || dimensions === 0)
    throw new DomainValidationError("localModel.windows", "must not be empty");
  const totals = new Float64Array(dimensions);
  for (const window of windows) {
    if (window.length !== dimensions)
      throw new DomainValidationError("localModel.windows", "must use one embedding dimension");
    const normalized = normalize(window, "localModel.window");
    for (let dimension = 0; dimension < dimensions; dimension += 1)
      totals[dimension] = (totals[dimension] ?? 0) + (normalized[dimension] ?? 0);
  }
  return normalize(
    Array.from(totals, (total) => total / windows.length),
    "localModel.combinedOutput",
  );
}

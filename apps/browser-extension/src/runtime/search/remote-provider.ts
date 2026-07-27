import { DomainValidationError } from "../../domain/errors";
import type { EmbeddingProvider, EmbeddingProviderIdentity } from "./contracts";
import { normalizeRemoteSearchEndpoint, remoteSearchEndpointPathHash } from "./remote-endpoint";
import { normalizeEmbedding } from "./semantic";

export const OPENAI_COMPATIBILITY_PROBE = "AWSM embedding compatibility test.";

const MAX_BATCH_ITEMS = 32;
const MAX_INPUT_BYTES = 24 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const MAX_RETRY_DELAY_MS = 5 * 60_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class RemoteEmbeddingProviderError extends Error {
  readonly id:
    | "SEARCH_PROVIDER_UNAVAILABLE"
    | "SEARCH_PROVIDER_RESPONSE_INVALID"
    | "SEARCH_PROVIDER_DIMENSION_CHANGED";
  readonly status?: number;
  readonly retryAfter?: string;

  constructor(
    id: RemoteEmbeddingProviderError["id"],
    message: string,
    details?: { readonly status?: number; readonly retryAfter?: string },
  ) {
    super(message);
    this.name = "RemoteEmbeddingProviderError";
    this.id = id;
    if (details?.status !== undefined) this.status = details.status;
    if (details?.retryAfter !== undefined) this.retryAfter = details.retryAfter;
  }
}

function retryAfterDelay(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000));
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, timestamp - now));
}

export function remoteEmbeddingRetryDelay(input: {
  readonly error: RemoteEmbeddingProviderError;
  readonly attempt: number;
  readonly now: number;
  readonly random: number;
}): number | undefined {
  const { status } = input.error;
  if (status !== undefined && status !== 408 && status !== 429 && (status < 500 || status > 599))
    return undefined;
  if (
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 0 ||
    input.random < 0 ||
    input.random >= 1
  )
    throw new DomainValidationError("remoteEmbeddingRetry", "has invalid inputs");
  const cap = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** input.attempt);
  const jitter = Math.floor(input.random * (cap + 1));
  const retryAfter = retryAfterDelay(input.error.retryAfter, input.now);
  return retryAfter === undefined ? jitter : Math.max(jitter, retryAfter);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const complete = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainValidationError(field, "must be an object");
  }
  const input = Object.fromEntries(Object.entries(value));
  const allowed = new Set(keys);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new DomainValidationError(field, "contains fields outside the supported contract");
  }
  return input;
}

function positiveCounter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainValidationError(field, "must be a nonnegative safe integer");
  }
  return value;
}

function validateUsage(value: unknown): void {
  if (value === undefined) return;
  const usage = record(value, "embeddingResponse.usage", ["prompt_tokens", "total_tokens"]);
  if (usage.prompt_tokens !== undefined)
    positiveCounter(usage.prompt_tokens, "embeddingResponse.usage.prompt_tokens");
  if (usage.total_tokens !== undefined)
    positiveCounter(usage.total_tokens, "embeddingResponse.usage.total_tokens");
}

function parseEmbeddingResponse(
  value: unknown,
  expectedItems: number,
  expectedModel?: string,
  expectedDimensions?: number,
): {
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: readonly Float32Array[];
} {
  const input = record(value, "embeddingResponse", ["object", "data", "model", "usage"]);
  if (input.object !== "list") {
    throw new DomainValidationError("embeddingResponse.object", "must equal list");
  }
  if (typeof input.model !== "string" || input.model.length === 0) {
    throw new DomainValidationError("embeddingResponse.model", "must be a non-empty string");
  }
  if (expectedModel !== undefined && input.model !== expectedModel) {
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_RESPONSE_INVALID",
      "The embedding provider changed its response model.",
    );
  }
  if (!Array.isArray(input.data) || input.data.length !== expectedItems) {
    throw new DomainValidationError(
      "embeddingResponse.data",
      "must contain exactly one item per input",
    );
  }
  validateUsage(input.usage);
  const vectors = new Array<Float32Array | undefined>(expectedItems);
  let dimensions: number | undefined;
  for (let offset = 0; offset < input.data.length; offset += 1) {
    const item = record(input.data[offset], `embeddingResponse.data.${offset}`, [
      "object",
      "embedding",
      "index",
    ]);
    if (item.object !== "embedding") {
      throw new DomainValidationError(
        `embeddingResponse.data.${offset}.object`,
        "must equal embedding",
      );
    }
    if (
      typeof item.index !== "number" ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= expectedItems ||
      vectors[item.index] !== undefined
    ) {
      throw new DomainValidationError(
        `embeddingResponse.data.${offset}.index`,
        "must be unique and in range",
      );
    }
    if (!Array.isArray(item.embedding)) {
      throw new DomainValidationError(
        `embeddingResponse.data.${offset}.embedding`,
        "must be a dense number array",
      );
    }
    const vector = normalizeEmbedding(
      item.embedding.map((component, index) => {
        if (typeof component !== "number" || !Number.isFinite(component)) {
          throw new DomainValidationError(
            `embeddingResponse.data.${offset}.embedding.${index}`,
            "must be finite",
          );
        }
        return component;
      }),
    );
    dimensions ??= vector.length;
    if (vector.length !== dimensions) {
      throw new DomainValidationError(
        `embeddingResponse.data.${offset}.embedding`,
        "must use stable dimensions",
      );
    }
    vectors[item.index] = vector;
  }
  if (dimensions === undefined || vectors.some((vector) => vector === undefined)) {
    throw new DomainValidationError("embeddingResponse.data", "contains a missing embedding");
  }
  if (expectedDimensions !== undefined && dimensions !== expectedDimensions) {
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_DIMENSION_CHANGED",
      "The embedding provider changed its vector dimensions.",
    );
  }
  return {
    model: input.model,
    dimensions,
    vectors: vectors as readonly Float32Array[],
  };
}

async function requestEmbeddings(input: {
  readonly endpoint: string;
  readonly requestModel: string;
  readonly expectedModel?: string;
  readonly dimensions?: number;
  readonly apiKey: string;
  readonly texts: readonly string[];
  readonly signal: AbortSignal;
  readonly fetcher: Fetcher;
}): Promise<{
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: readonly Float32Array[];
}> {
  const endpoint = normalizeRemoteSearchEndpoint(input.endpoint);
  if (endpoint !== input.endpoint)
    throw new DomainValidationError("embeddingRequest.endpoint", "must be normalized");
  if (
    input.texts.length === 0 ||
    input.texts.length > MAX_BATCH_ITEMS ||
    input.texts.some((text) => text.length === 0) ||
    encoder.encode(input.texts.join("")).byteLength > MAX_INPUT_BYTES
  ) {
    throw new DomainValidationError("embeddingRequest.input", "exceeds the fixed batch limits");
  }
  let response: Response;
  try {
    response = await input.fetcher(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: input.requestModel,
        input: input.texts,
        encoding_format: "float",
        ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
      }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: input.signal,
    });
  } catch {
    input.signal.throwIfAborted();
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_UNAVAILABLE",
      "The embedding provider could not be reached.",
    );
  }
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_UNAVAILABLE",
      `The embedding provider returned HTTP ${String(response.status)}.`,
      {
        status: response.status,
        ...(retryAfter === null ? {} : { retryAfter }),
      },
    );
  }
  if (
    !response.headers.get("content-type")?.toLocaleLowerCase("en-US").includes("application/json")
  ) {
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_RESPONSE_INVALID",
      "The embedding provider did not return JSON.",
    );
  }
  const text = await response.text();
  if (encoder.encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_RESPONSE_INVALID",
      "The embedding provider response exceeded the size limit.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_RESPONSE_INVALID",
      "The embedding provider returned invalid JSON.",
    );
  }
  try {
    return parseEmbeddingResponse(
      parsed,
      input.texts.length,
      input.expectedModel,
      input.dimensions,
    );
  } catch (error) {
    if (error instanceof RemoteEmbeddingProviderError) throw error;
    throw new RemoteEmbeddingProviderError(
      "SEARCH_PROVIDER_RESPONSE_INVALID",
      "The embedding provider returned an unsupported response.",
    );
  }
}

export interface OpenAiCompatibleEmbeddingProviderInput {
  readonly endpoint: string;
  readonly requestModel: string;
  readonly responseModel: string;
  readonly dimensions: number;
  readonly endpointPathHash: string;
  readonly apiKey: string;
  readonly fetcher?: Fetcher;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly maximumBatchItems = MAX_BATCH_ITEMS;
  readonly maximumInputBytes = MAX_INPUT_BYTES;
  readonly identity: EmbeddingProviderIdentity;
  private apiKey: string;
  private readonly endpoint: string;
  private readonly requestModel: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(input: OpenAiCompatibleEmbeddingProviderInput) {
    if (!SHA256_PATTERN.test(input.endpointPathHash)) {
      throw new DomainValidationError(
        "remoteEmbeddingProvider.endpointPathHash",
        "must be a lowercase SHA-256 digest",
      );
    }
    const normalizedEndpoint = normalizeRemoteSearchEndpoint(input.endpoint);
    if (normalizedEndpoint !== input.endpoint)
      throw new DomainValidationError("remoteEmbeddingProvider.endpoint", "must be normalized");
    if (remoteSearchEndpointPathHash(normalizedEndpoint) !== input.endpointPathHash)
      throw new DomainValidationError(
        "remoteEmbeddingProvider.endpointPathHash",
        "does not match the exact endpoint path",
      );
    const endpoint = new URL(normalizedEndpoint);
    this.identity = {
      version: 1,
      kind: "RemoteOpenAiCompatible",
      endpointOrigin: endpoint.origin,
      endpointPathHash: input.endpointPathHash,
      model: input.responseModel,
      dimensions: input.dimensions,
      pooling: "Mean",
      normalized: true,
    };
    this.endpoint = normalizedEndpoint;
    this.requestModel = input.requestModel;
    this.apiKey = input.apiKey;
    this.fetcher = input.fetcher ?? fetch;
    this.now = input.now ?? Date.now;
    this.random = input.random ?? Math.random;
    this.sleep = input.sleep ?? defaultSleep;
  }

  async embed(input: {
    readonly purpose: "Document" | "Query" | "Probe";
    readonly texts: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<readonly Float32Array[]> {
    if (this.apiKey.length === 0) {
      throw new RemoteEmbeddingProviderError(
        "SEARCH_PROVIDER_UNAVAILABLE",
        "The embedding provider was disposed.",
      );
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (
          await requestEmbeddings({
            endpoint: this.endpoint,
            requestModel: this.requestModel,
            expectedModel: this.identity.model,
            dimensions: this.identity.dimensions,
            apiKey: this.apiKey,
            texts: input.texts,
            signal: input.signal,
            fetcher: this.fetcher,
          })
        ).vectors;
      } catch (error) {
        if (
          input.purpose !== "Document" ||
          attempt >= 4 ||
          !(error instanceof RemoteEmbeddingProviderError)
        )
          throw error;
        const delay = remoteEmbeddingRetryDelay({
          error,
          attempt,
          now: this.now(),
          random: this.random(),
        });
        if (delay === undefined) throw error;
        await this.sleep(delay, input.signal);
      }
    }
  }

  async dispose(): Promise<void> {
    this.apiKey = "";
  }
}

export async function probeOpenAiCompatibleEmbeddingProvider(input: {
  readonly endpoint: string;
  readonly model: string;
  readonly dimensions?: number;
  readonly apiKey: string;
  readonly fetcher?: Fetcher;
  readonly signal: AbortSignal;
}): Promise<{ readonly responseModel: string; readonly effectiveDimensions: number }> {
  const result = await requestEmbeddings({
    endpoint: input.endpoint,
    requestModel: input.model,
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
    apiKey: input.apiKey,
    texts: [OPENAI_COMPATIBILITY_PROBE],
    signal: input.signal,
    fetcher: input.fetcher ?? fetch,
  });
  return {
    responseModel: result.model,
    effectiveDimensions: result.dimensions,
  };
}

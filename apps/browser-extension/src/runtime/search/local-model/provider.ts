import { DomainValidationError } from "../../../domain/errors";
import type { EmbeddingProvider, EmbeddingProviderIdentity } from "../contracts";
import type { CacheStorageLocalModelStore } from "./cache-store";
import { LOCAL_MINILM_MANIFEST, type LocalMiniLmManifest, localModelFileUrl } from "./manifest";
import { combineWindowEmbeddings, meanPoolLastHiddenState, splitContentTokenIds } from "./math";

const MAX_BATCH_ITEMS = 8;
const MAX_INPUT_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export interface LocalMiniLmInference {
  readonly lastHiddenState: Float32Array;
  readonly attentionMask: Uint8Array;
  readonly tokenCount: number;
  readonly dimensions: number;
}

export interface LocalMiniLmEngine {
  encodeWithoutSpecialTokens(text: string): readonly number[];
  infer(contentTokenIds: readonly number[]): Promise<LocalMiniLmInference>;
  dispose(): Promise<void>;
}

export interface VerifiedModelFileStore {
  file(path: string): Promise<Response | undefined>;
}

interface TransformersCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
}

export function verifiedModelCache(
  store: VerifiedModelFileStore,
  manifest: LocalMiniLmManifest = LOCAL_MINILM_MANIFEST,
): TransformersCache {
  const paths = new Map<string, string>();
  for (const file of manifest.files) {
    paths.set(localModelFileUrl(file.path), file.path);
    paths.set(`/models/${manifest.model}/${file.path}`, file.path);
  }
  return {
    async match(request) {
      const url =
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const path = paths.get(url);
      if (path === undefined) return undefined;
      return (await store.file(path))?.clone();
    },
    async put() {
      throw new Error("The verified local model cache is read-only.");
    },
  };
}

export type LocalMiniLmEngineLoader = (input: {
  readonly manifest: LocalMiniLmManifest;
}) => Promise<LocalMiniLmEngine>;

export class LocalMiniLmEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingProviderIdentity;
  readonly maximumBatchItems = MAX_BATCH_ITEMS;
  readonly maximumInputBytes = MAX_INPUT_BYTES;
  private enginePromise?: Promise<LocalMiniLmEngine>;
  private disposed = false;

  constructor(
    private readonly input: {
      readonly load: LocalMiniLmEngineLoader;
      readonly manifest?: LocalMiniLmManifest;
    },
  ) {
    const manifest = input.manifest ?? LOCAL_MINILM_MANIFEST;
    this.identity = {
      version: 1,
      kind: "LocalMiniLm",
      model: manifest.model,
      modelRevision: manifest.revision,
      dimensions: manifest.dimensions,
      pooling: "Mean",
      normalized: true,
    };
  }

  private engine(): Promise<LocalMiniLmEngine> {
    if (this.disposed)
      throw new DomainValidationError("localModel.provider", "has already been disposed");
    this.enginePromise ??= this.input.load({
      manifest: this.input.manifest ?? LOCAL_MINILM_MANIFEST,
    });
    return this.enginePromise;
  }

  async embed(input: {
    readonly purpose: "Document" | "Query" | "Probe";
    readonly texts: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<readonly Float32Array[]> {
    if (
      input.texts.length === 0 ||
      input.texts.length > this.maximumBatchItems ||
      input.texts.some((text) => text.length === 0) ||
      encoder.encode(input.texts.join("")).byteLength > this.maximumInputBytes
    )
      throw new DomainValidationError("localModel.input", "exceeds the fixed batch limits");
    input.signal.throwIfAborted();
    const engine = await this.engine();
    const purpose = input.purpose === "Document" ? "Document" : "Query";
    const output: Float32Array[] = [];
    for (const text of input.texts) {
      input.signal.throwIfAborted();
      const tokenIds = engine.encodeWithoutSpecialTokens(text);
      const windows = splitContentTokenIds(tokenIds, purpose);
      const embeddings: Float32Array[] = [];
      for (const window of windows) {
        input.signal.throwIfAborted();
        const inferred = await engine.infer(window);
        input.signal.throwIfAborted();
        if (inferred.dimensions !== this.identity.dimensions)
          throw new DomainValidationError(
            "localModel.output",
            "does not match the declared embedding dimensions",
          );
        embeddings.push(meanPoolLastHiddenState(inferred));
      }
      output.push(combineWindowEmbeddings(embeddings));
    }
    return output;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.enginePromise !== undefined) await (await this.enginePromise).dispose();
  }
}

export function localMiniLmProvider(
  store: CacheStorageLocalModelStore,
  runtime: { readonly factoryUrl: string; readonly wasmUrl: string },
): LocalMiniLmEmbeddingProvider {
  return new LocalMiniLmEmbeddingProvider({
    load: async ({ manifest }) => {
      const transformers = await import("@huggingface/transformers");
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = false;
      transformers.env.useBrowserCache = false;
      transformers.env.useFSCache = false;
      transformers.env.useCustomCache = true;
      transformers.env.useWasmCache = false;
      transformers.env.customCache = verifiedModelCache(store, manifest);
      transformers.env.fetch = async () => {
        throw new Error("Network access is disabled during local model inference.");
      };
      const wasmEnvironment = transformers.env.backends.onnx.wasm;
      if (wasmEnvironment === undefined)
        throw new DomainValidationError("localModel.runtime", "does not expose the WASM backend");
      wasmEnvironment.wasmPaths = {
        mjs: runtime.factoryUrl,
        wasm: runtime.wasmUrl,
      };
      const options = {
        revision: manifest.revision,
        local_files_only: true,
      } as const;
      const [tokenizer, model] = await Promise.all([
        transformers.AutoTokenizer.from_pretrained(manifest.model, options),
        transformers.AutoModel.from_pretrained(manifest.model, {
          ...options,
          device: "wasm",
          dtype: manifest.dtype,
          model_file_name: "model",
        }),
      ]);
      const clsTokenId = tokenizer.convert_tokens_to_ids("[CLS]");
      const sepTokenId = tokenizer.sep_token_id;
      if (!Number.isSafeInteger(clsTokenId) || !Number.isSafeInteger(sepTokenId))
        throw new DomainValidationError(
          "localModel.tokenizer",
          "does not define BERT special tokens",
        );
      return {
        encodeWithoutSpecialTokens: (text) => tokenizer.encode(text, { add_special_tokens: false }),
        async infer(contentTokenIds) {
          const inputIds = [clsTokenId, ...contentTokenIds, sepTokenId];
          const attentionMask = new Uint8Array(inputIds.length).fill(1);
          const shape = [1, inputIds.length];
          const result = await model({
            input_ids: new transformers.Tensor(
              "int64",
              BigInt64Array.from(inputIds, BigInt),
              shape,
            ),
            attention_mask: new transformers.Tensor(
              "int64",
              BigInt64Array.from(attentionMask, BigInt),
              shape,
            ),
            token_type_ids: new transformers.Tensor(
              "int64",
              new BigInt64Array(inputIds.length),
              shape,
            ),
          });
          const hidden = result.last_hidden_state;
          if (
            hidden === undefined ||
            hidden.dims.length !== 3 ||
            hidden.dims[0] !== 1 ||
            !(hidden.data instanceof Float32Array)
          )
            throw new DomainValidationError(
              "localModel.output",
              "does not contain a supported hidden-state tensor",
            );
          return {
            lastHiddenState: Float32Array.from(hidden.data),
            attentionMask,
            tokenCount: hidden.dims[1] ?? 0,
            dimensions: hidden.dims[2] ?? 0,
          };
        },
        async dispose() {
          await model.dispose();
        },
      };
    },
  });
}

import { DomainValidationError } from "../../../domain/errors";
import {
  LOCAL_MINILM_MANIFEST,
  type LocalMiniLmManifest,
  validateLocalModelResponseUrl,
  verifyLocalModelFileStream,
} from "./manifest";

export interface LocalModelGenerationPointer {
  readonly manifestId: string;
  readonly generationName: string;
}

export interface LocalModelGenerationStore {
  putFile(generationName: string, path: string, response: Response): Promise<void>;
  deleteFile(generationName: string, path: string): Promise<void>;
  promote(manifestId: string, generationName: string): Promise<void>;
  current(): Promise<LocalModelGenerationPointer | undefined>;
  deleteGeneration(generationName: string): Promise<void>;
}

export interface LocalModelDownloadProgress {
  readonly completedBytes: number;
  readonly totalBytes: number;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

function validateManifest(manifest: LocalMiniLmManifest): void {
  if (
    manifest.files.length === 0 ||
    new Set(manifest.files.map(({ path }) => path)).size !== manifest.files.length ||
    manifest.files.reduce((total, file) => total + file.bytes, 0) !== manifest.totalBytes
  )
    throw new DomainValidationError("localModel.manifest", "is internally inconsistent");
}

function modelUrl(manifest: LocalMiniLmManifest, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}/${encodedPath}`;
}

function generationName(manifestId: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(manifestId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(id))
    throw new DomainValidationError("localModel.generation", "has an invalid identifier");
  return `awsm-search-model-${manifestId}-${id}`;
}

export class LocalModelDownloader {
  private readonly store: LocalModelGenerationStore;
  private readonly fetcher: Fetcher;
  private readonly manifest: LocalMiniLmManifest;
  private readonly createGenerationId: () => string;

  constructor(input: {
    readonly store: LocalModelGenerationStore;
    readonly fetcher?: Fetcher;
    readonly manifest?: LocalMiniLmManifest;
    readonly createGenerationId?: () => string;
  }) {
    this.store = input.store;
    this.fetcher = input.fetcher ?? fetch;
    this.manifest = input.manifest ?? LOCAL_MINILM_MANIFEST;
    this.createGenerationId = input.createGenerationId ?? (() => crypto.randomUUID());
    validateManifest(this.manifest);
  }

  async download(input: {
    readonly signal: AbortSignal;
    readonly onProgress: (progress: LocalModelDownloadProgress) => void;
  }): Promise<{
    readonly manifestId: string;
    readonly completedBytes: number;
    readonly totalBytes: number;
  }> {
    input.signal.throwIfAborted();
    const temporaryGeneration = generationName(this.manifest.manifestId, this.createGenerationId());
    const prior = await this.store.current();
    let completedBeforeFile = 0;
    try {
      for (const file of this.manifest.files) {
        input.signal.throwIfAborted();
        const response = await this.fetcher(modelUrl(this.manifest, file.path), {
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          redirect: "follow",
          referrerPolicy: "no-referrer",
          signal: input.signal,
        });
        if (!response.ok)
          throw new DomainValidationError(
            "localModel.response",
            `failed with HTTP status ${response.status}`,
          );
        validateLocalModelResponseUrl(response.url);
        const declaredLength = response.headers.get("content-length");
        if (
          declaredLength !== null &&
          (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) || Number(declaredLength) !== file.bytes)
        )
          throw new DomainValidationError(
            "localModel.response",
            "does not match the manifest byte budget",
          );
        if (response.body === null)
          throw new DomainValidationError("localModel.response", "has no response body");
        const [cacheBody, verificationBody] = response.body.tee();
        const safeHeaders = new Headers();
        const contentType = response.headers.get("content-type");
        if (contentType !== null) safeHeaders.set("content-type", contentType);
        safeHeaders.set("content-length", String(file.bytes));
        const cacheWrite = this.store.putFile(
          temporaryGeneration,
          file.path,
          new Response(cacheBody, { status: 200, headers: safeHeaders }),
        );
        try {
          await verifyLocalModelFileStream({
            file,
            stream: verificationBody,
            signal: input.signal,
            onChunk: async () => undefined,
            onProgress: (fileBytes) =>
              input.onProgress({
                completedBytes: completedBeforeFile + fileBytes,
                totalBytes: this.manifest.totalBytes,
              }),
          });
          await cacheWrite;
        } catch (error) {
          await cacheWrite.catch(() => undefined);
          await this.store.deleteFile(temporaryGeneration, file.path);
          throw error;
        }
        completedBeforeFile += file.bytes;
      }
      input.signal.throwIfAborted();
      await this.store.promote(this.manifest.manifestId, temporaryGeneration);
      if (prior !== undefined && prior.generationName !== temporaryGeneration)
        await this.store.deleteGeneration(prior.generationName);
      return {
        manifestId: this.manifest.manifestId,
        completedBytes: completedBeforeFile,
        totalBytes: this.manifest.totalBytes,
      };
    } catch (error) {
      await this.store.deleteGeneration(temporaryGeneration);
      throw error;
    }
  }
}

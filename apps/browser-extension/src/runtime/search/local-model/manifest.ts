import { sha256 } from "@noble/hashes/sha2.js";
import { DomainValidationError } from "../../../domain/errors";

export interface LocalModelFileManifest {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LocalMiniLmManifest {
  readonly manifestId: string;
  readonly model: "Xenova/all-MiniLM-L6-v2";
  readonly revision: "751bff37182d3f1213fa05d7196b954e230abad9";
  readonly dtype: "int8";
  readonly dimensions: 384;
  readonly maximumWordpieces: 256;
  readonly pooling: "Mean";
  readonly normalization: "L2";
  readonly language: "English";
  readonly license: "Apache-2.0";
  readonly totalBytes: number;
  readonly files: readonly LocalModelFileManifest[];
}

const files: readonly LocalModelFileManifest[] = [
  {
    path: "config.json",
    bytes: 650,
    sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  },
  {
    path: "special_tokens_map.json",
    bytes: 125,
    sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
  },
  {
    path: "tokenizer.json",
    bytes: 711_661,
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  },
  {
    path: "tokenizer_config.json",
    bytes: 366,
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  },
  {
    path: "vocab.txt",
    bytes: 231_508,
    sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
  },
  {
    path: "onnx/model_int8.onnx",
    bytes: 22_972_370,
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  },
];

export const LOCAL_MINILM_MANIFEST: LocalMiniLmManifest = {
  manifestId: "xenova-all-minilm-l6-v2-int8-751bff37182d3f1213fa05d7196b954e230abad9",
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dtype: "int8",
  dimensions: 384,
  maximumWordpieces: 256,
  pooling: "Mean",
  normalization: "L2",
  language: "English",
  license: "Apache-2.0",
  totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  files,
};

export function localModelFile(path: string): LocalModelFileManifest {
  const file = LOCAL_MINILM_MANIFEST.files.find((candidate) => candidate.path === path);
  if (file === undefined)
    throw new DomainValidationError("localModel.path", "is not declared by the manifest");
  return file;
}

export function localModelFileUrl(path: string): string {
  const file = localModelFile(path);
  const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${LOCAL_MINILM_MANIFEST.model}/resolve/${LOCAL_MINILM_MANIFEST.revision}/${encodedPath}`;
}

export function validateLocalModelResponseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainValidationError("localModel.responseUrl", "must be an absolute URL");
  }
  const hostAllowed = url.hostname === "huggingface.co" || url.hostname.endsWith(".hf.co");
  if (
    url.protocol !== "https:" ||
    !hostAllowed ||
    url.username.length > 0 ||
    url.password.length > 0
  )
    throw new DomainValidationError(
      "localModel.responseUrl",
      "is outside the permitted model hosts",
    );
  return url.href;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyLocalModelFileStream(input: {
  readonly file: LocalModelFileManifest;
  readonly stream: ReadableStream<Uint8Array>;
  readonly signal: AbortSignal;
  readonly onChunk: (chunk: Uint8Array) => Promise<void>;
  readonly onProgress: (completedBytes: number) => void;
}): Promise<number> {
  if (
    !Number.isSafeInteger(input.file.bytes) ||
    input.file.bytes < 0 ||
    !/^[0-9a-f]{64}$/u.test(input.file.sha256)
  )
    throw new DomainValidationError("localModel.file", "has an invalid integrity declaration");
  const reader = input.stream.getReader();
  const hasher = sha256.create();
  let completedBytes = 0;
  try {
    while (true) {
      input.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const chunk = Uint8Array.from(next.value);
      completedBytes += chunk.byteLength;
      if (completedBytes > input.file.bytes)
        throw new DomainValidationError("localModel.file", "exceeds its declared byte budget");
      hasher.update(chunk);
      await input.onChunk(chunk);
      input.onProgress(completedBytes);
    }
    input.signal.throwIfAborted();
    if (completedBytes !== input.file.bytes)
      throw new DomainValidationError("localModel.file", "is truncated");
    if (hex(hasher.digest()) !== input.file.sha256)
      throw new DomainValidationError("localModel.file", "failed SHA-256 verification");
    return completedBytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

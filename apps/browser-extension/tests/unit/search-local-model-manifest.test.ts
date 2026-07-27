import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MINILM_MANIFEST,
  localModelFile,
  localModelFileUrl,
  validateLocalModelResponseUrl,
  verifyLocalModelFileStream,
} from "../../src/runtime/search/local-model/manifest";

describe("local MiniLM manifest and streamed integrity", () => {
  it("pins the immutable model identity and exact six-file allowlist", () => {
    expect(LOCAL_MINILM_MANIFEST).toMatchObject({
      model: "Xenova/all-MiniLM-L6-v2",
      revision: "751bff37182d3f1213fa05d7196b954e230abad9",
      dtype: "int8",
      dimensions: 384,
      maximumWordpieces: 256,
      pooling: "Mean",
      normalization: "L2",
      language: "English",
      license: "Apache-2.0",
      totalBytes: 23_916_680,
    });
    expect(LOCAL_MINILM_MANIFEST.files).toEqual([
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
    ]);
    expect(localModelFileUrl("onnx/model_int8.onnx")).toBe(
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model_int8.onnx",
    );
    expect(() => localModelFile("../model.onnx")).toThrow();
  });

  it("verifies incrementally without buffering and reports exact progress", async () => {
    const chunks = [new TextEncoder().encode("a"), new TextEncoder().encode("bc")];
    const onChunk = vi.fn(async (_chunk: Uint8Array) => undefined);
    const onProgress = vi.fn((_bytes: number) => undefined);

    await expect(
      verifyLocalModelFileStream({
        file: {
          path: "fixture",
          bytes: 3,
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        signal: new AbortController().signal,
        onChunk,
        onProgress,
      }),
    ).resolves.toBe(3);
    expect(onChunk.mock.calls.map(([chunk]) => [...chunk])).toEqual([[97], [98, 99]]);
    expect(onProgress.mock.calls.map(([bytes]) => bytes)).toEqual([1, 3]);
  });

  it("rejects over-budget, truncated, corrupt, and cancelled streams", async () => {
    const stream = (value: string) => new Blob([value]).stream() as ReadableStream<Uint8Array>;
    const base = {
      signal: new AbortController().signal,
      onChunk: async () => undefined,
      onProgress: () => undefined,
    };
    await expect(
      verifyLocalModelFileStream({
        ...base,
        file: { path: "fixture", bytes: 2, sha256: "00".repeat(32) },
        stream: stream("abc"),
      }),
    ).rejects.toThrow();
    await expect(
      verifyLocalModelFileStream({
        ...base,
        file: { path: "fixture", bytes: 4, sha256: "00".repeat(32) },
        stream: stream("abc"),
      }),
    ).rejects.toThrow();
    await expect(
      verifyLocalModelFileStream({
        ...base,
        file: { path: "fixture", bytes: 3, sha256: "00".repeat(32) },
        stream: stream("abc"),
      }),
    ).rejects.toThrow();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      verifyLocalModelFileStream({
        ...base,
        signal: cancelled.signal,
        file: { path: "fixture", bytes: 3, sha256: "00".repeat(32) },
        stream: stream("abc"),
      }),
    ).rejects.toThrow(/abort/iu);
  });

  it("accepts only HTTPS responses on the two permitted model host patterns", () => {
    for (const url of [
      localModelFileUrl("config.json"),
      "https://cdn-lfs.hf.co/model/file?token=transient",
      "https://subdomain.hf.co/model/file",
    ]) {
      expect(validateLocalModelResponseUrl(url)).toBe(url);
    }
    for (const url of [
      "http://huggingface.co/model",
      "https://huggingface.co.evil.test/model",
      "https://evilhf.co/model",
      "https://user:password@cdn-lfs.hf.co/model",
    ]) {
      expect(() => validateLocalModelResponseUrl(url)).toThrow();
    }
  });
});

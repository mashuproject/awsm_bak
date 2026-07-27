import { describe, expect, it, vi } from "vitest";
import {
  LocalModelDownloader,
  type LocalModelGenerationStore,
} from "../../src/runtime/search/local-model/download";
import type { LocalMiniLmManifest } from "../../src/runtime/search/local-model/manifest";

const fixtureManifest: LocalMiniLmManifest = {
  manifestId: "fixture-manifest",
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dtype: "int8",
  dimensions: 384,
  maximumWordpieces: 256,
  pooling: "Mean",
  normalization: "L2",
  language: "English",
  license: "Apache-2.0",
  totalBytes: 3,
  files: [
    {
      path: "config.json",
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
  ],
};

function response(body: string, url = "https://cdn-lfs.hf.co/fixture"): Response {
  const value = new Response(body, {
    status: 200,
    headers: { "content-length": String(body.length), "content-type": "application/octet-stream" },
  });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

class MemoryGenerationStore implements LocalModelGenerationStore {
  readonly generations = new Map<string, Map<string, Uint8Array>>();
  promoted?: { readonly manifestId: string; readonly generationName: string };
  readonly deleted: string[] = [];

  async putFile(generationName: string, path: string, value: Response): Promise<void> {
    const bytes = new Uint8Array(await value.arrayBuffer());
    const generation = this.generations.get(generationName) ?? new Map();
    generation.set(path, bytes);
    this.generations.set(generationName, generation);
  }

  async deleteFile(generationName: string, path: string): Promise<void> {
    this.generations.get(generationName)?.delete(path);
  }

  async promote(manifestId: string, generationName: string): Promise<void> {
    this.promoted = { manifestId, generationName };
  }

  async current(): Promise<
    { readonly manifestId: string; readonly generationName: string } | undefined
  > {
    return this.promoted;
  }

  async deleteGeneration(generationName: string): Promise<void> {
    this.generations.delete(generationName);
    this.deleted.push(generationName);
  }
}

describe("local model download", () => {
  it("streams, verifies, and promotes only the complete immutable generation", async () => {
    const store = new MemoryGenerationStore();
    const fetcher = vi.fn(async () => response("abc"));
    const progress = vi.fn();
    const downloader = new LocalModelDownloader({
      store,
      fetcher,
      manifest: fixtureManifest,
      createGenerationId: () => "generation-a",
    });

    await expect(
      downloader.download({
        signal: new AbortController().signal,
        onProgress: progress,
      }),
    ).resolves.toEqual({ manifestId: "fixture-manifest", completedBytes: 3, totalBytes: 3 });
    expect(fetcher).toHaveBeenCalledWith(
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/config.json",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
      }),
    );
    expect(store.promoted).toEqual({
      manifestId: "fixture-manifest",
      generationName: "awsm-search-model-fixture-manifest-generation-a",
    });
    expect(
      store.generations.get("awsm-search-model-fixture-manifest-generation-a")?.get("config.json"),
    ).toEqual(new TextEncoder().encode("abc"));
    expect(progress).toHaveBeenLastCalledWith({ completedBytes: 3, totalBytes: 3 });
  });

  it("deletes the unpromoted generation on hash failure without exposing response content", async () => {
    const store = new MemoryGenerationStore();
    const fetcher = vi.fn(async () => response("abd"));
    const downloader = new LocalModelDownloader({
      store,
      fetcher,
      manifest: fixtureManifest,
      createGenerationId: () => "generation-b",
    });

    let message = "";
    try {
      await downloader.download({
        signal: new AbortController().signal,
        onProgress: () => undefined,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("abd");
    expect(store.promoted).toBeUndefined();
    expect(store.deleted).toEqual(["awsm-search-model-fixture-manifest-generation-b"]);
  });

  it("rejects failed HTTP and off-allowlist redirects before cache promotion", async () => {
    for (const value of [
      new Response("private provider body", { status: 500 }),
      response("abc", "https://evil.example/model"),
    ]) {
      const store = new MemoryGenerationStore();
      const downloader = new LocalModelDownloader({
        store,
        fetcher: async () => value,
        manifest: fixtureManifest,
        createGenerationId: () => "generation-c",
      });
      await expect(
        downloader.download({
          signal: new AbortController().signal,
          onProgress: () => undefined,
        }),
      ).rejects.toThrow();
      expect(store.promoted).toBeUndefined();
    }
  });
});

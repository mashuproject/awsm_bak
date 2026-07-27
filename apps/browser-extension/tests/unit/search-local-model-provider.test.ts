import { describe, expect, it, vi } from "vitest";
import type { LocalMiniLmManifest } from "../../src/runtime/search/local-model/manifest";
import {
  LocalMiniLmEmbeddingProvider,
  type LocalMiniLmEngine,
  verifiedModelCache,
} from "../../src/runtime/search/local-model/provider";

const manifest: LocalMiniLmManifest = {
  manifestId: "fixture",
  model: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dtype: "int8",
  dimensions: 384,
  maximumWordpieces: 256,
  pooling: "Mean",
  normalization: "L2",
  language: "English",
  license: "Apache-2.0",
  totalBytes: 1,
  files: [{ path: "config.json", bytes: 1, sha256: "0".repeat(64) }],
};

function engine(): LocalMiniLmEngine {
  return {
    encodeWithoutSpecialTokens: vi.fn((text: string) =>
      Array.from({ length: text === "long" ? 300 : 1 }, (_, index) => index + 10),
    ),
    infer: vi.fn(async (contentTokenIds: readonly number[]) => {
      const tokenCount = contentTokenIds.length + 2;
      const hidden = new Float32Array(tokenCount * 384);
      for (let token = 0; token < tokenCount; token += 1) {
        hidden[token * 384] = 1;
        hidden[token * 384 + 1] = 2;
      }
      return {
        lastHiddenState: hidden,
        attentionMask: new Uint8Array(tokenCount).fill(1),
        tokenCount,
        dimensions: 384,
      };
    }),
    dispose: vi.fn(async () => undefined),
  };
}

describe("local MiniLM embedding provider", () => {
  it("uses overlapping document windows, combines them, and remains local", async () => {
    const localEngine = engine();
    const load = vi.fn(async () => localEngine);
    const provider = new LocalMiniLmEmbeddingProvider({ load, manifest });

    const result = await provider.embed({
      purpose: "Document",
      texts: ["long"],
      signal: new AbortController().signal,
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(localEngine.infer).toHaveBeenCalledTimes(2);
    expect(localEngine.infer).toHaveBeenNthCalledWith(1, expect.arrayContaining([10, 263]));
    expect(localEngine.infer).toHaveBeenNthCalledWith(2, expect.arrayContaining([232, 309]));
    expect(result[0]).toHaveLength(384);
    expect(Math.hypot(...(result[0] ?? []))).toBeCloseTo(1);
    expect(provider.identity).toMatchObject({
      kind: "LocalMiniLm",
      model: manifest.model,
      modelRevision: manifest.revision,
      dimensions: 384,
    });
  });

  it("loads once, observes cancellation, validates limits, and disposes the engine", async () => {
    const localEngine = engine();
    const load = vi.fn(async () => localEngine);
    const provider = new LocalMiniLmEmbeddingProvider({ load, manifest });
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      provider.embed({ purpose: "Query", texts: ["x"], signal: aborted.signal }),
    ).rejects.toThrow();
    await expect(
      provider.embed({ purpose: "Query", texts: [], signal: new AbortController().signal }),
    ).rejects.toThrow();
    await provider.embed({
      purpose: "Query",
      texts: ["x"],
      signal: new AbortController().signal,
    });
    await provider.dispose();
    expect(localEngine.dispose).toHaveBeenCalledOnce();
  });

  it("exposes only exact immutable manifest URLs through the verified cache", async () => {
    const file = vi.fn(async (path: string) =>
      path === "config.json" ? new Response("x") : undefined,
    );
    const cache = verifiedModelCache({ file }, manifest);
    const exact =
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/" +
      `${manifest.revision}/config.json`;

    await expect(cache.match(exact)).resolves.toBeInstanceOf(Response);
    await expect(cache.match(new Request(exact))).resolves.toBeInstanceOf(Response);
    await expect(cache.match(`/models/${manifest.model}/config.json`)).resolves.toBeInstanceOf(
      Response,
    );
    await expect(cache.match(exact.replace("config.json", "other.json"))).resolves.toBeUndefined();
    await expect(cache.match("https://evil.example/config.json")).resolves.toBeUndefined();
    await expect(cache.put(exact, new Response("x"))).rejects.toThrow();
  });
});

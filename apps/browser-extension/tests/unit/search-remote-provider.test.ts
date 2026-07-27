import { describe, expect, it, vi } from "vitest";
import { remoteSearchEndpointPathHash } from "../../src/runtime/search/remote-endpoint";
import {
  OPENAI_COMPATIBILITY_PROBE,
  OpenAiCompatibleEmbeddingProvider,
  probeOpenAiCompatibleEmbeddingProvider,
} from "../../src/runtime/search/remote-provider";

const endpoint = "https://embeddings.example.test/v1/embeddings";

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("OpenAI-compatible remote Search provider", () => {
  it("sends the narrow embeddings request and reorders validated vectors by index", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response({
        object: "list",
        data: [
          { object: "embedding", embedding: [0, 2], index: 1 },
          { object: "embedding", embedding: [3, 0], index: 0 },
        ],
        model: "response-model",
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
    );
    const provider = new OpenAiCompatibleEmbeddingProvider({
      endpoint: `${endpoint}?api-version=1`,
      requestModel: "requested-model",
      responseModel: "response-model",
      dimensions: 2,
      endpointPathHash: remoteSearchEndpointPathHash(`${endpoint}?api-version=1`),
      apiKey: "secret",
      fetcher,
    });

    const vectors = await provider.embed({
      purpose: "Document",
      texts: ["first", "second"],
      signal: new AbortController().signal,
    });

    expect(vectors.map((vector) => Array.from(vector))).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(`${endpoint}?api-version=1`);
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "requested-model",
      input: ["first", "second"],
      encoding_format: "float",
      dimensions: 2,
    });
  });

  it("uses only the fixed non-user probe string and reports effective identity", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response({
        object: "list",
        data: [{ object: "embedding", embedding: [1, 2, 3], index: 0 }],
        model: "resolved-model",
      }),
    );
    const result = await probeOpenAiCompatibleEmbeddingProvider({
      endpoint,
      model: "alias",
      apiKey: "secret",
      fetcher,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ responseModel: "resolved-model", effectiveDimensions: 3 });
    const request = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body)).input).toEqual([OPENAI_COMPATIBILITY_PROBE]);
  });

  it("rejects malformed, missing, duplicate, non-finite, and changed responses", async () => {
    const invalidBodies = [
      {
        object: "list",
        data: [{ object: "embedding", embedding: [1, 0], index: 0 }],
        model: "changed-model",
      },
      {
        object: "list",
        data: [
          { object: "embedding", embedding: [1, 0], index: 0 },
          { object: "embedding", embedding: [0, 1], index: 0 },
        ],
        model: "response-model",
      },
      {
        object: "list",
        data: [{ object: "embedding", embedding: [1, Number.NaN], index: 0 }],
        model: "response-model",
      },
      {
        object: "list",
        data: [{ object: "embedding", embedding: [1, 0, 0], index: 0 }],
        model: "response-model",
      },
      {
        object: "list",
        data: [{ object: "embedding", embedding: "base64", index: 0 }],
        model: "response-model",
      },
    ];

    for (const body of invalidBodies) {
      const provider = new OpenAiCompatibleEmbeddingProvider({
        endpoint,
        requestModel: "requested-model",
        responseModel: "response-model",
        dimensions: 2,
        endpointPathHash: remoteSearchEndpointPathHash(endpoint),
        apiKey: "secret",
        fetcher: async () => response(body),
      });
      await expect(
        provider.embed({
          purpose: "Query",
          texts: ["query"],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects non-JSON, oversized batches, and provider HTTP errors without leaking bodies", async () => {
    const provider = new OpenAiCompatibleEmbeddingProvider({
      endpoint,
      requestModel: "requested-model",
      responseModel: "response-model",
      dimensions: 2,
      endpointPathHash: remoteSearchEndpointPathHash(endpoint),
      apiKey: "secret",
      fetcher: async () =>
        new Response("provider-secret-error", {
          status: 429,
          headers: { "content-type": "text/plain" },
        }),
    });

    await expect(
      provider.embed({
        purpose: "Query",
        texts: ["query"],
        signal: new AbortController().signal,
      }),
    ).rejects.not.toThrow(/provider-secret-error/u);
    await expect(
      provider.embed({
        purpose: "Document",
        texts: Array.from({ length: 33 }, () => "passage"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  it("retries only transient indexing failures with injected full jitter and Retry-After", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(
        response({
          object: "list",
          data: [{ object: "embedding", embedding: [1, 0], index: 0 }],
          model: "response-model",
        }),
      );
    const sleep = vi.fn(async () => undefined);
    const provider = new OpenAiCompatibleEmbeddingProvider({
      endpoint,
      requestModel: "requested-model",
      responseModel: "response-model",
      dimensions: 2,
      endpointPathHash: remoteSearchEndpointPathHash(endpoint),
      apiKey: "secret",
      fetcher,
      now: () => 0,
      random: () => 0,
      sleep,
    });

    await expect(
      provider.embed({
        purpose: "Document",
        texts: ["passage"],
        signal: new AbortController().signal,
      }),
    ).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));

    const unauthorized = new OpenAiCompatibleEmbeddingProvider({
      endpoint,
      requestModel: "requested-model",
      responseModel: "response-model",
      dimensions: 2,
      endpointPathHash: remoteSearchEndpointPathHash(endpoint),
      apiKey: "secret",
      fetcher: vi.fn(async () => new Response("", { status: 401 })),
      sleep,
    });
    await expect(
      unauthorized.embed({
        purpose: "Document",
        texts: ["passage"],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

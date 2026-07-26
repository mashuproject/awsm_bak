import { describe, expect, it, vi } from "vitest";
import { CoordinationAccountHttp } from "../../src/runtime/account/http";
import { SynchronizationHttp } from "../../src/runtime/synchronization/http";

describe("browser HTTP receiver binding", () => {
  it("invokes Account fetch with the Worker global receiver", async () => {
    const fetcher = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(undefined, { status: 204 }));
    }) as unknown as typeof fetch;

    await new CoordinationAccountHttp("https://sync.example.test", fetcher).logout("access");

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("invokes synchronization fetch with the Worker global receiver", async () => {
    const fetcher = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(JSON.stringify({ vaults: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const response = await new SynchronizationHttp(
      "https://sync.example.test",
      { accessToken: async () => "access" },
      fetcher,
    ).request("GET", "/api/vaults");

    expect(response.body).toEqual({ vaults: [] });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("classifies transport failures as interrupted synchronization", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("network unavailable");
    }) as unknown as typeof fetch;

    await expect(
      new SynchronizationHttp(
        "https://sync.example.test",
        { accessToken: async () => "access" },
        fetcher,
      ).request("POST", "/api/vaults/source/replacement-candidates/target/activate"),
    ).rejects.toMatchObject({ id: "SYNCHRONIZATION_INTERRUPTED" });
  });
});

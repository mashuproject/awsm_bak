import { describe, expect, it } from "vitest";

import { DesktopRuntimeApi, DesktopRuntimeCommandError } from "../../src/hosts/desktop/runtime-api";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("desktop Runtime API transport", () => {
  it("keeps the local Runtime transport on loopback", () => {
    expect(() => new DesktopRuntimeApi({ endpoint: "https://remote.example.test" })).toThrow(
      "Desktop Runtime endpoint must be loopback.",
    );
    expect(() => new DesktopRuntimeApi({ endpoint: "http://user:pass@127.0.0.1:37373" })).toThrow(
      "Desktop Runtime endpoint must not contain credentials or URL state.",
    );
  });

  it("uses the fixed loopback endpoint for health and pairing", async () => {
    const requests: Request[] = [];
    const api = new DesktopRuntimeApi({
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/health")) return response({ status: "ok" });
        return response(
          {
            pairingId: "pair-1",
            clientName: "extension",
            scopes: ["runtime.vault"],
            code: "pair-code",
          },
          { status: 201 },
        );
      },
    });

    await expect(api.health()).resolves.toEqual({ status: "ok" });
    await expect(api.beginPairing("extension")).resolves.toEqual({
      pairingId: "pair-1",
      clientName: "extension",
      scopes: ["runtime.vault"],
      code: "pair-code",
    });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "http://127.0.0.1:37373/api/awsm/runtime/health"],
      ["POST", "http://127.0.0.1:37373/api/awsm/runtime/pairings"],
    ]);
    await expect(requests[1]?.json()).resolves.toEqual({ clientName: "extension" });
  });

  it("sends a paired grant and rejects a non-success response", async () => {
    let request: Request | undefined;
    const api = new DesktopRuntimeApi({
      token: "grant-token",
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return response({ error: "revoked" }, { status: 401 });
      },
    });

    await expect(api.grant()).rejects.toThrow("Runtime API request failed (401)");
    expect(request?.headers.get("Authorization")).toBe("Bearer grant-token");
  });

  it("binds the browser fetch function to its global object", async () => {
    const fetcher = function (
      this: typeof globalThis,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      if (this !== globalThis) throw new TypeError("fetch lost its global receiver");
      return Promise.resolve(response({ status: "ok" }));
    };
    const api = new DesktopRuntimeApi({ fetcher });

    await expect(api.health()).resolves.toEqual({ status: "ok" });
  });

  it("forwards the canonical Vault command envelope and preserves Runtime errors", async () => {
    const requests: Request[] = [];
    const api = new DesktopRuntimeApi({
      token: "grant-token",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return response({ ok: true, value: { vaults: [] } });
      },
    });

    await expect(api.command({ type: "GetState" })).resolves.toEqual({ vaults: [] });
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer grant-token");
    await expect(requests[0]?.json()).resolves.toEqual({ type: "GetState" });

    const failing = new DesktopRuntimeApi({
      fetcher: async () =>
        response({
          ok: false,
          error: { id: "CAPTURE_UNAVAILABLE", message: "Desktop page capture is not available." },
        }),
    });
    await expect(failing.command({ type: "CaptureActivePage" })).rejects.toEqual(
      new DesktopRuntimeCommandError(
        "CAPTURE_UNAVAILABLE",
        "Desktop page capture is not available.",
      ),
    );
  });

  it("uses a one-use transfer secret without putting it in request bodies", async () => {
    const requests: Request[] = [];
    const api = new DesktopRuntimeApi({
      token: "grant-token",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST") {
          return response(
            { transferId: "transfer-1", vaultId: "a".repeat(64), secret: "secret" },
            { status: 201 },
          );
        }
        return response(
          { transferId: "transfer-1", vaultId: "a".repeat(64), byteLength: 3, digest: "digest" },
          { status: 201 },
        );
      },
    });

    await expect(api.beginTransfer("a".repeat(64))).resolves.toMatchObject({
      transferId: "transfer-1",
    });
    await expect(
      api.stageTransfer("transfer-1", "secret", new Uint8Array([1, 2, 3])),
    ).resolves.toEqual({
      transferId: "transfer-1",
      vaultId: "a".repeat(64),
      byteLength: 3,
      digest: "digest",
    });
    expect(await requests[1]?.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(requests[1]?.headers.get("Awsm-Transfer-Secret")).toBe("secret");
  });
});

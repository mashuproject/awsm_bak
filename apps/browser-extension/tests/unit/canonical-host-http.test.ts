import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import {
  CanonicalHostedReplicaHttp,
  CanonicalHostedReplicaHttpError,
} from "../../src/runtime/synchronization/canonical-host-http";

const REPLICA_HANDLE = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Awsm-Protocol-Version": "1",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("canonical Hosted Replica HTTP transport", () => {
  it("reads only a bounded opaque inventory page with the configured bearer channel", async () => {
    const storageItemId = identifier("StorageItem", new Uint8Array(32).fill(1));
    const digest = new Uint8Array(32).fill(2);
    let request: Request | undefined;
    const transport = new CanonicalHostedReplicaHttp({
      endpoint: "https://sync.example.test/",
      bearerToken: "opaque-bearer-token",
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return response({
          snapshot_cursor: 9,
          next_position: null,
          items: [
            {
              storage_item_id: base64Url(storageItemId),
              storage_class: "compact",
              byte_length: 64,
              ciphertext_digest: base64Url(digest),
            },
          ],
        });
      },
    });

    await expect(
      transport.inventory({ replicaHandle: REPLICA_HANDLE, limit: 100 }),
    ).resolves.toEqual({
      snapshotCursor: 9,
      nextPosition: null,
      items: [
        {
          storageItemId,
          storageClass: 1,
          byteLength: 64,
          ciphertextDigest: digest,
        },
      ],
    });
    expect(request?.url).toBe(
      `https://sync.example.test/api/replicas/${REPLICA_HANDLE}/inventory?limit=100`,
    );
    expect(request?.headers.get("Authorization")).toBe("Bearer opaque-bearer-token");
    expect(request?.headers.get("Awsm-Protocol-Version")).toBe("1");
    expect(request?.url).not.toContain("vault");
  });

  it("preserves an exact inventory snapshot position without treating the Host cursor as Vault order", async () => {
    const position = identifier("StorageItem", new Uint8Array(32).fill(3));
    let request: Request | undefined;
    const transport = new CanonicalHostedReplicaHttp({
      endpoint: "https://sync.example.test/",
      bearerToken: "opaque-bearer-token",
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return response({ snapshot_cursor: 9, next_position: null, items: [] });
      },
    });

    await transport.inventory({
      replicaHandle: REPLICA_HANDLE,
      snapshotCursor: 9,
      position,
      limit: 1,
    });

    expect(Object.fromEntries(new URL(request?.url ?? "").searchParams)).toEqual({
      snapshot_cursor: "9",
      position: base64Url(position),
      limit: "1",
    });
  });

  it("streams an exact opaque item only when the Host confirms its requested full length", async () => {
    const storageItemId = identifier("StorageItem", new Uint8Array(32).fill(4));
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const transport = new CanonicalHostedReplicaHttp({
      endpoint: "https://sync.example.test/",
      bearerToken: "opaque-bearer-token",
      fetcher: async () =>
        new Response(bytes, {
          headers: {
            "Awsm-Protocol-Version": "1",
            "Content-Length": String(bytes.byteLength),
            "Content-Type": "application/octet-stream",
          },
        }),
    });

    const stream = await transport.item({
      replicaHandle: REPLICA_HANDLE,
      storageItemId,
      byteLength: bytes.byteLength,
    });
    await expect(new Response(stream).bytes()).resolves.toEqual(bytes);
  });

  it("reports only a strict retryable Host outcome when opaque inventory access is refused", async () => {
    const transport = new CanonicalHostedReplicaHttp({
      endpoint: "https://sync.example.test/",
      bearerToken: "opaque-bearer-token",
      fetcher: async () =>
        response(
          {
            outcome: "rate_limited",
            retryable: true,
            request_id: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
            retry_after_seconds: 2,
          },
          { status: 429 },
        ),
    });

    await expect(transport.inventory({ replicaHandle: REPLICA_HANDLE, limit: 1 })).rejects.toEqual(
      expect.objectContaining({
        constructor: CanonicalHostedReplicaHttpError,
        outcome: "rate_limited",
        retryable: true,
        retryAfterSeconds: 2,
      }),
    );
  });
});

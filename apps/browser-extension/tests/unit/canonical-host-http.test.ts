import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import {
  CanonicalHostedReplicaHttp,
  CanonicalHostedReplicaHttpError,
  CanonicalHostedReplicaSessionHttp,
} from "../../src/runtime/synchronization/canonical-host-http";
import { COMPACT_STORAGE_CLASS, encodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

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
  it("creates and lists only strict Host-local Hosted Replica summaries", async () => {
    const locatorSalt = new Uint8Array(32).fill(7);
    const createdHandle = "019fa62e-a653-7f63-b2bf-94e7ed5e46cc";
    const listedHandle = "019fa62e-a653-7f63-b2bf-94e7ed5e46cd";
    const requests: Request[] = [];
    const transport = new CanonicalHostedReplicaHttp({
      endpoint: "https://sync.example.test/",
      bearerToken: "opaque-bearer-token",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const summary = (replicaHandle: string) => ({
          replica_handle: replicaHandle,
          locator_salt: base64Url(locatorSalt),
          capabilities: [
            "awsm.replica.inventory.read",
            "awsm.replica.item.read",
            "awsm.replica.item.write",
            "awsm.replica.manage",
          ],
          quota_bytes: null,
          stored_bytes: 0,
        });
        return request.method === "POST"
          ? response(summary(createdHandle), { status: 201 })
          : response({ replicas: [summary(createdHandle), summary(listedHandle)] });
      },
    });

    await expect(transport.createReplica()).resolves.toEqual({
      replicaHandle: createdHandle,
      locatorSalt,
      capabilities: [
        "awsm.replica.inventory.read",
        "awsm.replica.item.read",
        "awsm.replica.item.write",
        "awsm.replica.manage",
      ],
      quotaBytes: null,
      storedBytes: 0,
    });
    await expect(transport.listReplicas()).resolves.toEqual([
      expect.objectContaining({ replicaHandle: createdHandle, locatorSalt }),
      expect.objectContaining({ replicaHandle: listedHandle, locatorSalt }),
    ]);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "https://sync.example.test/api/replicas"],
      ["GET", "https://sync.example.test/api/replicas"],
    ]);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer opaque-bearer-token");
    await expect(requests[0]?.json()).resolves.toEqual({});
  });

  it("admits one locally verified compact envelope without sending protected identity", async () => {
    const envelope = encodeOpaqueEnvelope({
      storageClass: COMPACT_STORAGE_CLASS,
      protectionParameters: new Uint8Array(64).fill(4),
      payload: new Uint8Array(16).fill(5),
    });
    const locator = new Uint8Array(32).fill(6);
    let request: Request | undefined;
    const transport = new CanonicalHostedReplicaHttp({
      endpoint: "https://sync.example.test/",
      bearerToken: "opaque-bearer-token",
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return response(
          {
            storage_item_id: base64Url(envelope.storageItemId),
            byte_length: envelope.bytes.byteLength,
            admission: "stored",
            hint_cursor: 3,
          },
          { status: 201 },
        );
      },
    });

    await expect(
      transport.admitCompact({
        replicaHandle: REPLICA_HANDLE,
        locator,
        bytes: envelope.bytes,
      }),
    ).resolves.toEqual({
      storageItemId: envelope.storageItemId,
      byteLength: envelope.bytes.byteLength,
      admission: "stored",
      hintCursor: 3,
    });
    expect(request?.method).toBe("PUT");
    expect(request?.url).toBe(
      `https://sync.example.test/api/replicas/${REPLICA_HANDLE}/items/${base64Url(envelope.storageItemId)}`,
    );
    expect(request?.headers.get("Awsm-Opaque-Locator")).toBe(base64Url(locator));
    expect(request?.headers.get("Content-Type")).toBe("application/octet-stream");
    await expect(request?.bytes()).resolves.toEqual(envelope.bytes);
    expect(request?.url).not.toContain("vault");
  });

  it("rejects an opaque admission receipt that does not bind the submitted outer item", async () => {
    const envelope = encodeOpaqueEnvelope({
      storageClass: COMPACT_STORAGE_CLASS,
      protectionParameters: new Uint8Array(64).fill(8),
      payload: new Uint8Array(16).fill(9),
    });
    let requests = 0;
    const transport = new CanonicalHostedReplicaHttp({
      endpoint: "https://sync.example.test/",
      bearerToken: "opaque-bearer-token",
      fetcher: async () => {
        requests += 1;
        return response(
          {
            storage_item_id: base64Url(new Uint8Array(32).fill(10)),
            byte_length: envelope.bytes.byteLength,
            admission: "stored",
            hint_cursor: 3,
          },
          { status: 201 },
        );
      },
    });

    await expect(
      transport.admitCompact({
        replicaHandle: REPLICA_HANDLE,
        locator: new Uint8Array(32).fill(11),
        bytes: envelope.bytes,
      }),
    ).rejects.toThrow(/does not match the submitted item/u);
    expect(requests).toBe(1);
  });

  it("exchanges transient username/password credentials for one strict Host session", async () => {
    let request: Request | undefined;
    const transport = new CanonicalHostedReplicaSessionHttp({
      endpoint: "https://sync.example.test/",
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return response({
          account: {
            username: "archive_reader",
            inactive_deletion_at: "2026-08-31T00:00:00.000Z",
          },
          session_id: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
          access_token: "access-token",
          access_expires_at: "2026-08-02T00:15:00.000Z",
          refresh_token: "refresh-token",
          refresh_expires_at: "2026-09-01T00:00:00.000Z",
        });
      },
    });

    await expect(
      transport.signIn({ username: "archive_reader", password: "correct horse battery staple" }),
    ).resolves.toEqual({
      username: "archive_reader",
      sessionId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
      accessToken: "access-token",
      accessExpiresAt: Date.parse("2026-08-02T00:15:00.000Z"),
      refreshToken: "refresh-token",
      refreshExpiresAt: Date.parse("2026-09-01T00:00:00.000Z"),
    });
    expect(request?.url).toBe("https://sync.example.test/api/sessions");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    expect(request?.headers.get("Awsm-Protocol-Version")).toBe("1");
    await expect(request?.json()).resolves.toEqual({
      username: "archive_reader",
      password: "correct horse battery staple",
    });
  });

  it("rotates a Host session only through its refresh credential", async () => {
    let request: Request | undefined;
    const transport = new CanonicalHostedReplicaSessionHttp({
      endpoint: "https://sync.example.test/",
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return response({
          account: {
            username: "archive_reader",
            inactive_deletion_at: "2026-08-31T00:00:00.000Z",
          },
          session_id: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
          access_token: "fresh-access-token",
          access_expires_at: "2026-08-02T00:15:00.000Z",
          refresh_token: "fresh-refresh-token",
          refresh_expires_at: "2026-09-01T00:00:00.000Z",
        });
      },
    });

    await expect(
      transport.refresh({ refreshToken: "previous-refresh-token" }),
    ).resolves.toMatchObject({
      username: "archive_reader",
      sessionId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
    });
    expect(request?.url).toBe("https://sync.example.test/api/session/refresh");
    expect(request?.method).toBe("POST");
    await expect(request?.json()).resolves.toEqual({ refresh_token: "previous-refresh-token" });
  });

  it("rejects out-of-contract account credentials before sending a Host request", async () => {
    let requests = 0;
    const transport = new CanonicalHostedReplicaSessionHttp({
      endpoint: "https://sync.example.test/",
      fetcher: async () => {
        requests += 1;
        throw new Error("credentials outside the protocol must not reach the Host");
      },
    });

    await expect(transport.signIn({ username: "a", password: "password" })).rejects.toThrow(
      /canonical username/u,
    );
    await expect(
      transport.signIn({ username: "archive_reader", password: "x".repeat(1_025) }),
    ).rejects.toThrow(/sign-in password/u);
    await expect(transport.refresh({ refreshToken: "x".repeat(1_025) })).rejects.toThrow(
      /refresh token/u,
    );
    expect(requests).toBe(0);
  });

  it("reads only a bounded opaque inventory page with the configured bearer channel", async () => {
    const storageItemId = identifier("StorageItem", new Uint8Array(32).fill(1));
    const digest = new Uint8Array(32).fill(2);
    const locator = new Uint8Array(32).fill(3);
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
              locator: base64Url(locator),
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
          locator,
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

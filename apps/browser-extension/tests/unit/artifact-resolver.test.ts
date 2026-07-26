import { beforeAll, describe, expect, it } from "vitest";

import { bytesToBase64Url } from "../../src/runtime/account/wire";
import type { ArtifactStore } from "../../src/runtime/artifact";
import { ArtifactResolver } from "../../src/runtime/artifact/resolver";

const vaultId = "01900000-0000-7000-8000-000000000701";
const objectId = "01900000-0000-7000-8000-000000000702";
const generationId = "01900000-0000-7000-8000-000000000703";
const bytes = new TextEncoder().encode("encrypted wrapper bytes");
let checksum: Uint8Array;

beforeAll(async () => {
  checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
});

function object() {
  return {
    version: 1,
    objectId,
    objectType: "Artifact",
    keyEpochId: "00000000-0000-4000-8000-000000000009",
    envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
    envelopeByteLength: bytes.byteLength,
    envelopeChecksumAlgorithm: "hash:sha256:v1",
    envelopeChecksum: checksum,
  } as const;
}

function stream(value = bytes): ReadableStream<Uint8Array> {
  return new Blob([Uint8Array.from(value)]).stream();
}

function fixture(input?: { readonly local?: boolean; readonly quota?: boolean }) {
  let local = input?.local ?? false;
  let remoteOnly = !local;
  let requests = 0;
  let clears = 0;
  const store = {
    has: async () => local,
    verifyEncrypted: async () => local,
    openEncrypted: async () => stream(),
    openPlaintext: async () => stream(),
    prepareEncrypted: async (value) => {
      if (input?.quota === true)
        throw Object.assign(new Error("quota"), { id: "STORAGE_QUOTA_EXCEEDED" });
      await new Response(value.encrypted).arrayBuffer();
      await value.afterFirstWrite?.();
      local = true;
    },
  } as Pick<
    ArtifactStore,
    "has" | "verifyEncrypted" | "openEncrypted" | "openPlaintext" | "prepareEncrypted"
  >;
  const remote = {
    request: async () => {
      requests += 1;
      return {
        status: 200,
        body: {
          record: {
            state: "Committed",
            objectId,
            objectType: "Artifact",
            keyEpochId: object().keyEpochId,
            byteLength: bytes.byteLength,
            sha256: bytesToBase64Url(checksum),
          },
          ticket: {
            method: "GET",
            url: `/transfers/${requests}`,
            expiresAt: "2026-07-21T04:00:00.000Z",
            requiredHeaders: {},
          },
        },
      };
    },
    getTransfer: async () => stream(),
  };
  const resolver = new ArtifactResolver(
    store,
    {
      isArtifactRemoteOnly: async () => remoteOnly,
      clearArtifactRemoteOnly: async () => {
        clears += 1;
        remoteOnly = false;
      },
    },
    remote,
    { online: () => true },
  );
  return { resolver, store, remote, counts: () => ({ requests, clears }) };
}

const context = {
  vaultId,
  serverOrigin: "https://sync.example.test",
  scope: { type: "ActiveGeneration" as const, generationId },
};

describe("ArtifactResolver", () => {
  it("uses a verified local wrapper without contacting the server", async () => {
    const value = fixture({ local: true });
    const resolved = await value.resolver.openEncrypted({
      ...context,
      object: object(),
      retention: "RestoreLocal",
    });
    expect(new Uint8Array(await new Response(resolved.stream).arrayBuffer())).toEqual(bytes);
    expect(resolved.retention).toBe("Local");
    expect(value.counts()).toEqual({ requests: 0, clears: 0 });
  });

  it("verifies a requested remote source without consulting local availability", async () => {
    const value = fixture({ local: true });
    const resolved = await value.resolver.openRemoteEncrypted({
      ...context,
      object: object(),
      retention: "Transient",
    });
    expect(new Uint8Array(await new Response(resolved).arrayBuffer())).toEqual(bytes);
    expect(value.counts()).toEqual({ requests: 1, clears: 0 });
  });

  it("restores and verifies a remote-only wrapper locally", async () => {
    const value = fixture();
    const reached: string[] = [];
    const resolver = new ArtifactResolver(
      value.store,
      {
        isArtifactRemoteOnly: async () => true,
        clearArtifactRemoteOnly: async () => {
          reached.push("clear");
        },
      },
      value.remote,
      { online: () => true },
      () => undefined,
      {
        afterPartialLocalWrite: async () => {
          reached.push("partial");
        },
        afterLocalVerify: async () => {
          reached.push("verified");
        },
        beforeAvailabilityClear: async () => {
          reached.push("before-clear");
        },
      },
    );
    const resolved = await resolver.openEncrypted({
      ...context,
      object: object(),
      retention: "RestoreLocal",
    });
    expect(new Uint8Array(await new Response(resolved.stream).arrayBuffer())).toEqual(bytes);
    expect(resolved.retention).toBe("Local");
    expect(value.counts().requests).toBe(1);
    expect(reached).toEqual(["partial", "verified", "before-clear", "clear"]);
  });

  it("uses a fresh verified transient stream only after quota failure", async () => {
    const value = fixture({ quota: true });
    const resolved = await value.resolver.openEncrypted({
      ...context,
      object: object(),
      retention: "RestoreLocal",
    });
    expect(new Uint8Array(await new Response(resolved.stream).arrayBuffer())).toEqual(bytes);
    expect(resolved.retention).toBe("Transient");
    expect(value.counts()).toEqual({ requests: 2, clears: 0 });
  });

  it("keeps remote-only state when interrupted after the first local write", async () => {
    const value = fixture();
    const interrupted = new Error("worker stopped");
    const resolver = new ArtifactResolver(
      value.store,
      {
        isArtifactRemoteOnly: async () => true,
        clearArtifactRemoteOnly: async () => {
          throw new Error("availability must not clear");
        },
      },
      value.remote,
      { online: () => true },
      () => undefined,
      {
        afterPartialLocalWrite: async () => {
          throw interrupted;
        },
        afterLocalVerify: async () => undefined,
        beforeAvailabilityClear: async () => undefined,
      },
    );

    await expect(
      resolver.openEncrypted({ ...context, object: object(), retention: "RestoreLocal" }),
    ).rejects.toBe(interrupted);
    expect(value.counts()).toEqual({ requests: 1, clears: 0 });
  });

  it("rejects unmarked local absence as corruption", async () => {
    const value = fixture({ local: true });
    const missing = new ArtifactResolver(
      { ...value.store, has: async () => false },
      {
        isArtifactRemoteOnly: async () => false,
        clearArtifactRemoteOnly: async () => undefined,
      },
      value.remote,
      { online: () => true },
    );
    await expect(
      missing.openEncrypted({ ...context, object: object(), retention: "RestoreLocal" }),
    ).rejects.toMatchObject({ id: "BUNDLE_INVALID" });
  });

  it("rejects corrupt transient bytes without clearing remote-only state", async () => {
    const value = fixture();
    const corrupt = new ArtifactResolver(
      value.store,
      {
        isArtifactRemoteOnly: async () => true,
        clearArtifactRemoteOnly: async () => undefined,
      },
      { ...value.remote, getTransfer: async () => stream(new Uint8Array(bytes.byteLength)) },
      { online: () => true },
    );
    const resolved = await corrupt.openEncrypted({
      ...context,
      object: object(),
      retention: "Transient",
    });
    await expect(new Response(resolved.stream).arrayBuffer()).rejects.toMatchObject({
      id: "REMOTE_ARTIFACT_INTEGRITY_FAILED",
    });
  });

  it("rejects corrupt restore bytes as remote integrity failure", async () => {
    const value = fixture();
    const corrupt = new ArtifactResolver(
      value.store,
      {
        isArtifactRemoteOnly: async () => true,
        clearArtifactRemoteOnly: async () => {
          throw new Error("availability must not clear");
        },
      },
      { ...value.remote, getTransfer: async () => stream(new Uint8Array(bytes.byteLength)) },
      { online: () => true },
    );
    await expect(
      corrupt.openEncrypted({ ...context, object: object(), retention: "RestoreLocal" }),
    ).rejects.toMatchObject({ id: "REMOTE_ARTIFACT_INTEGRITY_FAILED" });
    expect(value.counts()).toEqual({ requests: 1, clears: 0 });
  });

  it("distinguishes offline retrieval before requesting a ticket", async () => {
    const value = fixture();
    const offline = new ArtifactResolver(
      value.store,
      {
        isArtifactRemoteOnly: async () => true,
        clearArtifactRemoteOnly: async () => undefined,
      },
      value.remote,
      { online: () => false },
    );
    await expect(
      offline.openEncrypted({ ...context, object: object(), retention: "Transient" }),
    ).rejects.toMatchObject({ id: "REMOTE_ARTIFACT_OFFLINE" });
    expect(value.counts().requests).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import type { StoredArtifactObjectV1 } from "../../src/drivers/indexeddb/schema";
import { openPullArtifact } from "../../src/runtime/synchronization/pull-artifact";

const vaultId = "01900000-0000-7000-8000-000000000721";
const object: StoredArtifactObjectV1 = {
  version: 1,
  objectId: "01900000-0000-7000-8000-000000000722",
  objectType: "Artifact",
  keyEpochId: "00000000-0000-4000-8000-000000000009",
  envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
  envelopeByteLength: 10,
  envelopeChecksumAlgorithm: "hash:sha256:v1",
  envelopeChecksum: new Uint8Array(32),
};

describe("synchronization Artifact availability", () => {
  it("verifies an existing remote-only Artifact through the server without OPFS", async () => {
    const calls: string[] = [];
    const result = await openPullArtifact(
      { vaultId, object, generationId: "01900000-0000-7000-8000-000000000723" },
      { isArtifactRemoteOnly: async () => true },
      {
        local: async () => {
          calls.push("local");
          return new ReadableStream<Uint8Array>();
        },
        remote: async () => {
          calls.push("remote");
          return new ReadableStream<Uint8Array>();
        },
      },
    );
    await result.cancel();
    expect(calls).toEqual(["remote"]);
  });

  it("keeps ordinary local Artifacts on the local verification path", async () => {
    const calls: string[] = [];
    const result = await openPullArtifact(
      { vaultId, object, generationId: "01900000-0000-7000-8000-000000000723" },
      { isArtifactRemoteOnly: async () => false },
      {
        local: async () => {
          calls.push("local");
          return new ReadableStream<Uint8Array>();
        },
        remote: async () => {
          calls.push("remote");
          return new ReadableStream<Uint8Array>();
        },
      },
    );
    await result.cancel();
    expect(calls).toEqual(["local"]);
  });
});

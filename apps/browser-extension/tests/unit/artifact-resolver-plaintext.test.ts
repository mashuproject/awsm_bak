import { describe, expect, it } from "vitest";

import { writeArtifactEnvelope } from "../../src/crypto/artifact-envelope";
import { deriveContextKeyFromCryptoKey } from "../../src/crypto/hkdf";
import { wipe } from "../../src/crypto/sodium";
import { sha256 } from "../../src/domain/hash";
import { bytesToBase64Url } from "../../src/runtime/account/wire";
import type { ArtifactStore } from "../../src/runtime/artifact";
import { ArtifactResolver } from "../../src/runtime/artifact/resolver";
import { TEST_KEY_EPOCH_ID, testKeyring } from "../helpers/keyring";

const vaultId = "01900000-0000-7000-8000-000000000711";
const objectId = "01900000-0000-7000-8000-000000000712";
const generationId = "01900000-0000-7000-8000-000000000713";

async function preparedArtifact() {
  const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(9), "HKDF", false, [
    "deriveBits",
  ]);
  const key = await deriveContextKeyFromCryptoKey(rootKey, {
    vaultId,
    keyEpochId: TEST_KEY_EPOCH_ID,
    domain: "vault:artifact:v1",
    contextId: objectId,
    keyVersion: 1,
  });
  const plaintext = new TextEncoder().encode("retrieved screenshot bytes");
  const encrypted: Uint8Array[] = [];
  async function* source(): AsyncGenerator<Uint8Array> {
    yield plaintext;
  }
  const summary = await writeArtifactEnvelope({
    objectId,
    keyEpochId: TEST_KEY_EPOCH_ID,
    key,
    plaintext: source(),
    noncePrefix: new Uint8Array(16).fill(4),
    write: (value) => {
      encrypted.push(Uint8Array.from(value));
    },
  });
  await wipe(key);
  const wrapper = new Uint8Array(summary.envelopeByteLength);
  let offset = 0;
  for (const part of encrypted) {
    wrapper.set(part, offset);
    offset += part.byteLength;
  }
  return {
    rootKey,
    plaintext,
    wrapper,
    object: {
      version: 1,
      objectId,
      objectType: "Artifact",
      keyEpochId: "00000000-0000-4000-8000-000000000009",
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
      envelopeByteLength: wrapper.byteLength,
      envelopeChecksumAlgorithm: "hash:sha256:v1",
      envelopeChecksum: await sha256(wrapper),
    } as const,
    reference: {
      artifactVersion: 1,
      artifactObjectId: objectId,
      kind: "CAPTURE",
      role: "SCREENSHOT_FULL",
      mimeType: "image/png",
      acquiredAt: "2026-07-21T00:00:00.000Z",
      plaintextByteLength: plaintext.byteLength,
      checksumAlgorithm: "hash:sha256:v1",
      plaintextChecksum: await sha256(plaintext),
    } as const,
  };
}

describe("ArtifactResolver plaintext retrieval", () => {
  it("authenticates transient plaintext after a quota-specific fresh download", async () => {
    const value = await preparedArtifact();
    let requests = 0;
    let cleared = false;
    const artifacts = {
      has: async () => false,
      verifyEncrypted: async () => false,
      openEncrypted: async () => new ReadableStream<Uint8Array>(),
      openPlaintext: async () => new ReadableStream<Uint8Array>(),
      prepareEncrypted: async () => {
        throw Object.assign(new Error("quota"), { id: "STORAGE_QUOTA_EXCEEDED" });
      },
    } satisfies Pick<
      ArtifactStore,
      "has" | "verifyEncrypted" | "openEncrypted" | "openPlaintext" | "prepareEncrypted"
    >;
    const resolver = new ArtifactResolver(
      artifacts,
      {
        isArtifactRemoteOnly: async () => true,
        clearArtifactRemoteOnly: async () => {
          cleared = true;
        },
      },
      {
        request: async () => {
          requests += 1;
          return {
            status: 200,
            body: {
              record: {
                state: "Committed",
                objectId,
                objectType: "Artifact",
                keyEpochId: TEST_KEY_EPOCH_ID,
                byteLength: value.wrapper.byteLength,
                sha256: bytesToBase64Url(value.object.envelopeChecksum),
              },
              ticket: {
                method: "GET",
                url: `/transfer/${requests}`,
                expiresAt: "2026-07-21T04:00:00.000Z",
                requiredHeaders: {},
              },
            },
          };
        },
        getTransfer: async () => new Blob([Uint8Array.from(value.wrapper)]).stream(),
      },
      { online: () => true },
    );

    const resolved = await resolver.openPlaintext({
      vaultId,
      serverOrigin: "https://sync.example.test",
      object: value.object,
      reference: value.reference,
      keyring: testKeyring(value.rootKey),
      scope: { type: "ActiveGeneration", generationId },
      retention: "RestoreLocal",
    });

    expect(new Uint8Array(await new Response(resolved.stream).arrayBuffer())).toEqual(
      value.plaintext,
    );
    expect(resolved.retention).toBe("Transient");
    expect(requests).toBe(2);
    expect(cleared).toBe(false);
  });
});

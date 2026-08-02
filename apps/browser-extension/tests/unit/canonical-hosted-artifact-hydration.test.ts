import { describe, expect, it } from "vitest";

import { digestArtifactPayload, sealArtifactFrames } from "../../src/crypto/artifact-stream";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import type { Identifier } from "../../src/domain/canonical/identifiers";
import { ARTIFACT_OBJECT, artifactId, encodeVaultObject } from "../../src/domain/canonical/object";
import { concatBytes } from "../../src/domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  encodeCanonicalValue,
} from "../../src/domain/canonical/value";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactImportStore } from "../../src/runtime/artifact/canonical-store";
import { CanonicalHostedArtifactHydrationService } from "../../src/runtime/synchronization/canonical-hosted-artifact-hydration";
import {
  deriveHostedReplicaOpaqueLocator,
  HOSTED_REPLICA_LOGICAL_NAMESPACE,
} from "../../src/runtime/synchronization/canonical-hosted-replica-locator";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";
import { decodeOpaqueEnvelope, FRAME_PLAINTEXT_LIMIT } from "../../src/storage/opaque-envelope";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
const LOCATOR_SALT = new Uint8Array(32).fill(91);

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value.subarray(0, 3);
  yield value.subarray(3);
}

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([Uint8Array.from(value)]).stream();
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

function replicaState(
  input: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
): CanonicalReplicaState {
  return {
    vaultId: input.ids.vaultId,
    generationId: input.ids.generationId,
    causalFrontier: [input.genesis.recordId],
    authorityFrontier: [input.genesis.recordId],
    continuityRecordIds: [input.genesis.recordId],
    baselineId: input.baseline.recordId,
    currentKeyEpochId: input.secrets.keyEpoch.id,
    requiredFeatureSetId: input.genesis.requiredFeatureSetId,
    authoringClientCredentialId: input.ids.clientCredentialId,
    memberId: input.ids.firstMemberId,
    lifecycle: 1,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
}

class MemoryArtifactStore implements CanonicalArtifactImportStore {
  readonly items = new Map<string, Uint8Array>();

  async prepare(): Promise<never> {
    throw new TypeError("This hydration test never creates a new Artifact wrapper");
  }

  async prepareOpaque(input: {
    readonly artifactId: Identifier<"Artifact">;
    readonly storageItemId: Identifier<"StorageItem">;
    readonly envelopeByteLength: number;
    readonly source: ReadableStream<Uint8Array>;
  }) {
    const bytes = new Uint8Array(await new Response(input.source).arrayBuffer());
    expect(bytes.byteLength).toBe(input.envelopeByteLength);
    expect(decodeOpaqueEnvelope(bytes).storageItemId).toEqual(input.storageItemId);
    let promoted = false;
    return {
      artifactId: input.artifactId,
      storageItemId: input.storageItemId,
      envelopeByteLength: input.envelopeByteLength,
      promote: async () => {
        promoted = true;
        this.items.set(identifierStorageKey(input.storageItemId), bytes);
      },
      discard: async () => {
        if (!promoted) return;
      },
    };
  }

  async has(storageItemId: Identifier<"StorageItem">): Promise<boolean> {
    return this.items.has(identifierStorageKey(storageItemId));
  }

  async open(storageItemId: Identifier<"StorageItem">): Promise<ReadableStream<Uint8Array>> {
    const value = this.items.get(identifierStorageKey(storageItemId));
    if (value === undefined) throw new TypeError("Artifact is unavailable");
    return stream(value);
  }

  async remove(_storageItemId: Identifier<"StorageItem">): Promise<void> {}
}

describe("canonical Hosted Artifact hydration", () => {
  it("promotes a fully verified Streamable wrapper and atomically records its local resolution", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Hydration", assertedAt: 1 });
    const payload = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const plaintextDigest = await digestArtifactPayload({
      plaintextLength: payload.byteLength,
      source: chunks(payload),
    });
    const object = encodeVaultObject({
      vaultId: creation.ids.vaultId,
      objectType: ARTIFACT_OBJECT,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        "awsm.artifact.capture",
        "application/vnd.awsm.web-page+zip",
        "awsm.representation.web-page-zip",
        payload.byteLength,
        plaintextDigest,
        indexedMap(1, FRAME_PLAINTEXT_LIMIT, 16, payload.byteLength, plaintextDigest),
        encodeCanonicalValue(indexedMap(1)),
      ),
    });
    const frames: Uint8Array[] = [];
    const sealed = await sealArtifactFrames({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      artifactId: artifactId(object),
      contract: { plaintextLength: payload.byteLength, plaintextDigest },
      source: chunks(payload),
      protectionParameters: new Uint8Array(64).fill(8),
      writeFrame: async (frame) => {
        frames.push(Uint8Array.from(frame));
      },
    });
    const wrapper = concatBytes([sealed.envelopePrefix.prefixBytes, ...frames]);
    const storageItemId = decodeOpaqueEnvelope(wrapper).storageItemId;
    const corruptPayload = Uint8Array.from([9, 8, 7, 6, 5, 4]);
    const corruptPlaintextDigest = await digestArtifactPayload({
      plaintextLength: corruptPayload.byteLength,
      source: chunks(corruptPayload),
    });
    const corruptObject = encodeVaultObject({
      vaultId: creation.ids.vaultId,
      objectType: ARTIFACT_OBJECT,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        "awsm.artifact.capture",
        "application/vnd.awsm.web-page+zip",
        "awsm.representation.web-page-zip",
        corruptPayload.byteLength,
        corruptPlaintextDigest,
        indexedMap(1, FRAME_PLAINTEXT_LIMIT, 16, corruptPayload.byteLength, corruptPlaintextDigest),
        encodeCanonicalValue(indexedMap(1)),
      ),
    });
    const corruptFrames: Uint8Array[] = [];
    const corruptSealed = await sealArtifactFrames({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      artifactId: artifactId(corruptObject),
      contract: {
        plaintextLength: corruptPayload.byteLength,
        plaintextDigest: corruptPlaintextDigest,
      },
      source: chunks(corruptPayload),
      protectionParameters: new Uint8Array(64).fill(7),
      writeFrame: async (frame) => {
        corruptFrames.push(Uint8Array.from(frame));
      },
    });
    const corruptWrapper = concatBytes([
      corruptSealed.envelopePrefix.prefixBytes,
      ...corruptFrames,
    ]);
    const corruptStorageItemId = decodeOpaqueEnvelope(corruptWrapper).storageItemId;
    const locator = await deriveHostedReplicaOpaqueLocator({
      locatorSalt: LOCATOR_SALT,
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.Artifact,
      logicalId: artifactId(object),
    });
    const state = replicaState(creation);
    const vault = {
      directory: {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        label: "Hydration",
        selectedClientCredentialId: creation.ids.clientCredentialId,
      },
      replicaState: state,
      clientSecret: null,
      epochSecret: {
        vaultId: creation.ids.vaultId,
        keyEpochId: creation.secrets.keyEpoch.id,
        displayNumber: 0,
        key: creation.secrets.keyEpoch.key,
      },
      baseline: creation.baseline,
      genesis: creation.genesis,
      installationWrappingKey: await crypto.subtle.generateKey(
        { name: "AES-KW", length: 256 },
        false,
        ["wrapKey", "unwrapKey"],
      ),
      replicaStateStorageBytes: new Uint8Array([1]),
    } satisfies PersistedOpenedCanonicalVault;
    const artifacts = new MemoryArtifactStore();
    const commits: unknown[] = [];
    const inaccessibleRemote = {
      remoteId: "00000000-0000-7000-8000-000000000000",
      vaultId: creation.ids.vaultId,
      name: "Inaccessible Host",
      endpoint: "https://inaccessible.example/",
      hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
      locatorSalt: LOCATOR_SALT,
      enabled: true,
      inventoryPageSize: 100,
    } as const;
    const unavailableRemote = {
      remoteId: "00000000-0000-7000-8000-000000000001",
      vaultId: creation.ids.vaultId,
      name: "Unavailable Host",
      endpoint: "https://unavailable.example/",
      hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
      locatorSalt: LOCATOR_SALT,
      enabled: true,
      inventoryPageSize: 100,
    } as const;
    const corruptRemote = {
      remoteId: "00000000-0000-7000-8000-000000000002",
      vaultId: creation.ids.vaultId,
      name: "Corrupt Host",
      endpoint: "https://corrupt.example/",
      hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cd",
      locatorSalt: LOCATOR_SALT,
      enabled: true,
      inventoryPageSize: 100,
    } as const;
    const expectedRemote = {
      remoteId: REMOTE_ID,
      vaultId: creation.ids.vaultId,
      name: "Host",
      endpoint: "https://host.example/",
      hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
      locatorSalt: LOCATOR_SALT,
      enabled: true,
      inventoryPageSize: 100,
    } as const;
    const service = new CanonicalHostedArtifactHydrationService({
      remotes: {
        list: async () => [expectedRemote, corruptRemote, unavailableRemote, inaccessibleRemote],
        load: async ({ remoteId }) => {
          if (remoteId === inaccessibleRemote.remoteId) {
            throw new TypeError("Remote channel is unavailable");
          }
          return {
            remote:
              remoteId === unavailableRemote.remoteId
                ? unavailableRemote
                : remoteId === corruptRemote.remoteId
                  ? corruptRemote
                  : expectedRemote,
            bearerToken: "channel-token",
          };
        },
      },
      vaults: {
        realm: NORMAL_STORAGE_REALM,
        storage: {
          commitReplicaMutation: async (input: unknown) => {
            commits.push(input);
          },
          getBytes: async () => undefined,
        },
        openVault: async () => vault,
        listEpochSecrets: async () => [vault.epochSecret],
        openResolvedCompactItem: async () => ({ payloadBytes: object.bytes }),
        readLogicalResolution: async () => {
          throw new TypeError("Artifact resolution is unavailable");
        },
      },
      artifacts,
      createHttp: ({ endpoint }) =>
        endpoint === unavailableRemote.endpoint
          ? {
              inventory: async () => {
                throw new TypeError("Remote inventory is unavailable");
              },
              item: async () => {
                throw new TypeError("Remote item is unavailable");
              },
            }
          : endpoint === corruptRemote.endpoint
            ? {
                inventory: async () => ({
                  snapshotCursor: 1,
                  nextPosition: null,
                  items: [
                    {
                      storageItemId: corruptStorageItemId,
                      storageClass: 2 as const,
                      byteLength: corruptWrapper.byteLength,
                      ciphertextDigest: corruptSealed.envelopePrefix.ciphertextDigest,
                      locator,
                    },
                  ],
                }),
                item: async () => stream(corruptWrapper),
              }
            : {
                inventory: async () => ({
                  snapshotCursor: 1,
                  nextPosition: null,
                  items: [
                    {
                      storageItemId,
                      storageClass: 2 as const,
                      byteLength: wrapper.byteLength,
                      ciphertextDigest: sealed.envelopePrefix.ciphertextDigest,
                      locator,
                    },
                  ],
                }),
                item: async () => stream(wrapper),
              },
    });

    await expect(
      service.hydrate({ vaultId: creation.ids.vaultId, artifactId: artifactId(object) }),
    ).resolves.toEqual({ artifactId: artifactId(object), storageItemId, remoteId: REMOTE_ID });

    expect(await artifacts.has(storageItemId)).toBe(true);
    expect(await artifacts.has(corruptStorageItemId)).toBe(true);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual(
      expect.objectContaining({
        realm: NORMAL_STORAGE_REALM,
        expectedReplicaState: vault.replicaStateStorageBytes,
        expectedAbsentItems: [
          {
            namespace: NAMESPACES.logicalResolution.key,
            scopeKey: identifierStorageKey(creation.ids.vaultId),
            itemKey: `5:${identifierStorageKey(artifactId(object))}`,
          },
        ],
      }),
    );
  });
});

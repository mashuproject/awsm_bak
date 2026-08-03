import { describe, expect, it, vi } from "vitest";
import { sealArtifactFrames } from "../../src/crypto/artifact-stream";
import {
  createKeyEpoch,
  deriveRecoveryCredential,
  encodeRecoveryPhrase,
} from "../../src/crypto/canonical";
import { sealCompactItem } from "../../src/crypto/compact";
import { sealKeyEnvelope } from "../../src/crypto/key-envelope";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import {
  type Identifier,
  identifier,
  randomIdentifier,
} from "../../src/domain/canonical/identifiers";
import { signVaultEvent } from "../../src/domain/canonical/record";
import { concatBytes } from "../../src/domain/canonical/transcript";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../../src/runtime/artifact/canonical-store";
import { prepareCanonicalCapture } from "../../src/runtime/capture/canonical-prepare";
import { createPageSnapshotBlob } from "../../src/runtime/page-snapshot";
import { CanonicalReplayService } from "../../src/runtime/projection/canonical-replay";
import type {
  CanonicalHostedReplicaSummary,
  CanonicalOpaqueInventoryItem,
} from "../../src/runtime/synchronization/canonical-host-http";
import {
  CanonicalHostedRecoveryClosureService,
  wipeHostedRecoveryClosure,
} from "../../src/runtime/synchronization/canonical-hosted-recovery-closure";
import { CanonicalHostedRecoveryDiscoveryService } from "../../src/runtime/synchronization/canonical-hosted-recovery-discovery";
import { deriveHostedReplicaOpaqueLocator } from "../../src/runtime/synchronization/canonical-hosted-replica-locator";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import { prepareVacuum } from "../../src/runtime/vault/canonical-vacuum-content-checkpoint";
import { decodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function replica(replicaHandle: string): CanonicalHostedReplicaSummary {
  return {
    replicaHandle,
    locatorSalt: crypto.getRandomValues(new Uint8Array(32)),
    capabilities: ["awsm.replica.inventory.read", "awsm.replica.item.read"],
    quotaBytes: null,
    storedBytes: 0,
  };
}

class MemoryArtifactStore implements CanonicalArtifactStore {
  readonly bytes = new Map<string, Uint8Array>();

  async prepare(
    input: Parameters<CanonicalArtifactStore["prepare"]>[0],
  ): Promise<PreparedArtifactRepresentation> {
    const frames: Uint8Array[] = [];
    const stream = await sealArtifactFrames({
      ...input,
      writeFrame: async (frame) => {
        frames.push(Uint8Array.from(frame));
      },
    });
    const bytes = concatBytes([stream.envelopePrefix.prefixBytes, ...frames]);
    const storageItemId = decodeOpaqueEnvelope(bytes).storageItemId;
    return {
      artifactId: input.artifactId,
      storageItemId,
      envelopeByteLength: bytes.byteLength,
      stream,
      promote: async () => {
        this.bytes.set(identifierStorageKey(storageItemId), bytes);
      },
      discard: async () => {
        this.bytes.delete(identifierStorageKey(storageItemId));
      },
    };
  }

  async has(storageItemId: Identifier<"StorageItem">): Promise<boolean> {
    return this.bytes.has(identifierStorageKey(storageItemId));
  }

  async open(storageItemId: Identifier<"StorageItem">): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.bytes.get(identifierStorageKey(storageItemId));
    if (bytes === undefined) throw new Error("Expected a prepared Artifact wrapper");
    return stream(bytes);
  }

  async remove(storageItemId: Identifier<"StorageItem">): Promise<void> {
    this.bytes.delete(identifierStorageKey(storageItemId));
  }
}

async function initialRecoveryReplica() {
  const creation = await prepareCanonicalVaultCreation({ label: "Recovered", assertedAt: 1 });
  const replicaSummary = replica("123e4567-e89b-42d3-a456-426614174000");
  const sourceItems: readonly (readonly [1 | 2, Uint8Array, Uint8Array])[] = [
    [1, creation.baseline.recordId, creation.baselineEnvelope.bytes],
    [1, creation.genesis.recordId, creation.genesisEnvelope.bytes],
    [2, creation.recoveryKeyEnvelope.id, creation.recoveryKeyEnvelope.envelope.bytes],
    [2, creation.clientKeyEnvelope.id, creation.clientKeyEnvelope.envelope.bytes],
  ];
  const items = await Promise.all(
    sourceItems.map(async ([namespace, logicalId, bytes]) => {
      const envelope = decodeOpaqueEnvelope(bytes);
      return {
        storageItemId: envelope.storageItemId,
        storageClass: 1 as const,
        byteLength: bytes.byteLength,
        ciphertextDigest: envelope.ciphertextDigest,
        locator: await deriveHostedReplicaOpaqueLocator({
          locatorSalt: replicaSummary.locatorSalt,
          logicalNamespace: namespace,
          logicalId,
        }),
        bytes,
      };
    }),
  );
  const bytes = new Map(
    items.map((item) => [identifierStorageKey(item.storageItemId), item.bytes]),
  );
  const http = {
    listReplicas: vi.fn(
      async (): Promise<readonly CanonicalHostedReplicaSummary[]> => [replicaSummary],
    ),
    inventory: vi.fn(
      async (): Promise<{
        readonly snapshotCursor: number;
        readonly nextPosition: null;
        readonly items: readonly CanonicalOpaqueInventoryItem[];
      }> => ({
        snapshotCursor: 7,
        nextPosition: null,
        items: items.map(({ bytes: _bytes, ...item }) => item),
      }),
    ),
    item: vi.fn(
      async ({ storageItemId }: { readonly storageItemId: Identifier<"StorageItem"> }) => {
        const item = bytes.get(identifierStorageKey(storageItemId));
        if (item === undefined) throw new Error("Unexpected opaque item fetch");
        return stream(item);
      },
    ),
  };
  return {
    creation,
    http,
    replicaSummary,
    bytes,
    inventoryItems: items.map(({ bytes: _bytes, ...item }) => item),
  };
}

async function initialOpenedVault(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
) {
  return {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Recovered",
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      causalFrontier: [creation.genesis.recordId],
      authorityFrontier: [creation.genesis.recordId],
      continuityRecordIds: [creation.genesis.recordId],
      baselineId: creation.baseline.recordId,
      currentKeyEpochId: creation.secrets.keyEpoch.id,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      authoringClientCredentialId: creation.ids.clientCredentialId,
      memberId: creation.ids.firstMemberId,
      lifecycle: 1 as const,
      preservationRoots: [],
      garbageCollectionFences: [],
      adoption: null,
    },
    clientSecret: {
      vaultId: creation.ids.vaultId,
      memberId: creation.ids.firstMemberId,
      clientCredentialId: creation.ids.clientCredentialId,
      signingPublicKey: creation.secrets.client.signingPublicKey,
      signingSecretKey: creation.secrets.client.signingSecretKey,
      wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
      wrappingPrivateKey: creation.secrets.client.wrappingPrivateKey,
    },
    epochSecret: {
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      displayNumber: 0,
      key: creation.secrets.keyEpoch.key,
    },
    baseline: creation.baseline,
    genesis: creation.genesis,
    installationWrappingKey: {} as CryptoKey,
    replicaStateStorageBytes: new Uint8Array(),
  };
}

describe("Hosted Recovery discovery", () => {
  it("opens only phrase-owned Recovery Envelopes from bounded opaque Compact inventory", async () => {
    const phrase = encodeRecoveryPhrase(Uint8Array.from({ length: 16 }, (_, index) => index + 1));
    const keys = await deriveRecoveryCredential(
      Uint8Array.from({ length: 16 }, (_, index) => index + 1),
    );
    const vaultId = randomIdentifier("Vault");
    const epoch = createKeyEpoch(vaultId);
    const envelope = await sealKeyEnvelope({
      vaultId,
      keyEpochId: epoch.id,
      keyEpochKey: epoch.key,
      targetKind: 1,
      targetCredentialId: randomIdentifier("RecoveryCredential"),
      targetRevision: 0,
      recipientWrappingPublicKey: keys.wrappingPublicKey,
    });
    const otherKeys = await deriveRecoveryCredential(new Uint8Array(16).fill(99));
    const otherEnvelope = await sealKeyEnvelope({
      vaultId,
      keyEpochId: epoch.id,
      keyEpochKey: epoch.key,
      targetKind: 1,
      targetCredentialId: randomIdentifier("RecoveryCredential"),
      targetRevision: 0,
      recipientWrappingPublicKey: otherKeys.wrappingPublicKey,
    });
    const inventoryItem: CanonicalOpaqueInventoryItem = {
      storageItemId: envelope.envelope.storageItemId,
      storageClass: 1,
      byteLength: envelope.envelope.bytes.byteLength,
      ciphertextDigest: envelope.envelope.ciphertextDigest,
      locator: crypto.getRandomValues(new Uint8Array(32)),
    };
    const other = randomIdentifier("StorageItem");
    const http = {
      listReplicas: vi.fn(async () => [replica("123e4567-e89b-42d3-a456-426614174000")]),
      inventory: vi.fn(async () => ({
        snapshotCursor: 7,
        nextPosition: null,
        items: [
          {
            storageItemId: other,
            storageClass: 2 as const,
            byteLength: 1,
            ciphertextDigest: crypto.getRandomValues(new Uint8Array(32)),
            locator: crypto.getRandomValues(new Uint8Array(32)),
          },
          inventoryItem,
          {
            storageItemId: otherEnvelope.envelope.storageItemId,
            storageClass: 1 as const,
            byteLength: otherEnvelope.envelope.bytes.byteLength,
            ciphertextDigest: otherEnvelope.envelope.ciphertextDigest,
            locator: crypto.getRandomValues(new Uint8Array(32)),
          },
        ],
      })),
      item: vi.fn(async ({ storageItemId }: { readonly storageItemId: Uint8Array }) => {
        if (storageItemId.every((byte, index) => byte === envelope.envelope.storageItemId[index])) {
          return stream(envelope.envelope.bytes);
        }
        if (
          storageItemId.every((byte, index) => byte === otherEnvelope.envelope.storageItemId[index])
        ) {
          return stream(otherEnvelope.envelope.bytes);
        }
        throw new Error("Unexpected opaque item fetch");
      }),
    };
    const service = new CanonicalHostedRecoveryDiscoveryService({
      createHttp: () => http,
    });

    await expect(
      service.discover({
        endpoint: "https://sync.example.test/",
        bearerToken: "ephemeral-channel-token",
        recoveryPhrase: phrase,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        replicaHandle: "123e4567-e89b-42d3-a456-426614174000",
        storageItemId: envelope.envelope.storageItemId,
        vaultId,
        keyEpochId: epoch.id,
      }),
    ]);
    expect(http.inventory).toHaveBeenCalledWith({
      replicaHandle: "123e4567-e89b-42d3-a456-426614174000",
      limit: 128,
    });
    expect(http.item).toHaveBeenCalledTimes(2);
  });

  it("authenticates a phrase-openable candidate only after the complete initial authority closure", async () => {
    const { creation, http } = await initialRecoveryReplica();
    const discovery = new CanonicalHostedRecoveryDiscoveryService({ createHttp: () => http });
    const [candidate] = await discovery.discover({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
    });
    if (candidate === undefined) throw new Error("Expected one phrase-openable candidate");
    const closure = new CanonicalHostedRecoveryClosureService({ createHttp: () => http });

    const recovered = await closure.authenticate({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
      candidate,
    });
    try {
      expect(recovered).toEqual(
        expect.objectContaining({
          replicaHandle: candidate.replicaHandle,
          replicaState: expect.objectContaining({
            vaultId: creation.ids.vaultId,
            baselineId: creation.baseline.recordId,
            causalFrontier: [creation.genesis.recordId],
          }),
        }),
      );
    } finally {
      await wipeHostedRecoveryClosure(recovered);
    }
  });

  it("rejects a phrase-openable candidate when its authority closure omits a required envelope", async () => {
    const { creation, http, inventoryItems } = await initialRecoveryReplica();
    const clientEnvelopeKey = identifierStorageKey(
      creation.clientKeyEnvelope.envelope.storageItemId,
    );
    http.inventory.mockImplementation(async () => ({
      snapshotCursor: 7,
      nextPosition: null,
      items: inventoryItems.filter(
        (item: CanonicalOpaqueInventoryItem) =>
          identifierStorageKey(item.storageItemId) !== clientEnvelopeKey,
      ),
    }));
    const discovery = new CanonicalHostedRecoveryDiscoveryService({ createHttp: () => http });
    const [candidate] = await discovery.discover({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
    });
    if (candidate === undefined) throw new Error("Expected one phrase-openable candidate");
    const closure = new CanonicalHostedRecoveryClosureService({ createHttp: () => http });

    await expect(
      closure.authenticate({
        endpoint: "https://sync.example.test/",
        bearerToken: "ephemeral-channel-token",
        recoveryPhrase: creation.recoveryPhrase,
        candidate,
      }),
    ).rejects.toThrow(/closure|unavailable/u);
  });

  it("authenticates every reachable Epoch rather than assigning the discovery Epoch globally", async () => {
    const { creation, http, replicaSummary, bytes, inventoryItems } =
      await initialRecoveryReplica();
    const successorEpoch = createKeyEpoch(creation.ids.vaultId);
    const recoveryEnvelope = await sealKeyEnvelope({
      vaultId: creation.ids.vaultId,
      keyEpochId: successorEpoch.id,
      keyEpochKey: successorEpoch.key,
      targetKind: 1,
      targetCredentialId: creation.ids.recoveryCredentialId,
      targetRevision: 0,
      recipientWrappingPublicKey: creation.secrets.recovery.wrappingPublicKey,
    });
    const clientEnvelope = await sealKeyEnvelope({
      vaultId: creation.ids.vaultId,
      keyEpochId: successorEpoch.id,
      keyEpochKey: successorEpoch.key,
      targetKind: 2,
      targetCredentialId: creation.ids.clientCredentialId,
      targetRevision: null,
      recipientWrappingPublicKey: creation.secrets.client.wrappingPublicKey,
    });
    const transition = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [recoveryEnvelope.id, clientEnvelope.id].map((id) => ({
          type: DEPENDENCY_TYPES.KeyEnvelope,
          id,
        })),
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 12,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 2,
        body: canonicalMap([
          [0, canonicalSet([creation.secrets.keyEpoch.id])],
          [1, successorEpoch.id],
          [2, 1],
          [
            3,
            canonicalSet([
              canonicalMap([
                [0, successorEpoch.id],
                [1, 1],
                [2, creation.ids.recoveryCredentialId],
                [3, 0],
                [4, recoveryEnvelope.id],
              ]),
              canonicalMap([
                [0, successorEpoch.id],
                [1, 2],
                [2, creation.ids.clientCredentialId],
                [3, null],
                [4, clientEnvelope.id],
              ]),
            ]),
          ],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const transitionEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: transition.bytes,
    });
    const sourceItems: readonly (readonly [1 | 2, Uint8Array, Uint8Array])[] = [
      [1, transition.recordId, transitionEnvelope.bytes],
      [2, recoveryEnvelope.id, recoveryEnvelope.envelope.bytes],
      [2, clientEnvelope.id, clientEnvelope.envelope.bytes],
    ];
    const additions = await Promise.all(
      sourceItems.map(async ([namespace, logicalId, itemBytes]) => {
        const envelope = decodeOpaqueEnvelope(itemBytes);
        return {
          storageItemId: envelope.storageItemId,
          storageClass: 1 as const,
          byteLength: itemBytes.byteLength,
          ciphertextDigest: envelope.ciphertextDigest,
          locator: await deriveHostedReplicaOpaqueLocator({
            locatorSalt: replicaSummary.locatorSalt,
            logicalNamespace: namespace,
            logicalId,
          }),
          bytes: itemBytes,
        };
      }),
    );
    for (const addition of additions)
      bytes.set(identifierStorageKey(addition.storageItemId), addition.bytes);
    http.inventory.mockImplementation(async () => ({
      snapshotCursor: 7,
      nextPosition: null,
      items: [...inventoryItems, ...additions.map(({ bytes: _bytes, ...item }) => item)],
    }));
    const discovery = new CanonicalHostedRecoveryDiscoveryService({ createHttp: () => http });
    const candidates = await discovery.discover({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
    });
    const candidate = candidates.find(({ keyEpochId }) =>
      keyEpochId.every((byte, index) => byte === creation.secrets.keyEpoch.id[index]),
    );
    if (candidate === undefined) throw new Error("Expected an initial-Epoch Recovery Envelope");
    const closure = new CanonicalHostedRecoveryClosureService({ createHttp: () => http });

    const recovered = await closure.authenticate({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
      candidate,
    });
    try {
      expect(recovered.validated.keyEpochs.map(({ keyEpochId }) => keyEpochId)).toEqual(
        expect.arrayContaining([creation.secrets.keyEpoch.id, successorEpoch.id]),
      );
      expect(recovered.replicaState.currentKeyEpochId).toEqual(successorEpoch.id);
    } finally {
      await wipeHostedRecoveryClosure(recovered);
    }
  });

  it("selects a successor Baseline through its signed Vacuum continuity", async () => {
    const { creation, http, replicaSummary, bytes, inventoryItems } =
      await initialRecoveryReplica();
    const replay = await new CanonicalReplayService({} as never).replayOpened(
      await initialOpenedVault(creation),
    );
    const vacuum = await prepareVacuum({
      replay,
      successorGenerationId: identifier("Generation", new Uint8Array(32).fill(81)),
      assertedAt: 2,
    });
    const successorItems: readonly (readonly [1, Uint8Array, Uint8Array])[] = [
      [1, vacuum.successor.baseline.recordId, vacuum.successor.baselineEnvelope.bytes],
      [1, vacuum.event.recordId, vacuum.eventEnvelope.bytes],
    ];
    const additions = await Promise.all(
      successorItems.map(async ([namespace, logicalId, itemBytes]) => {
        const envelope = decodeOpaqueEnvelope(itemBytes);
        return {
          storageItemId: envelope.storageItemId,
          storageClass: 1 as const,
          byteLength: itemBytes.byteLength,
          ciphertextDigest: envelope.ciphertextDigest,
          locator: await deriveHostedReplicaOpaqueLocator({
            locatorSalt: replicaSummary.locatorSalt,
            logicalNamespace: namespace,
            logicalId,
          }),
          bytes: itemBytes,
        };
      }),
    );
    const combined = [...inventoryItems, ...additions.map(({ bytes: _bytes, ...item }) => item)];
    for (const addition of additions)
      bytes.set(identifierStorageKey(addition.storageItemId), addition.bytes);
    http.inventory.mockImplementation(async () => ({
      snapshotCursor: 7,
      nextPosition: null,
      items: combined,
    }));
    const discovery = new CanonicalHostedRecoveryDiscoveryService({ createHttp: () => http });
    const [candidate] = await discovery.discover({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
    });
    if (candidate === undefined) throw new Error("Expected one phrase-openable candidate");
    const closure = new CanonicalHostedRecoveryClosureService({ createHttp: () => http });

    const recovered = await closure.authenticate({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
      candidate,
    });
    try {
      expect(recovered).toEqual(
        expect.objectContaining({
          replicaState: expect.objectContaining({
            baselineId: vacuum.successor.baseline.recordId,
            generationId: vacuum.successor.baseline.generationId,
            adoption: { vacuumEventRecordId: vacuum.event.recordId },
          }),
        }),
      );
    } finally {
      await wipeHostedRecoveryClosure(recovered);
    }
  });

  it("authenticates the Streamable Artifact dependency of an otherwise complete closure", async () => {
    const { creation, http, replicaSummary, bytes, inventoryItems } =
      await initialRecoveryReplica();
    const artifacts = new MemoryArtifactStore();
    const snapshot = await createPageSnapshotBlob({
      capturedAt: 2,
      originalUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      documents: [
        {
          originalUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          bytes: new TextEncoder().encode("<!doctype html><title>Snapshot</title>"),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
      omissions: [],
    });
    const capture = await prepareCanonicalCapture({
      vault: await initialOpenedVault(creation),
      artifactStore: artifacts,
      originalUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      title: "Example",
      capturedAt: 2,
      primary: { blob: snapshot.blob },
      artifactProtectionParameters: new Uint8Array(64).fill(21),
      artifactObjectProtectionParameters: new Uint8Array(64).fill(22),
      descriptorProtectionParameters: new Uint8Array(64).fill(23),
      eventProtectionParameters: new Uint8Array(64).fill(24),
    });
    await capture.artifactRepresentation.promote();
    const artifactBytes = artifacts.bytes.get(
      identifierStorageKey(capture.artifactRepresentation.storageItemId),
    );
    if (artifactBytes === undefined) throw new Error("Expected a promoted Artifact wrapper");
    const sourceItems: readonly (readonly [1 | 3 | 5, Uint8Array, Uint8Array])[] = [
      [1, capture.event.recordId, capture.eventEnvelope.bytes],
      [3, capture.descriptorObject.objectId, capture.descriptorObjectEnvelope.bytes],
      [3, capture.artifactObject.objectId, capture.artifactObjectEnvelope.bytes],
      [5, capture.artifactRepresentation.artifactId, artifactBytes],
    ];
    const additions = await Promise.all(
      sourceItems.map(async ([namespace, logicalId, itemBytes]) => {
        const envelope = decodeOpaqueEnvelope(itemBytes);
        return {
          storageItemId: envelope.storageItemId,
          storageClass: namespace === 5 ? (2 as const) : (1 as const),
          byteLength: itemBytes.byteLength,
          ciphertextDigest: envelope.ciphertextDigest,
          locator: await deriveHostedReplicaOpaqueLocator({
            locatorSalt: replicaSummary.locatorSalt,
            logicalNamespace: namespace,
            logicalId,
          }),
          bytes: itemBytes,
        };
      }),
    );
    for (const addition of additions)
      bytes.set(identifierStorageKey(addition.storageItemId), addition.bytes);
    http.inventory.mockImplementation(async () => ({
      snapshotCursor: 7,
      nextPosition: null,
      items: [...inventoryItems, ...additions.map(({ bytes: _bytes, ...item }) => item)],
    }));
    const discovery = new CanonicalHostedRecoveryDiscoveryService({ createHttp: () => http });
    const [candidate] = await discovery.discover({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
    });
    if (candidate === undefined) throw new Error("Expected one phrase-openable candidate");
    const closure = new CanonicalHostedRecoveryClosureService({ createHttp: () => http });

    const recovered = await closure.authenticate({
      endpoint: "https://sync.example.test/",
      bearerToken: "ephemeral-channel-token",
      recoveryPhrase: creation.recoveryPhrase,
      candidate,
    });
    try {
      expect(recovered.validated.reachability.artifactIds).toEqual([
        capture.artifactRepresentation.artifactId,
      ]);
    } finally {
      await wipeHostedRecoveryClosure(recovered);
    }
  });
});

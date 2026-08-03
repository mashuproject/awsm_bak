import { describe, expect, it, vi } from "vitest";

import {
  createKeyEpoch,
  deriveRecoveryCredential,
  encodeRecoveryPhrase,
} from "../../src/crypto/canonical";
import { sealKeyEnvelope } from "../../src/crypto/key-envelope";
import { type Identifier, randomIdentifier } from "../../src/domain/canonical/identifiers";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
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
    listReplicas: vi.fn(async () => [replicaSummary]),
    inventory: vi.fn(async () => ({
      snapshotCursor: 7,
      nextPosition: null,
      items: items.map(({ bytes: _bytes, ...item }) => item),
    })),
    item: vi.fn(
      async ({ storageItemId }: { readonly storageItemId: Identifier<"StorageItem"> }) => {
        const item = bytes.get(identifierStorageKey(storageItemId));
        if (item === undefined) throw new Error("Unexpected opaque item fetch");
        return stream(item);
      },
    ),
  };
  return { creation, http, inventoryItems: items.map(({ bytes: _bytes, ...item }) => item) };
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
});

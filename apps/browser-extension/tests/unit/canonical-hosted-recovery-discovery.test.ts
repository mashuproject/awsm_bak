import { describe, expect, it, vi } from "vitest";

import {
  createKeyEpoch,
  deriveRecoveryCredential,
  encodeRecoveryPhrase,
} from "../../src/crypto/canonical";
import { sealKeyEnvelope } from "../../src/crypto/key-envelope";
import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import type {
  CanonicalHostedReplicaSummary,
  CanonicalOpaqueInventoryItem,
} from "../../src/runtime/synchronization/canonical-host-http";
import { CanonicalHostedRecoveryDiscoveryService } from "../../src/runtime/synchronization/canonical-hosted-recovery-discovery";

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
});

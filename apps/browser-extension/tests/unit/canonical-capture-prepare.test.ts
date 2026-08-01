import { describe, expect, it } from "vitest";

import { sealArtifactFrames } from "../../src/crypto/artifact-stream";
import { openCompactItem } from "../../src/crypto/compact";
import type { Identifier } from "../../src/domain/canonical/identifiers";
import { decodeVaultObject } from "../../src/domain/canonical/object";
import { verifyVaultEventSignature } from "../../src/domain/canonical/record";
import { concatBytes } from "../../src/domain/canonical/transcript";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../../src/runtime/artifact/canonical-store";
import { prepareCanonicalCapture } from "../../src/runtime/capture/canonical-prepare";
import { createPageSnapshotBlob } from "../../src/runtime/page-snapshot";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import {
  type OpenedCanonicalVault,
  requireCanonicalClientSecret,
} from "../../src/runtime/vault/canonical-service";
import { decodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

async function pageSnapshot(input: {
  readonly capturedAt: number;
  readonly originalUrl: string;
  readonly finalUrl: string;
}): Promise<Blob> {
  return (
    await createPageSnapshotBlob({
      ...input,
      documents: [
        {
          originalUrl: input.originalUrl,
          finalUrl: input.finalUrl,
          bytes: new TextEncoder().encode("<!doctype html><title>Snapshot</title>"),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
      omissions: [],
    })
  ).blob;
}

class MemoryCanonicalArtifactStore implements CanonicalArtifactStore {
  readonly promoted = new Map<string, Uint8Array>();
  discarded = 0;

  async prepare(
    input: Parameters<CanonicalArtifactStore["prepare"]>[0],
  ): Promise<PreparedArtifactRepresentation> {
    const frames: Uint8Array[] = [];
    const sealed = await sealArtifactFrames({
      ...input,
      writeFrame: async (frame) => {
        frames.push(Uint8Array.from(frame));
      },
    });
    const bytes = concatBytes([sealed.envelopePrefix.prefixBytes, ...frames]);
    const envelope = decodeOpaqueEnvelope(bytes);
    const key = hex(envelope.storageItemId);
    let promoted = false;
    return {
      artifactId: input.artifactId,
      storageItemId: envelope.storageItemId,
      envelopeByteLength: bytes.byteLength,
      stream: sealed,
      promote: async () => {
        this.promoted.set(key, bytes);
        promoted = true;
      },
      discard: async () => {
        if (promoted) this.promoted.delete(key);
        this.discarded += 1;
      },
    };
  }

  async has(storageItemId: Identifier<"StorageItem">): Promise<boolean> {
    return this.promoted.has(hex(storageItemId));
  }

  async open(storageItemId: Identifier<"StorageItem">): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.promoted.get(hex(storageItemId));
    if (bytes === undefined) throw new Error("missing Artifact");
    return new Blob([Uint8Array.from(bytes)]).stream();
  }

  async remove(storageItemId: Identifier<"StorageItem">): Promise<void> {
    this.promoted.delete(hex(storageItemId));
  }
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function openedInitialVault(): Promise<OpenedCanonicalVault> {
  const creation = await prepareCanonicalVaultCreation({ label: "Vault", assertedAt: 1 });
  const replicaState: CanonicalReplicaState = {
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
    lifecycle: 1,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
  return {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Vault",
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState,
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
  };
}

describe("canonical Capture preparation", () => {
  it("rejects non-snapshot primary bytes before preparing Artifact storage", async () => {
    const vault = await openedInitialVault();
    const store = new MemoryCanonicalArtifactStore();
    const payload = new TextEncoder().encode("not a page-snapshot ZIP");

    await expect(
      prepareCanonicalCapture({
        vault,
        artifactStore: store,
        originalUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        title: null,
        capturedAt: 1,
        primary: { blob: new Blob([payload]) },
      }),
    ).rejects.toThrow(/page snapshot|ZIP|signature/iu);
    expect(store.promoted.size).toBe(0);
    expect(store.discarded).toBe(0);
  });

  it("rejects a valid snapshot whose provenance does not match the Capture", async () => {
    const vault = await openedInitialVault();
    const store = new MemoryCanonicalArtifactStore();
    const snapshot = await pageSnapshot({
      capturedAt: 10,
      originalUrl: "https://example.com/source",
      finalUrl: "https://example.com/final",
    });

    await expect(
      prepareCanonicalCapture({
        vault,
        artifactStore: store,
        originalUrl: "https://example.com/source",
        finalUrl: "https://example.com/final",
        title: null,
        capturedAt: 11,
        primary: { blob: snapshot },
      }),
    ).rejects.toThrow(/provenance|does not match/iu);
    expect(store.promoted.size).toBe(0);
    expect(store.discarded).toBe(0);
  });

  it("prepares one complete primary Artifact graph and signed Bundle registration", async () => {
    const vault = await openedInitialVault();
    const store = new MemoryCanonicalArtifactStore();
    const payload = await pageSnapshot({
      capturedAt: 1_800_000_000_001,
      originalUrl: "https://example.com/page",
      finalUrl: "https://example.com/page?view=final",
    });
    const prepared = await prepareCanonicalCapture({
      vault,
      artifactStore: store,
      originalUrl: "https://example.com/page#fragment",
      finalUrl: "https://example.com/page?view=final#ignored",
      title: "Example page",
      capturedAt: 1_800_000_000_001,
      primary: { blob: payload },
      artifactProtectionParameters: new Uint8Array(64).fill(1),
      artifactObjectProtectionParameters: new Uint8Array(64).fill(2),
      descriptorProtectionParameters: new Uint8Array(64).fill(3),
      eventProtectionParameters: new Uint8Array(64).fill(4),
    });

    expect(prepared.descriptorObject.referencedObjectIds).toEqual([
      prepared.artifactObject.objectId,
    ]);
    expect(prepared.event.dependencies).toEqual([
      { type: 4, id: prepared.descriptorObject.objectId },
    ]);
    expect(prepared.event.parentRecordIds).toEqual(vault.replicaState.causalFrontier);
    expect(prepared.event.authorityParentRecordIds).toEqual(vault.replicaState.authorityFrontier);
    expect(prepared.nextReplicaState.causalFrontier).toEqual([prepared.event.recordId]);
    expect(
      await verifyVaultEventSignature(
        prepared.event,
        requireCanonicalClientSecret(vault).signingPublicKey,
      ),
    ).toBe(true);
    const openedObject = await openCompactItem({
      vaultId: vault.replicaState.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      envelopeBytes: prepared.artifactObjectEnvelope.bytes,
    });
    expect(decodeVaultObject(openedObject.payloadBytes).objectId).toEqual(
      prepared.artifactObject.objectId,
    );
    expect(await store.has(prepared.artifactRepresentation.storageItemId)).toBe(false);
    await prepared.artifactRepresentation.promote();
    expect(await store.has(prepared.artifactRepresentation.storageItemId)).toBe(true);
  });

  it("discards a prepared heavy wrapper when later graph validation fails", async () => {
    const vault = await openedInitialVault();
    const store = new MemoryCanonicalArtifactStore();
    const payload = await pageSnapshot({
      capturedAt: 1,
      originalUrl: "https://example.com/",
      finalUrl: "https://example.com/",
    });

    await expect(
      prepareCanonicalCapture({
        vault,
        artifactStore: store,
        originalUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        title: "invalid\0title",
        capturedAt: 1,
        primary: { blob: payload },
      }),
    ).rejects.toThrow();
    expect(store.discarded).toBe(1);
    expect(store.promoted.size).toBe(0);
  });
});

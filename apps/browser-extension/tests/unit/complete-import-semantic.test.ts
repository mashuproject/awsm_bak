import { describe, expect, it } from "vitest";

import { sealArtifactFrames } from "../../src/crypto/artifact-stream";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { type Identifier, identifier } from "../../src/domain/canonical/identifiers";
import { concatBytes } from "../../src/domain/canonical/transcript";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../../src/runtime/artifact/canonical-store";
import { prepareCanonicalCapture } from "../../src/runtime/capture/canonical-prepare";
import { prepareCompleteExportEntry } from "../../src/runtime/complete-export/container";
import {
  type CompleteExportManifestInput,
  type CompleteExportOpaqueItem,
  completeExportStateDigest,
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "../../src/runtime/complete-export/contracts";
import {
  type CompleteImportPreparedSource,
  validateCompleteExportSemantics,
} from "../../src/runtime/complete-import/semantic";
import { createPageSnapshotBlob } from "../../src/runtime/page-snapshot";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { OpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";
import { decodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

function key(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

type Creation = Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>;

interface StoredOpaque {
  readonly namespace: 1 | 2 | 3 | 5;
  readonly logicalId: Uint8Array;
  readonly bytes: Uint8Array;
}

function initialStored(creation: Creation): StoredOpaque[] {
  return [
    {
      namespace: 1 as const,
      logicalId: creation.baseline.recordId,
      bytes: creation.baselineEnvelope.bytes,
    },
    {
      namespace: 1 as const,
      logicalId: creation.genesis.recordId,
      bytes: creation.genesisEnvelope.bytes,
    },
    {
      namespace: 2 as const,
      logicalId: creation.recoveryKeyEnvelope.id,
      bytes: creation.recoveryKeyEnvelope.envelope.bytes,
    },
    {
      namespace: 2 as const,
      logicalId: creation.clientKeyEnvelope.id,
      bytes: creation.clientKeyEnvelope.envelope.bytes,
    },
  ];
}

function openedVault(creation: Creation): OpenedCanonicalVault {
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
      label: "Research",
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

class MemoryArtifactStore implements CanonicalArtifactStore {
  readonly promoted = new Map<string, Uint8Array>();

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
        this.promoted.set(key(storageItemId), bytes);
      },
      discard: async () => {
        this.promoted.delete(key(storageItemId));
      },
    };
  }

  async has(storageItemId: Identifier<"StorageItem">): Promise<boolean> {
    return this.promoted.has(key(storageItemId));
  }

  async open(storageItemId: Identifier<"StorageItem">): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.promoted.get(key(storageItemId));
    if (bytes === undefined) throw new Error("missing Artifact wrapper");
    return new Blob([Uint8Array.from(bytes)]).stream();
  }

  async remove(storageItemId: Identifier<"StorageItem">): Promise<void> {
    this.promoted.delete(key(storageItemId));
  }
}

async function packageFrom(input: {
  readonly creation: Creation;
  readonly stored: readonly StoredOpaque[];
  readonly frontierId: Identifier<"VaultRecord">;
}) {
  const { creation, stored } = input;
  const opaqueItemInventory: CompleteExportOpaqueItem[] = stored.map((item) => {
    const entry = prepareCompleteExportEntry(2, item.bytes);
    return {
      namespace: item.namespace,
      logicalId: item.logicalId,
      storageItemId: decodeOpaqueEnvelope(item.bytes).storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      byteLength: entry.header.byteLength,
      byteDigest: entry.header.byteDigest,
    };
  });
  const manifestInput: CompleteExportManifestInput = {
    vaultId: creation.ids.vaultId,
    generationId: creation.ids.generationId,
    frontier: [input.frontierId],
    requiredFeatureSetId: creation.baseline.requiredFeatureSetId,
    typedLogicalRoots: [
      { type: DEPENDENCY_TYPES.VaultRecord, id: input.frontierId },
      { type: DEPENDENCY_TYPES.VaultBaseline, id: creation.baseline.recordId },
    ],
    opaqueItemInventory,
    continuityProofRoots: [creation.genesis.recordId],
  };
  const manifest = decodeCompleteExportManifest(
    encodeCompleteExportManifest({
      format: 1,
      ...manifestInput,
      stateDigest: completeExportStateDigest(manifestInput),
    }),
  );
  const keyInventory = decodeCompleteExportKeyInventory(
    encodeCompleteExportKeyInventory({
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      entries: [
        {
          keyEpochId: creation.secrets.keyEpoch.id,
          keyEpochKey: creation.secrets.keyEpoch.key,
        },
      ],
    }),
  );
  const bytesByStorageId = new Map(
    stored.map((item, index) => [
      key(opaqueItemInventory[index]?.storageItemId ?? new Uint8Array()),
      item.bytes,
    ]),
  );
  const source: CompleteImportPreparedSource = {
    openOpaque: async (item) => {
      const bytes = bytesByStorageId.get(key(item.storageItemId));
      if (bytes === undefined) throw new Error("missing Prepared Data");
      return new Blob([Uint8Array.from(bytes)]).stream();
    },
  };
  return { creation, manifest, keyInventory, source };
}

async function initialVaultPackage() {
  const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
  return packageFrom({
    creation,
    stored: initialStored(creation),
    frontierId: creation.genesis.recordId,
  });
}

async function capturedVaultPackage() {
  const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
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
    vault: openedVault(creation),
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
  const artifactBytes = artifacts.promoted.get(key(capture.artifactRepresentation.storageItemId));
  if (artifactBytes === undefined) throw new Error("missing promoted fixture Artifact");
  return packageFrom({
    creation,
    frontierId: capture.event.recordId,
    stored: [
      ...initialStored(creation),
      { namespace: 1, logicalId: capture.event.recordId, bytes: capture.eventEnvelope.bytes },
      {
        namespace: 3,
        logicalId: capture.descriptorObject.objectId,
        bytes: capture.descriptorObjectEnvelope.bytes,
      },
      {
        namespace: 3,
        logicalId: capture.artifactObject.objectId,
        bytes: capture.artifactObjectEnvelope.bytes,
      },
      {
        namespace: 5,
        logicalId: capture.artifactRepresentation.artifactId,
        bytes: artifactBytes,
      },
    ],
  });
}

describe("canonical Complete Import semantic validation", () => {
  it("recomputes an initial Vault's exact reachable authenticated closure", async () => {
    const fixture = await initialVaultPackage();

    const validated = await validateCompleteExportSemantics(fixture);

    expect(validated.reachability.recordIds).toHaveLength(2);
    expect(validated.reachability.keyEnvelopeIds).toHaveLength(2);
    expect(validated.reachability.vaultObjectIds).toHaveLength(0);
    expect(validated.reachability.artifactIds).toHaveLength(0);
  });

  it("rejects a Key Envelope mapping not committed by reachable Vault Records", async () => {
    const fixture = await initialVaultPackage();
    let replaced = false;
    const opaqueItemInventory = fixture.manifest.opaqueItemInventory.map((item) => {
      if (item.namespace !== 2 || replaced) return item;
      replaced = true;
      return { ...item, logicalId: identifier("KeyEnvelope", new Uint8Array(32).fill(99)) };
    });
    const manifestInput: CompleteExportManifestInput = {
      ...fixture.manifest,
      opaqueItemInventory,
    };
    const manifest = decodeCompleteExportManifest(
      encodeCompleteExportManifest({
        format: 1,
        ...manifestInput,
        stateDigest: completeExportStateDigest(manifestInput),
      }),
    );

    await expect(validateCompleteExportSemantics({ ...fixture, manifest })).rejects.toThrow(
      /reachable inventory/u,
    );
  });

  it("authenticates a streamed Artifact wrapper against its reachable Artifact Object", async () => {
    const fixture = await capturedVaultPackage();

    const validated = await validateCompleteExportSemantics(fixture);

    expect(validated.reachability.recordIds).toHaveLength(3);
    expect(validated.reachability.vaultObjectIds).toHaveLength(2);
    expect(validated.reachability.artifactIds).toHaveLength(1);
  });
});

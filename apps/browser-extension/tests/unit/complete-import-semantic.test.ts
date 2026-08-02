import { describe, expect, it, vi } from "vitest";
import { sealArtifactFrames } from "../../src/crypto/artifact-stream";
import { createClientCredentialKeys } from "../../src/crypto/canonical";
import { sealCompactItem } from "../../src/crypto/compact";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { type Identifier, identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import { signVaultEvent } from "../../src/domain/canonical/record";
import { exactMap, mapValue } from "../../src/domain/canonical/schema";
import { concatBytes } from "../../src/domain/canonical/transcript";
import { canonicalMap } from "../../src/domain/canonical/value";
import type {
  CanonicalIndexedDb,
  InitialVaultCommit,
} from "../../src/drivers/indexeddb/canonical-database";
import { CanonicalStorageError } from "../../src/drivers/indexeddb/canonical-database";
import { NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../../src/runtime/artifact/canonical-store";
import { prepareCanonicalCapture } from "../../src/runtime/capture/canonical-prepare";
import { prepareCompleteExportEntry } from "../../src/runtime/complete-export/container";
import {
  type CompleteExportKeyEpochEntry,
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
import { CanonicalCompleteImportService } from "../../src/runtime/complete-import/service";
import { createPageSnapshotBlob } from "../../src/runtime/page-snapshot";
import { CanonicalReplayService } from "../../src/runtime/projection/canonical-replay";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import {
  type CanonicalReplicaState,
  decodeCanonicalReplicaState,
  decodeEpochSecretState,
  decodeLogicalResolution,
  decodeVaultDirectoryEntry,
  openWrappedLocalState,
} from "../../src/runtime/vault/canonical-local-state";
import type { OpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";
import { prepareVacuum } from "../../src/runtime/vault/canonical-vacuum-content-checkpoint";
import { decodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

function key(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

type Creation = Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>;

interface StoredOpaque {
  readonly namespace: 1 | 2 | 3 | 5;
  readonly logicalId: Uint8Array;
  readonly bytes: Uint8Array;
  readonly keyEpochId?: Identifier<"KeyEpoch">;
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
  readonly authorityFrontierId?: Identifier<"VaultRecord">;
  readonly generationId?: Identifier<"Generation">;
  readonly baselineId?: Identifier<"VaultRecord">;
  readonly keyEpochEntries?: readonly CompleteExportKeyEpochEntry[];
}) {
  const { creation, stored } = input;
  const generationId = input.generationId ?? creation.ids.generationId;
  const baselineId = input.baselineId ?? creation.baseline.recordId;
  const opaqueItemInventory: CompleteExportOpaqueItem[] = stored.map((item) => {
    const entry = prepareCompleteExportEntry(2, item.bytes);
    return {
      namespace: item.namespace,
      logicalId: item.logicalId,
      storageItemId: decodeOpaqueEnvelope(item.bytes).storageItemId,
      keyEpochId: item.keyEpochId ?? creation.secrets.keyEpoch.id,
      byteLength: entry.header.byteLength,
      byteDigest: entry.header.byteDigest,
    };
  });
  const manifestInput: CompleteExportManifestInput = {
    vaultId: creation.ids.vaultId,
    generationId,
    frontier: [input.frontierId],
    requiredFeatureSetId: creation.baseline.requiredFeatureSetId,
    typedLogicalRoots: [
      { type: DEPENDENCY_TYPES.VaultRecord, id: input.frontierId },
      { type: DEPENDENCY_TYPES.VaultBaseline, id: baselineId },
    ],
    opaqueItemInventory,
    continuityProofRoots: [input.authorityFrontierId ?? creation.genesis.recordId],
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
      generationId,
      entries: input.keyEpochEntries ?? [
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

async function capturedVaultPackage(input: { readonly signingSecretKey?: Uint8Array } = {}) {
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
  const event =
    input.signingSecretKey === undefined
      ? capture.event
      : await signVaultEvent(capture.event, input.signingSecretKey);
  const eventEnvelope =
    input.signingSecretKey === undefined
      ? capture.eventEnvelope
      : await sealCompactItem({
          vaultId: creation.ids.vaultId,
          keyEpochId: creation.secrets.keyEpoch.id,
          keyEpochKey: creation.secrets.keyEpoch.key,
          payloadType: 1,
          payloadBytes: event.bytes,
        });
  return packageFrom({
    creation,
    frontierId: event.recordId,
    stored: [
      ...initialStored(creation),
      { namespace: 1, logicalId: event.recordId, bytes: eventEnvelope.bytes },
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

async function vacuumedVaultPackage(input: { readonly signingSecretKey?: Uint8Array } = {}) {
  const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
  const replay = await new CanonicalReplayService({} as never).replayOpened({
    ...openedVault(creation),
    installationWrappingKey: {} as CryptoKey,
    replicaStateStorageBytes: new Uint8Array(),
  });
  const generationId = identifier("Generation", new Uint8Array(32).fill(81));
  const vacuum = await prepareVacuum({
    replay,
    successorGenerationId: generationId,
    assertedAt: 2,
  });
  const event =
    input.signingSecretKey === undefined
      ? vacuum.event
      : await signVaultEvent(vacuum.event, input.signingSecretKey);
  const eventEnvelope =
    input.signingSecretKey === undefined
      ? vacuum.eventEnvelope
      : await sealCompactItem({
          vaultId: creation.ids.vaultId,
          keyEpochId: creation.secrets.keyEpoch.id,
          keyEpochKey: creation.secrets.keyEpoch.key,
          payloadType: 1,
          payloadBytes: event.bytes,
        });
  return packageFrom({
    creation,
    generationId,
    baselineId: vacuum.successor.baseline.recordId,
    frontierId: vacuum.successor.baseline.recordId,
    authorityFrontierId: event.recordId,
    stored: [
      ...initialStored(creation),
      {
        namespace: 1,
        logicalId: vacuum.successor.baseline.recordId,
        bytes: vacuum.successor.baselineEnvelope.bytes,
      },
      { namespace: 1, logicalId: event.recordId, bytes: eventEnvelope.bytes },
    ],
  });
}

async function installationWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
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

  it("rejects a structurally reachable Genesis signed by an unrelated Credential", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
    const attacker = await createClientCredentialKeys();
    const forgedGenesis = await signVaultEvent(creation.genesis, attacker.signingSecretKey);
    const forgedEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: forgedGenesis.bytes,
    });
    const fixture = await packageFrom({
      creation,
      frontierId: forgedGenesis.recordId,
      authorityFrontierId: forgedGenesis.recordId,
      stored: initialStored(creation).map((item) =>
        item.namespace === 1 && key(item.logicalId) === key(creation.genesis.recordId)
          ? { namespace: 1, logicalId: forgedGenesis.recordId, bytes: forgedEnvelope.bytes }
          : item,
      ),
    });

    await expect(validateCompleteExportSemantics(fixture)).rejects.toThrow(
      "Vault Event signature is invalid",
    );
  });

  it("rejects a Genesis with a forged Recovery possession proof", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
    const body = exactMap(creation.genesis.body, [0, 1, 2, 3, 4, 5, 6], "Genesis body");
    const proof = exactMap(mapValue(body, 6), [0, 1], "Genesis creation proof");
    const forgedBody = canonicalMap([
      [0, mapValue(body, 0)],
      [1, mapValue(body, 1)],
      [2, mapValue(body, 2)],
      [3, mapValue(body, 3)],
      [4, mapValue(body, 4)],
      [5, mapValue(body, 5)],
      [
        6,
        canonicalMap([
          [0, mapValue(proof, 0)],
          [1, new Uint8Array(64).fill(93)],
        ]),
      ],
    ]);
    const forgedGenesis = await signVaultEvent(
      { ...creation.genesis, body: forgedBody },
      creation.secrets.client.signingSecretKey,
    );
    const forgedEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: forgedGenesis.bytes,
    });
    const fixture = await packageFrom({
      creation,
      frontierId: forgedGenesis.recordId,
      authorityFrontierId: forgedGenesis.recordId,
      stored: initialStored(creation).map((item) =>
        item.namespace === 1 && key(item.logicalId) === key(creation.genesis.recordId)
          ? { namespace: 1, logicalId: forgedGenesis.recordId, bytes: forgedEnvelope.bytes }
          : item,
      ),
    });

    await expect(validateCompleteExportSemantics(fixture)).rejects.toThrow(
      "Genesis signatures are invalid",
    );
  });

  it("rejects a structurally reachable descendant Event signed by an unrelated key", async () => {
    const attacker = await createClientCredentialKeys();
    const fixture = await capturedVaultPackage({
      signingSecretKey: attacker.signingSecretKey,
    });

    await expect(validateCompleteExportSemantics(fixture)).rejects.toThrow(
      "Vault Event signature is invalid",
    );
  });

  it("rejects a successor Baseline anchored by a forged Vacuum Event", async () => {
    const attacker = await createClientCredentialKeys();
    const fixture = await vacuumedVaultPackage({ signingSecretKey: attacker.signingSecretKey });

    await expect(validateCompleteExportSemantics(fixture)).rejects.toThrow(
      "Vault Event signature is invalid",
    );
  });

  it("authenticates a valid successor Baseline through its Vacuum Continuity anchor", async () => {
    const fixture = await vacuumedVaultPackage();

    const validated = await validateCompleteExportSemantics(fixture);

    expect(validated.manifest.generationId).toEqual(fixture.manifest.generationId);
    expect(validated.replicaState).toMatchObject({
      authoringClientCredentialId: null,
      memberId: null,
      lifecycle: 1,
    });
    expect(validated.replicaState.adoption?.vacuumEventRecordId).toEqual(
      fixture.manifest.continuityProofRoots[0],
    );
    expect(validated.replicaState.causalFrontier).toEqual(fixture.manifest.frontier);
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

  it("rejects an unreferenced Key Epoch Secret from the package inventory", async () => {
    const fixture = await initialVaultPackage();
    const extraKey = new Uint8Array(32).fill(77);
    const keyInventory = decodeCompleteExportKeyInventory(
      encodeCompleteExportKeyInventory({
        ...fixture.keyInventory,
        entries: [
          ...fixture.keyInventory.entries,
          {
            keyEpochId: keyEpochId(fixture.creation.ids.vaultId, extraKey),
            keyEpochKey: extraKey,
          },
        ],
      }),
    );

    await expect(validateCompleteExportSemantics({ ...fixture, keyInventory })).rejects.toThrow(
      "Complete Export Key Inventory is not the exact referenced Epoch set",
    );
  });

  it("rejects a wrapper Epoch that is absent from authenticated Authority State", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
    const extraKey = new Uint8Array(32).fill(78);
    const extraEpochId = keyEpochId(creation.ids.vaultId, extraKey);
    const [baselineEnvelope, genesisEnvelope] = await Promise.all([
      sealCompactItem({
        vaultId: creation.ids.vaultId,
        keyEpochId: extraEpochId,
        keyEpochKey: extraKey,
        payloadType: 1,
        payloadBytes: creation.baseline.bytes,
      }),
      sealCompactItem({
        vaultId: creation.ids.vaultId,
        keyEpochId: extraEpochId,
        keyEpochKey: extraKey,
        payloadType: 1,
        payloadBytes: creation.genesis.bytes,
      }),
    ]);
    const fixture = await packageFrom({
      creation,
      frontierId: creation.genesis.recordId,
      keyEpochEntries: [
        {
          keyEpochId: creation.secrets.keyEpoch.id,
          keyEpochKey: creation.secrets.keyEpoch.key,
        },
        { keyEpochId: extraEpochId, keyEpochKey: extraKey },
      ],
      stored: initialStored(creation).map((item) => {
        if (item.logicalId === creation.baseline.recordId) {
          return { ...item, bytes: baselineEnvelope.bytes, keyEpochId: extraEpochId };
        }
        if (item.logicalId === creation.genesis.recordId) {
          return { ...item, bytes: genesisEnvelope.bytes, keyEpochId: extraEpochId };
        }
        return item;
      }),
    });

    await expect(validateCompleteExportSemantics(fixture)).rejects.toThrow(
      "Complete Import Key Epoch is not authenticated by Authority State",
    );
  });

  it("authenticates a streamed Artifact wrapper against its reachable Artifact Object", async () => {
    const fixture = await capturedVaultPackage();

    const validated = await validateCompleteExportSemantics(fixture);

    expect(validated.reachability.recordIds).toHaveLength(3);
    expect(validated.reachability.vaultObjectIds).toHaveLength(2);
    expect(validated.reachability.artifactIds).toHaveLength(1);
  });

  it("atomically activates an unknown package as an authoring-free local Replica", async () => {
    const fixture = await initialVaultPackage();
    const wrappingKey = await installationWrappingKey();
    let committed: InitialVaultCommit | undefined;
    const storage = {
      getOrCreateInstallationWrappingKey: vi.fn(async () => wrappingKey),
      commitInitialVault: vi.fn(async (input: InitialVaultCommit) => {
        committed = input;
      }),
    } as unknown as CanonicalIndexedDb;

    const result = await new CanonicalCompleteImportService(
      storage,
      NORMAL_STORAGE_REALM,
      {} as never,
    ).activateUnknown(fixture);

    expect(result).toEqual({
      vaultId: fixture.creation.ids.vaultId,
      generationId: fixture.creation.ids.generationId,
    });
    expect(storage.commitInitialVault).toHaveBeenCalledOnce();
    if (committed === undefined) throw new Error("missing captured Import commit");
    expect(committed.immutableItems).toHaveLength(4);
    expect(committed.replicaSafetyItems).toHaveLength(4);
    expect(committed.trustedSecrets).toHaveLength(1);
    const replicaState = decodeCanonicalReplicaState(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.replica-state",
        vaultId: fixture.creation.ids.vaultId,
        identity: fixture.creation.ids.generationId,
        wrappedBytes: committed.replicaState.bytes,
      }),
    );
    expect(replicaState).toMatchObject({
      authoringClientCredentialId: null,
      memberId: null,
      adoption: null,
    });
    const directory = decodeVaultDirectoryEntry(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.vault-directory",
        vaultId: fixture.creation.ids.vaultId,
        identity: fixture.creation.ids.vaultId,
        wrappedBytes: committed.vaultDirectoryEntry.bytes,
      }),
    );
    expect(directory).toMatchObject({ label: "Research", selectedClientCredentialId: null });
    const epoch = decodeEpochSecretState(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.epoch-secret",
        vaultId: fixture.creation.ids.vaultId,
        identity: fixture.creation.secrets.keyEpoch.id,
        wrappedBytes: committed.trustedSecrets[0]?.bytes ?? new Uint8Array(),
      }),
    );
    expect(epoch).toMatchObject({ displayNumber: 0 });
    expect(
      await Promise.all(
        committed.replicaSafetyItems?.map(async (item) =>
          decodeLogicalResolution(
            await openWrappedLocalState({
              wrappingKey,
              domain: "awsm.local.logical-resolution",
              vaultId: fixture.creation.ids.vaultId,
              identity: Uint8Array.from(
                fixture.manifest.opaqueItemInventory.find((candidate) =>
                  item.itemKey.endsWith(key(candidate.logicalId)),
                )?.logicalId ?? [],
              ),
              wrappedBytes: item.bytes,
            }),
          ),
        ) ?? [],
      ),
    ).toHaveLength(4);
  });

  it("promotes every authenticated Artifact wrapper before activating its resolutions", async () => {
    const fixture = await capturedVaultPackage();
    const wrappingKey = await installationWrappingKey();
    const order: string[] = [];
    const promote = vi.fn(async () => {
      order.push("promote");
    });
    const discard = vi.fn(async () => undefined);
    const prepareOpaque = vi.fn(
      async (input: {
        readonly artifactId: Identifier<"Artifact">;
        readonly storageItemId: Identifier<"StorageItem">;
        readonly envelopeByteLength: number;
        readonly source: ReadableStream<Uint8Array>;
      }) => {
        expect((await new Response(input.source).arrayBuffer()).byteLength).toBe(
          input.envelopeByteLength,
        );
        return {
          artifactId: input.artifactId,
          storageItemId: input.storageItemId,
          envelopeByteLength: input.envelopeByteLength,
          promote,
          discard,
        };
      },
    );
    let committed: InitialVaultCommit | undefined;
    const storage = {
      getOrCreateInstallationWrappingKey: vi.fn(async () => wrappingKey),
      commitInitialVault: vi.fn(async (input: InitialVaultCommit) => {
        order.push("commit");
        committed = input;
      }),
    } as unknown as CanonicalIndexedDb;

    await new CanonicalCompleteImportService(storage, NORMAL_STORAGE_REALM, {
      prepareOpaque,
    } as never).activateUnknown(fixture);

    expect(prepareOpaque).toHaveBeenCalledOnce();
    expect(promote).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    expect(order).toEqual(["promote", "commit"]);
    if (committed === undefined) throw new Error("missing captured Import commit");
    expect(committed.immutableItems).toHaveLength(7);
    expect(committed.replicaSafetyItems).toHaveLength(8);
  });

  it("preserves the atomic Vault collision and cleans owned Artifact preparation state", async () => {
    const fixture = await capturedVaultPackage();
    const wrappingKey = await installationWrappingKey();
    const promote = vi.fn(async () => undefined);
    const discard = vi.fn(async () => undefined);
    const storage = {
      getOrCreateInstallationWrappingKey: vi.fn(async () => wrappingKey),
      commitInitialVault: vi.fn(async () => {
        throw new CanonicalStorageError(
          "VAULT_ALREADY_EXISTS",
          "The Vault already exists in this Storage Realm.",
        );
      }),
    } as unknown as CanonicalIndexedDb;
    const artifacts = {
      prepareOpaque: vi.fn(async () => ({
        artifactId: fixture.manifest.opaqueItemInventory.find(({ namespace }) => namespace === 5)
          ?.logicalId,
        storageItemId: fixture.manifest.opaqueItemInventory.find(({ namespace }) => namespace === 5)
          ?.storageItemId,
        envelopeByteLength: 1,
        promote,
        discard,
      })),
    };

    await expect(
      new CanonicalCompleteImportService(
        storage,
        NORMAL_STORAGE_REALM,
        artifacts as never,
      ).activateUnknown(fixture),
    ).rejects.toMatchObject({ id: "VAULT_ALREADY_EXISTS" });
    expect(promote).toHaveBeenCalledOnce();
    expect(storage.commitInitialVault).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });
});

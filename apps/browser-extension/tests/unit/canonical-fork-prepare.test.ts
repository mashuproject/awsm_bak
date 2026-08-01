import { describe, expect, it, vi } from "vitest";

import * as sodium from "../../src/crypto/sodium";
import { contentCheckpointCauseIds } from "../../src/domain/canonical/baseline-body";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { type Identifier, identifier } from "../../src/domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  BUNDLE_DESCRIPTOR_OBJECT,
  encodeVaultObject,
} from "../../src/domain/canonical/object";
import { signVaultEvent } from "../../src/domain/canonical/record";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { exactMap, mapValue } from "../../src/domain/canonical/schema";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../src/domain/canonical/value";
import { bytesEqual } from "../../src/domain/hash";
import type {
  CanonicalIndexedDb,
  InitialVaultCommit,
} from "../../src/drivers/indexeddb/canonical-database";
import { NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactStore } from "../../src/runtime/artifact/canonical-store";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import { prepareCanonicalFork } from "../../src/runtime/vault/canonical-fork-prepare";
import { CanonicalForkCeremony } from "../../src/runtime/vault/canonical-fork-service";
import { prepareCanonicalVaultStorage } from "../../src/runtime/vault/canonical-local-state";

async function wrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

async function prepareEmptyFork(
  label: string | null,
  lifecycle: 1 | 2 = 1,
  requiredFeatureSetId?: Identifier<"RequiredFeatureSet">,
) {
  const source = await prepareCanonicalVaultCreation({
    label,
    assertedAt: 1,
    ...(requiredFeatureSetId === undefined ? {} : { requiredFeatureSetId }),
  });
  const local = await prepareCanonicalVaultStorage({
    creation: source,
    label,
    realm: NORMAL_STORAGE_REALM,
    wrappingKey: await wrappingKey(),
  });
  const sourceReplicaBytes = Uint8Array.from(local.commit.replicaState.bytes);
  const graph = new CausalGraph();
  const baselineBody = exactMap(source.baseline.body, [0, 1, 2, 3, 4, 5], "source Baseline body");
  graph.addBaseline(source.baseline.recordId, contentCheckpointCauseIds(mapValue(baselineBody, 2)));
  graph.add(source.genesis.recordId, [source.baseline.recordId]);
  const prepared = await prepareCanonicalFork({
    replay: {
      vault: {
        directory: {
          vaultId: source.ids.vaultId,
          generationId: source.ids.generationId,
          label,
          selectedClientCredentialId: source.ids.clientCredentialId,
        },
        replicaState: { ...local.replicaState, lifecycle },
        clientSecret: {
          vaultId: source.ids.vaultId,
          memberId: source.ids.firstMemberId,
          clientCredentialId: source.ids.clientCredentialId,
          signingPublicKey: source.secrets.client.signingPublicKey,
          signingSecretKey: source.secrets.client.signingSecretKey,
          wrappingPublicKey: source.secrets.client.wrappingPublicKey,
          wrappingPrivateKey: source.secrets.client.wrappingPrivateKey,
        },
        epochSecret: {
          vaultId: source.ids.vaultId,
          keyEpochId: source.secrets.keyEpoch.id,
          displayNumber: 0,
          key: source.secrets.keyEpoch.key,
        },
        baseline: source.baseline,
        genesis: source.genesis,
        installationWrappingKey: await wrappingKey(),
        replicaStateStorageBytes: sourceReplicaBytes,
      },
      graph,
      events: [source.genesis],
    },
    artifactStore: {} as CanonicalArtifactStore,
    assertedAt: 2,
    openObject: async () => {
      throw new Error("An empty Vault has no Objects");
    },
    readArtifactResolution: async () => {
      throw new Error("An empty Vault has no Artifacts");
    },
  });
  return { source, local, sourceReplicaBytes, prepared };
}

describe("canonical Fork preparation", () => {
  it("creates fresh authority and history over mapped source state without touching the source", async () => {
    const { source, local, sourceReplicaBytes, prepared } = await prepareEmptyFork("Research", 2);

    expect(prepared.content.state.vaultLabel.value).toBe("Research");
    expect(prepared.content.state.credentialLabels).toEqual([]);
    expect(bytesEqual(prepared.creation.ids.vaultId, source.ids.vaultId)).toBe(false);
    expect(bytesEqual(prepared.creation.ids.generationId, source.ids.generationId)).toBe(false);
    expect(prepared.creation.genesis.parentRecordIds).toEqual([]);
    expect(prepared.creation.genesis.authorityParentRecordIds).toEqual([]);
    expect(prepared.objects).toEqual([]);
    expect(prepared.artifacts).toEqual([]);
    expect(local.commit.replicaState.bytes).toEqual(sourceReplicaBytes);
  });

  it("activates the complete destination in one initial commit after Recovery Phrase confirmation", async () => {
    const { prepared } = await prepareEmptyFork(null);
    const destinationWrappingKey = await wrappingKey();
    const commitInitialVault = vi.fn(async (_commit: InitialVaultCommit) => undefined);
    const storage = {
      getOrCreateInstallationWrappingKey: vi.fn(async () => destinationWrappingKey),
      commitInitialVault,
    } as unknown as CanonicalIndexedDb;
    const ceremony = new CanonicalForkCeremony(storage, NORMAL_STORAGE_REALM, prepared);

    await expect(ceremony.confirm("wrong phrase")).rejects.toMatchObject({
      id: "RECOVERY_PHRASE_MISMATCH",
    });
    expect(commitInitialVault).not.toHaveBeenCalled();
    const result = await ceremony.confirm(ceremony.recoveryPhrase);

    expect(result.vaultId).toEqual(prepared.creation.ids.vaultId);
    expect(commitInitialVault).toHaveBeenCalledOnce();
    expect(commitInitialVault.mock.calls[0]?.[0]).toMatchObject({
      vaultKey: expect.any(String),
      immutableItems: expect.any(Array),
      replicaSafetyItems: expect.any(Array),
    });
  });

  it("consumes the ceremony and wipes secrets after a failed activation attempt", async () => {
    const { prepared } = await prepareEmptyFork(null);
    const storage = {
      getOrCreateInstallationWrappingKey: vi.fn(async () => wrappingKey()),
      commitInitialVault: vi.fn(async () => {
        throw new Error("forced activation failure");
      }),
    } as unknown as CanonicalIndexedDb;
    const wipe = vi.spyOn(sodium, "wipe");
    const ceremony = new CanonicalForkCeremony(storage, NORMAL_STORAGE_REALM, prepared);

    await expect(ceremony.confirm(ceremony.recoveryPhrase)).rejects.toThrow(
      /forced activation failure/u,
    );

    expect(wipe).toHaveBeenCalledTimes(11);
    await expect(ceremony.confirm(ceremony.recoveryPhrase)).rejects.toThrow(
      /ceremony is no longer active/u,
    );
    wipe.mockRestore();
  });

  it("wipes prepared destination secrets when Artifact preparation fails", async () => {
    const source = await prepareCanonicalVaultCreation({ label: null, assertedAt: 1 });
    const local = await prepareCanonicalVaultStorage({
      creation: source,
      label: null,
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: await wrappingKey(),
    });
    const bundleId = filled("Bundle", 31);
    const collectionId = filled("Collection", 32);
    const artifactDigest = filled("Artifact", 33);
    const artifact = encodeVaultObject({
      vaultId: source.ids.vaultId,
      objectType: ARTIFACT_OBJECT,
      requiredFeatureSetId: source.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        "awsm.artifact.capture",
        "application/vnd.awsm.web-page+zip",
        "awsm.representation.web-page-zip",
        0,
        artifactDigest,
        indexedMap(1, 1_048_576, 16, 0, artifactDigest),
        encodeCanonicalValue(indexedMap(1)),
      ),
    });
    const descriptor = encodeVaultObject({
      vaultId: source.ids.vaultId,
      objectType: BUNDLE_DESCRIPTOR_OBJECT,
      requiredFeatureSetId: source.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        bundleId,
        2,
        "https://example.com/",
        "https://example.com/",
        "awsm.capture.web-page-snapshot",
        "awsm.adapter.browser-web-page",
        1,
        "Example",
        canonicalSet([indexedMap(artifact.objectId, "awsm.artifact.primary")]),
        [],
        indexedMap(1, encodeCanonicalValue(indexedMap(1))),
      ),
    });
    const registration = await signVaultEvent(
      {
        vaultId: source.ids.vaultId,
        generationId: source.ids.generationId,
        parentRecordIds: [source.genesis.recordId],
        authorityParentRecordIds: [source.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptor.objectId }],
        requiredFeatureSetId: source.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 2,
        type: 3,
        signerCredentialId: source.ids.clientCredentialId,
        assertedAt: 2,
        body: indexedMap(bundleId, descriptor.objectId, collectionId),
      },
      source.secrets.client.signingSecretKey,
    );
    const graph = new CausalGraph();
    const baselineBody = exactMap(source.baseline.body, [0, 1, 2, 3, 4, 5], "source Baseline body");
    graph.addBaseline(
      source.baseline.recordId,
      contentCheckpointCauseIds(mapValue(baselineBody, 2)),
    );
    graph.add(source.genesis.recordId, [source.baseline.recordId]);
    graph.add(registration.recordId, registration.parentRecordIds);
    const wipe = vi.spyOn(sodium, "wipe");

    await expect(
      prepareCanonicalFork({
        replay: {
          vault: {
            directory: {
              vaultId: source.ids.vaultId,
              generationId: source.ids.generationId,
              label: null,
              selectedClientCredentialId: source.ids.clientCredentialId,
            },
            replicaState: {
              ...local.replicaState,
              causalFrontier: [registration.recordId],
            },
            clientSecret: {
              vaultId: source.ids.vaultId,
              memberId: source.ids.firstMemberId,
              clientCredentialId: source.ids.clientCredentialId,
              signingPublicKey: source.secrets.client.signingPublicKey,
              signingSecretKey: source.secrets.client.signingSecretKey,
              wrappingPublicKey: source.secrets.client.wrappingPublicKey,
              wrappingPrivateKey: source.secrets.client.wrappingPrivateKey,
            },
            epochSecret: {
              vaultId: source.ids.vaultId,
              keyEpochId: source.secrets.keyEpoch.id,
              displayNumber: 0,
              key: source.secrets.keyEpoch.key,
            },
            baseline: source.baseline,
            genesis: source.genesis,
            installationWrappingKey: await wrappingKey(),
            replicaStateStorageBytes: local.commit.replicaState.bytes,
          },
          graph,
          events: [source.genesis, registration],
        },
        artifactStore: {} as CanonicalArtifactStore,
        assertedAt: 3,
        openObject: async (objectId) => {
          if (bytesEqual(objectId, descriptor.objectId)) return descriptor;
          if (bytesEqual(objectId, artifact.objectId)) return artifact;
          throw new TypeError("Unexpected Object ID");
        },
        readArtifactResolution: async () => {
          throw new Error("forced Artifact resolution failure");
        },
      }),
    ).rejects.toThrow(/forced Artifact resolution failure/u);

    expect(wipe).toHaveBeenCalledTimes(11);
    wipe.mockRestore();
  });

  it("blocks a non-empty Required Feature Set until its Manifest closure can be copied", async () => {
    await expect(prepareEmptyFork(null, 1, filled("RequiredFeatureSet", 71))).rejects.toThrow(
      /Required Feature Set Manifest closure/u,
    );
  });
});

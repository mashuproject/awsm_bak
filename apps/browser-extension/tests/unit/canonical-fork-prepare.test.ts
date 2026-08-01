import { describe, expect, it, vi } from "vitest";

import { contentCheckpointCauseIds } from "../../src/domain/canonical/baseline-body";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { exactMap, mapValue } from "../../src/domain/canonical/schema";
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

describe("canonical Fork preparation", () => {
  it("creates fresh authority and history over mapped source state without touching the source", async () => {
    const source = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
    const local = await prepareCanonicalVaultStorage({
      creation: source,
      label: "Research",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: await wrappingKey(),
    });
    const sourceReplicaBytes = Uint8Array.from(local.commit.replicaState.bytes);
    const graph = new CausalGraph();
    const baselineBody = exactMap(source.baseline.body, [0, 1, 2, 3, 4, 5], "source Baseline body");
    graph.addBaseline(
      source.baseline.recordId,
      contentCheckpointCauseIds(mapValue(baselineBody, 2)),
    );
    graph.add(source.genesis.recordId, []);
    const prepared = await prepareCanonicalFork({
      replay: {
        vault: {
          directory: {
            vaultId: source.ids.vaultId,
            generationId: source.ids.generationId,
            label: "Research",
            selectedClientCredentialId: source.ids.clientCredentialId,
          },
          replicaState: { ...local.replicaState, lifecycle: 2 },
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
    const source = await prepareCanonicalVaultCreation({ label: null, assertedAt: 1 });
    const local = await prepareCanonicalVaultStorage({
      creation: source,
      label: null,
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: await wrappingKey(),
    });
    const graph = new CausalGraph();
    const baselineBody = exactMap(source.baseline.body, [0, 1, 2, 3, 4, 5], "source Baseline body");
    graph.addBaseline(
      source.baseline.recordId,
      contentCheckpointCauseIds(mapValue(baselineBody, 2)),
    );
    graph.add(source.genesis.recordId, []);
    const prepared = await prepareCanonicalFork({
      replay: {
        vault: {
          directory: {
            vaultId: source.ids.vaultId,
            generationId: source.ids.generationId,
            label: null,
            selectedClientCredentialId: source.ids.clientCredentialId,
          },
          replicaState: local.replicaState,
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
});

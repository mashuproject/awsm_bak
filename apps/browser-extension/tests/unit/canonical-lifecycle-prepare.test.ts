import { describe, expect, it } from "vitest";

import { openCompactItem } from "../../src/crypto/compact";
import { verifyVaultEventSignature } from "../../src/domain/canonical/record";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import { prepareCanonicalClosureEvent } from "../../src/runtime/vault/canonical-lifecycle-prepare";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { OpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";

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

describe("canonical Vault lifecycle preparation", () => {
  it("authors explicit Closure as a terminal signed authority-continuity Event", async () => {
    const vault = await openedInitialVault();
    const prepared = await prepareCanonicalClosureEvent({
      vault,
      assertedAt: 10,
      protectionParameters: new Uint8Array(64).fill(9),
    });

    expect(prepared.event).toMatchObject({
      family: 3,
      type: 2,
      parentRecordIds: vault.replicaState.causalFrontier,
      authorityParentRecordIds: vault.replicaState.authorityFrontier,
      dependencies: [],
      body: canonicalMap([]),
    });
    expect(prepared.nextReplicaState).toMatchObject({
      lifecycle: 2,
      causalFrontier: [prepared.event.recordId],
      authorityFrontier: [prepared.event.recordId],
    });
    expect(prepared.nextReplicaState.continuityRecordIds).toEqual(
      canonicalSet([vault.genesis.recordId, prepared.event.recordId]),
    );
    expect(
      await verifyVaultEventSignature(prepared.event, vault.clientSecret.signingPublicKey),
    ).toBe(true);
    await expect(
      openCompactItem({
        vaultId: vault.replicaState.vaultId,
        keyEpochId: vault.epochSecret.keyEpochId,
        keyEpochKey: vault.epochSecret.key,
        envelopeBytes: prepared.eventEnvelope.bytes,
      }),
    ).resolves.toMatchObject({ payloadBytes: prepared.event.bytes });
    await expect(
      prepareCanonicalClosureEvent({
        vault: { ...vault, replicaState: prepared.nextReplicaState },
        assertedAt: 11,
      }),
    ).rejects.toThrow("Closed Vaults cannot author Lifecycle Events");
  });
});

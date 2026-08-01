import { describe, expect, it } from "vitest";

import { openCompactItem } from "../../src/crypto/compact";
import { verifyVaultEventSignature } from "../../src/domain/canonical/record";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { prepareCanonicalContentEvent } from "../../src/runtime/content/canonical-prepare";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
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

describe("canonical Content Event preparation", () => {
  it("signs and encrypts one exact Content fact against both accepted frontiers", async () => {
    const vault = await openedInitialVault();
    const bundleId = crypto.getRandomValues(new Uint8Array(32));
    const prepared = await prepareCanonicalContentEvent({
      vault,
      type: 4,
      assertedAt: 10,
      body: canonicalMap([[0, canonicalSet([bundleId])]]),
      protectionParameters: new Uint8Array(64).fill(4),
    });

    expect(prepared.event.parentRecordIds).toEqual(vault.replicaState.causalFrontier);
    expect(prepared.event.authorityParentRecordIds).toEqual(vault.replicaState.authorityFrontier);
    expect(prepared.nextReplicaState.causalFrontier).toEqual([prepared.event.recordId]);
    expect(prepared.nextReplicaState.authorityFrontier).toEqual(
      vault.replicaState.authorityFrontier,
    );
    expect(
      await verifyVaultEventSignature(prepared.event, vault.clientSecret.signingPublicKey),
    ).toBe(true);
    const opened = await openCompactItem({
      vaultId: vault.replicaState.vaultId,
      keyEpochId: vault.epochSecret.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      envelopeBytes: prepared.eventEnvelope.bytes,
    });
    expect(opened.payloadBytes).toEqual(prepared.event.bytes);
  });
});

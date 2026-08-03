import { describe, expect, it } from "vitest";

import { sealCompactItem } from "../../src/crypto/compact";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { signVaultEvent } from "../../src/domain/canonical/record";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { prepareCanonicalContentEvent } from "../../src/runtime/content/canonical-prepare";
import { CanonicalHostedPullService } from "../../src/runtime/synchronization/canonical-hosted-pull-service";
import {
  deriveHostedReplicaOpaqueLocator,
  HOSTED_REPLICA_LOGICAL_NAMESPACE,
} from "../../src/runtime/synchronization/canonical-hosted-replica-locator";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
const LOCATOR_SALT = new Uint8Array(32).fill(91);

describe("canonical Hosted pull service", () => {
  it("promotes a valid Content branch while retaining an unrelated unverifiable branch", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Sync", assertedAt: 1 });
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
    const vault = {
      directory: {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        label: "Sync",
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
      installationWrappingKey: await crypto.subtle.generateKey(
        { name: "AES-KW", length: 256 },
        false,
        ["wrapKey", "unwrapKey"],
      ),
      replicaStateStorageBytes: new Uint8Array([1]),
    } satisfies PersistedOpenedCanonicalVault;
    const prepared = await prepareCanonicalContentEvent({
      vault,
      type: 4,
      assertedAt: 2,
      body: canonicalMap([[0, canonicalSet([new Uint8Array(32).fill(8)])]]),
      protectionParameters: new Uint8Array(64).fill(9),
    });
    const locator = await deriveHostedReplicaOpaqueLocator({
      locatorSalt: LOCATOR_SALT,
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultRecord,
      logicalId: prepared.event.recordId,
    });
    const unverified = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: vault.replicaState.causalFrontier,
        authorityParentRecordIds: vault.replicaState.authorityFrontier,
        dependencies: [],
        requiredFeatureSetId: randomIdentifier("RequiredFeatureSet"),
        extensions: advisoryExtensions([]),
        family: 2,
        type: 4,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 3,
        body: canonicalMap([[0, canonicalSet([new Uint8Array(32).fill(7)])]]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const unverifiedEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: unverified.bytes,
      protectionParameters: new Uint8Array(64).fill(10),
    });
    const unverifiedLocator = await deriveHostedReplicaOpaqueLocator({
      locatorSalt: LOCATOR_SALT,
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultRecord,
      logicalId: unverified.recordId,
    });
    const job = {
      jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
      vaultId: creation.ids.vaultId,
      remoteId: REMOTE_ID,
      realm: { kind: "Normal" as const, id: "default" },
      stage: 2 as const,
      state: 1 as const,
      snapshotCursor: 1,
      nextPosition: null,
      attempt: 0,
      retryAfterMs: null,
      quarantineReferences: [
        { storageItemId: prepared.eventEnvelope.storageItemId, locator },
        { storageItemId: unverifiedEnvelope.storageItemId, locator: unverifiedLocator },
      ],
      progress: {
        discoveredItemCount: 2,
        downloadedItemCount: 2,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
    };
    const local = {
      openVault: async () => vault,
      listEpochSecrets: async () => [vault.epochSecret],
      hasVerifiedCompactStorageItem: async () => {
        throw new TypeError("unexpected inventory lookup");
      },
      hasVerifiedCompactLogicalItem: async () => false,
      openResolvedCompactItem: async ({ logicalId }: { readonly logicalId: Uint8Array }) => {
        if (logicalId.toString() === creation.baseline.recordId.toString()) {
          return {
            keyEpochId: creation.secrets.keyEpoch.id,
            payloadType: 1 as const,
            payloadBytes: creation.baseline.bytes,
            envelope: creation.baselineEnvelope,
          };
        }
        if (logicalId.toString() === creation.genesis.recordId.toString()) {
          return {
            keyEpochId: creation.secrets.keyEpoch.id,
            payloadType: 1 as const,
            payloadBytes: creation.genesis.bytes,
            envelope: creation.genesisEnvelope,
          };
        }
        throw new TypeError("unexpected local Compact item");
      },
      readResolvedOpaqueItem: async () => {
        throw new TypeError("unexpected local opaque dependency");
      },
    };
    const promoted: unknown[] = [];
    const service = new CanonicalHostedPullService({
      remotes: {
        withLoaded: async (_input, operation) =>
          operation({
            remote: {
              remoteId: REMOTE_ID,
              vaultId: creation.ids.vaultId,
              name: "Host",
              endpoint: "https://host.example/",
              hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
              locatorSalt: LOCATOR_SALT,
              enabled: true,
              inventoryPageSize: 100,
            },
            bearerToken: "channel-token",
          }),
      },
      vaults: local,
      jobs: {
        findActive: async () => job,
        create: async () => {
          throw new TypeError("unexpected Job creation");
        },
        checkpoint: async () => {
          throw new TypeError("unexpected Job checkpoint");
        },
        recordQuarantine: async () => {
          throw new TypeError("unexpected Quarantine write");
        },
        completeValidation: async () => {
          throw new TypeError("unexpected empty completion");
        },
        readQuarantine: async ({ storageItemId }) =>
          storageItemId.toString() === prepared.eventEnvelope.storageItemId.toString()
            ? prepared.eventEnvelope.bytes
            : unverifiedEnvelope.bytes,
        promoteValidated: async (input) => {
          promoted.push(input);
        },
      },
    });

    await expect(
      service.pull({ vaultId: creation.ids.vaultId, remoteId: REMOTE_ID }),
    ).resolves.toMatchObject({
      stage: 2,
      state: 1,
      quarantineReferences: [
        { storageItemId: unverifiedEnvelope.storageItemId, locator: unverifiedLocator },
      ],
    });
    expect(promoted).toHaveLength(1);
  });
});

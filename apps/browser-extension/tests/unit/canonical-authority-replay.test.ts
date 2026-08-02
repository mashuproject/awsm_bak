import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";

import { readySodium } from "../../src/crypto/sodium";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { signVaultEvent } from "../../src/domain/canonical/record";
import { transcript } from "../../src/domain/canonical/transcript";
import { canonicalMap, canonicalSet, encodeCanonicalValue } from "../../src/domain/canonical/value";
import {
  CanonicalReplayService,
  replayEventMemberId,
} from "../../src/runtime/projection/canonical-replay";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";

async function replaySingleAuthorityEvent(input: {
  readonly type: 2 | 4 | 5 | 10;
  readonly lifecycle: 1 | 2;
  readonly body: (
    creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  ) => ReturnType<typeof canonicalMap>;
}) {
  const creation = await prepareCanonicalVaultCreation({ label: "Authority", assertedAt: 1 });
  const event = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: [creation.genesis.recordId],
      authorityParentRecordIds: [creation.genesis.recordId],
      dependencies: [],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 1,
      type: input.type,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: 2,
      body: input.body(creation),
    },
    creation.secrets.client.signingSecretKey,
  );
  const replicaState: CanonicalReplicaState = {
    vaultId: creation.ids.vaultId,
    generationId: creation.ids.generationId,
    causalFrontier: [event.recordId],
    authorityFrontier: [event.recordId],
    continuityRecordIds: [creation.genesis.recordId, event.recordId],
    baselineId: creation.baseline.recordId,
    currentKeyEpochId: creation.secrets.keyEpoch.id,
    requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
    authoringClientCredentialId: null,
    memberId: null,
    lifecycle: input.lifecycle,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
  const vault = {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Authority",
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
    installationWrappingKey: {} as CryptoKey,
    replicaStateStorageBytes: new Uint8Array(),
  } satisfies PersistedOpenedCanonicalVault;
  const service = new CanonicalReplayService({
    openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: event.bytes })),
  } as never);
  return { creation, event, replay: await service.replayOpened(vault) };
}

describe("canonical Authority replay", () => {
  it("derives Closure when the sole Administrator resigns", async () => {
    const { creation, event, replay } = await replaySingleAuthorityEvent({
      type: 2,
      lifecycle: 2,
      body: ({ ids }) => canonicalMap([[0, ids.firstMemberId]]),
    });

    expect(replay.authority.activeMemberIds).toEqual([]);
    expect(replay.authority.administratorIds).toEqual([]);
    expect(replay.authority.lifecycle).toBe(2);
    expect(replayEventMemberId(replay, event)).toEqual(creation.ids.firstMemberId);
  });

  it("derives Closure when the sole Administrator steps down", async () => {
    const { creation, replay } = await replaySingleAuthorityEvent({
      type: 4,
      lifecycle: 2,
      body: ({ ids }) =>
        canonicalMap([
          [0, ids.firstMemberId],
          [1, []],
        ]),
    });

    expect(replay.authority.activeMemberIds).toEqual([creation.ids.firstMemberId]);
    expect(replay.authority.administratorIds).toEqual([]);
    expect(replay.authority.lifecycle).toBe(2);
  });

  it("ends the sole Client Credential without ending membership or the Vault", async () => {
    const { creation, event, replay } = await replaySingleAuthorityEvent({
      type: 10,
      lifecycle: 1,
      body: ({ ids }) => canonicalMap([[0, ids.clientCredentialId]]),
    });

    expect(replay.authority.activeMemberIds).toEqual([creation.ids.firstMemberId]);
    expect(replay.authority.administratorIds).toEqual([creation.ids.firstMemberId]);
    expect(
      replay.authority.clientCredentials.get(
        Buffer.from(creation.ids.clientCredentialId).toString("hex"),
      )?.active,
    ).toBe(false);
    expect(replay.authority.lifecycle).toBe(1);
    expect(replayEventMemberId(replay, event)).toEqual(creation.ids.firstMemberId);
  });

  it("retains an Administrator-authored portable Invitation without an expiry", async () => {
    const invitationId = randomIdentifier("Invitation");
    const { creation, replay } = await replaySingleAuthorityEvent({
      type: 5,
      lifecycle: 1,
      body: ({ ids }) =>
        canonicalMap([
          [0, invitationId],
          [
            1,
            canonicalSet([
              canonicalMap([
                [0, "awsm.vault"],
                [1, ids.firstMemberId],
                [2, ids.vaultId],
                [3, "awsm.vault.join"],
                [4, new Uint8Array()],
              ]),
            ]),
          ],
          [2, new Uint8Array(32).fill(11)],
          [3, new Uint8Array(32).fill(12)],
          [4, new Uint8Array(32).fill(13)],
          [5, new Uint8Array(32).fill(14)],
        ]),
    });

    expect(replay.authority.activeInvitations).toEqual([
      expect.objectContaining({
        invitationId,
        issuerMemberId: creation.ids.firstMemberId,
      }),
    ]);
    expect(replay.authority.recoveryCredentials).toEqual([
      expect.objectContaining({
        recoveryCredentialId: creation.ids.recoveryCredentialId,
        memberId: creation.ids.firstMemberId,
        revision: 0,
        effective: true,
      }),
    ]);
    expect(replay.authority.keyEpochs).toEqual([
      {
        keyEpochId: creation.secrets.keyEpoch.id,
        displayNumber: 0,
        current: true,
      },
    ]);
  });

  it("replays the complete Invitation, conflict, and member-removal lifecycle", async () => {
    const sodium = await readySodium();
    const creation = await prepareCanonicalVaultCreation({ label: "Members", assertedAt: 1 });
    const invitationId = randomIdentifier("Invitation");
    const proposedMemberId = randomIdentifier("Member");
    const proposedClientCredentialId = randomIdentifier("ClientCredential");
    const proposedRecoveryCredentialId = randomIdentifier("RecoveryCredential");
    const redemption = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(21));
    const receipt = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(22));
    const proposedClient = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(23));
    const proposedRecovery = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(24));
    const cancellationCapability = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(25));
    const capabilities = canonicalSet([
      canonicalMap([
        [0, "awsm.vault"],
        [1, creation.ids.firstMemberId],
        [2, creation.ids.vaultId],
        [3, "awsm.vault.join"],
        [4, new Uint8Array()],
      ]),
      canonicalMap([
        [0, "awsm.vault"],
        [1, creation.ids.firstMemberId],
        [2, creation.ids.vaultId],
        [3, "awsm.vault.administrator"],
        [4, new Uint8Array()],
      ]),
    ]);
    const invitation = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 5,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 2,
        body: canonicalMap([
          [0, invitationId],
          [1, capabilities],
          [2, redemption.publicKey],
          [3, cancellationCapability.publicKey],
          [4, new Uint8Array(32).fill(26)],
          [5, receipt.publicKey],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const proposedCertificate = canonicalMap([
      [0, proposedClientCredentialId],
      [1, proposedMemberId],
      [2, proposedClient.publicKey],
      [3, new Uint8Array(32).fill(27)],
    ]);
    const proposedRecoveryDescriptor = canonicalMap([
      [0, proposedRecoveryCredentialId],
      [1, proposedMemberId],
      [2, 0],
      [3, proposedRecovery.publicKey],
      [4, new Uint8Array(32).fill(28)],
    ]);
    const joinRequestPrefix = canonicalMap([
      [0, invitationId],
      [1, capabilities],
      [2, proposedMemberId],
      [3, proposedCertificate],
      [4, proposedRecoveryDescriptor],
    ]);
    const joinProof = transcript("awsm:invitation-join-request:v1", [
      encodeCanonicalValue(joinRequestPrefix),
    ]);
    const joinRequest = canonicalMap([
      ...joinRequestPrefix,
      [5, sodium.crypto_sign_detached(joinProof, proposedClient.privateKey)],
      [6, sodium.crypto_sign_detached(joinProof, proposedRecovery.privateKey)],
      [7, sodium.crypto_sign_detached(joinProof, redemption.privateKey)],
    ]);
    const joinRequestId = sha256(
      transcript("awsm:invitation-join-request-id:v1", [encodeCanonicalValue(joinRequest)]),
    );
    const recoveryEnvelopeId = randomIdentifier("KeyEnvelope");
    const clientEnvelopeId = randomIdentifier("KeyEnvelope");
    const envelopeSlots = canonicalSet([
      canonicalMap([
        [0, creation.secrets.keyEpoch.id],
        [1, 1],
        [2, proposedRecoveryCredentialId],
        [3, 0],
        [4, recoveryEnvelopeId],
      ]),
      canonicalMap([
        [0, creation.secrets.keyEpoch.id],
        [1, 2],
        [2, proposedClientCredentialId],
        [3, null],
        [4, clientEnvelopeId],
      ]),
    ]);
    const proposal = canonicalMap([
      [0, invitationId],
      [1, joinRequestId],
      [2, canonicalSet([invitation.recordId])],
      [3, proposedMemberId],
      [4, proposedCertificate],
      [5, proposedRecoveryDescriptor],
      [6, capabilities],
      [7, envelopeSlots],
    ]);
    const proposalId = sha256(
      transcript("awsm:invitation-acceptance-proposal-id:v1", [encodeCanonicalValue(proposal)]),
    );
    const receiptPrefix = canonicalMap([
      [0, invitationId],
      [1, 1],
      [2, joinRequestId],
      [3, proposalId],
      [4, new Uint8Array(32).fill(29)],
    ]);
    const consumedReceipt = canonicalMap([
      ...receiptPrefix,
      [
        5,
        sodium.crypto_sign_detached(
          transcript("awsm:invitation-receipt:v1", [encodeCanonicalValue(receiptPrefix)]),
          receipt.privateKey,
        ),
      ],
    ]);
    const acceptance = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [invitation.recordId],
        authorityParentRecordIds: [invitation.recordId],
        dependencies: [
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: recoveryEnvelopeId },
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: clientEnvelopeId },
        ],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 6,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 3,
        body: canonicalMap([
          [0, joinRequest],
          [1, proposal],
          [2, consumedReceipt],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const replicaState: CanonicalReplicaState = {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      causalFrontier: [acceptance.recordId],
      authorityFrontier: [acceptance.recordId],
      continuityRecordIds: [creation.genesis.recordId, invitation.recordId, acceptance.recordId],
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
        label: "Members",
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
      installationWrappingKey: {} as CryptoKey,
      replicaStateStorageBytes: new Uint8Array(),
    } satisfies PersistedOpenedCanonicalVault;
    const byId = new Map([
      [Buffer.from(invitation.recordId).toString("hex"), invitation],
      [Buffer.from(acceptance.recordId).toString("hex"), acceptance],
    ]);
    const readResolvedOpaqueItem = vi.fn(
      async (_input: { readonly logicalId: Uint8Array }) => new Uint8Array([1]),
    );
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened(vault);

    expect(replay.authority.activeMemberIds).toEqual(
      expect.arrayContaining([creation.ids.firstMemberId, proposedMemberId]),
    );
    expect(replay.authority.administratorIds).toEqual(
      expect.arrayContaining([creation.ids.firstMemberId, proposedMemberId]),
    );
    expect(replay.authority.activeInvitations).toEqual([]);
    expect(
      replay.authority.clientCredentials.get(
        Buffer.from(proposedClientCredentialId).toString("hex"),
      ),
    ).toEqual(expect.objectContaining({ memberId: proposedMemberId, active: true }));
    expect(replay.authority.recoveryCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recoveryCredentialId: proposedRecoveryCredentialId,
          memberId: proposedMemberId,
          effective: true,
        }),
      ]),
    );
    expect(readResolvedOpaqueItem.mock.calls.map(([input]) => input.logicalId)).toEqual(
      expect.arrayContaining([recoveryEnvelopeId, clientEnvelopeId]),
    );
    expect(readResolvedOpaqueItem).toHaveBeenCalledTimes(2);

    const duplicateAcceptance = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [invitation.recordId],
        authorityParentRecordIds: [invitation.recordId],
        dependencies: [
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: recoveryEnvelopeId },
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: clientEnvelopeId },
        ],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 6,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 30,
        body: acceptance.body,
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(Buffer.from(duplicateAcceptance.recordId).toString("hex"), duplicateAcceptance);
    const idempotentAcceptance = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [acceptance.recordId, duplicateAcceptance.recordId],
        authorityFrontier: [acceptance.recordId, duplicateAcceptance.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          duplicateAcceptance.recordId,
        ],
      },
    });
    expect(idempotentAcceptance.authority.invitationConflicts).toEqual([]);
    expect(
      idempotentAcceptance.authority.activeMemberIds.filter((memberId) =>
        Buffer.from(memberId).equals(Buffer.from(proposedMemberId)),
      ),
    ).toHaveLength(1);

    const cancellationChallenge = new Uint8Array(32).fill(40);
    const cancellationRequest = canonicalMap([
      [0, invitationId],
      [1, cancellationChallenge],
      [
        2,
        sodium.crypto_sign_detached(
          transcript("awsm:invitation-cancel-request:v1", [invitationId, cancellationChallenge]),
          cancellationCapability.privateKey,
        ),
      ],
    ]);
    const cancellationRequestId = sha256(
      transcript("awsm:invitation-cancel-request-id:v1", [
        encodeCanonicalValue(cancellationRequest),
      ]),
    );
    const cancellationReceiptPrefix = canonicalMap([
      [0, invitationId],
      [1, 2],
      [2, cancellationRequestId],
      [3, null],
      [4, new Uint8Array(32).fill(41)],
    ]);
    const cancellation = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [invitation.recordId],
        authorityParentRecordIds: [invitation.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 7,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 4,
        body: canonicalMap([
          [0, cancellationRequest],
          [
            1,
            canonicalMap([
              ...cancellationReceiptPrefix,
              [
                5,
                sodium.crypto_sign_detached(
                  transcript("awsm:invitation-receipt:v1", [
                    encodeCanonicalValue(cancellationReceiptPrefix),
                  ]),
                  receipt.privateKey,
                ),
              ],
            ]),
          ],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(Buffer.from(cancellation.recordId).toString("hex"), cancellation);
    const cancelled = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [cancellation.recordId],
        authorityFrontier: [cancellation.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          cancellation.recordId,
        ],
      },
    });
    expect(cancelled.authority.activeInvitations).toEqual([]);
    expect(cancelled.authority.activeMemberIds).toEqual([creation.ids.firstMemberId]);
    expect(cancelled.authority.writeFences).toEqual([]);

    const invalidCancellationRequest = canonicalMap([
      [0, invitationId],
      [1, cancellationChallenge],
      [2, new Uint8Array(64)],
    ]);
    const invalidCancellationRequestId = sha256(
      transcript("awsm:invitation-cancel-request-id:v1", [
        encodeCanonicalValue(invalidCancellationRequest),
      ]),
    );
    const invalidCancellationReceiptPrefix = canonicalMap([
      [0, invitationId],
      [1, 2],
      [2, invalidCancellationRequestId],
      [3, null],
      [4, new Uint8Array(32).fill(42)],
    ]);
    const invalidCancellation = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [invitation.recordId],
        authorityParentRecordIds: [invitation.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 7,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 4,
        body: canonicalMap([
          [0, invalidCancellationRequest],
          [
            1,
            canonicalMap([
              ...invalidCancellationReceiptPrefix,
              [
                5,
                sodium.crypto_sign_detached(
                  transcript("awsm:invitation-receipt:v1", [
                    encodeCanonicalValue(invalidCancellationReceiptPrefix),
                  ]),
                  receipt.privateKey,
                ),
              ],
            ]),
          ],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(Buffer.from(invalidCancellation.recordId).toString("hex"), invalidCancellation);
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem,
      } as never).replayOpened({
        ...vault,
        replicaState: {
          ...vault.replicaState,
          causalFrontier: [invalidCancellation.recordId],
          authorityFrontier: [invalidCancellation.recordId],
          continuityRecordIds: [
            creation.genesis.recordId,
            invitation.recordId,
            invalidCancellation.recordId,
          ],
        },
      }),
    ).rejects.toThrow("Invitation Cancellation request or receipt signature is invalid");

    const conflicted = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [acceptance.recordId, cancellation.recordId],
        authorityFrontier: [acceptance.recordId, cancellation.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          cancellation.recordId,
        ],
      },
    });
    expect(conflicted.authority.invitationConflicts).toEqual([
      expect.objectContaining({
        invitationId,
        candidates: expect.arrayContaining([
          expect.objectContaining({
            headRecordId: acceptance.recordId,
            outcome: 1,
            authorityReceiptId: new Uint8Array(32).fill(29),
            joinRequestId,
            memberId: proposedMemberId,
          }),
          expect.objectContaining({
            headRecordId: cancellation.recordId,
            outcome: 2,
            authorityReceiptId: new Uint8Array(32).fill(41),
            joinRequestId: null,
            memberId: null,
          }),
        ]),
      }),
    ]);
    expect(conflicted.authority.activeMemberIds).toEqual([creation.ids.firstMemberId]);
    expect(
      conflicted.authority.clientCredentials.get(
        Buffer.from(proposedClientCredentialId).toString("hex"),
      )?.active,
    ).toBe(false);
    expect(conflicted.authority.writeFences).toContainEqual({
      kind: "invitation-conflict",
      subjectId: invitationId,
      causeRecordIds: [acceptance.recordId],
    });

    const candidateContent = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [acceptance.recordId],
        authorityParentRecordIds: [acceptance.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 2,
        type: 12,
        signerCredentialId: proposedClientCredentialId,
        assertedAt: 5,
        body: canonicalMap([
          [0, randomIdentifier("Folder")],
          [1, "Candidate branch"],
          [2, null],
        ]),
      },
      proposedClient.privateKey,
    );
    byId.set(Buffer.from(candidateContent.recordId).toString("hex"), candidateContent);
    const conflictWithPriorContent = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [candidateContent.recordId, cancellation.recordId],
        authorityFrontier: [acceptance.recordId, cancellation.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          cancellation.recordId,
        ],
      },
    });
    expect(conflictWithPriorContent.events).toContainEqual(candidateContent);
    expect(replayEventMemberId(conflictWithPriorContent, candidateContent)).toEqual(
      proposedMemberId,
    );
    expect(
      conflictWithPriorContent.authority.clientCredentials.get(
        Buffer.from(proposedClientCredentialId).toString("hex"),
      )?.active,
    ).toBe(false);

    const conflictingReceiptIds = canonicalSet([
      new Uint8Array(32).fill(29),
      new Uint8Array(32).fill(41),
    ]);
    const conflictingRecordIds = canonicalSet([acceptance.recordId, cancellation.recordId]);
    const selectConsumed = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [acceptance.recordId, cancellation.recordId],
        authorityParentRecordIds: [acceptance.recordId, cancellation.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 8,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 5,
        body: canonicalMap([
          [0, invitationId],
          [1, conflictingReceiptIds],
          [2, conflictingRecordIds],
          [3, 1],
          [4, joinRequestId],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const cancelAll = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [acceptance.recordId, cancellation.recordId],
        authorityParentRecordIds: [acceptance.recordId, cancellation.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 8,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 6,
        body: canonicalMap([
          [0, invitationId],
          [1, conflictingReceiptIds],
          [2, conflictingRecordIds],
          [3, 2],
          [4, null],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(Buffer.from(selectConsumed.recordId).toString("hex"), selectConsumed);
    byId.set(Buffer.from(cancelAll.recordId).toString("hex"), cancelAll);
    const resolvedConsumed = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [selectConsumed.recordId],
        authorityFrontier: [selectConsumed.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          cancellation.recordId,
          selectConsumed.recordId,
        ],
      },
    });
    expect(resolvedConsumed.authority.invitationConflicts).toEqual([]);
    expect(resolvedConsumed.authority.activeMemberIds).toEqual(
      expect.arrayContaining([creation.ids.firstMemberId, proposedMemberId]),
    );
    expect(resolvedConsumed.authority.administratorIds).toEqual(
      expect.arrayContaining([creation.ids.firstMemberId, proposedMemberId]),
    );
    expect(resolvedConsumed.authority.writeFences).toEqual([]);

    const selectedCandidateContent = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [selectConsumed.recordId],
        authorityParentRecordIds: [selectConsumed.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 2,
        type: 12,
        signerCredentialId: proposedClientCredentialId,
        assertedAt: 6,
        body: canonicalMap([
          [0, randomIdentifier("Folder")],
          [1, "Selected candidate"],
          [2, null],
        ]),
      },
      proposedClient.privateKey,
    );
    byId.set(
      Buffer.from(selectedCandidateContent.recordId).toString("hex"),
      selectedCandidateContent,
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem,
      } as never).replayOpened({
        ...vault,
        replicaState: {
          ...vault.replicaState,
          causalFrontier: [selectedCandidateContent.recordId],
          authorityFrontier: [selectConsumed.recordId],
          continuityRecordIds: [
            creation.genesis.recordId,
            invitation.recordId,
            acceptance.recordId,
            cancellation.recordId,
            selectConsumed.recordId,
          ],
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ events: expect.arrayContaining([selectedCandidateContent]) }),
    );

    const resolvedCancelled = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [cancelAll.recordId],
        authorityFrontier: [cancelAll.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          cancellation.recordId,
          cancelAll.recordId,
        ],
      },
    });
    expect(resolvedCancelled.authority.invitationConflicts).toEqual([]);
    expect(resolvedCancelled.authority.activeMemberIds).toEqual([creation.ids.firstMemberId]);
    expect(resolvedCancelled.authority.writeFences).toContainEqual({
      kind: "invitation-conflict",
      subjectId: invitationId,
      causeRecordIds: [acceptance.recordId],
    });
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem,
      } as never).replayOpened({
        ...vault,
        replicaState: {
          ...vault.replicaState,
          causalFrontier: [selectConsumed.recordId, cancelAll.recordId],
          authorityFrontier: [selectConsumed.recordId, cancelAll.recordId],
          continuityRecordIds: [
            creation.genesis.recordId,
            invitation.recordId,
            acceptance.recordId,
            cancellation.recordId,
            selectConsumed.recordId,
            cancelAll.recordId,
          ],
        },
      }),
    ).rejects.toThrow("Concurrent Invitation Conflict Resolutions cannot yet be reduced");

    const invalidReceiptAcceptance = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [invitation.recordId],
        authorityParentRecordIds: [invitation.recordId],
        dependencies: [
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: recoveryEnvelopeId },
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: clientEnvelopeId },
        ],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 6,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 4,
        body: canonicalMap([
          [0, joinRequest],
          [1, proposal],
          [2, canonicalMap([...receiptPrefix, [5, new Uint8Array(64)]])],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(
      Buffer.from(invalidReceiptAcceptance.recordId).toString("hex"),
      invalidReceiptAcceptance,
    );
    readResolvedOpaqueItem.mockClear();
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem,
      } as never).replayOpened({
        ...vault,
        replicaState: {
          ...vault.replicaState,
          causalFrontier: [invalidReceiptAcceptance.recordId],
          authorityFrontier: [invalidReceiptAcceptance.recordId],
          continuityRecordIds: [
            creation.genesis.recordId,
            invitation.recordId,
            invalidReceiptAcceptance.recordId,
          ],
        },
      }),
    ).rejects.toThrow("Invitation Acceptance possession or receipt signature is invalid");
    expect(readResolvedOpaqueItem).not.toHaveBeenCalled();

    const revokeInvitedCredential = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [acceptance.recordId],
        authorityParentRecordIds: [acceptance.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 10,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 5,
        body: canonicalMap([[0, proposedClientCredentialId]]),
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(
      Buffer.from(revokeInvitedCredential.recordId).toString("hex"),
      revokeInvitedCredential,
    );
    const revokedCredential = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [revokeInvitedCredential.recordId],
        authorityFrontier: [revokeInvitedCredential.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          revokeInvitedCredential.recordId,
        ],
      },
    });
    expect(
      revokedCredential.authority.clientCredentials.get(
        Buffer.from(proposedClientCredentialId).toString("hex"),
      )?.active,
    ).toBe(false);
    expect(revokedCredential.authority.writeFences).toContainEqual({
      kind: "client-credential-removal",
      subjectId: proposedClientCredentialId,
      causeRecordIds: [revokeInvitedCredential.recordId],
    });

    const removeInvitedMember = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [acceptance.recordId],
        authorityParentRecordIds: [acceptance.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 2,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 9_999_999_999,
        body: canonicalMap([[0, proposedMemberId]]),
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(Buffer.from(removeInvitedMember.recordId).toString("hex"), removeInvitedMember);

    const secondInvitationId = randomIdentifier("Invitation");
    const secondClientCredentialId = randomIdentifier("ClientCredential");
    const secondRecoveryCredentialId = randomIdentifier("RecoveryCredential");
    const secondRecoveryEnvelopeId = randomIdentifier("KeyEnvelope");
    const secondClientEnvelopeId = randomIdentifier("KeyEnvelope");
    const secondRedemption = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(31));
    const secondReceipt = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(32));
    const secondClient = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(33));
    const secondRecovery = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(34));
    const secondInvitation = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [removeInvitedMember.recordId],
        authorityParentRecordIds: [removeInvitedMember.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 5,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 6,
        body: canonicalMap([
          [0, secondInvitationId],
          [1, capabilities],
          [2, secondRedemption.publicKey],
          [3, new Uint8Array(32).fill(35)],
          [4, new Uint8Array(32).fill(36)],
          [5, secondReceipt.publicKey],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const secondClientCertificate = canonicalMap([
      [0, secondClientCredentialId],
      [1, proposedMemberId],
      [2, secondClient.publicKey],
      [3, new Uint8Array(32).fill(37)],
    ]);
    const secondRecoveryDescriptor = canonicalMap([
      [0, secondRecoveryCredentialId],
      [1, proposedMemberId],
      [2, 0],
      [3, secondRecovery.publicKey],
      [4, new Uint8Array(32).fill(38)],
    ]);
    const secondJoinPrefix = canonicalMap([
      [0, secondInvitationId],
      [1, capabilities],
      [2, proposedMemberId],
      [3, secondClientCertificate],
      [4, secondRecoveryDescriptor],
    ]);
    const secondJoinProof = transcript("awsm:invitation-join-request:v1", [
      encodeCanonicalValue(secondJoinPrefix),
    ]);
    const secondJoinRequest = canonicalMap([
      ...secondJoinPrefix,
      [5, sodium.crypto_sign_detached(secondJoinProof, secondClient.privateKey)],
      [6, sodium.crypto_sign_detached(secondJoinProof, secondRecovery.privateKey)],
      [7, sodium.crypto_sign_detached(secondJoinProof, secondRedemption.privateKey)],
    ]);
    const secondJoinRequestId = sha256(
      transcript("awsm:invitation-join-request-id:v1", [encodeCanonicalValue(secondJoinRequest)]),
    );
    const secondProposal = canonicalMap([
      [0, secondInvitationId],
      [1, secondJoinRequestId],
      [2, canonicalSet([secondInvitation.recordId])],
      [3, proposedMemberId],
      [4, secondClientCertificate],
      [5, secondRecoveryDescriptor],
      [6, capabilities],
      [
        7,
        canonicalSet([
          canonicalMap([
            [0, creation.secrets.keyEpoch.id],
            [1, 1],
            [2, secondRecoveryCredentialId],
            [3, 0],
            [4, secondRecoveryEnvelopeId],
          ]),
          canonicalMap([
            [0, creation.secrets.keyEpoch.id],
            [1, 2],
            [2, secondClientCredentialId],
            [3, null],
            [4, secondClientEnvelopeId],
          ]),
        ]),
      ],
    ]);
    const secondProposalId = sha256(
      transcript("awsm:invitation-acceptance-proposal-id:v1", [
        encodeCanonicalValue(secondProposal),
      ]),
    );
    const secondReceiptPrefix = canonicalMap([
      [0, secondInvitationId],
      [1, 1],
      [2, secondJoinRequestId],
      [3, secondProposalId],
      [4, new Uint8Array(32).fill(39)],
    ]);
    const secondAcceptance = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [secondInvitation.recordId],
        authorityParentRecordIds: [secondInvitation.recordId],
        dependencies: [
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: secondRecoveryEnvelopeId },
          { type: DEPENDENCY_TYPES.KeyEnvelope, id: secondClientEnvelopeId },
        ],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 6,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 7,
        body: canonicalMap([
          [0, secondJoinRequest],
          [1, secondProposal],
          [
            2,
            canonicalMap([
              ...secondReceiptPrefix,
              [
                5,
                sodium.crypto_sign_detached(
                  transcript("awsm:invitation-receipt:v1", [
                    encodeCanonicalValue(secondReceiptPrefix),
                  ]),
                  secondReceipt.privateKey,
                ),
              ],
            ]),
          ],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    byId.set(Buffer.from(secondInvitation.recordId).toString("hex"), secondInvitation);
    byId.set(Buffer.from(secondAcceptance.recordId).toString("hex"), secondAcceptance);
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem,
      } as never).replayOpened({
        ...vault,
        replicaState: {
          ...vault.replicaState,
          causalFrontier: [secondAcceptance.recordId],
          authorityFrontier: [secondAcceptance.recordId],
          continuityRecordIds: [
            creation.genesis.recordId,
            invitation.recordId,
            acceptance.recordId,
            removeInvitedMember.recordId,
            secondInvitation.recordId,
            secondAcceptance.recordId,
          ],
        },
      }),
    ).rejects.toThrow("Invitation Acceptance reuses a permanent Member identity");

    const removeInitialMember = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [acceptance.recordId],
        authorityParentRecordIds: [acceptance.recordId],
        dependencies: [],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 2,
        signerCredentialId: proposedClientCredentialId,
        assertedAt: -9_999_999_999,
        body: canonicalMap([[0, creation.ids.firstMemberId]]),
      },
      proposedClient.privateKey,
    );
    byId.set(Buffer.from(removeInitialMember.recordId).toString("hex"), removeInitialMember);
    const mutuallyRemovedVault: PersistedOpenedCanonicalVault = {
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [removeInvitedMember.recordId, removeInitialMember.recordId],
        authorityFrontier: [removeInvitedMember.recordId, removeInitialMember.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          removeInvitedMember.recordId,
          removeInitialMember.recordId,
        ],
        authoringClientCredentialId: null,
        memberId: null,
        lifecycle: 2,
      },
    };
    const mutuallyRemoved = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened(mutuallyRemovedVault);

    expect(mutuallyRemoved.authority.activeMemberIds).toEqual([]);
    expect(mutuallyRemoved.authority.administratorIds).toEqual([]);
    expect(mutuallyRemoved.authority.lifecycle).toBe(2);
    expect(
      [...mutuallyRemoved.authority.clientCredentials.values()].every(({ active }) => !active),
    ).toBe(true);
    expect(mutuallyRemoved.authority.writeFences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "member-removal",
          subjectId: creation.ids.firstMemberId,
          causeRecordIds: [removeInitialMember.recordId],
        }),
        expect.objectContaining({
          kind: "member-removal",
          subjectId: proposedMemberId,
          causeRecordIds: [removeInvitedMember.recordId],
        }),
      ]),
    );
  });
});

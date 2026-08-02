import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";

import { readySodium } from "../../src/crypto/sodium";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import {
  advisoryExtensions,
  encodeFeatureManifest,
  type FeatureManifest,
  featureManifestId,
  requiredFeatureSetId,
} from "../../src/domain/canonical/features";
import { type Identifier, randomIdentifier } from "../../src/domain/canonical/identifiers";
import { signVaultEvent } from "../../src/domain/canonical/record";
import { transcript } from "../../src/domain/canonical/transcript";
import { canonicalMap, canonicalSet, encodeCanonicalValue } from "../../src/domain/canonical/value";
import {
  CanonicalAuthorityReplay,
  type CanonicalAuthorityState,
} from "../../src/runtime/projection/canonical-authority-replay";
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

function openedVaultAt(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  event: Awaited<ReturnType<typeof signVaultEvent>>,
): PersistedOpenedCanonicalVault {
  return openedVaultAtFrontier(creation, [event.recordId]);
}

function openedVaultAtFrontier(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  frontier: CanonicalReplicaState["causalFrontier"],
  continuityRecordIds: CanonicalReplicaState["continuityRecordIds"] = frontier,
  requiredFeatureSetId: Identifier<"RequiredFeatureSet"> = creation.genesis.requiredFeatureSetId,
): PersistedOpenedCanonicalVault {
  return {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Authority",
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      causalFrontier: frontier,
      authorityFrontier: frontier,
      continuityRecordIds: [creation.genesis.recordId, ...continuityRecordIds],
      baselineId: creation.baseline.recordId,
      currentKeyEpochId: creation.secrets.keyEpoch.id,
      requiredFeatureSetId,
      authoringClientCredentialId: creation.ids.clientCredentialId,
      memberId: creation.ids.firstMemberId,
      lifecycle: 1,
      preservationRoots: [],
      garbageCollectionFences: [],
      adoption: null,
    },
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
  };
}

async function clientEnrollmentProposal(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  seedByte: number,
) {
  const sodium = await readySodium();
  const proposedCredentialId = randomIdentifier("ClientCredential");
  const proposed = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(seedByte));
  const certificate = canonicalMap([
    [0, proposedCredentialId],
    [1, creation.ids.firstMemberId],
    [2, proposed.publicKey],
    [3, new Uint8Array(32).fill(seedByte + 1)],
  ]);
  const envelopeId = randomIdentifier("KeyEnvelope");
  const slots = canonicalSet([
    canonicalMap([
      [0, creation.secrets.keyEpoch.id],
      [1, 2],
      [2, proposedCredentialId],
      [3, null],
      [4, envelopeId],
    ]),
  ]);
  const prefix = canonicalMap([
    [0, creation.ids.vaultId],
    [1, creation.ids.firstMemberId],
    [2, canonicalSet([creation.genesis.recordId])],
    [3, certificate],
    [4, slots],
  ]);
  const proposal = canonicalMap([
    ...prefix,
    [
      5,
      sodium.crypto_sign_detached(
        transcript("awsm:client-enrollment-proposal:v1", [encodeCanonicalValue(prefix)]),
        proposed.privateKey,
      ),
    ],
  ]);
  return {
    proposedCredentialId,
    proposed,
    envelopeId,
    proposal,
    proposalId: sha256(
      transcript("awsm:client-enrollment-proposal-id:v1", [encodeCanonicalValue(proposal)]),
    ),
  };
}

async function recoveryReplacement(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  input: {
    readonly parentRecordIds: CanonicalReplicaState["authorityFrontier"];
    readonly replacedCredentialIds: readonly Uint8Array[];
    readonly revision: number;
    readonly seedByte: number;
    readonly assertedAt: number;
    readonly corruptPossession?: boolean;
  },
) {
  const sodium = await readySodium();
  const recoveryCredentialId = randomIdentifier("RecoveryCredential");
  const recovery = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(input.seedByte));
  const descriptor = canonicalMap([
    [0, recoveryCredentialId],
    [1, creation.ids.firstMemberId],
    [2, input.revision],
    [3, recovery.publicKey],
    [4, new Uint8Array(32).fill(input.seedByte + 1)],
  ]);
  const envelopeId = randomIdentifier("KeyEnvelope");
  const slots = canonicalSet([
    canonicalMap([
      [0, creation.secrets.keyEpoch.id],
      [1, 1],
      [2, recoveryCredentialId],
      [3, input.revision],
      [4, envelopeId],
    ]),
  ]);
  const possession = input.corruptPossession
    ? new Uint8Array(64)
    : sodium.crypto_sign_detached(
        transcript("awsm:recovery-replacement-possession:v1", [
          creation.ids.vaultId,
          creation.ids.firstMemberId,
          encodeCanonicalValue(canonicalSet(input.parentRecordIds)),
          encodeCanonicalValue(descriptor),
          encodeCanonicalValue(slots),
        ]),
        recovery.privateKey,
      );
  const event = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: input.parentRecordIds,
      authorityParentRecordIds: input.parentRecordIds,
      dependencies: [{ type: DEPENDENCY_TYPES.KeyEnvelope, id: envelopeId }],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 1,
      type: 11,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, creation.ids.firstMemberId],
        [1, canonicalSet(input.replacedCredentialIds)],
        [2, descriptor],
        [3, slots],
        [4, possession],
      ]),
    },
    creation.secrets.client.signingSecretKey,
  );
  return { event, recoveryCredentialId, envelopeId };
}

async function keyEpochTransition(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  input: {
    readonly parentRecordIds: CanonicalReplicaState["authorityFrontier"];
    readonly parentKeyEpochIds: readonly Uint8Array[];
    readonly displayNumber: number;
    readonly assertedAt: number;
    readonly keyEpochId?: Identifier<"KeyEpoch">;
    readonly recoveryTargets?: readonly {
      readonly recoveryCredentialId: Uint8Array;
      readonly revision: number;
    }[];
    readonly clientCredentialIds?: readonly Uint8Array[];
    readonly duplicateFirstRecoveryTarget?: boolean;
  },
) {
  const keyEpochId = input.keyEpochId ?? randomIdentifier("KeyEpoch");
  const recoveryTargets = input.recoveryTargets ?? [
    {
      recoveryCredentialId: creation.ids.recoveryCredentialId,
      revision: 0,
    },
  ];
  const clientCredentialIds = input.clientCredentialIds ?? [creation.ids.clientCredentialId];
  const recoveryEnvelopeIds = recoveryTargets.map(() => randomIdentifier("KeyEnvelope"));
  const clientEnvelopeIds = clientCredentialIds.map(() => randomIdentifier("KeyEnvelope"));
  const recoveryEnvelopeId = recoveryEnvelopeIds[0];
  const clientEnvelopeId = clientEnvelopeIds[0];
  const firstRecoveryTarget = recoveryTargets[0];
  if (
    recoveryEnvelopeId === undefined ||
    clientEnvelopeId === undefined ||
    firstRecoveryTarget === undefined
  ) {
    throw new TypeError("Key Epoch Transition fixture requires Recovery and Client targets");
  }
  const duplicateRecoveryEnvelopeId = input.duplicateFirstRecoveryTarget
    ? randomIdentifier("KeyEnvelope")
    : null;
  const slots = canonicalSet([
    ...recoveryTargets.map(({ recoveryCredentialId, revision }, index) => {
      const envelopeId = recoveryEnvelopeIds[index];
      if (envelopeId === undefined) throw new TypeError("Recovery target has no Envelope ID");
      return canonicalMap([
        [0, keyEpochId],
        [1, 1],
        [2, recoveryCredentialId],
        [3, revision],
        [4, envelopeId],
      ]);
    }),
    ...clientCredentialIds.map((clientCredentialId, index) => {
      const envelopeId = clientEnvelopeIds[index];
      if (envelopeId === undefined) throw new TypeError("Client target has no Envelope ID");
      return canonicalMap([
        [0, keyEpochId],
        [1, 2],
        [2, clientCredentialId],
        [3, null],
        [4, envelopeId],
      ]);
    }),
    ...(duplicateRecoveryEnvelopeId === null
      ? []
      : [
          canonicalMap([
            [0, keyEpochId],
            [1, 1],
            [2, firstRecoveryTarget.recoveryCredentialId],
            [3, firstRecoveryTarget.revision],
            [4, duplicateRecoveryEnvelopeId],
          ]),
        ]),
  ]);
  const event = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: input.parentRecordIds,
      authorityParentRecordIds: input.parentRecordIds,
      dependencies: [
        ...recoveryEnvelopeIds,
        ...clientEnvelopeIds,
        ...(duplicateRecoveryEnvelopeId === null ? [] : [duplicateRecoveryEnvelopeId]),
      ].map((id) => ({
        type: DEPENDENCY_TYPES.KeyEnvelope,
        id,
      })),
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 1,
      type: 12,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, canonicalSet(input.parentKeyEpochIds)],
        [1, keyEpochId],
        [2, input.displayNumber],
        [3, slots],
      ]),
    },
    creation.secrets.client.signingSecretKey,
  );
  return {
    event,
    keyEpochId,
    recoveryEnvelopeIds,
    clientEnvelopeIds,
    recoveryEnvelopeId,
    clientEnvelopeId,
  };
}

async function keyDelivery(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  input: {
    readonly parentRecordIds: CanonicalReplicaState["authorityFrontier"];
    readonly signerCredentialId: Identifier<"ClientCredential">;
    readonly signingSecretKey: Uint8Array;
    readonly assertedAt: number;
    readonly keyEnvelopeIds?: readonly Identifier<"KeyEnvelope">[];
    readonly targets: readonly {
      readonly keyEpochId: Identifier<"KeyEpoch">;
      readonly targetKind: 1 | 2;
      readonly targetCredentialId: Uint8Array;
      readonly targetRevision: number | null;
    }[];
  },
) {
  const keyEnvelopeIds =
    input.keyEnvelopeIds ?? input.targets.map(() => randomIdentifier("KeyEnvelope"));
  if (keyEnvelopeIds.length !== input.targets.length) {
    throw new TypeError("Key Delivery fixture requires one Envelope ID per target");
  }
  const slots = canonicalSet(
    input.targets.map((target, index) => {
      const keyEnvelopeId = keyEnvelopeIds[index];
      if (keyEnvelopeId === undefined)
        throw new TypeError("Key Delivery target has no Envelope ID");
      return canonicalMap([
        [0, target.keyEpochId],
        [1, target.targetKind],
        [2, target.targetCredentialId],
        [3, target.targetRevision],
        [4, keyEnvelopeId],
      ]);
    }),
  );
  const event = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: input.parentRecordIds,
      authorityParentRecordIds: input.parentRecordIds,
      dependencies: keyEnvelopeIds.map((id) => ({
        type: DEPENDENCY_TYPES.KeyEnvelope,
        id,
      })),
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 1,
      type: 13,
      signerCredentialId: input.signerCredentialId,
      assertedAt: input.assertedAt,
      body: canonicalMap([[0, slots]]),
    },
    input.signingSecretKey,
  );
  return { event, keyEnvelopeIds };
}

async function featureActivation(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  input: {
    readonly parentRecordIds: CanonicalReplicaState["authorityFrontier"];
    readonly previousFeatureSetId: Identifier<"RequiredFeatureSet">;
    readonly previousManifests: readonly FeatureManifest[];
    readonly addedManifests: readonly FeatureManifest[];
    readonly assertedAt: number;
  },
) {
  const manifestBytes = input.addedManifests.map(encodeFeatureManifest);
  const resultingFeatureSetId = requiredFeatureSetId([
    ...input.previousManifests,
    ...input.addedManifests,
  ]);
  const event = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: input.parentRecordIds,
      authorityParentRecordIds: input.parentRecordIds,
      dependencies: manifestBytes.map((bytes) => ({
        type: DEPENDENCY_TYPES.FeatureManifest,
        id: featureManifestId(bytes),
      })),
      requiredFeatureSetId: input.previousFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 1,
      type: 14,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: input.assertedAt,
      body: canonicalMap([
        [0, input.previousFeatureSetId],
        [1, canonicalSet(manifestBytes)],
        [2, resultingFeatureSetId],
      ]),
    },
    creation.secrets.client.signingSecretKey,
  );
  return { event, manifestBytes, resultingFeatureSetId };
}

async function replayFeatureAuthority(
  creation: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
  activations: readonly Awaited<ReturnType<typeof featureActivation>>[],
  frontier: CanonicalReplicaState["authorityFrontier"],
  finalFeatureSetId: Identifier<"RequiredFeatureSet">,
  supportedFeatureManifestIds: readonly Identifier<"FeatureManifest">[] = [],
) {
  const byId = new Map<string, Uint8Array>();
  for (const activation of activations) {
    byId.set(Buffer.from(activation.event.recordId).toString("hex"), activation.event.bytes);
    for (const bytes of activation.manifestBytes) {
      byId.set(Buffer.from(featureManifestId(bytes)).toString("hex"), bytes);
    }
  }
  const openResolvedCompactItem = vi.fn(
    async ({ logicalId }: { readonly logicalId: Uint8Array }) => ({
      payloadBytes: byId.get(Buffer.from(logicalId).toString("hex")),
    }),
  );
  const replay = await new CanonicalReplayService({ openResolvedCompactItem } as never, {
    supportedFeatureManifestIds,
  }).replayOpened(
    openedVaultAtFrontier(
      creation,
      frontier,
      activations.map(({ event }) => event.recordId),
      finalFeatureSetId,
    ),
  );
  return { replay, openResolvedCompactItem };
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

  it("enrolls an additional Client Credential authorized by an existing Credential", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Enrollment", assertedAt: 1 });
    const { proposedCredentialId, envelopeId, proposal } = await clientEnrollmentProposal(
      creation,
      71,
    );
    const enrollment = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.KeyEnvelope, id: envelopeId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 9,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 2,
        body: canonicalMap([
          [0, proposal],
          [1, 1],
          [2, null],
          [3, null],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const readResolvedOpaqueItem = vi.fn(
      async (_input: { readonly logicalId: Uint8Array; readonly expectedKeyEpochId: Uint8Array }) =>
        new Uint8Array([1]),
    );
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: enrollment.bytes })),
      readResolvedOpaqueItem,
    } as never).replayOpened(openedVaultAt(creation, enrollment));

    expect(
      replay.authority.clientCredentials.get(Buffer.from(proposedCredentialId).toString("hex")),
    ).toEqual(expect.objectContaining({ memberId: creation.ids.firstMemberId, active: true }));
    expect(readResolvedOpaqueItem).toHaveBeenCalledOnce();
    expect(readResolvedOpaqueItem.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        logicalId: envelopeId,
        expectedKeyEpochId: creation.secrets.keyEpoch.id,
      }),
    );

    const invalidProposal = canonicalMap(
      [...proposal].map(([field, value]) =>
        field === 5 ? ([field, new Uint8Array(64)] as const) : ([field, value] as const),
      ),
    );
    const invalidEnrollment = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.KeyEnvelope, id: envelopeId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 9,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 3,
        body: canonicalMap([
          [0, invalidProposal],
          [1, 1],
          [2, null],
          [3, null],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const invalidOpaqueRead = vi.fn(async () => new Uint8Array([1]));
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: invalidEnrollment.bytes })),
        readResolvedOpaqueItem: invalidOpaqueRead,
      } as never).replayOpened(openedVaultAt(creation, invalidEnrollment)),
    ).rejects.toThrow("Client Credential Enrollment possession signature is invalid");
    expect(invalidOpaqueRead).not.toHaveBeenCalled();
  });

  it("enrolls a proposed Client Credential through same-member Recovery authority", async () => {
    const sodium = await readySodium();
    const creation = await prepareCanonicalVaultCreation({ label: "Recovery", assertedAt: 1 });
    const { proposedCredentialId, proposed, envelopeId, proposal, proposalId } =
      await clientEnrollmentProposal(creation, 73);
    const recoveryAuthorization = sodium.crypto_sign_detached(
      transcript("awsm:recovery-client-enrollment-authorization:v1", [proposalId]),
      creation.secrets.recovery.signingSecretKey,
    );
    const enrollment = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.KeyEnvelope, id: envelopeId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 9,
        signerCredentialId: proposedCredentialId,
        assertedAt: 2,
        body: canonicalMap([
          [0, proposal],
          [1, 2],
          [2, creation.ids.recoveryCredentialId],
          [3, recoveryAuthorization],
        ]),
      },
      proposed.privateKey,
    );
    const readResolvedOpaqueItem = vi.fn(async () => new Uint8Array([1]));
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: enrollment.bytes })),
      readResolvedOpaqueItem,
    } as never).replayOpened(openedVaultAt(creation, enrollment));

    expect(
      replay.authority.clientCredentials.get(Buffer.from(proposedCredentialId).toString("hex")),
    ).toEqual(expect.objectContaining({ memberId: creation.ids.firstMemberId, active: true }));
    expect(replayEventMemberId(replay, enrollment)).toEqual(creation.ids.firstMemberId);
    expect(readResolvedOpaqueItem).toHaveBeenCalledOnce();

    const invalidEnrollment = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.KeyEnvelope, id: envelopeId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 9,
        signerCredentialId: proposedCredentialId,
        assertedAt: 3,
        body: canonicalMap([
          [0, proposal],
          [1, 2],
          [2, creation.ids.recoveryCredentialId],
          [3, new Uint8Array(64)],
        ]),
      },
      proposed.privateKey,
    );
    const invalidOpaqueRead = vi.fn(async () => new Uint8Array([1]));
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: invalidEnrollment.bytes })),
        readResolvedOpaqueItem: invalidOpaqueRead,
      } as never).replayOpened(openedVaultAt(creation, invalidEnrollment)),
    ).rejects.toThrow("Client Enrollment Recovery authorization is invalid");
    expect(invalidOpaqueRead).not.toHaveBeenCalled();
  });

  it("replaces the effective Recovery Credential and retains the new revision", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Rotation", assertedAt: 1 });
    const replacement = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 75,
      assertedAt: 2,
    });
    const readResolvedOpaqueItem = vi.fn(async () => new Uint8Array([1]));
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: replacement.event.bytes })),
      readResolvedOpaqueItem,
    } as never).replayOpened(openedVaultAt(creation, replacement.event));

    expect(replay.authority.recoveryCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recoveryCredentialId: creation.ids.recoveryCredentialId,
          revision: 0,
          effective: false,
        }),
        expect.objectContaining({
          recoveryCredentialId: replacement.recoveryCredentialId,
          memberId: creation.ids.firstMemberId,
          revision: 1,
          effective: true,
        }),
      ]),
    );
    expect(readResolvedOpaqueItem).toHaveBeenCalledOnce();

    const invalidPossession = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 76,
      assertedAt: 3,
      corruptPossession: true,
    });
    const invalidOpaqueRead = vi.fn(async () => new Uint8Array([1]));
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async () => ({
          payloadBytes: invalidPossession.event.bytes,
        })),
        readResolvedOpaqueItem: invalidOpaqueRead,
      } as never).replayOpened(openedVaultAt(creation, invalidPossession.event)),
    ).rejects.toThrow("Recovery Credential Replacement possession signature is invalid");
    expect(invalidOpaqueRead).not.toHaveBeenCalled();

    const skippedRevision = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 2,
      seedByte: 78,
      assertedAt: 4,
    });
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: skippedRevision.event.bytes })),
        readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
      } as never).replayOpened(openedVaultAt(creation, skippedRevision.event)),
    ).rejects.toThrow("Recovery Replacement revision does not follow its effective heads");
  });

  it("preserves concurrent Recovery Replacements as a recovery-only Conflict", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Conflict", assertedAt: 1 });
    const left = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 77,
      assertedAt: 10_000,
    });
    const right = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 79,
      assertedAt: -10_000,
    });
    const byId = new Map([
      [Buffer.from(left.event.recordId).toString("hex"), left.event],
      [Buffer.from(right.event.recordId).toString("hex"), right.event],
    ]);
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
    } as never).replayOpened(
      openedVaultAtFrontier(creation, [left.event.recordId, right.event.recordId]),
    );

    expect(
      replay.authority.recoveryCredentials
        .filter(({ effective }) => effective)
        .map(({ recoveryCredentialId }) => recoveryCredentialId),
    ).toEqual(expect.arrayContaining([left.recoveryCredentialId, right.recoveryCredentialId]));
    expect(replay.authority.recoveryConflicts).toEqual([
      expect.objectContaining({
        memberId: creation.ids.firstMemberId,
        candidates: expect.arrayContaining([
          {
            headRecordId: left.event.recordId,
            recoveryCredentialId: left.recoveryCredentialId,
          },
          {
            headRecordId: right.event.recordId,
            recoveryCredentialId: right.recoveryCredentialId,
          },
        ]),
      }),
    ]);
    expect(
      replay.authority.clientCredentials.get(
        Buffer.from(creation.ids.clientCredentialId).toString("hex"),
      )?.active,
    ).toBe(true);
    expect(replay.authority.writeFences).toEqual([]);
  });

  it("resolves a Recovery Conflict through one descendant all-head Replacement", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Resolution", assertedAt: 1 });
    const left = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 87,
      assertedAt: 2,
    });
    const right = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 89,
      assertedAt: 3,
    });
    const resolution = await recoveryReplacement(creation, {
      parentRecordIds: [left.event.recordId, right.event.recordId],
      replacedCredentialIds: [left.recoveryCredentialId, right.recoveryCredentialId],
      revision: 2,
      seedByte: 91,
      assertedAt: 4,
    });
    const byId = new Map(
      [left.event, right.event, resolution.event].map(
        (event) => [Buffer.from(event.recordId).toString("hex"), event] as const,
      ),
    );
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
    } as never).replayOpened(
      openedVaultAtFrontier(
        creation,
        [resolution.event.recordId],
        [left.event.recordId, right.event.recordId, resolution.event.recordId],
      ),
    );

    expect(replay.authority.recoveryConflicts).toEqual([]);
    expect(replay.authority.recoveryCredentials.filter(({ effective }) => effective)).toEqual([
      expect.objectContaining({
        recoveryCredentialId: resolution.recoveryCredentialId,
        revision: 2,
      }),
    ]);

    const partial = await recoveryReplacement(creation, {
      parentRecordIds: [left.event.recordId, right.event.recordId],
      replacedCredentialIds: [left.recoveryCredentialId],
      revision: 2,
      seedByte: 93,
      assertedAt: 5,
    });
    byId.set(Buffer.from(partial.event.recordId).toString("hex"), partial.event);
    const partialOpaqueRead = vi.fn(
      async ({ logicalId }: { readonly logicalId: Uint8Array }) => logicalId,
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: partialOpaqueRead,
      } as never).replayOpened(
        openedVaultAtFrontier(
          creation,
          [partial.event.recordId],
          [left.event.recordId, right.event.recordId, partial.event.recordId],
        ),
      ),
    ).rejects.toThrow("Recovery Replacement does not name every effective Credential");
    expect(partialOpaqueRead.mock.calls.map(([input]) => input.logicalId)).not.toContainEqual(
      partial.envelopeId,
    );
  });

  it("lets a Recovery Fence dominate concurrent Enrollment from the closed phrase", async () => {
    const sodium = await readySodium();
    const creation = await prepareCanonicalVaultCreation({ label: "Fence", assertedAt: 1 });
    const replacement = await recoveryReplacement(creation, {
      parentRecordIds: [creation.genesis.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 81,
      assertedAt: 2,
    });
    const { proposedCredentialId, proposed, envelopeId, proposal, proposalId } =
      await clientEnrollmentProposal(creation, 83);
    const recoveryAuthorization = sodium.crypto_sign_detached(
      transcript("awsm:recovery-client-enrollment-authorization:v1", [proposalId]),
      creation.secrets.recovery.signingSecretKey,
    );
    const enrollment = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.KeyEnvelope, id: envelopeId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 9,
        signerCredentialId: proposedCredentialId,
        assertedAt: 3,
        body: canonicalMap([
          [0, proposal],
          [1, 2],
          [2, creation.ids.recoveryCredentialId],
          [3, recoveryAuthorization],
        ]),
      },
      proposed.privateKey,
    );
    const byId = new Map([
      [Buffer.from(replacement.event.recordId).toString("hex"), replacement.event],
      [Buffer.from(enrollment.recordId).toString("hex"), enrollment],
    ]);
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
    } as never).replayOpened(
      openedVaultAtFrontier(creation, [replacement.event.recordId, enrollment.recordId]),
    );

    expect(
      replay.authority.clientCredentials.get(Buffer.from(proposedCredentialId).toString("hex")),
    ).toEqual(expect.objectContaining({ memberId: creation.ids.firstMemberId, active: false }));
    expect(replayEventMemberId(replay, enrollment)).toEqual(creation.ids.firstMemberId);
    expect(replay.authority.writeFences).toEqual([]);

    const descendantReplacement = await recoveryReplacement(creation, {
      parentRecordIds: [enrollment.recordId],
      replacedCredentialIds: [creation.ids.recoveryCredentialId],
      revision: 1,
      seedByte: 85,
      assertedAt: 4,
    });
    byId.set(
      Buffer.from(descendantReplacement.event.recordId).toString("hex"),
      descendantReplacement.event,
    );
    const priorEnrollment = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
    } as never).replayOpened(
      openedVaultAtFrontier(
        creation,
        [descendantReplacement.event.recordId],
        [enrollment.recordId, descendantReplacement.event.recordId],
      ),
    );
    expect(
      priorEnrollment.authority.clientCredentials.get(
        Buffer.from(proposedCredentialId).toString("hex"),
      )?.active,
    ).toBe(true);
  });

  it("transitions to a fresh Key Epoch with the exact eligible target set", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Epoch", assertedAt: 1 });
    const transition = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 2,
    });
    const readResolvedOpaqueItem = vi.fn(
      async (_input: { readonly logicalId: Uint8Array; readonly expectedKeyEpochId: Uint8Array }) =>
        new Uint8Array([1]),
    );
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: transition.event.bytes })),
      readResolvedOpaqueItem,
    } as never).replayOpened(openedVaultAt(creation, transition.event));

    expect(replay.authority.keyEpochs).toEqual(
      expect.arrayContaining([
        {
          keyEpochId: creation.secrets.keyEpoch.id,
          displayNumber: 0,
          current: false,
        },
        { keyEpochId: transition.keyEpochId, displayNumber: 1, current: true },
      ]),
    );
    expect(readResolvedOpaqueItem.mock.calls.map(([input]) => input.logicalId)).toEqual(
      expect.arrayContaining([transition.recoveryEnvelopeId, transition.clientEnvelopeId]),
    );
    expect(readResolvedOpaqueItem.mock.calls.map(([input]) => input.expectedKeyEpochId)).toEqual([
      transition.keyEpochId,
      transition.keyEpochId,
    ]);
    expect(replay.authority.writeFences).toEqual([]);
  });

  it("rejects duplicate Key Epoch target slots before reading either Envelope", async () => {
    const creation = await prepareCanonicalVaultCreation({
      label: "Duplicate Epoch target",
      assertedAt: 1,
    });
    const transition = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 2,
      duplicateFirstRecoveryTarget: true,
    });
    const readResolvedOpaqueItem = vi.fn(async () => new Uint8Array([1]));

    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: transition.event.bytes })),
        readResolvedOpaqueItem,
      } as never).replayOpened(openedVaultAt(creation, transition.event)),
    ).rejects.toThrow("Key Epoch Transition Envelope slots are not the exact eligible target set");
    expect(readResolvedOpaqueItem).not.toHaveBeenCalled();
  });

  it("preserves sibling Key Epoch Transitions as a protected-write Conflict", async () => {
    const creation = await prepareCanonicalVaultCreation({
      label: "Epoch conflict",
      assertedAt: 1,
    });
    const left = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 10_000,
    });
    const right = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: -10_000,
    });
    const byId = new Map([
      [Buffer.from(left.event.recordId).toString("hex"), left.event],
      [Buffer.from(right.event.recordId).toString("hex"), right.event],
    ]);
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
    } as never).replayOpened(
      openedVaultAtFrontier(creation, [left.event.recordId, right.event.recordId]),
    );

    expect(replay.authority.keyEpochs.filter(({ current }) => current)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyEpochId: left.keyEpochId, displayNumber: 1 }),
        expect.objectContaining({ keyEpochId: right.keyEpochId, displayNumber: 1 }),
      ]),
    );
    expect(replay.authority.keyEpochConflicts).toEqual([
      {
        candidates: expect.arrayContaining([
          { headRecordId: left.event.recordId, keyEpochId: left.keyEpochId },
          { headRecordId: right.event.recordId, keyEpochId: right.keyEpochId },
        ]),
      },
    ]);
    expect(replay.authority.writeFences).toContainEqual(
      expect.objectContaining({
        kind: "key-epoch-conflict",
        causeRecordIds: expect.arrayContaining([left.event.recordId, right.event.recordId]),
      }),
    );
  });

  it("rejects sibling Transitions that reuse one fresh Key Epoch identity", async () => {
    const creation = await prepareCanonicalVaultCreation({
      label: "Epoch identity collision",
      assertedAt: 1,
    });
    const keyEpochId = randomIdentifier("KeyEpoch");
    const left = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 2,
      keyEpochId,
    });
    const right = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 3,
      keyEpochId,
    });
    const byId = new Map(
      [left.event, right.event].map(
        (event) => [Buffer.from(event.recordId).toString("hex"), event] as const,
      ),
    );

    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
      } as never).replayOpened(
        openedVaultAtFrontier(creation, [left.event.recordId, right.event.recordId]),
      ),
    ).rejects.toThrow("Authority State reuses a Key Epoch identity");
  });

  it("resolves a Key Epoch Conflict through one exact all-head Transition", async () => {
    const creation = await prepareCanonicalVaultCreation({
      label: "Epoch resolution",
      assertedAt: 1,
    });
    const left = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 2,
    });
    const right = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 3,
    });
    const resolution = await keyEpochTransition(creation, {
      parentRecordIds: [left.event.recordId, right.event.recordId],
      parentKeyEpochIds: [left.keyEpochId, right.keyEpochId],
      displayNumber: 2,
      assertedAt: 4,
    });
    const byId = new Map(
      [left.event, right.event, resolution.event].map(
        (event) => [Buffer.from(event.recordId).toString("hex"), event] as const,
      ),
    );
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
    } as never).replayOpened(
      openedVaultAtFrontier(
        creation,
        [resolution.event.recordId],
        [left.event.recordId, right.event.recordId, resolution.event.recordId],
      ),
    );

    expect(replay.authority.keyEpochConflicts).toEqual([]);
    expect(replay.authority.keyEpochs.filter(({ current }) => current)).toEqual([
      { keyEpochId: resolution.keyEpochId, displayNumber: 2, current: true },
    ]);
    expect(replay.authority.writeFences).toEqual([]);

    const partial = await keyEpochTransition(creation, {
      parentRecordIds: [left.event.recordId, right.event.recordId],
      parentKeyEpochIds: [left.keyEpochId],
      displayNumber: 2,
      assertedAt: 5,
    });
    byId.set(Buffer.from(partial.event.recordId).toString("hex"), partial.event);
    const partialOpaqueRead = vi.fn(
      async ({ logicalId }: { readonly logicalId: Uint8Array }) => logicalId,
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: partialOpaqueRead,
      } as never).replayOpened(
        openedVaultAtFrontier(
          creation,
          [partial.event.recordId],
          [left.event.recordId, right.event.recordId, partial.event.recordId],
        ),
      ),
    ).rejects.toThrow("Key Epoch Transition does not name every effective Epoch head");
    expect(partialOpaqueRead.mock.calls.map(([input]) => input.logicalId)).not.toContainEqual(
      partial.clientEnvelopeId,
    );
  });

  it("delivers a missing concurrent-Epoch slot without changing Authority", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Delivery", assertedAt: 1 });
    const { proposedCredentialId, proposed, envelopeId, proposal } = await clientEnrollmentProposal(
      creation,
      91,
    );
    const enrollment = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.KeyEnvelope, id: envelopeId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 9,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 2,
        body: canonicalMap([
          [0, proposal],
          [1, 1],
          [2, null],
          [3, null],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const transition = await keyEpochTransition(creation, {
      parentRecordIds: [creation.genesis.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 3,
    });
    const delivery = await keyDelivery(creation, {
      parentRecordIds: [enrollment.recordId, transition.event.recordId],
      signerCredentialId: proposedCredentialId,
      signingSecretKey: proposed.privateKey,
      assertedAt: 4,
      targets: [
        {
          keyEpochId: transition.keyEpochId,
          targetKind: 2,
          targetCredentialId: proposedCredentialId,
          targetRevision: null,
        },
      ],
    });
    const deliveredEnvelopeId = delivery.keyEnvelopeIds[0];
    if (deliveredEnvelopeId === undefined) {
      throw new TypeError("Key Delivery fixture did not produce its Envelope ID");
    }
    const byId = new Map(
      [enrollment, transition.event, delivery.event].map(
        (event) => [Buffer.from(event.recordId).toString("hex"), event] as const,
      ),
    );
    const readResolvedOpaqueItem = vi.fn(
      async (_input: { readonly logicalId: Uint8Array; readonly expectedKeyEpochId: Uint8Array }) =>
        new Uint8Array([1]),
    );
    const replay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened(
      openedVaultAtFrontier(
        creation,
        [delivery.event.recordId],
        [enrollment.recordId, transition.event.recordId, delivery.event.recordId],
      ),
    );

    expect(
      replay.authority.clientCredentials.get(Buffer.from(proposedCredentialId).toString("hex")),
    ).toEqual(expect.objectContaining({ active: true }));
    expect(replay.authority.keyEpochs.filter(({ current }) => current)).toEqual([
      expect.objectContaining({ keyEpochId: transition.keyEpochId, displayNumber: 1 }),
    ]);
    expect(replay.authority.keyEnvelopeSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyEnvelopeId: creation.recoveryKeyEnvelope.id }),
        expect.objectContaining({ keyEnvelopeId: creation.clientKeyEnvelope.id }),
        expect.objectContaining({ keyEnvelopeId: deliveredEnvelopeId }),
      ]),
    );
    expect(replay.authority.keyEnvelopeSlots).toHaveLength(6);
    expect(readResolvedOpaqueItem.mock.calls.map(([input]) => input.logicalId)).toContainEqual(
      deliveredEnvelopeId,
    );

    const redundant = await keyDelivery(creation, {
      parentRecordIds: [delivery.event.recordId],
      signerCredentialId: proposedCredentialId,
      signingSecretKey: proposed.privateKey,
      assertedAt: 5,
      keyEnvelopeIds: [deliveredEnvelopeId],
      targets: [
        {
          keyEpochId: transition.keyEpochId,
          targetKind: 2,
          targetCredentialId: proposedCredentialId,
          targetRevision: null,
        },
      ],
    });
    byId.set(Buffer.from(redundant.event.recordId).toString("hex"), redundant.event);
    const redundantReads = vi.fn(
      async (_input: { readonly logicalId: Uint8Array }) => new Uint8Array([1]),
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: redundantReads,
      } as never).replayOpened(
        openedVaultAtFrontier(
          creation,
          [redundant.event.recordId],
          [
            enrollment.recordId,
            transition.event.recordId,
            delivery.event.recordId,
            redundant.event.recordId,
          ],
        ),
      ),
    ).rejects.toThrow("Key Delivery Envelope slot is already present");
    expect(
      redundantReads.mock.calls.filter(([input]) =>
        Buffer.from(input.logicalId).equals(Buffer.from(deliveredEnvelopeId)),
      ),
    ).toHaveLength(1);

    const invalid = await keyDelivery(creation, {
      parentRecordIds: [enrollment.recordId, transition.event.recordId],
      signerCredentialId: proposedCredentialId,
      signingSecretKey: proposed.privateKey,
      assertedAt: 6,
      targets: [
        {
          keyEpochId: transition.keyEpochId,
          targetKind: 2,
          targetCredentialId: randomIdentifier("ClientCredential"),
          targetRevision: null,
        },
      ],
    });
    byId.set(Buffer.from(invalid.event.recordId).toString("hex"), invalid.event);
    const invalidReads = vi.fn(
      async (_input: { readonly logicalId: Uint8Array }) => new Uint8Array([1]),
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: invalidReads,
      } as never).replayOpened(
        openedVaultAtFrontier(
          creation,
          [invalid.event.recordId],
          [enrollment.recordId, transition.event.recordId, invalid.event.recordId],
        ),
      ),
    ).rejects.toThrow("Key Delivery target is not currently eligible");
    expect(invalidReads.mock.calls.map(([input]) => input.logicalId)).not.toContainEqual(
      invalid.keyEnvelopeIds[0],
    );

    const duplicateTarget = await keyDelivery(creation, {
      parentRecordIds: [enrollment.recordId, transition.event.recordId],
      signerCredentialId: proposedCredentialId,
      signingSecretKey: proposed.privateKey,
      assertedAt: 7,
      targets: [
        {
          keyEpochId: transition.keyEpochId,
          targetKind: 2,
          targetCredentialId: proposedCredentialId,
          targetRevision: null,
        },
        {
          keyEpochId: transition.keyEpochId,
          targetKind: 2,
          targetCredentialId: proposedCredentialId,
          targetRevision: null,
        },
      ],
    });
    byId.set(Buffer.from(duplicateTarget.event.recordId).toString("hex"), duplicateTarget.event);
    const duplicateReads = vi.fn(
      async (_input: { readonly logicalId: Uint8Array }) => new Uint8Array([1]),
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: duplicateReads,
      } as never).replayOpened(
        openedVaultAtFrontier(
          creation,
          [duplicateTarget.event.recordId],
          [enrollment.recordId, transition.event.recordId, duplicateTarget.event.recordId],
        ),
      ),
    ).rejects.toThrow("Key Delivery contains more than one Envelope for one target");
    const duplicateReadIds = duplicateReads.mock.calls.map(([input]) => input.logicalId);
    for (const keyEnvelopeId of duplicateTarget.keyEnvelopeIds) {
      expect(duplicateReadIds).not.toContainEqual(keyEnvelopeId);
    }

    const rebound = await keyDelivery(creation, {
      parentRecordIds: [enrollment.recordId, transition.event.recordId],
      signerCredentialId: proposedCredentialId,
      signingSecretKey: proposed.privateKey,
      assertedAt: 8,
      keyEnvelopeIds: [creation.clientKeyEnvelope.id],
      targets: [
        {
          keyEpochId: transition.keyEpochId,
          targetKind: 2,
          targetCredentialId: proposedCredentialId,
          targetRevision: null,
        },
      ],
    });
    byId.set(Buffer.from(rebound.event.recordId).toString("hex"), rebound.event);
    const reboundReads = vi.fn(
      async (_input: { readonly logicalId: Uint8Array }) => new Uint8Array([1]),
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: reboundReads,
      } as never).replayOpened(
        openedVaultAtFrontier(
          creation,
          [rebound.event.recordId],
          [enrollment.recordId, transition.event.recordId, rebound.event.recordId],
        ),
      ),
    ).rejects.toThrow("Key Delivery rebinds a Key Envelope identity");
    expect(reboundReads.mock.calls.map(([input]) => input.logicalId)).not.toContainEqual(
      creation.clientKeyEnvelope.id,
    );

    const duplicateDeliveryId = randomIdentifier("KeyEnvelope");
    const duplicateDeliveryTarget = [
      {
        keyEpochId: transition.keyEpochId,
        targetKind: 2 as const,
        targetCredentialId: proposedCredentialId,
        targetRevision: null,
      },
    ];
    const leftDuplicate = await keyDelivery(creation, {
      parentRecordIds: [enrollment.recordId, transition.event.recordId],
      signerCredentialId: proposedCredentialId,
      signingSecretKey: proposed.privateKey,
      assertedAt: 10_000,
      keyEnvelopeIds: [duplicateDeliveryId],
      targets: duplicateDeliveryTarget,
    });
    const rightDuplicate = await keyDelivery(creation, {
      parentRecordIds: [enrollment.recordId, transition.event.recordId],
      signerCredentialId: proposedCredentialId,
      signingSecretKey: proposed.privateKey,
      assertedAt: -10_000,
      keyEnvelopeIds: [duplicateDeliveryId],
      targets: duplicateDeliveryTarget,
    });
    byId.set(Buffer.from(leftDuplicate.event.recordId).toString("hex"), leftDuplicate.event);
    byId.set(Buffer.from(rightDuplicate.event.recordId).toString("hex"), rightDuplicate.event);
    const convergedDuplicates = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array([1])),
    } as never).replayOpened(
      openedVaultAtFrontier(
        creation,
        [leftDuplicate.event.recordId, rightDuplicate.event.recordId],
        [
          enrollment.recordId,
          transition.event.recordId,
          leftDuplicate.event.recordId,
          rightDuplicate.event.recordId,
        ],
      ),
    );
    expect(
      convergedDuplicates.authority.keyEnvelopeSlots.filter(({ keyEnvelopeId }) =>
        Buffer.from(keyEnvelopeId).equals(Buffer.from(duplicateDeliveryId)),
      ),
    ).toHaveLength(1);
    expect(convergedDuplicates.authority.keyEpochConflicts).toEqual([]);
    expect(convergedDuplicates.authority.writeFences).toEqual([]);
  });

  it("activates an exact Feature Manifest under the parent Required Feature Set", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Features", assertedAt: 1 });
    const manifest = {
      featureKey: "awsm.test-alpha",
      revision: 1,
      parameters: Uint8Array.of(7),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const satisfies FeatureManifest;
    const activation = await featureActivation(creation, {
      parentRecordIds: [creation.genesis.recordId],
      previousFeatureSetId: creation.genesis.requiredFeatureSetId,
      previousManifests: [],
      addedManifests: [manifest],
      assertedAt: 2,
    });
    const manifestBytes = activation.manifestBytes[0];
    if (manifestBytes === undefined) throw new TypeError("Feature fixture omitted its Manifest");
    const manifestId = featureManifestId(manifestBytes);
    const { replay, openResolvedCompactItem } = await replayFeatureAuthority(
      creation,
      [activation],
      [activation.event.recordId],
      activation.resultingFeatureSetId,
    );

    expect(replay.authority.requiredFeatureSetId).toEqual(activation.resultingFeatureSetId);
    expect(replay.authority.featureManifests).toEqual([
      expect.objectContaining({ id: manifestId, manifest }),
    ]);
    expect(openResolvedCompactItem.mock.calls.map(([input]) => input.logicalId)).toContainEqual(
      manifestId,
    );

    const invalidResultId = randomIdentifier("RequiredFeatureSet");
    const invalid = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [creation.genesis.recordId],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.FeatureManifest, id: manifestId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 14,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 3,
        body: canonicalMap([
          [0, creation.genesis.requiredFeatureSetId],
          [1, canonicalSet(activation.manifestBytes)],
          [2, invalidResultId],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const invalidOpen = vi.fn(async ({ logicalId }: { readonly logicalId: Uint8Array }) => ({
      payloadBytes: Buffer.from(logicalId).equals(Buffer.from(invalid.recordId))
        ? invalid.bytes
        : activation.manifestBytes[0],
    }));
    await expect(
      new CanonicalReplayService({ openResolvedCompactItem: invalidOpen } as never).replayOpened(
        openedVaultAtFrontier(creation, [invalid.recordId], [invalid.recordId], invalidResultId),
      ),
    ).rejects.toThrow("Feature Activation resulting set is invalid");
    expect(invalidOpen.mock.calls.map(([input]) => input.logicalId)).not.toContainEqual(manifestId);
  });

  it("allows a later Feature Manifest to require an already-active Manifest", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Features", assertedAt: 1 });
    const foundation = {
      featureKey: "awsm.test-foundation",
      revision: 1,
      parameters: new Uint8Array(),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const satisfies FeatureManifest;
    const first = await featureActivation(creation, {
      parentRecordIds: [creation.genesis.recordId],
      previousFeatureSetId: creation.genesis.requiredFeatureSetId,
      previousManifests: [],
      addedManifests: [foundation],
      assertedAt: 2,
    });
    const foundationBytes = first.manifestBytes[0];
    if (foundationBytes === undefined) {
      throw new TypeError("Feature fixture omitted its foundation Manifest");
    }
    const foundationId = featureManifestId(foundationBytes);
    const dependent = {
      featureKey: "awsm.test-dependent",
      revision: 1,
      parameters: new Uint8Array(),
      requiredManifestIds: [foundationId],
      incompatibleKeys: [],
    } as const satisfies FeatureManifest;
    const second = await featureActivation(creation, {
      parentRecordIds: [first.event.recordId],
      previousFeatureSetId: first.resultingFeatureSetId,
      previousManifests: [foundation],
      addedManifests: [dependent],
      assertedAt: 3,
    });

    const { replay } = await replayFeatureAuthority(
      creation,
      [first, second],
      [second.event.recordId],
      second.resultingFeatureSetId,
      [foundationId],
    );
    expect(replay.authority.requiredFeatureSetId).toEqual(second.resultingFeatureSetId);
    expect(
      replay.authority.featureManifests.map(({ manifest }) => manifest.featureKey).sort(),
    ).toEqual(["awsm.test-dependent", "awsm.test-foundation"]);
  });

  it("stops semantic descendants until the Runtime supports every active Feature Manifest", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Features", assertedAt: 1 });
    const manifest = {
      featureKey: "awsm.test-gated",
      revision: 1,
      parameters: new Uint8Array(),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const satisfies FeatureManifest;
    const activation = await featureActivation(creation, {
      parentRecordIds: [creation.genesis.recordId],
      previousFeatureSetId: creation.genesis.requiredFeatureSetId,
      previousManifests: [],
      addedManifests: [manifest],
      assertedAt: 2,
    });
    const invitationId = randomIdentifier("Invitation");
    const descendant = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [activation.event.recordId],
        authorityParentRecordIds: [activation.event.recordId],
        dependencies: [],
        requiredFeatureSetId: activation.resultingFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 5,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 3,
        body: canonicalMap([
          [0, invitationId],
          [
            1,
            canonicalSet([
              canonicalMap([
                [0, "awsm.vault"],
                [1, creation.ids.firstMemberId],
                [2, creation.ids.vaultId],
                [3, "awsm.vault.join"],
                [4, new Uint8Array()],
              ]),
            ]),
          ],
          [2, new Uint8Array(32).fill(81)],
          [3, new Uint8Array(32).fill(82)],
          [4, new Uint8Array(32).fill(83)],
          [5, new Uint8Array(32).fill(84)],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const manifestBytes = activation.manifestBytes[0];
    if (manifestBytes === undefined) throw new TypeError("Feature fixture omitted its Manifest");
    const manifestId = featureManifestId(manifestBytes);
    const byId = new Map([
      [Buffer.from(activation.event.recordId).toString("hex"), activation.event.bytes],
      [Buffer.from(descendant.recordId).toString("hex"), descendant.bytes],
      [Buffer.from(manifestId).toString("hex"), manifestBytes],
    ]);
    const vaults = {
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { readonly logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex")),
      })),
    } as never;
    const opened = openedVaultAtFrontier(
      creation,
      [descendant.recordId],
      [activation.event.recordId, descendant.recordId],
      activation.resultingFeatureSetId,
    );

    await expect(new CanonicalReplayService(vaults).replayOpened(opened)).rejects.toThrow(
      "Runtime does not support the complete Required Feature Set",
    );
    const replay = await new CanonicalReplayService(vaults, {
      supportedFeatureManifestIds: [manifestId],
    }).replayOpened(opened);
    expect(replay.authority.activeInvitations).toEqual([expect.objectContaining({ invitationId })]);
  });

  it("fences concurrent incompatible Feature Activations without choosing by time", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Features", assertedAt: 1 });
    const revisionOne = {
      featureKey: "awsm.test-revision",
      revision: 1,
      parameters: new Uint8Array(),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const satisfies FeatureManifest;
    const revisionTwo = { ...revisionOne, revision: 2 } as const satisfies FeatureManifest;
    const revisionThree = { ...revisionOne, revision: 3 } as const satisfies FeatureManifest;
    const left = await featureActivation(creation, {
      parentRecordIds: [creation.genesis.recordId],
      previousFeatureSetId: creation.genesis.requiredFeatureSetId,
      previousManifests: [],
      addedManifests: [revisionOne],
      assertedAt: 10_000,
    });
    const right = await featureActivation(creation, {
      parentRecordIds: [creation.genesis.recordId],
      previousFeatureSetId: creation.genesis.requiredFeatureSetId,
      previousManifests: [],
      addedManifests: [revisionTwo],
      assertedAt: -10_000,
    });
    const third = await featureActivation(creation, {
      parentRecordIds: [creation.genesis.recordId],
      previousFeatureSetId: creation.genesis.requiredFeatureSetId,
      previousManifests: [],
      addedManifests: [revisionThree],
      assertedAt: 5,
    });

    const { replay } = await replayFeatureAuthority(
      creation,
      [left, right, third],
      [left.event.recordId, right.event.recordId, third.event.recordId],
      creation.genesis.requiredFeatureSetId,
    );
    const candidateRecordIds = [
      left.event.recordId,
      right.event.recordId,
      third.event.recordId,
    ].sort((first, second) => Buffer.compare(Buffer.from(first), Buffer.from(second)));
    const manifestIds = [...left.manifestBytes, ...right.manifestBytes, ...third.manifestBytes]
      .map(featureManifestId)
      .sort((first, second) => Buffer.compare(Buffer.from(first), Buffer.from(second)));
    expect(replay.authority.requiredFeatureSetId).toEqual(creation.genesis.requiredFeatureSetId);
    expect(replay.authority.featureManifests).toEqual([]);
    expect(replay.authority.featureSetConflict).toEqual({ candidateRecordIds, manifestIds });
    expect(replay.authority.writeFences).toContainEqual({
      kind: "feature-set-incompatibility",
      subjectId: creation.ids.vaultId,
      causeRecordIds: candidateRecordIds,
    });

    const blocked = await featureActivation(creation, {
      parentRecordIds: [left.event.recordId, right.event.recordId, third.event.recordId],
      previousFeatureSetId: creation.genesis.requiredFeatureSetId,
      previousManifests: [],
      addedManifests: [
        {
          featureKey: "awsm.test-after-conflict",
          revision: 1,
          parameters: new Uint8Array(),
          requiredManifestIds: [],
          incompatibleKeys: [],
        },
      ],
      assertedAt: 4,
    });
    const blockedManifestBytes = blocked.manifestBytes[0];
    if (blockedManifestBytes === undefined) {
      throw new TypeError("Feature fixture omitted its blocked Manifest");
    }
    const blockedManifestId = featureManifestId(blockedManifestBytes);
    const byId = new Map<string, Uint8Array>();
    for (const candidate of [left, right, third, blocked]) {
      byId.set(Buffer.from(candidate.event.recordId).toString("hex"), candidate.event.bytes);
      for (const bytes of candidate.manifestBytes) {
        byId.set(Buffer.from(featureManifestId(bytes)).toString("hex"), bytes);
      }
    }
    const openResolvedCompactItem = vi.fn(
      async ({ logicalId }: { readonly logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex")),
      }),
    );
    await expect(
      new CanonicalReplayService({ openResolvedCompactItem } as never).replayOpened(
        openedVaultAtFrontier(
          creation,
          [blocked.event.recordId],
          [left.event.recordId, right.event.recordId, third.event.recordId, blocked.event.recordId],
          creation.genesis.requiredFeatureSetId,
        ),
      ),
    ).rejects.toThrow("An Event cannot descend from an incompatible Required Feature Set");
    expect(openResolvedCompactItem.mock.calls.map(([input]) => input.logicalId)).not.toContainEqual(
      blockedManifestId,
    );
  });

  it("unions compatible sibling Feature Activations and coalesces exact duplicates", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Features", assertedAt: 1 });
    const alpha = {
      featureKey: "awsm.test-alpha",
      revision: 1,
      parameters: new Uint8Array(),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const satisfies FeatureManifest;
    const beta = { ...alpha, featureKey: "awsm.test-beta" } as const satisfies FeatureManifest;
    const activation = async (manifest: FeatureManifest, assertedAt: number) =>
      featureActivation(creation, {
        parentRecordIds: [creation.genesis.recordId],
        previousFeatureSetId: creation.genesis.requiredFeatureSetId,
        previousManifests: [],
        addedManifests: [manifest],
        assertedAt,
      });
    const left = await activation(alpha, 10_000);
    const right = await activation(beta, -10_000);
    const duplicate = await activation(alpha, 3);
    const combinedFeatureSetId = requiredFeatureSetId([alpha, beta]);

    const { replay } = await replayFeatureAuthority(
      creation,
      [left, right, duplicate],
      [left.event.recordId, right.event.recordId, duplicate.event.recordId],
      combinedFeatureSetId,
    );
    expect(replay.authority.requiredFeatureSetId).toEqual(combinedFeatureSetId);
    expect(
      replay.authority.featureManifests.map(({ manifest }) => manifest.featureKey).sort(),
    ).toEqual(["awsm.test-alpha", "awsm.test-beta"]);
    expect(replay.authority.featureSetConflict).toBeNull();
    expect(
      replay.authority.writeFences.filter(({ kind }) => kind === "feature-set-incompatibility"),
    ).toEqual([]);
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
    const prematureConflictEpoch = await keyEpochTransition(creation, {
      parentRecordIds: [acceptance.recordId, cancellation.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 5,
    });
    byId.set(
      Buffer.from(prematureConflictEpoch.event.recordId).toString("hex"),
      prematureConflictEpoch.event,
    );
    const prematureConflictEpochReads = vi.fn(
      async (_input: { readonly logicalId: Uint8Array }) => new Uint8Array([1]),
    );
    await expect(
      new CanonicalReplayService({
        openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
          payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
        })),
        readResolvedOpaqueItem: prematureConflictEpochReads,
      } as never).replayOpened({
        ...vault,
        replicaState: {
          ...vault.replicaState,
          causalFrontier: [prematureConflictEpoch.event.recordId],
          authorityFrontier: [prematureConflictEpoch.event.recordId],
          continuityRecordIds: [
            creation.genesis.recordId,
            invitation.recordId,
            acceptance.recordId,
            cancellation.recordId,
            prematureConflictEpoch.event.recordId,
          ],
        },
      }),
    ).rejects.toThrow("Key Epoch Transition cannot precede Invitation Conflict Resolution");
    const prematureReadIds = prematureConflictEpochReads.mock.calls.map(
      ([input]) => input.logicalId,
    );
    expect(prematureReadIds).not.toContainEqual(prematureConflictEpoch.recoveryEnvelopeId);
    expect(prematureReadIds).not.toContainEqual(prematureConflictEpoch.clientEnvelopeId);

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
    const excludingEpoch = await keyEpochTransition(creation, {
      parentRecordIds: [cancelAll.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 7,
    });
    byId.set(Buffer.from(excludingEpoch.event.recordId).toString("hex"), excludingEpoch.event);
    const protectedAgain = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [excludingEpoch.event.recordId],
        authorityFrontier: [excludingEpoch.event.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          cancellation.recordId,
          cancelAll.recordId,
          excludingEpoch.event.recordId,
        ],
        currentKeyEpochId: excludingEpoch.keyEpochId,
      },
    });
    expect(protectedAgain.authority.writeFences).toEqual([]);
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
    const credentialExcludingEpoch = await keyEpochTransition(creation, {
      parentRecordIds: [revokeInvitedCredential.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 6,
      recoveryTargets: [
        {
          recoveryCredentialId: creation.ids.recoveryCredentialId,
          revision: 0,
        },
        { recoveryCredentialId: proposedRecoveryCredentialId, revision: 0 },
      ],
      clientCredentialIds: [creation.ids.clientCredentialId],
    });
    byId.set(
      Buffer.from(credentialExcludingEpoch.event.recordId).toString("hex"),
      credentialExcludingEpoch.event,
    );
    const protectedAfterCredentialExclusion = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [credentialExcludingEpoch.event.recordId],
        authorityFrontier: [credentialExcludingEpoch.event.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          revokeInvitedCredential.recordId,
          credentialExcludingEpoch.event.recordId,
        ],
        currentKeyEpochId: credentialExcludingEpoch.keyEpochId,
      },
    });
    expect(protectedAfterCredentialExclusion.authority.writeFences).toEqual([]);
    expect(
      protectedAfterCredentialExclusion.authority.clientCredentials.get(
        Buffer.from(proposedClientCredentialId).toString("hex"),
      )?.active,
    ).toBe(false);

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
    const memberExcludingEpoch = await keyEpochTransition(creation, {
      parentRecordIds: [removeInvitedMember.recordId],
      parentKeyEpochIds: [creation.secrets.keyEpoch.id],
      displayNumber: 1,
      assertedAt: 6,
    });
    byId.set(
      Buffer.from(memberExcludingEpoch.event.recordId).toString("hex"),
      memberExcludingEpoch.event,
    );
    const protectedAfterMemberExclusion = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }: { logicalId: Uint8Array }) => ({
        payloadBytes: byId.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem,
    } as never).replayOpened({
      ...vault,
      replicaState: {
        ...vault.replicaState,
        causalFrontier: [memberExcludingEpoch.event.recordId],
        authorityFrontier: [memberExcludingEpoch.event.recordId],
        continuityRecordIds: [
          creation.genesis.recordId,
          invitation.recordId,
          acceptance.recordId,
          removeInvitedMember.recordId,
          memberExcludingEpoch.event.recordId,
        ],
        currentKeyEpochId: memberExcludingEpoch.keyEpochId,
      },
    });
    expect(protectedAfterMemberExclusion.authority.activeMemberIds).not.toContainEqual(
      proposedMemberId,
    );
    expect(protectedAfterMemberExclusion.authority.writeFences).toEqual([]);

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

  it("advances every checkpointed authority class from a successor anchor", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Anchor", assertedAt: 1 });
    const opened = openedVaultAtFrontier(creation, [creation.genesis.recordId], []);
    const initial = await new CanonicalReplayService({} as never).replayOpened(opened);
    const memberId = randomIdentifier("Member");
    const clientCredentialId = randomIdentifier("ClientCredential");
    const recoveryCredentialId = randomIdentifier("RecoveryCredential");
    const anchorRecordId = randomIdentifier("VaultRecord");
    const conflictedMemberId = randomIdentifier("Member");
    const administratorGrantHead = randomIdentifier("VaultRecord");
    const administratorEndHead = randomIdentifier("VaultRecord");
    const conflictedInvitationId = randomIdentifier("Invitation");
    const consumedHead = randomIdentifier("VaultRecord");
    const cancelledHead = randomIdentifier("VaultRecord");
    const anchorState: CanonicalAuthorityState = {
      ...initial.authority,
      activeMemberIds: [...initial.authority.activeMemberIds, memberId, conflictedMemberId],
      administratorIds: [...initial.authority.administratorIds, memberId],
      administratorConflicts: [
        {
          memberId: conflictedMemberId,
          candidates: [
            { headRecordId: administratorGrantHead, administrator: true },
            { headRecordId: administratorEndHead, administrator: false },
          ],
        },
      ],
      invitationConflicts: [
        {
          invitationId: conflictedInvitationId,
          candidates: [
            {
              headRecordId: consumedHead,
              outcome: 1,
              authorityReceiptId: new Uint8Array(32).fill(87),
              joinRequestId: new Uint8Array(32).fill(88),
              memberId: conflictedMemberId,
            },
            {
              headRecordId: cancelledHead,
              outcome: 2,
              authorityReceiptId: new Uint8Array(32).fill(89),
              joinRequestId: null,
              memberId: null,
            },
          ],
        },
      ],
      recoveryCredentials: [
        ...initial.authority.recoveryCredentials,
        {
          recoveryCredentialId,
          memberId,
          revision: 0,
          signingPublicKey: new Uint8Array(32).fill(80),
          wrappingPublicKey: new Uint8Array(32).fill(81),
          effective: true,
        },
      ],
      clientCredentials: new Map([
        ...initial.authority.clientCredentials,
        [
          Buffer.from(clientCredentialId).toString("hex"),
          {
            clientCredentialId,
            memberId,
            signingPublicKey: creation.secrets.client.signingPublicKey,
            wrappingPublicKey: new Uint8Array(32).fill(82),
            active: true,
          },
        ],
      ]),
      writeFences: [
        {
          kind: "invitation-conflict",
          subjectId: conflictedInvitationId,
          causeRecordIds: [consumedHead],
        },
      ],
    };
    const invitationId = randomIdentifier("Invitation");
    const invitation = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [anchorRecordId],
        authorityParentRecordIds: [anchorRecordId],
        dependencies: [],
        requiredFeatureSetId: anchorState.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 5,
        signerCredentialId: clientCredentialId,
        assertedAt: 2,
        body: canonicalMap([
          [0, invitationId],
          [
            1,
            canonicalSet([
              canonicalMap([
                [0, "awsm.vault"],
                [1, memberId],
                [2, creation.ids.vaultId],
                [3, "awsm.vault.join"],
                [4, new Uint8Array()],
              ]),
            ]),
          ],
          [2, new Uint8Array(32).fill(83)],
          [3, new Uint8Array(32).fill(84)],
          [4, new Uint8Array(32).fill(85)],
          [5, new Uint8Array(32).fill(86)],
        ]),
      },
      creation.secrets.client.signingSecretKey,
    );
    const replay = new CanonicalAuthorityReplay(creation.genesis, anchorRecordId, anchorState, []);

    await replay.validateAndAccept(invitation);
    const advanced = replay.stateAt([invitation.recordId]);

    expect(advanced.activeMemberIds).toEqual(expect.arrayContaining([memberId]));
    expect(advanced.administratorIds).toEqual(expect.arrayContaining([memberId]));
    expect(advanced.clientCredentials.get(Buffer.from(clientCredentialId).toString("hex"))).toEqual(
      expect.objectContaining({ memberId, active: true }),
    );
    expect(advanced.recoveryCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recoveryCredentialId, memberId, effective: true }),
      ]),
    );
    expect(advanced.keyEpochs).toEqual(anchorState.keyEpochs);
    expect(advanced.keyEnvelopeSlots).toHaveLength(anchorState.keyEnvelopeSlots.length);
    expect(advanced.keyEnvelopeSlots).toEqual(
      expect.arrayContaining([...anchorState.keyEnvelopeSlots]),
    );
    expect(advanced.administratorConflicts).toHaveLength(1);
    expect(advanced.administratorConflicts[0]).toEqual(
      expect.objectContaining({
        memberId: conflictedMemberId,
        candidates: expect.arrayContaining([
          ...(anchorState.administratorConflicts[0]?.candidates ?? []),
        ]),
      }),
    );
    expect(advanced.invitationConflicts).toHaveLength(1);
    expect(advanced.invitationConflicts[0]).toEqual(
      expect.objectContaining({
        invitationId: conflictedInvitationId,
        candidates: expect.arrayContaining([
          ...(anchorState.invitationConflicts[0]?.candidates ?? []),
        ]),
      }),
    );
    expect(advanced.writeFences).toEqual(anchorState.writeFences);
    expect(advanced.activeInvitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ invitationId })]),
    );
  });
});

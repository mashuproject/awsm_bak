import { describe, expect, it, vi } from "vitest";

import { encodeRecoveryPhrase } from "../../src/crypto/canonical";
import { sealKeyEnvelope } from "../../src/crypto/key-envelope";
import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { bytesEqual } from "../../src/domain/hash";
import type { ReplicaMutationCommit } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import {
  CanonicalReplayService,
  replayEventMemberId,
} from "../../src/runtime/projection/canonical-replay";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import { prepareCanonicalMemberRecoveryEnrollment } from "../../src/runtime/vault/canonical-member-recovery";
import { CanonicalMemberRecoveryService } from "../../src/runtime/vault/canonical-member-recovery-service";
import { prepareCanonicalRecoveryCredentialReplacement } from "../../src/runtime/vault/canonical-recovery-replacement";
import { CanonicalRecoveryReplacementService } from "../../src/runtime/vault/canonical-recovery-replacement-service";
import type { PersistedOpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";

async function recoveryFixture() {
  const creation = await prepareCanonicalVaultCreation({
    label: "Recovery",
    assertedAt: 1,
    deterministic: { recoveryEntropy: new Uint8Array(16).fill(1) },
  });
  const replicaState: CanonicalReplicaState = {
    vaultId: creation.ids.vaultId,
    generationId: creation.ids.generationId,
    causalFrontier: [creation.genesis.recordId],
    authorityFrontier: [creation.genesis.recordId],
    continuityRecordIds: [creation.genesis.recordId],
    baselineId: creation.baseline.recordId,
    currentKeyEpochId: creation.secrets.keyEpoch.id,
    requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
    authoringClientCredentialId: null,
    memberId: null,
    lifecycle: 1,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
  const vault: PersistedOpenedCanonicalVault = {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Recovery",
      selectedClientCredentialId: null,
    },
    replicaState,
    clientSecret: null,
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
    replicaStateStorageBytes: new Uint8Array(),
  };
  const replay = await new CanonicalReplayService({} as never).replayOpened(vault);
  return { creation, vault, replay };
}

describe("canonical member Recovery enrollment", () => {
  it("proves phrase possession and enrolls a fresh same-member Client Credential", async () => {
    const { creation, vault, replay } = await recoveryFixture();
    const readRecoveryKeyEnvelope = vi.fn(async () => creation.recoveryKeyEnvelope.envelope.bytes);

    const prepared = await prepareCanonicalMemberRecoveryEnrollment({
      replay,
      recoveryPhrase: creation.recoveryPhrase,
      readRecoveryKeyEnvelope,
      assertedAt: 2,
    });

    expect(readRecoveryKeyEnvelope).toHaveBeenCalledOnce();
    expect(prepared.event).toMatchObject({ family: 1, type: 9 });
    expect(prepared.clientKeyEnvelopes).toHaveLength(1);
    expect(prepared.recoveredEpochs).toHaveLength(1);
    expect(prepared.recoveredEpochs[0]).toMatchObject({
      keyEpochId: creation.secrets.keyEpoch.id,
      displayNumber: 0,
    });
    expect(prepared.recoveredEpochs[0]?.key).toEqual(creation.secrets.keyEpoch.key);

    const recoveredVault: PersistedOpenedCanonicalVault = {
      ...vault,
      directory: {
        ...vault.directory,
        selectedClientCredentialId: prepared.clientSecret.clientCredentialId,
      },
      replicaState: prepared.nextReplicaState,
      clientSecret: prepared.clientSecret,
    };
    const recoveredReplay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: prepared.event.bytes })),
      readResolvedOpaqueItem: vi.fn(async ({ logicalId }) => {
        const envelope = prepared.clientKeyEnvelopes.find(({ id }) => bytesEqual(id, logicalId));
        if (envelope === undefined) throw new TypeError("Missing prepared Client Key Envelope");
        return envelope.envelope.bytes;
      }),
    } as never).replayOpened(recoveredVault);
    expect(
      recoveredReplay.authority.clientCredentials.get(
        Buffer.from(prepared.clientSecret.clientCredentialId).toString("hex"),
      ),
    ).toEqual(expect.objectContaining({ memberId: creation.ids.firstMemberId, active: true }));
    expect(replayEventMemberId(recoveredReplay, prepared.event)).toEqual(
      creation.ids.firstMemberId,
    );
  });

  it("rejects a different valid phrase before reading an opaque Envelope", async () => {
    const { replay } = await recoveryFixture();
    const readRecoveryKeyEnvelope = vi.fn(async () => new Uint8Array([1]));

    await expect(
      prepareCanonicalMemberRecoveryEnrollment({
        replay,
        recoveryPhrase: encodeRecoveryPhrase(new Uint8Array(16)),
        readRecoveryKeyEnvelope,
        assertedAt: 2,
      }),
    ).rejects.toThrow("Recovery Phrase does not match an effective Recovery Credential");
    expect(readRecoveryKeyEnvelope).not.toHaveBeenCalled();
  });

  it("rejects incomplete or duplicate authenticated slots before reading opaque storage", async () => {
    const { creation, replay } = await recoveryFixture();
    const readRecoveryKeyEnvelope = vi.fn(async () => new Uint8Array([1]));
    const slot = replay.authority.keyEnvelopeSlots.find(({ targetKind }) => targetKind === 1);
    if (slot === undefined) throw new TypeError("Recovery fixture has no Recovery Envelope slot");

    for (const keyEnvelopeSlots of [
      replay.authority.keyEnvelopeSlots.filter(({ targetKind }) => targetKind !== 1),
      [
        ...replay.authority.keyEnvelopeSlots,
        { ...slot, keyEnvelopeId: randomIdentifier("KeyEnvelope") },
      ],
    ]) {
      await expect(
        prepareCanonicalMemberRecoveryEnrollment({
          replay: { ...replay, authority: { ...replay.authority, keyEnvelopeSlots } },
          recoveryPhrase: creation.recoveryPhrase,
          readRecoveryKeyEnvelope,
          assertedAt: 2,
        }),
      ).rejects.toThrow("Recovery Key Envelope slots are not the complete Key Epoch set");
    }
    expect(readRecoveryKeyEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a decryptable Recovery Envelope whose protected target misses its slot", async () => {
    const { creation, replay } = await recoveryFixture();
    const misbound = await sealKeyEnvelope({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      targetKind: 1,
      targetCredentialId: randomIdentifier("RecoveryCredential"),
      targetRevision: 0,
      recipientWrappingPublicKey: creation.secrets.recovery.wrappingPublicKey,
    });
    const readRecoveryKeyEnvelope = vi.fn(async () => misbound.envelope.bytes);

    await expect(
      prepareCanonicalMemberRecoveryEnrollment({
        replay,
        recoveryPhrase: creation.recoveryPhrase,
        readRecoveryKeyEnvelope,
        assertedAt: 2,
      }),
    ).rejects.toThrow("Recovery Key Envelope does not match its authenticated slot");
    expect(readRecoveryKeyEnvelope).toHaveBeenCalledOnce();
  });

  it("atomically persists the Enrollment, recovered keyring, fresh Client, and local selection", async () => {
    const { creation, replay } = await recoveryFixture();
    const commitReplicaMutation = vi.fn(async (_commit: ReplicaMutationCommit) => undefined);
    const storage = {
      getBytes: vi.fn(async () => undefined),
      commitReplicaMutation,
    };
    const vaults = {
      realm: NORMAL_STORAGE_REALM,
      storage,
      readResolvedOpaqueItem: vi.fn(async () => creation.recoveryKeyEnvelope.envelope.bytes),
    };
    const service = new CanonicalMemberRecoveryService(vaults as never);
    vi.spyOn(service.replay, "replay").mockResolvedValue(replay);

    const outcome = await service.enroll({
      commandId: "member-recovery-1",
      vaultId: creation.ids.vaultId,
      recoveryPhrase: creation.recoveryPhrase,
      assertedAt: 2,
    });

    expect(outcome).toMatchObject({
      commandId: "member-recovery-1",
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
    });
    expect(commitReplicaMutation).toHaveBeenCalledOnce();
    const commit = commitReplicaMutation.mock.calls[0]?.[0];
    expect(commit?.expectedReplicaState).toEqual(replay.vault.replicaStateStorageBytes);
    expect(commit?.nextReplicaState).toEqual(
      expect.objectContaining({ namespace: NAMESPACES.replicaState.key }),
    );
    expect(commit?.immutableItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: NAMESPACES.vaultRecord.key }),
        expect.objectContaining({ namespace: NAMESPACES.keyEnvelope.key }),
        expect.objectContaining({ namespace: NAMESPACES.commandOutcome.key }),
      ]),
    );
    expect(commit?.immutableItems).toHaveLength(3);
    expect(commit?.mutableItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: NAMESPACES.logicalResolution.key }),
        expect.objectContaining({ namespace: NAMESPACES.vaultDirectory.key }),
        expect.objectContaining({ namespace: NAMESPACES.clientSecret.key }),
        expect.objectContaining({ namespace: NAMESPACES.epochSecret.key }),
      ]),
    );
    expect(commit?.mutableItems).toHaveLength(5);
  });

  it("replaces every effective Recovery head with a freshly possessed descendant Credential", async () => {
    const { creation, vault, replay } = await recoveryFixture();
    const enrollment = await prepareCanonicalMemberRecoveryEnrollment({
      replay,
      recoveryPhrase: creation.recoveryPhrase,
      readRecoveryKeyEnvelope: async () => creation.recoveryKeyEnvelope.envelope.bytes,
      assertedAt: 2,
    });
    const recoveredVault: PersistedOpenedCanonicalVault = {
      ...vault,
      directory: {
        ...vault.directory,
        selectedClientCredentialId: enrollment.clientSecret.clientCredentialId,
      },
      replicaState: enrollment.nextReplicaState,
      clientSecret: enrollment.clientSecret,
    };
    const recoveredReplay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: enrollment.event.bytes })),
      readResolvedOpaqueItem: vi.fn(async () => enrollment.clientKeyEnvelopes[0]?.envelope.bytes),
    } as never).replayOpened(recoveredVault);

    const replacement = await prepareCanonicalRecoveryCredentialReplacement({
      replay: recoveredReplay,
      epochSecrets: enrollment.recoveredEpochs,
      assertedAt: 3,
      deterministic: { recoveryEntropy: new Uint8Array(16).fill(2) },
    });

    expect(replacement.recoveryPhrase.split(" ")).toHaveLength(12);
    expect(replacement.event).toMatchObject({ family: 1, type: 11 });
    expect(replacement.replacedRecoveryCredentialIds).toEqual([creation.ids.recoveryCredentialId]);
    expect(replacement.recoveryCredential).toMatchObject({
      memberId: creation.ids.firstMemberId,
      revision: 1,
    });
    expect(replacement.recoveryKeyEnvelopes).toHaveLength(1);

    const eventById = new Map(
      [enrollment.event, replacement.event].map(
        (event) => [Buffer.from(event.recordId).toString("hex"), event] as const,
      ),
    );
    const envelopeById = new Map(
      [...enrollment.clientKeyEnvelopes, ...replacement.recoveryKeyEnvelopes].map(
        (envelope) => [Buffer.from(envelope.id).toString("hex"), envelope] as const,
      ),
    );
    const replacedReplay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async ({ logicalId }) => ({
        payloadBytes: eventById.get(Buffer.from(logicalId).toString("hex"))?.bytes,
      })),
      readResolvedOpaqueItem: vi.fn(async ({ logicalId }) => {
        const envelope = envelopeById.get(Buffer.from(logicalId).toString("hex"));
        if (envelope === undefined) throw new TypeError("Missing Recovery ceremony Envelope");
        return envelope.envelope.bytes;
      }),
    } as never).replayOpened({
      ...recoveredVault,
      replicaState: replacement.nextReplicaState,
    });
    expect(
      replacedReplay.authority.recoveryCredentials.filter(({ effective }) => effective),
    ).toEqual([
      expect.objectContaining({
        recoveryCredentialId: replacement.recoveryCredential.recoveryCredentialId,
        revision: 1,
      }),
    ]);
    expect(replacedReplay.authority.recoveryConflicts).toEqual([]);
  });

  it("commits Recovery Replacement only after confirming the fresh phrase", async () => {
    const { creation, vault, replay } = await recoveryFixture();
    const enrollment = await prepareCanonicalMemberRecoveryEnrollment({
      replay,
      recoveryPhrase: creation.recoveryPhrase,
      readRecoveryKeyEnvelope: async () => creation.recoveryKeyEnvelope.envelope.bytes,
      assertedAt: 2,
    });
    const recoveredVault: PersistedOpenedCanonicalVault = {
      ...vault,
      directory: {
        ...vault.directory,
        selectedClientCredentialId: enrollment.clientSecret.clientCredentialId,
      },
      replicaState: enrollment.nextReplicaState,
      clientSecret: enrollment.clientSecret,
    };
    const recoveredReplay = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: enrollment.event.bytes })),
      readResolvedOpaqueItem: vi.fn(async () => enrollment.clientKeyEnvelopes[0]?.envelope.bytes),
    } as never).replayOpened(recoveredVault);
    const commitReplicaMutation = vi.fn(async (_commit: ReplicaMutationCommit) => undefined);
    const vaults = {
      realm: NORMAL_STORAGE_REALM,
      storage: { commitReplicaMutation },
      listEpochSecrets: vi.fn(async () => enrollment.recoveredEpochs),
    };
    const service = new CanonicalRecoveryReplacementService(vaults as never);
    vi.spyOn(service.replay, "replay").mockResolvedValue(recoveredReplay);

    const ceremony = await service.begin({
      vaultId: creation.ids.vaultId,
      assertedAt: 3,
    });
    expect(ceremony.recoveryPhrase.split(" ")).toHaveLength(12);
    await expect(ceremony.confirm(creation.recoveryPhrase)).rejects.toMatchObject({
      id: "RECOVERY_PHRASE_MISMATCH",
    });
    expect(commitReplicaMutation).not.toHaveBeenCalled();

    const outcome = await ceremony.confirm(ceremony.recoveryPhrase);
    expect(outcome).toMatchObject({
      vaultId: creation.ids.vaultId,
      memberId: creation.ids.firstMemberId,
      revision: 1,
    });
    expect(commitReplicaMutation).toHaveBeenCalledOnce();
    const commit = commitReplicaMutation.mock.calls[0]?.[0];
    expect(commit?.expectedReplicaState).toEqual(recoveredReplay.vault.replicaStateStorageBytes);
    expect(commit?.immutableItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: NAMESPACES.vaultRecord.key }),
        expect.objectContaining({ namespace: NAMESPACES.keyEnvelope.key }),
      ]),
    );
    expect(commit?.immutableItems).toHaveLength(2);
    expect(commit?.mutableItems).toEqual([
      expect.objectContaining({ namespace: NAMESPACES.logicalResolution.key }),
      expect.objectContaining({ namespace: NAMESPACES.logicalResolution.key }),
    ]);
    await expect(ceremony.confirm(ceremony.recoveryPhrase)).rejects.toThrow(/no longer active/u);
  });
});

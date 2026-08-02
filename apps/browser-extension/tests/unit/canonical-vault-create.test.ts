import { describe, expect, it } from "vitest";

import { decodeRecoveryPhrase } from "../../src/crypto/canonical";
import { openCompactItem } from "../../src/crypto/compact";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import {
  EMPTY_REQUIRED_FEATURE_SET_ID,
  encodeFeatureManifest,
  featureManifestId,
  requiredFeatureSetId,
} from "../../src/domain/canonical/features";
import { identifier, keyEpochId } from "../../src/domain/canonical/identifiers";
import { decodeCanonicalValue } from "../../src/domain/canonical/value";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function mapField(value: unknown, key: number): unknown {
  if (!(value instanceof Map) || !value.has(key)) throw new TypeError(`Missing map field ${key}`);
  return value.get(key);
}

describe("canonical local Vault creation", () => {
  it("constructs and self-verifies one Initial Baseline and parentless Genesis", async () => {
    const vaultId = filled("Vault", 1);
    const key = new Uint8Array(32).fill(9);
    const created = await prepareCanonicalVaultCreation({
      label: "Research",
      assertedAt: 1_800_000_000_000,
      deterministic: {
        ids: {
          vaultId,
          generationId: filled("Generation", 2),
          firstMemberId: filled("Member", 3),
          clientCredentialId: filled("ClientCredential", 4),
          recoveryCredentialId: filled("RecoveryCredential", 5),
          labelCauseId: filled("BaselineCause", 6),
        },
        recoveryEntropy: new Uint8Array(16),
        clientSigningSeed: new Uint8Array(32).fill(7),
        clientWrappingPrivateKey: new Uint8Array(32).fill(8),
        keyEpochKey: key,
        recoveryEnvelopePadding: new Uint8Array(32).fill(10),
        clientEnvelopePadding: new Uint8Array(32).fill(11),
        baselineProtectionParameters: new Uint8Array(64).fill(12),
        genesisProtectionParameters: new Uint8Array(64).fill(13),
      },
    });

    expect(created.recoveryPhrase).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(decodeRecoveryPhrase(created.recoveryPhrase)).toEqual(new Uint8Array(16));
    expect(created.secrets.keyEpoch).toEqual({ id: keyEpochId(vaultId, key), key });
    expect(created.baseline.dependencies).toEqual(
      expect.arrayContaining([
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: created.recoveryKeyEnvelope.id },
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: created.clientKeyEnvelope.id },
      ]),
    );
    expect(created.baseline.dependencies).toHaveLength(2);
    expect(created.genesis.parentRecordIds).toEqual([]);
    expect(created.genesis.authorityParentRecordIds).toEqual([]);
    expect(created.genesis.dependencies).toEqual([
      { type: DEPENDENCY_TYPES.VaultBaseline, id: created.baseline.recordId },
    ]);
    expect(created.genesis.requiredFeatureSetId).toEqual(EMPTY_REQUIRED_FEATURE_SET_ID);
    expect(requiredFeatureSetId([])).toEqual(EMPTY_REQUIRED_FEATURE_SET_ID);
    expect(created.baselineEnvelope.storageItemId).not.toEqual(
      created.genesisEnvelope.storageItemId,
    );
  });

  it("places the optional initial label in Baseline state with a fresh Baseline Cause", async () => {
    const labelCauseId = filled("BaselineCause", 22);
    const created = await prepareCanonicalVaultCreation({
      label: "Field notes",
      assertedAt: 1,
      deterministic: { ids: { labelCauseId } },
    });
    const baseline = decodeCanonicalValue(created.baseline.bytes);
    const body = mapField(baseline, 9);
    const content = mapField(body, 2);
    const label = mapField(content, 1);

    expect(mapField(label, 0)).toBe("Field notes");
    expect(mapField(label, 1)).toEqual([labelCauseId]);
  });

  it("protects the exact initial Feature Manifest closure as Baseline dependencies", async () => {
    const feature = {
      featureKey: "awsm.test-initial",
      revision: 1,
      parameters: new Uint8Array([1, 2]),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const;
    const bytes = encodeFeatureManifest(feature);
    const created = await prepareCanonicalVaultCreation({
      label: "Feature Vault",
      assertedAt: 1,
      featureManifests: [feature],
    } as Parameters<typeof prepareCanonicalVaultCreation>[0]);

    expect(created.baseline.requiredFeatureSetId).toEqual(requiredFeatureSetId([feature]));
    expect(created.baseline.dependencies).toContainEqual({
      type: DEPENDENCY_TYPES.FeatureManifest,
      id: featureManifestId(bytes),
    });
    expect(created.featureManifests).toHaveLength(1);
    const preparedManifest = created.featureManifests[0];
    expect(preparedManifest?.id).toEqual(featureManifestId(bytes));
    expect(preparedManifest?.bytes).toEqual(bytes);
    await expect(
      openCompactItem({
        vaultId: created.ids.vaultId,
        keyEpochId: created.secrets.keyEpoch.id,
        keyEpochKey: created.secrets.keyEpoch.key,
        envelopeBytes: preparedManifest?.envelope.bytes ?? new Uint8Array(),
      }),
    ).resolves.toMatchObject({ payloadType: 3, payloadBytes: bytes });
  });

  it("does not create a phantom label cause for an unnamed Vault", async () => {
    const created = await prepareCanonicalVaultCreation({ label: null, assertedAt: 1 });
    const baseline = decodeCanonicalValue(created.baseline.bytes);
    const label = mapField(mapField(mapField(baseline, 9), 2), 1);

    expect(mapField(label, 0)).toBeNull();
    expect(mapField(label, 1)).toEqual([]);
  });

  it("rebuilds a prepared creation only from its phrase and exact persisted protected material", async () => {
    const initial = await prepareCanonicalVaultCreation({
      label: "Restart-safe",
      assertedAt: 42,
      deterministic: {
        ids: {
          vaultId: filled("Vault", 31),
          generationId: filled("Generation", 32),
          firstMemberId: filled("Member", 33),
          clientCredentialId: filled("ClientCredential", 34),
          recoveryCredentialId: filled("RecoveryCredential", 35),
          labelCauseId: filled("BaselineCause", 36),
        },
        recoveryEntropy: new Uint8Array(16).fill(37),
        clientSigningSeed: new Uint8Array(32).fill(38),
        clientWrappingPrivateKey: new Uint8Array(32).fill(39),
        keyEpochKey: new Uint8Array(32).fill(40),
        baselineProtectionParameters: new Uint8Array(64).fill(41),
        genesisProtectionParameters: new Uint8Array(64).fill(42),
      },
    });

    const resumed = await prepareCanonicalVaultCreation({
      label: "Restart-safe",
      assertedAt: 42,
      deterministic: {
        ids: initial.ids,
        recoveryEntropy: decodeRecoveryPhrase(initial.recoveryPhrase),
        clientSigningSeed: initial.secrets.client.signingSeed,
        clientWrappingPrivateKey: initial.secrets.client.wrappingPrivateKey,
        keyEpochKey: initial.secrets.keyEpoch.key,
        recoveryEnvelopeBytes: initial.recoveryKeyEnvelope.envelope.bytes,
        clientEnvelopeBytes: initial.clientKeyEnvelope.envelope.bytes,
        baselineProtectionParameters: initial.baselineEnvelope.protectionParameters,
        genesisProtectionParameters: initial.genesisEnvelope.protectionParameters,
      },
    });

    expect(resumed.recoveryKeyEnvelope.envelope.bytes).toEqual(
      initial.recoveryKeyEnvelope.envelope.bytes,
    );
    expect(resumed.clientKeyEnvelope.envelope.bytes).toEqual(
      initial.clientKeyEnvelope.envelope.bytes,
    );
    expect(resumed.baseline.bytes).toEqual(initial.baseline.bytes);
    expect(resumed.genesis.bytes).toEqual(initial.genesis.bytes);
    expect(resumed.baselineEnvelope.bytes).toEqual(initial.baselineEnvelope.bytes);
    expect(resumed.genesisEnvelope.bytes).toEqual(initial.genesisEnvelope.bytes);
  });
});

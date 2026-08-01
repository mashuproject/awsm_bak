import { describe, expect, it } from "vitest";

import { decodeRecoveryPhrase } from "../../src/crypto/canonical";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import {
  EMPTY_REQUIRED_FEATURE_SET_ID,
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

  it("does not create a phantom label cause for an unnamed Vault", async () => {
    const created = await prepareCanonicalVaultCreation({ label: null, assertedAt: 1 });
    const baseline = decodeCanonicalValue(created.baseline.bytes);
    const label = mapField(mapField(mapField(baseline, 9), 2), 1);

    expect(mapField(label, 0)).toBeNull();
    expect(mapField(label, 1)).toEqual([]);
  });
});

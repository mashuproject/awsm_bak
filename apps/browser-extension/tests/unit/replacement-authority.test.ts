import { describe, expect, it } from "vitest";

import type { StoredAccountMetadataV1 } from "../../src/drivers/indexeddb/schema";
import {
  openDeviceKeyEnvelope,
  verifyDeviceEnrollmentProof,
} from "../../src/runtime/recovery/device";
import { openRecoveryKit } from "../../src/runtime/recovery/kit";
import { decodeRecoveryFile } from "../../src/runtime/recovery/recovery-file";
import {
  confirmReplacementPhrase,
  prepareReplacementAuthority,
  wipeReplacementAuthority,
} from "../../src/runtime/recovery/replacement-authority";
import { VaultService } from "../../src/runtime/vault/service";
import { unwrapDeviceSlot } from "../../src/runtime/vault/slots";

const account: StoredAccountMetadataV1 = {
  version: 1,
  accountId: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  email: "archive@example.test",
  scope: "Account",
};

describe("replacement Vault authority", () => {
  it("creates phrase-bound independent recovery and Device authority", async () => {
    const target = await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Replacement archive",
      createdAt: "2026-07-25T22:00:00.000Z",
    });
    let nextId = 100;
    const result = await prepareReplacementAuthority({
      account,
      target,
      displayName: "Firefox on laptop",
      clientKind: "FirefoxExtension",
      randomUuid: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
      now: () => "2026-07-25T22:01:00.000Z",
    });

    expect(result.phrase.split(" ")).toHaveLength(12);
    expect(result.prepared.certificate.content).toMatchObject({
      vaultId: target.records.metadata.vaultId,
      deviceId: target.records.metadata.deviceId,
      recoveryGenerationId: result.prepared.recoveryGenerationId,
      displayName: "Firefox on laptop",
      clientKind: "FirefoxExtension",
    });
    await expect(
      verifyDeviceEnrollmentProof({
        certificate: result.prepared.certificate,
        accountSessionId: account.sessionId,
        proof: result.prepared.deviceProofSignature,
      }),
    ).resolves.toBeUndefined();
    await expect(decodeRecoveryFile(result.recoveryFile)).resolves.toEqual(
      result.prepared.recoveryKit,
    );
    const recovered = await openRecoveryKit(
      result.prepared.recoveryKit,
      result.prepared.wrappingKey,
    );
    expect(recovered).toMatchObject({
      vaultId: target.records.metadata.vaultId,
      recoveryGenerationId: result.prepared.recoveryGenerationId,
      activeKeyEpochId: target.records.metadata.activeKeyEpochId,
    });
    expect(recovered.keyEpochs).toHaveLength(1);
    const localRoot = await unwrapDeviceSlot(target.records.deviceSlot, target.records.deviceKey);
    await expect(
      openDeviceKeyEnvelope({
        envelope: result.prepared.envelope,
        certificate: result.prepared.certificate,
        deviceWrappingSecretKey: result.prepared.identity.wrappingSecretKey,
      }),
    ).resolves.toEqual(localRoot);
    await expect(confirmReplacementPhrase(result.prepared, result.phrase)).resolves.toBeUndefined();
    await expect(
      confirmReplacementPhrase(
        result.prepared,
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).rejects.toMatchObject({ id: "RECOVERY_PHRASE_INVALID" });

    await wipeReplacementAuthority(result.prepared);
    expect(result.prepared.entropy).toEqual(new Uint8Array(16));
    expect(result.prepared.rootKey).toEqual(new Uint8Array(32));
    expect(result.prepared.identity.signingSecretKey).toEqual(new Uint8Array(64));
    expect(result.prepared.identity.wrappingSecretKey).toEqual(new Uint8Array(32));
  });

  it("rejects Account authority of the wrong scope before creating secrets", async () => {
    const target = await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Replacement archive",
      createdAt: "2026-07-25T22:00:00.000Z",
    });

    await expect(
      prepareReplacementAuthority({
        account: { ...account, scope: "VaultDevice" },
        target,
        displayName: "Chrome on desktop",
        clientKind: "ChromeExtension",
      }),
    ).rejects.toMatchObject({ id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
  });
});

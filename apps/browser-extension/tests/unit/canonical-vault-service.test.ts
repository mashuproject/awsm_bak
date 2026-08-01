import { describe, expect, it, vi } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import type { CanonicalIndexedDb } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import { decodeInstallationSelection } from "../../src/runtime/vault/canonical-local-state";
import {
  CanonicalVaultCreationCeremony,
  CanonicalVaultService,
} from "../../src/runtime/vault/canonical-service";

function isWiped(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

describe("canonical Vault creation ceremony", () => {
  it("retains Prepared Data after a mismatched confirmation but persists nothing", async () => {
    const prepared = await prepareCanonicalVaultCreation({ label: "Vault", assertedAt: 1 });
    const storage = {
      getOrCreateInstallationWrappingKey: () => {
        throw new Error("storage must not be reached");
      },
    } as unknown as CanonicalIndexedDb;
    const ceremony = new CanonicalVaultCreationCeremony(
      storage,
      NORMAL_STORAGE_REALM,
      "Vault",
      prepared,
    );

    await expect(ceremony.confirm("not the recovery phrase")).rejects.toMatchObject({
      id: "RECOVERY_PHRASE_MISMATCH",
    });
    expect(isWiped(prepared.secrets.keyEpoch.key)).toBe(false);
    await ceremony.cancel();
  });

  it("wipes every retained private or plaintext Epoch copy when cancelled", async () => {
    const prepared = await prepareCanonicalVaultCreation({ label: null, assertedAt: 1 });
    const ceremony = new CanonicalVaultCreationCeremony(
      {} as CanonicalIndexedDb,
      NORMAL_STORAGE_REALM,
      null,
      prepared,
    );
    await ceremony.cancel();

    expect(
      [
        prepared.secrets.client.signingSeed,
        prepared.secrets.client.signingSecretKey,
        prepared.secrets.client.wrappingPrivateKey,
        prepared.secrets.recovery.signingSeed,
        prepared.secrets.recovery.signingSecretKey,
        prepared.secrets.recovery.wrappingPrivateKey,
        prepared.secrets.keyEpoch.key,
        prepared.clientKeyEnvelope.keyEpochKey,
        prepared.clientKeyEnvelope.bytes,
        prepared.recoveryKeyEnvelope.keyEpochKey,
        prepared.recoveryKeyEnvelope.bytes,
      ].every(isWiped),
    ).toBe(true);
    await expect(ceremony.confirm(ceremony.recoveryPhrase)).rejects.toThrow(/no longer active/u);
  });
});

describe("canonical Vault selection", () => {
  it("opens the destination before replacing the Installation selection", async () => {
    const vaultId = randomIdentifier("Vault");
    const writes: unknown[] = [];
    const storage = {
      putMutable: vi.fn(async (_realm, item) => {
        writes.push(item);
      }),
    } as unknown as CanonicalIndexedDb;
    const service = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const open = vi.spyOn(service, "openVault").mockResolvedValue({} as never);

    await service.selectVault(vaultId);

    expect(open).toHaveBeenCalledWith(vaultId);
    expect(writes).toHaveLength(1);
    const selection = writes[0] as {
      readonly namespace: string;
      readonly scopeKey: string;
      readonly itemKey: string;
      readonly bytes: Uint8Array;
    };
    expect(selection).toMatchObject({
      namespace: NAMESPACES.installationSelection.key,
      scopeKey: "installation",
      itemKey: "current",
    });
    expect(decodeInstallationSelection(selection.bytes).vaultId).toEqual(vaultId);
  });
});

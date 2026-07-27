import { describe, expect, it } from "vitest";

import { createRecoveryKit, recoveryKitToWire } from "../../src/runtime/recovery/kit";
import { ServerSwitchCandidateInspector } from "../../src/runtime/synchronization/server-switch-inspection";

const accountId = "01900000-0000-7000-8000-000000000001";
const vaultId = "01900000-0000-7000-8000-000000000003";
const recoveryGenerationId = "01900000-0000-7000-8000-000000000004";
const keyEpochId = "01900000-0000-7000-8000-000000000005";
const rootKey = new Uint8Array(32).fill(7);

async function recovery() {
  return createRecoveryKit({
    keyring: {
      version: 1,
      vaultId,
      recoveryGenerationId,
      activeKeyEpochId: keyEpochId,
      keyEpochs: [{ keyEpochId, ordinal: 0, rootKey }],
    },
    recoveryKitWrappingKey: new Uint8Array(32).fill(3),
    recoveryAdministratorSeed: new Uint8Array(32).fill(4),
    nonce: new Uint8Array(24).fill(5),
  });
}

async function inspector(
  response: unknown,
  suppliedLocal?: Awaited<ReturnType<typeof recovery>>,
  authority: unknown = {
    vaultId,
    state: "Active",
    activeKeyEpochId: keyEpochId,
    generationId: "01900000-0000-7000-8000-000000000806",
    generationNumber: 2,
    headCursor: 7,
  },
) {
  const local = suppliedLocal ?? (await recovery());
  return new ServerSwitchCandidateInspector(
    {
      loadMetadata: async () => ({
        version: 1,
        accountId,
        sessionId: "01900000-0000-7000-8000-000000000006",
        username: "candidate_test",
        inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
        scope: "Account",
      }),
      loadRecoveryKit: async () => ({
        version: 1,
        vaultId,
        recoveryGenerationId,
        metadata: local.metadata,
        ciphertext: local.ciphertext,
      }),
    },
    { request: async () => ({ status: 200, body: response }) },
    async () => ({ request: async () => ({ status: 200, body: authority }) }),
  );
}

describe("Server Switch candidate inspection", () => {
  it("classifies an empty Account without writing candidate authority", async () => {
    await expect((await inspector({ state: "Empty" })).inspect(vaultId, rootKey)).resolves.toEqual({
      headCursor: 0,
    });
  });

  it("accepts only an attached Vault with the same encrypted Recovery Kit authority", async () => {
    const kit = await recovery();
    await expect(
      (
        await inspector({
          state: "Attached",
          vaultId,
          recoveryKit: recoveryKitToWire(kit),
        })
      ).inspect(vaultId, rootKey),
    ).resolves.toMatchObject({
      registration: {
        accountId,
        vaultId,
        activeRecoveryGenerationId: recoveryGenerationId,
        activeKeyEpochId: keyEpochId,
        remoteGenerationId: "01900000-0000-7000-8000-000000000806",
        remoteGenerationNumber: 2,
      },
      headCursor: 7,
      replica: {
        vaultId,
        generation: {
          generationId: "01900000-0000-7000-8000-000000000806",
          generationNumber: 2,
        },
      },
    });
  });

  it("distinguishes another Vault and mismatched recovery authority", async () => {
    const kit = await recovery();
    await expect(
      (
        await inspector({
          state: "Attached",
          vaultId: "01900000-0000-7000-8000-000000000099",
          recoveryKit: recoveryKitToWire(kit),
        })
      ).inspect(vaultId, rootKey),
    ).rejects.toMatchObject({ id: "SERVER_SWITCH_VAULT_MISMATCH" });
    const other = await recovery();
    other.ciphertext[0] = (other.ciphertext[0] ?? 0) ^ 1;
    await expect(
      (
        await inspector({ state: "Attached", vaultId, recoveryKit: recoveryKitToWire(kit) }, other)
      ).inspect(vaultId, rootKey),
    ).rejects.toMatchObject({ id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
  });
});

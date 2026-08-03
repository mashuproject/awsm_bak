import { describe, expect, it, vi } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { CanonicalHostedMemberRecoveryService } from "../../src/runtime/synchronization/canonical-hosted-member-recovery";
import type { CanonicalHostedRecoveryClosure } from "../../src/runtime/synchronization/canonical-hosted-recovery-closure";
import type { CanonicalHostedRecoveryEnvelopeCandidate } from "../../src/runtime/synchronization/canonical-hosted-recovery-discovery";

function candidate(): CanonicalHostedRecoveryEnvelopeCandidate {
  return {
    replicaHandle: "123e4567-e89b-42d3-a456-426614174000",
    storageItemId: randomIdentifier("StorageItem"),
    vaultId: randomIdentifier("Vault"),
    keyEpochId: randomIdentifier("KeyEpoch"),
    keyEpochKey: crypto.getRandomValues(new Uint8Array(32)),
    recoveryCredentialId: randomIdentifier("RecoveryCredential"),
    recoveryCredentialRevision: 0,
    envelopeBytes: new Uint8Array([1]),
  };
}

describe("Hosted Member Recovery", () => {
  it("uses one transient Account session to authenticate an opaque closure before atomic local activation", async () => {
    const discovered = candidate();
    const recovery = {
      vaultId: discovered.vaultId,
      generationId: randomIdentifier("Generation"),
      memberId: randomIdentifier("Member"),
      clientCredentialId: randomIdentifier("ClientCredential"),
      eventRecordId: randomIdentifier("VaultRecord"),
    };
    const closure = {
      replicaHandle: discovered.replicaHandle,
      replicaState: { vaultId: discovered.vaultId },
      validated: {
        manifest: { vaultId: discovered.vaultId, stateDigest: new Uint8Array(32).fill(7) },
        keyInventory: { entries: [] },
      },
    } as unknown as CanonicalHostedRecoveryClosure;
    const itemBytes = new Uint8Array([9, 8, 7]);
    const signIn = vi.fn(async () => ({
      username: "tristan",
      sessionId: "123e4567-e89b-42d3-a456-426614174001",
      accessToken: "transient-access-token",
      accessExpiresAt: 1,
      refreshToken: "transient-refresh-token",
      refreshExpiresAt: 2,
    }));
    const discover = vi.fn(async () => [discovered, { ...discovered }]);
    const authenticate = vi.fn(async () => closure);
    const activate = vi.fn(async (input) => {
      expect(input.manifest).toBe(closure.validated.manifest);
      expect(input.keyInventory).toBe(closure.validated.keyInventory);
      expect(input.recoveryPhrase).toBe(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      );
      const item = await input.source.openOpaque({
        storageItemId: randomIdentifier("StorageItem"),
      });
      expect(new Uint8Array(await new Response(item).arrayBuffer())).toEqual(itemBytes);
      return recovery;
    });
    const item = vi.fn(async () => new Blob([itemBytes]).stream());

    const result = await new CanonicalHostedMemberRecoveryService({
      completeImports: { activateUnknownWithMemberRecovery: activate },
      discovery: { discover },
      closures: { authenticate },
      createSessionHttp: () => ({ signIn }),
      createReplicaHttp: () => ({ item }),
    }).recover({
      endpoint: "https://sync.example.test/",
      username: "tristan",
      password: "transient-password",
      recoveryPhrase:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      assertedAt: 3,
    });

    expect(result).toEqual(recovery);
    expect(signIn).toHaveBeenCalledWith({ username: "tristan", password: "transient-password" });
    expect(discover).toHaveBeenCalledWith({
      endpoint: "https://sync.example.test/",
      bearerToken: "transient-access-token",
      recoveryPhrase:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(item).toHaveBeenCalledWith({
      replicaHandle: discovered.replicaHandle,
      storageItemId: expect.any(Uint8Array),
      byteLength: undefined,
    });
  });

  it("refuses divergent authenticated closures before local activation", async () => {
    const first = candidate();
    const second = { ...candidate(), replicaHandle: "123e4567-e89b-42d3-a456-426614174002" };
    const closure = (source: CanonicalHostedRecoveryEnvelopeCandidate) =>
      ({
        replicaHandle: source.replicaHandle,
        replicaState: { vaultId: source.vaultId },
        validated: {
          manifest: { vaultId: source.vaultId, stateDigest: new Uint8Array(32) },
          keyInventory: { entries: [] },
        },
      }) as unknown as CanonicalHostedRecoveryClosure;
    const activate = vi.fn();

    await expect(
      new CanonicalHostedMemberRecoveryService({
        completeImports: { activateUnknownWithMemberRecovery: activate },
        discovery: { discover: vi.fn(async () => [first, second]) },
        closures: { authenticate: vi.fn(async ({ candidate: source }) => closure(source)) },
        createSessionHttp: () => ({
          signIn: vi.fn(async () => ({
            username: "tristan",
            sessionId: "123e4567-e89b-42d3-a456-426614174003",
            accessToken: "transient-access-token",
            accessExpiresAt: 1,
            refreshToken: "transient-refresh-token",
            refreshExpiresAt: 2,
          })),
        }),
      }).recover({
        endpoint: "https://sync.example.test/",
        username: "tristan",
        password: "transient-password",
        recoveryPhrase:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        assertedAt: 3,
      }),
    ).rejects.toThrow("multiple divergent");
    expect(activate).not.toHaveBeenCalled();
  });
});

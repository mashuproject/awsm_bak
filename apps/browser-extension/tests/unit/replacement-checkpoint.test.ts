import { describe, expect, it } from "vitest";
import {
  prepareReplacementAuthority,
  wipeReplacementAuthority,
} from "../../src/runtime/recovery/replacement-authority";
import {
  decodeVaultReplacementSensitiveCheckpoint,
  encodeVaultReplacementSensitiveCheckpoint,
} from "../../src/runtime/recovery/replacement-checkpoint";
import { VaultService } from "../../src/runtime/vault/service";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("replacement sensitive checkpoint", () => {
  it("round-trips only post-confirmation authority and mappings", async () => {
    const target = await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Replacement",
      createdAt: "2026-07-25T23:50:00.000Z",
    });
    let nextId = 20;
    const authority = await prepareReplacementAuthority({
      account: {
        version: 1,
        accountId: id(1),
        sessionId: id(2),
        email: "owner@example.test",
        scope: "Account",
      },
      target,
      displayName: "Chrome",
      clientKind: "ChromeExtension",
      randomUuid: () => id(nextId++),
      now: () => "2026-07-25T23:51:00.000Z",
    });
    const encoded = encodeVaultReplacementSensitiveCheckpoint({
      version: 1,
      targetVaultId: target.records.metadata.vaultId,
      recoveryGenerationId: authority.prepared.recoveryGenerationId,
      accountSessionId: id(2),
      deviceProofSignature: authority.prepared.deviceProofSignature,
      rootKey: authority.prepared.rootKey,
      identity: authority.prepared.identity,
      certificate: authority.prepared.certificate,
      envelope: authority.prepared.envelope,
      recoveryKit: authority.prepared.recoveryKit,
      identifierMappings: [
        {
          kind: "Vault",
          sourceId: id(3),
          targetId: target.records.metadata.vaultId,
        },
      ],
      session: {
        account: {
          accountId: id(1),
          email: "owner@example.test",
        },
        sessionId: id(4),
        scope: "VaultDevice",
        accessToken: "access-secret",
        accessExpiresAt: "2026-07-26T00:00:00.000Z",
        refreshToken: "refresh-secret",
        refreshExpiresAt: "2026-08-25T00:00:00.000Z",
      },
    });

    const decoded = decodeVaultReplacementSensitiveCheckpoint(encoded);

    expect(decoded).toMatchObject({
      version: 1,
      targetVaultId: target.records.metadata.vaultId,
      recoveryGenerationId: authority.prepared.recoveryGenerationId,
      accountSessionId: id(2),
      identifierMappings: [
        {
          kind: "Vault",
          sourceId: id(3),
          targetId: target.records.metadata.vaultId,
        },
      ],
      session: {
        scope: "VaultDevice",
        refreshToken: "refresh-secret",
      },
    });
    expect(decoded.rootKey).toEqual(authority.prepared.rootKey);
    expect(decoded.identity.signingSecretKey).toEqual(authority.prepared.identity.signingSecretKey);
    expect(new TextDecoder().decode(encoded)).not.toContain(authority.phrase);

    const corrupted = Uint8Array.from(encoded);
    corrupted[corrupted.byteLength - 1] = (corrupted[corrupted.byteLength - 1] ?? 0) ^ 1;
    expect(() => decodeVaultReplacementSensitiveCheckpoint(corrupted)).toThrow();
    await wipeReplacementAuthority(authority.prepared);
  });
});

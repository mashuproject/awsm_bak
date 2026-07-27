import { describe, expect, it, vi } from "vitest";

import type { LoadedDetachedVaultAuthority } from "../../src/drivers/indexeddb/device-repository";
import type { StoredAccountMetadataV1 } from "../../src/drivers/indexeddb/schema";
import { DetachedVaultAttachmentService } from "../../src/runtime/recovery/detached-attachment";
import {
  prepareReplacementAuthority,
  wipeReplacementAuthority,
} from "../../src/runtime/recovery/replacement-authority";
import { VaultService } from "../../src/runtime/vault/service";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function cloneAuthority(authority: LoadedDetachedVaultAuthority): LoadedDetachedVaultAuthority {
  return {
    ...authority,
    identity: {
      ...authority.identity,
      signingPublicKey: Uint8Array.from(authority.identity.signingPublicKey),
      signingSecretKey: Uint8Array.from(authority.identity.signingSecretKey),
      wrappingPublicKey: Uint8Array.from(authority.identity.wrappingPublicKey),
      wrappingSecretKey: Uint8Array.from(authority.identity.wrappingSecretKey),
    },
    keyEpochs: authority.keyEpochs.map((epoch) => ({
      ...epoch,
      rootKey: Uint8Array.from(epoch.rootKey),
    })),
  };
}

describe("detached Vault attachment", () => {
  it("publishes complete retained authority with restart-stable idempotency and commits locally last", async () => {
    const target = await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Detached",
      createdAt: "2026-07-27T18:00:00.000Z",
    });
    const account: StoredAccountMetadataV1 = {
      version: 1,
      accountId: id(1),
      sessionId: id(2),
      username: "quiet_vault",
      inactiveDeletionAt: "2027-07-27T18:00:00.000Z",
      scope: "Account",
    };
    let nextId = 10;
    const prepared = await prepareReplacementAuthority({
      account,
      target,
      displayName: "Firefox",
      clientKind: "FirefoxExtension",
      randomUuid: () => id(nextId++),
      now: () => "2026-07-27T18:01:00.000Z",
    });
    const detached: LoadedDetachedVaultAuthority = {
      vaultId: target.records.metadata.vaultId,
      recoveryGenerationId: prepared.prepared.recoveryGenerationId,
      identity: prepared.prepared.identity,
      certificate: prepared.prepared.certificate,
      envelopes: [prepared.prepared.envelope],
      keyEpochs: [
        {
          keyEpochId: target.records.metadata.activeKeyEpochId,
          ordinal: 0,
          rootKey: prepared.prepared.rootKey,
        },
      ],
      recoveryKit: {
        version: 1,
        vaultId: target.records.metadata.vaultId,
        recoveryGenerationId: prepared.prepared.recoveryGenerationId,
        metadata: prepared.prepared.recoveryKit.metadata,
        ciphertext: prepared.prepared.recoveryKit.ciphertext,
      },
    };
    const calls: {
      readonly method: string;
      readonly path: string;
      readonly body: unknown;
      readonly idempotencyKey: string;
    }[] = [];
    const saveReattachedDevice = vi.fn(async () => undefined);
    const transport = {
      request: vi.fn(
        async (method: string, path: string, body: unknown, idempotencyKey: string) => {
          calls.push({ method, path, body, idempotencyKey });
          if (path === "/api/vaults")
            return {
              status: 201,
              body: {
                upload: { uploadId: id(30), partSizeBytes: 4 },
                ticket: { url: "/api/transfers/detached/{partNumber}" },
                session: {
                  account: {
                    accountId: account.accountId,
                    username: account.username,
                    inactiveDeletionAt: account.inactiveDeletionAt,
                  },
                  sessionId: id(31),
                  scope: "VaultDevice",
                  accessToken: "device-access",
                  accessExpiresAt: "2026-07-27T19:00:00.000Z",
                  refreshToken: "device-refresh",
                  refreshExpiresAt: "2026-08-27T18:00:00.000Z",
                },
              },
            };
          return { status: 200, body: {} };
        },
      ),
      putTransfer: vi.fn(async () => undefined),
      useDeviceAccessToken: vi.fn(),
    };
    const firstAuthority = cloneAuthority(detached);
    const retryAuthority = cloneAuthority(detached);
    const service = new DetachedVaultAttachmentService(transport, { saveReattachedDevice });

    await service.attach({ account, records: target.records, authority: firstAuthority });
    const firstCalls = calls.splice(0);
    await service.attach({ account, records: target.records, authority: retryAuthority });
    const retryCalls = calls.splice(0);

    expect(firstCalls.map((call) => call.idempotencyKey)).toEqual(
      retryCalls.map((call) => call.idempotencyKey),
    );
    expect(firstCalls[0]?.body).toEqual(retryCalls[0]?.body);
    expect(firstCalls[0]?.body).toMatchObject({
      keyEpochs: [
        {
          keyEpochId: target.records.metadata.activeKeyEpochId,
          ordinal: 0,
          activatedAt: target.records.metadata.createdAt,
        },
      ],
      activeKeyEpochId: target.records.metadata.activeKeyEpochId,
      deviceKeyEnvelopes: [expect.any(Object)],
    });
    expect(firstCalls[0]?.body).not.toHaveProperty("keyEpoch");
    expect(firstCalls[0]?.body).not.toHaveProperty("deviceKeyEnvelope");
    expect(saveReattachedDevice).toHaveBeenCalledTimes(2);
    expect(transport.useDeviceAccessToken).toHaveBeenCalledWith("device-access");
    expect(transport.putTransfer).toHaveBeenCalled();
    await wipeReplacementAuthority(prepared.prepared);
  });
});
